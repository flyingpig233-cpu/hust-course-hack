//! Shared server state: the optional access token, the single platform
//! session (pasted cookies), and the current/last job with its progress
//! history.
//!
//! Mirrors the Tauri shell's `AppState`: at most one platform session and one
//! running job, cookie values never cross to the client.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use hust_course_hack::{CourseSummary, SmartCourseClient};
use serde::Serialize;
use serde_json::{Value, json};

/// What the browser is allowed to know about the connected session.
///
/// Cookie values deliberately never cross this boundary, matching the GUI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub cookie_source: String,
    pub cookie_count: usize,
}

pub struct SessionData {
    /// Random per-login token the browser sends as `X-Session-Token`.
    pub token: String,
    pub info: SessionInfo,
    pub client: SmartCourseClient,
    pub courses: Vec<CourseSummary>,
}

/// Progress history and final outcome of the current or last job.
#[derive(Default)]
pub struct JobHistory {
    pub running: bool,
    pub done: bool,
    pub error: Option<String>,
    pub result: Option<Value>,
    pub events: Vec<Value>,
}

pub struct JobRuntime {
    pub cancel: Arc<AtomicBool>,
    pub history: Arc<Mutex<JobHistory>>,
}

#[derive(Default)]
pub struct JobSlot {
    runtime: Mutex<Option<JobRuntime>>,
}

impl JobSlot {
    /// Start the single allowed job; returns its cancel flag and event sink.
    pub fn begin(&self) -> Result<(Arc<AtomicBool>, Arc<Mutex<JobHistory>>), String> {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if runtime.is_some() {
            return Err("已有任务正在进行，请等待当前任务结束".to_string());
        }
        let history = Arc::new(Mutex::new(JobHistory {
            running: true,
            ..JobHistory::default()
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        *runtime = Some(JobRuntime {
            cancel: cancel.clone(),
            history: history.clone(),
        });
        Ok((cancel, history))
    }

    pub fn cancel(&self) {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(job) = runtime.as_ref() {
            job.cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Poll snapshot: the job state plus events after `cursor`.
    pub fn snapshot(&self, cursor: usize) -> Value {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(job) = runtime.as_ref() else {
            return json!({
                "running": false,
                "done": true,
                "error": Value::Null,
                "result": Value::Null,
                "events": [],
            });
        };
        let history = job
            .history
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let start = cursor.min(history.events.len());
        json!({
            "running": history.running,
            "done": history.done,
            "error": history.error,
            "result": history.result,
            "events": history.events[start..],
        })
    }
}

/// Everything the request handlers need.
pub struct Shared {
    /// Shared secret checked on every API request except `/api/config`.
    pub access_token: Option<String>,
    /// Directory holding the built web UI (`index.html` + `assets/`).
    pub web_dir: PathBuf,
    /// Public path prefix the reverse proxy strips before forwarding, e.g.
    /// `/course-hack` (empty when served from the site root).
    pub url_prefix: String,
    pub session: RwLock<Option<SessionData>>,
    pub jobs: JobSlot,
    /// The single live unified-auth login attempt, if any.
    pub login: crate::login::LoginRegistry,
}

impl Shared {
    pub fn has_session(&self) -> bool {
        self.session
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }
}

/// Append one progress event to the job history.
pub fn push_event(history: &Mutex<JobHistory>, event: Value) {
    let mut history = history
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    history.events.push(event);
}

/// Mark the job finished and store its result or error.
pub fn finish_job(history: &Mutex<JobHistory>, result: Result<Value, String>) {
    let mut history = history
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    history.running = false;
    history.done = true;
    match result {
        Ok(value) => history.result = Some(value),
        Err(error) => history.error = Some(error),
    }
}
