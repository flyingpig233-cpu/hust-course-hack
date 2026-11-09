//! App-wide session state shared by the Tauri commands.
//!
//! Three platforms are supported: HUST SmartCourse, Zhihuishu (智慧树 / 知到)
//! and Ulearning (优学院 / U学). Only one platform session is active at a time;
//! the platform-neutral helpers (`info`, `has_session`) stay available so the
//! existing commands keep working unchanged.

use hust_course_hack::{
    CourseSummary, SmartCourseClient,
    cookie::{CookieRecord, jar_from_records},
    ulearning::{UlCourse, UlearningClient},
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
    /// Ulearning / 优学院 (`ulearning.cn`).
    Ulearning,
}

impl Platform {
    /// Chinese label used in user-visible messages.
    pub fn label(self) -> &'static str {
        match self {
            Self::Hust => "学在华科大",
            Self::Zhihuishu => "知到（智慧树）",
            Self::Ulearning => "优学院（U学）",
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
    /// Cookies captured by the login window. Kept in Rust memory only and used
    /// to inject the session into the isolated exam WebView2 profile; cookie
    /// values never cross the IPC boundary.
    pub cookies: Vec<CookieRecord>,
}

/// Ulearning session.
pub struct UlSession {
    pub client: UlearningClient,
    pub courses: Vec<UlCourse>,
}

/// Platform-specific payload of the active session.
pub enum SessionClient {
    Hust(HustSession),
    Zhihuishu(ZhsSession),
    Ulearning(UlSession),
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
    /// The exam cookie warm-up already ran in this login attempt (prevents
    /// navigation loops on repeated page-load validations).
    zhs_exam_warmup: AtomicBool,
    /// The login flow verified that the exam list renders authenticated content
    /// (real homework names/actions, stable URL). Exam/redo windows are only
    /// opened when this is true.
    zhs_exam_sso_ready: AtomicBool,
    /// The login window's WebView2 profile, kept after a successful Zhihuishu
    /// login/SSO so exam windows can reuse the same profile (the CAS/SSO state
    /// cannot be reproduced by injecting cookies alone).
    zhs_webview_dir: RwLock<Option<PathBuf>>,
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

    /// HUST client; `None` when the active session is another platform.
    pub fn client(&self) -> Option<SmartCourseClient> {
        match self.read_session().as_ref()?.client {
            SessionClient::Hust(ref hust) => Some(hust.client.clone()),
            SessionClient::Zhihuishu(_) | SessionClient::Ulearning(_) => None,
        }
    }

    /// Zhihuishu client; `None` when the active session is another platform.
    pub fn zhs_client(&self) -> Option<ZhsClient> {
        match self.read_session().as_ref()?.client {
            SessionClient::Hust(_) | SessionClient::Ulearning(_) => None,
            SessionClient::Zhihuishu(ref zhs) => Some(zhs.client.clone()),
        }
    }

    /// Cookies captured at Zhihuishu login, for the isolated exam webview.
    ///
    /// The values stay inside the process; only the exam window's WebView2
    /// cookie manager receives them.
    pub fn zhs_cookies(&self) -> Vec<CookieRecord> {
        let session = self.read_session();
        match session.as_ref().map(|s| &s.client) {
            Some(SessionClient::Zhihuishu(zhs)) => zhs.cookies.clone(),
            _ => Vec::new(),
        }
    }

    /// Claim the one-time exam cookie warm-up of the current login attempt.
    ///
    /// Returns `false` when it already ran (so a repeated page load cannot
    /// trigger another navigation loop).
    pub fn begin_zhs_exam_warmup(&self) -> bool {
        !self.zhs_exam_warmup.swap(true, Ordering::SeqCst)
    }

    /// Whether the login flow completed the exam-engine SSO (exam list renders
    /// authenticated content, not just the SPA shell/cookies).
    pub fn zhs_exam_sso_ready(&self) -> bool {
        self.zhs_exam_sso_ready.load(Ordering::SeqCst)
    }

    pub fn set_zhs_exam_sso_ready(&self, ready: bool) {
        self.zhs_exam_sso_ready.store(ready, Ordering::SeqCst);
    }

    /// Persist the current login window's WebView2 profile for exam windows.
    ///
    /// The login profile is moved out of `login_dir` so the login-window
    /// destroy handler no longer deletes it. Returns the previously stored
    /// profile (the caller deletes it).
    pub fn adopt_zhs_webview_dir(&self) -> Option<PathBuf> {
        let dir = self.write_login_dir().take();
        let mut stored = self.write_zhs_webview_dir();
        match dir {
            Some(dir) => stored.replace(dir),
            None => None,
        }
    }

    pub fn zhs_webview_dir(&self) -> Option<PathBuf> {
        self.read_zhs_webview_dir().clone()
    }

    pub fn take_zhs_webview_dir(&self) -> Option<PathBuf> {
        self.write_zhs_webview_dir().take()
    }

    /// Merge cookies captured from an exam-host page load into the session and
    /// rebuild the Zhihuishu client so the exam APIs receive the host cookies.
    ///
    /// Host-only cookies on `*.zhihuishu.com` are promoted to `.zhihuishu.com`
    /// so the `studentexam-api` / `taurusexam-api` hosts get them as well.
    pub fn merge_zhs_cookies(&self, records: Vec<CookieRecord>) {
        if records.is_empty() {
            return;
        }
        // Readiness is only set by the login-phase authenticated-content check;
        // cookie presence alone is a false positive (the SPA shell can render
        // without a valid engine session).
        let mut session = self.write_session();
        let Some(SessionClient::Zhihuishu(zhs)) = session.as_mut().map(|s| &mut s.client) else {
            return;
        };
        for record in records {
            let record_key = cookie_key(&record);
            match zhs
                .cookies
                .iter()
                .position(|existing| cookie_key(existing) == record_key)
            {
                Some(index) => zhs.cookies[index] = record,
                None => zhs.cookies.push(record),
            }
        }
        if let Ok(jar) = jar_from_records(zhs.cookies.clone())
            && let Ok(client) = ZhsClient::with_cookie_jar(jar)
        {
            zhs.client = client;
        }
    }

    /// Ulearning client; `None` when the active session is another platform.
    pub fn ul_client(&self) -> Option<UlearningClient> {
        match self.read_session().as_ref()?.client {
            SessionClient::Hust(_) | SessionClient::Zhihuishu(_) => None,
            SessionClient::Ulearning(ref ul) => Some(ul.client.clone()),
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

    /// Replace the Ulearning course list. No-op for other platforms.
    pub fn set_ul_courses(&self, courses: Vec<UlCourse>) {
        if let Some(SessionClient::Ulearning(ul)) =
            self.write_session().as_mut().map(|s| &mut s.client)
        {
            ul.courses = courses;
        }
    }

    /// Snapshot of the Ulearning course list.
    pub fn ul_courses(&self) -> Vec<UlCourse> {
        let session = self.read_session();
        match session.as_ref().map(|s| &s.client) {
            Some(SessionClient::Ulearning(ul)) => ul.courses.clone(),
            _ => Vec::new(),
        }
    }

    /// Find an Ulearning course by textbook id, `ocId`, class id or name.
    pub fn ul_course(&self, reference: &str) -> Option<UlCourse> {
        self.ul_courses().into_iter().find(|course| {
            course.textbook_id.to_string() == reference
                || course.oc_id.is_some_and(|id| id.to_string() == reference)
                || course
                    .class_id
                    .is_some_and(|id| id.to_string() == reference)
                || course.name == reference
        })
    }

    /// Insert or refresh one Ulearning course in the session list.
    pub fn upsert_ul_course(&self, course: UlCourse) {
        if let Some(SessionClient::Ulearning(ul)) =
            self.write_session().as_mut().map(|s| &mut s.client)
        {
            match ul
                .courses
                .iter_mut()
                .find(|item| item.textbook_id == course.textbook_id)
            {
                Some(item) => *item = course,
                None => ul.courses.push(course),
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
        self.zhs_exam_warmup.store(false, Ordering::SeqCst);
        self.zhs_exam_sso_ready.store(false, Ordering::SeqCst);
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

    fn read_zhs_webview_dir(&self) -> std::sync::RwLockReadGuard<'_, Option<PathBuf>> {
        self.zhs_webview_dir
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_zhs_webview_dir(&self) -> std::sync::RwLockWriteGuard<'_, Option<PathBuf>> {
        self.zhs_webview_dir
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Dedupe key for captured cookies: name + domain (dot-insensitive) + path.
/// The same name on different hosts is a different cookie (each exam engine
/// sets its own `JSESSIONID`).
fn cookie_key(record: &CookieRecord) -> (String, String, String) {
    (
        record.name.clone(),
        record
            .domain
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase(),
        record.path.clone(),
    )
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
