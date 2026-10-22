//! App-wide session state shared by the Tauri commands.

use hust_course_hack::{CourseSummary, SmartCourseClient};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

/// What the UI is allowed to know about the connected session.
///
/// Cookie values deliberately never cross this boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub cookie_source: String,
    pub cookie_count: usize,
}

pub struct Session {
    pub client: SmartCourseClient,
    pub info: SessionInfo,
    pub courses: Vec<CourseSummary>,
}

#[derive(Default)]
pub struct AppState {
    session: RwLock<Option<Session>>,
    cancel: AtomicBool,
    busy: AtomicBool,
    /// A login page load is being validated (cookies + course list).
    login_checking: AtomicBool,
    /// The login window already produced a session; ignore later page loads.
    login_succeeded: AtomicBool,
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

    pub fn info(&self) -> Option<SessionInfo> {
        self.read_session()
            .as_ref()
            .map(|session| session.info.clone())
    }

    pub fn client(&self) -> Option<SmartCourseClient> {
        self.read_session()
            .as_ref()
            .map(|session| session.client.clone())
    }

    pub fn set_courses(&self, courses: Vec<CourseSummary>) {
        if let Some(session) = self.write_session().as_mut() {
            session.courses = courses;
        }
    }

    pub fn course(&self, id: &str) -> Option<CourseSummary> {
        self.read_session().as_ref().and_then(|session| {
            session
                .courses
                .iter()
                .find(|course| course.course_id == id || course.class_id == id || course.name == id)
                .cloned()
        })
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
    pub fn start_login(&self, data_dir: PathBuf) {
        self.login_succeeded.store(false, Ordering::SeqCst);
        self.login_checking.store(false, Ordering::SeqCst);
        *self.write_login_dir() = Some(data_dir);
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
