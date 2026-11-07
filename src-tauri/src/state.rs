//! App-wide session state shared by the Tauri commands.
//!
//! Two platforms are supported: the original HUST SmartCourse client and the
//! Zhihuishu (智慧树 / 知到) client. Only one platform session is active at a
//! time; the platform-neutral helpers (`info`, `has_session`) stay available so
//! the existing commands keep working unchanged.

use hust_course_hack::{
    CourseSummary, SmartCourseClient,
    zhihuishu::{ZhsClient, ZhsCourse},
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

/// Platform the desktop app is connected to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    /// HUST SmartCourse (`smartcourse.hust.edu.cn`).
    #[default]
    Hust,
    /// Zhihuishu / 知到 (`zhihuishu.com`).
    Zhihuishu,
}

impl Platform {
    /// Chinese label used in user-visible messages.
    pub fn label(self) -> &'static str {
        match self {
            Self::Hust => "学在华科大",
            Self::Zhihuishu => "知到（智慧树）",
        }
    }
}

/// What the UI is allowed to know about the connected session.
///
/// Cookie values deliberately never cross this boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub platform: Platform,
    pub cookie_source: String,
    pub cookie_count: usize,
}

/// HUST SmartCourse session.
pub struct HustSession {
    pub client: SmartCourseClient,
    pub courses: Vec<CourseSummary>,
}

/// Zhihuishu session.
pub struct ZhsSession {
    pub client: ZhsClient,
    pub courses: Vec<ZhsCourse>,
}

/// Platform-specific payload of the active session.
pub enum SessionClient {
    Hust(HustSession),
    Zhihuishu(ZhsSession),
}

/// The active session, built by the login window.
pub struct Session {
    pub info: SessionInfo,
    pub client: SessionClient,
}

impl Session {
    pub fn platform(&self) -> Platform {
        self.info.platform
    }
}

#[derive(Default)]
pub struct AppState {
    session: RwLock<Option<Session>>,
    cancel: AtomicBool,
    busy: AtomicBool,
    /// A login page load is being validated (cookies + session check).
    login_checking: AtomicBool,
    /// The login window already produced a session; ignore later page loads.
    login_succeeded: AtomicBool,
    /// Platform of the login window that is currently open.
    login_platform: RwLock<Option<Platform>>,
    /// Temporary WebView2 profile used by the login window.
    login_dir: RwLock<Option<PathBuf>>,
}

impl AppState {
    pub fn set_session(&self, session: Session) {
        *self.write_session() = Some(session);
    }

    pub fn clear_session(&self) {
        *self.write_session() = None;
    }

    pub fn has_session(&self) -> bool {
        self.read_session().is_some()
    }

    /// Platform of the active session, when connected.
    pub fn platform(&self) -> Option<Platform> {
        self.read_session().as_ref().map(Session::platform)
    }

    pub fn info(&self) -> Option<SessionInfo> {
        self.read_session()
            .as_ref()
            .map(|session| session.info.clone())
    }

    /// HUST client; `None` when the active session is Zhihuishu.
    pub fn client(&self) -> Option<SmartCourseClient> {
        match self.read_session().as_ref()?.client {
            SessionClient::Hust(ref hust) => Some(hust.client.clone()),
            SessionClient::Zhihuishu(_) => None,
        }
    }

    /// Zhihuishu client; `None` when the active session is HUST.
    pub fn zhs_client(&self) -> Option<ZhsClient> {
        match self.read_session().as_ref()?.client {
            SessionClient::Hust(_) => None,
            SessionClient::Zhihuishu(ref zhs) => Some(zhs.client.clone()),
        }
    }

    /// Replace the HUST course list. No-op for a Zhihuishu session.
    pub fn set_courses(&self, courses: Vec<CourseSummary>) {
        if let Some(SessionClient::Hust(hust)) =
            self.write_session().as_mut().map(|s| &mut s.client)
        {
            hust.courses = courses;
        }
    }

    pub fn course(&self, id: &str) -> Option<CourseSummary> {
        let session = self.read_session();
        let Some(SessionClient::Hust(hust)) = session.as_ref().map(|s| &s.client) else {
            return None;
        };
        hust.courses
            .iter()
            .find(|course| course.course_id == id || course.class_id == id || course.name == id)
            .cloned()
    }

    /// Replace the Zhihuishu course list. No-op for a HUST session.
    pub fn set_zhs_courses(&self, courses: Vec<ZhsCourse>) {
        if let Some(SessionClient::Zhihuishu(zhs)) =
            self.write_session().as_mut().map(|s| &mut s.client)
        {
            zhs.courses = courses;
        }
    }

    /// Snapshot of the Zhihuishu course list.
    pub fn zhs_courses(&self) -> Vec<ZhsCourse> {
        let session = self.read_session();
        match session.as_ref().map(|s| &s.client) {
            Some(SessionClient::Zhihuishu(zhs)) => zhs.courses.clone(),
            _ => Vec::new(),
        }
    }

    /// Find a Zhihuishu course by id, recruit id, secret or exact name.
    pub fn zhs_course(&self, reference: &str) -> Option<ZhsCourse> {
        self.zhs_courses().into_iter().find(|course| {
            course.course_id.to_string() == reference
                || course.recruit_id.to_string() == reference
                || course.name == reference
                || course.secret.as_deref() == Some(reference)
        })
    }

    /// Insert or refresh one Zhihuishu course in the session list.
    pub fn upsert_zhs_course(&self, course: ZhsCourse) {
        if let Some(SessionClient::Zhihuishu(zhs)) =
            self.write_session().as_mut().map(|s| &mut s.client)
        {
            match zhs
                .courses
                .iter_mut()
                .find(|item| item.recruit_id == course.recruit_id)
            {
                Some(item) => *item = course,
                None => zhs.courses.push(course),
            }
        }
    }

    /// Mark a long-running crawl/report job as started.
    ///
    /// Only one job may run at a time; the returned guard clears the flag when
    /// the job finishes (including on error).
    pub fn begin_job(&self) -> Result<JobGuard<'_>, String> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("已有任务正在进行，请等待当前任务结束".to_string());
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(JobGuard { state: self })
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Register a new login attempt and its isolated WebView2 profile.
    pub fn start_login(&self, platform: Platform, data_dir: PathBuf) {
        self.login_succeeded.store(false, Ordering::SeqCst);
        self.login_checking.store(false, Ordering::SeqCst);
        *self.write_login_platform() = Some(platform);
        *self.write_login_dir() = Some(data_dir);
    }

    /// Platform of the login window that is currently being validated.
    pub fn login_platform(&self) -> Option<Platform> {
        *self
            .login_platform
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Try to claim the single login-validation slot. `None` means another
    /// page load is already being validated or the login already succeeded.
    pub fn begin_login_check(&self) -> Option<LoginCheckGuard<'_>> {
        if self.login_succeeded.load(Ordering::SeqCst) {
            return None;
        }
        if self.login_checking.swap(true, Ordering::SeqCst) {
            return None;
        }
        Some(LoginCheckGuard { state: self })
    }

    /// Returns `true` for the first successful validation only.
    pub fn mark_login_succeeded(&self) -> bool {
        !self.login_succeeded.swap(true, Ordering::SeqCst)
    }

    pub fn finish_login(&self) {
        self.login_checking.store(false, Ordering::SeqCst);
    }

    /// Take ownership of the login profile path so the caller can delete it.
    pub fn take_login_dir(&self) -> Option<PathBuf> {
        *self.write_login_platform() = None;
        self.write_login_dir().take()
    }

    fn read_session(&self) -> std::sync::RwLockReadGuard<'_, Option<Session>> {
        self.session
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_session(&self) -> std::sync::RwLockWriteGuard<'_, Option<Session>> {
        self.session
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_login_platform(&self) -> std::sync::RwLockWriteGuard<'_, Option<Platform>> {
        self.login_platform
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_login_dir(&self) -> std::sync::RwLockWriteGuard<'_, Option<PathBuf>> {
        self.login_dir
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

pub struct JobGuard<'a> {
    state: &'a AppState,
}

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        self.state.busy.store(false, Ordering::SeqCst);
    }
}

pub struct LoginCheckGuard<'a> {
    state: &'a AppState,
}

impl Drop for LoginCheckGuard<'_> {
    fn drop(&mut self) {
        self.state.login_checking.store(false, Ordering::SeqCst);
    }
}
