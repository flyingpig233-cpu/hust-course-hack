//! Official login window.
//!
//! The window loads the platform's `/passport` entry (the HUST unified
//! authentication page), waits for the redirect back to
//! `smartcourse.hust.edu.cn`, reads the webview's cookies (including HttpOnly)
//! and verifies them against the course-list API before adopting the session.
//!
//! The login window uses its own temporary WebView2 data directory so no
//! platform session is left in the app's main webview profile. The directory is
//! deleted when the window is destroyed.

use crate::state::{AppState, Session, SessionInfo};
use anyhow::{Context, Result, anyhow};
use hust_course_hack::{
    DEFAULT_BASE_URL, SmartCourseClient,
    cookie::{CookieRecord, jar_from_records},
};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    webview::PageLoadEvent,
};
use url::Url;

pub const LOGIN_LABEL: &str = "login";
const LOGIN_ENTRY: &str = "https://smartcourse.hust.edu.cn/passport";
const PLATFORM_HOST: &str = "smartcourse.hust.edu.cn";
const LOGIN_DIR_PREFIX: &str = "hust-course-hack-login-";

/// Open (or focus) the login window.
pub fn open_login_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        let _ = window.set_focus();
        return Ok(());
    }

    let data_dir = login_data_dir();
    let state = app.state::<AppState>();
    state.start_login(data_dir.clone());
    log::info!("opening login window");

    let entry = Url::parse(LOGIN_ENTRY).map_err(|error| format!("登录地址无效：{error}"))?;
    let builder = WebviewWindowBuilder::new(app, LOGIN_LABEL, WebviewUrl::External(entry))
        .title("登录 HUST SmartCourse")
        .inner_size(1000.0, 800.0)
        .min_inner_size(860.0, 620.0)
        .center()
        .data_directory(data_dir.clone())
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let url = payload.url();
            log::info!(
                "login page: {}://{}{}",
                url.scheme(),
                url.host_str().unwrap_or(""),
                url.path()
            );
            if !is_platform_page(url) {
                return;
            }
            let app = window.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = try_finish_login(app).await {
                    log::debug!("login validation skipped: {error:#}");
                }
            });
        });

    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            state.finish_login();
            if let Some(dir) = state.take_login_dir() {
                cleanup_login_dir(dir);
            }
            return Err(format!("打开登录窗口失败：{error}"));
        }
    };

    let app_for_close = app.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Destroyed) {
            return;
        }
        let state = app_for_close.state::<AppState>();
        state.finish_login();
        if let Some(dir) = state.take_login_dir() {
            cleanup_login_dir(dir);
        }
        log::info!("login window destroyed");
        if !state.has_session() {
            let _ = app_for_close.emit("login-closed", ());
        }
    });

    let _ = window.set_focus();
    Ok(())
}

/// A page on the platform that can carry a usable session. CAS pages run on
/// `pass.hust.edu.cn`; the `/sso/` callback is skipped because it immediately
/// redirects to the portal.
fn is_platform_page(url: &Url) -> bool {
    url.host_str() == Some(PLATFORM_HOST)
        && !url.path().starts_with("/passport")
        && !url.path().contains("/sso/")
}

async fn try_finish_login(app: AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    if state.has_session() {
        return Ok(());
    }
    let Some(_check) = state.begin_login_check() else {
        return Ok(());
    };

    let base = Url::parse(DEFAULT_BASE_URL)?;
    let app_for_cookies = app.clone();
    let cookies = tauri::async_runtime::spawn_blocking(move || {
        let window = app_for_cookies
            .get_webview_window(LOGIN_LABEL)
            .context("login window is already closed")?;
        window
            .cookies_for_url(base)
            .map_err(|error| anyhow!("{error}"))
    })
    .await
    .map_err(|error| anyhow!("cookie task failed: {error}"))??;

    if cookies.is_empty() {
        return Ok(());
    }

    let records = cookies
        .iter()
        .map(|cookie| CookieRecord {
            domain: cookie.domain().unwrap_or(PLATFORM_HOST).to_string(),
            include_subdomains: cookie
                .domain()
                .is_some_and(|domain| domain.starts_with('.')),
            path: cookie.path().unwrap_or("/").to_string(),
            secure: cookie.secure().unwrap_or(false),
            expires: cookie
                .expires_datetime()
                .map(|time| time.unix_timestamp())
                .unwrap_or(0),
            name: cookie.name().to_string(),
            value: cookie.value().to_string(),
        })
        .collect::<Vec<_>>();

    let jar = jar_from_records(records)?;
    let client = SmartCourseClient::with_cookie_jar(jar)?;
    let (courses, final_url) = client.list_courses_with_url().await?;

    // The course-list endpoint redirects to the public landing page when there
    // is no session; staying on the API path means the request was authorized
    // even if the account has no current courses.
    let authenticated = !courses.is_empty() || final_url.path().contains("getStudyCourse");
    if !authenticated {
        return Ok(());
    }

    if !state.mark_login_succeeded() {
        return Ok(());
    }

    let info = SessionInfo {
        cookie_source: "HUST 统一身份认证".to_string(),
        cookie_count: cookies.len(),
    };
    log::info!(
        "login session captured: {} cookies, {} courses",
        cookies.len(),
        courses.len()
    );
    state.set_session(Session {
        client,
        info: info.clone(),
        courses,
    });
    let _ = app.emit("session-changed", info);

    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        // The temporary profile is deleted on close; clearing browsing data is
        // a second line of defence if WebView2 still holds the files open.
        let _ = window.clear_all_browsing_data();
        let _ = window.close();
    }
    Ok(())
}

fn login_data_dir() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("{LOGIN_DIR_PREFIX}{}-{stamp}", std::process::id()))
}

/// Delete a login profile after its webview is gone. WebView2 can keep file
/// handles for a moment, so retry briefly.
fn cleanup_login_dir(path: PathBuf) {
    std::thread::spawn(move || {
        for _ in 0..20 {
            if std::fs::remove_dir_all(&path).is_ok() || !path.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    });
}

/// Remove login profiles left behind by a previous crash. Profiles younger
/// than an hour are kept in case another instance is still using them.
pub fn cleanup_stale_login_dirs() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(LOGIN_DIR_PREFIX)
        {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age.as_secs() > 3600);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
