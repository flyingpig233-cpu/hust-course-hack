//! Official login window.
//!
//! The window loads a platform entry page and waits for the redirect back to
//! the platform, then reads the webview's cookies (including HttpOnly) and
//! verifies them before adopting the session:
//!
//! * HUST — `smartcourse.hust.edu.cn/passport` → HUST unified authentication
//!   (`pass.hust.edu.cn/cas/login`) → course-list API verification.
//! * Zhihuishu (知到) — `onlineweb.zhihuishu.com/onlinestuh5` → Zhihuishu
//!   passport → `getLoginUserInfo` verification.
//! * Ulearning (优学院 / U学) — `umooc.ulearning.cn/pc.html#/login` → the
//!   Ulearning student portal → `GET /user` verification.
//!
//! The login window uses its own temporary WebView2 data directory so no
//! platform session is left in the app's main webview profile. The directory is
//! deleted when the window is destroyed.

use crate::state::{
    AppState, HustSession, Platform, Session, SessionClient, SessionInfo, UlSession, ZhsSession,
};
use anyhow::{Context, Result, anyhow};
use hust_course_hack::{
    SmartCourseClient,
    cookie::{CookieRecord, jar_from_records},
    ulearning::UlearningClient,
    zhihuishu::ZhsClient,
};
use std::{
    collections::HashSet,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    webview::PageLoadEvent,
};
use url::Url;

pub const LOGIN_LABEL: &str = "login";
const LOGIN_DIR_PREFIX: &str = "hust-course-hack-login-";

const HUST_ENTRY: &str = "https://smartcourse.hust.edu.cn/passport";
const HUST_HOST: &str = "smartcourse.hust.edu.cn";

const ZHS_ENTRY: &str = "https://onlineweb.zhihuishu.com/onlinestuh5";
const ZHS_HOST_SUFFIX: &str = "zhihuishu.com";
/// Cookie URLs read after a Zhihuishu login. Domain cookies are returned for
/// every matching host, so this list covers the API hosts used by the client.
const ZHS_COOKIE_URLS: [&str; 4] = [
    "https://www.zhihuishu.com/",
    "https://onlineweb.zhihuishu.com/",
    "https://online.zhihuishu.com/",
    "https://studyvideoh5.zhihuishu.com/",
];

/// Exam-list page opened once after login so the exam H5 host sets its own
/// cookies (`JSESSIONID`/`SERVERID`/`acw_tc`). The bare list route is enough;
/// it does not start an attempt.
const ZHS_EXAM_WARMUP_URL: &str =
    "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList";
/// URLs read after the exam warm-up page load. Host cookies override the domain
/// cookies captured at login (see [`merge_cookie_groups`]).
const ZHS_EXAM_COOKIE_URLS: [&str; 5] = [
    "https://onlineexamh5new.zhihuishu.com/",
    "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html",
    "https://studentexam-api.zhihuishu.com/",
    "https://taurusexam-api.zhihuishu.com/",
    "https://onlineweb.zhihuishu.com/onlinestuh5",
];

const UL_ENTRY: &str = "https://umooc.ulearning.cn/pc.html#/login";
const UL_HOST_SUFFIX: &str = "ulearning.cn";
/// Cookie URLs read after an Ulearning login. The session token is the
/// `AUTHORIZATION` cookie on the `.ulearning.cn` domain; the API hosts are
/// listed so path-scoped copies are picked up as well.
const UL_COOKIE_URLS: [&str; 6] = [
    "https://umooc.ulearning.cn/",
    "https://www.ulearning.cn/",
    "https://ua.ulearning.cn/",
    "https://api.ulearning.cn/",
    "https://courseapi.ulearning.cn/",
    "https://courseweb.ulearning.cn/",
];

struct LoginConfig {
    entry: &'static str,
    title: &'static str,
    cookie_urls: &'static [&'static str],
}

fn login_config(platform: Platform) -> LoginConfig {
    match platform {
        Platform::Hust => LoginConfig {
            entry: HUST_ENTRY,
            title: "登录 HUST SmartCourse",
            cookie_urls: &["https://smartcourse.hust.edu.cn/"],
        },
        Platform::Zhihuishu => LoginConfig {
            entry: ZHS_ENTRY,
            title: "登录 知到（智慧树）",
            cookie_urls: &ZHS_COOKIE_URLS,
        },
        Platform::Ulearning => LoginConfig {
            entry: UL_ENTRY,
            title: "登录 优学院（U学）",
            cookie_urls: &UL_COOKIE_URLS,
        },
    }
}

/// Open (or focus) the login window for `platform`.
pub fn open_login_window(app: &AppHandle, platform: Platform) -> Result<(), String> {
    let state = app.state::<AppState>();
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        if state.login_platform() == Some(platform) {
            let _ = window.set_focus();
            return Ok(());
        }
        // A login window for the other platform is still open. Close it and ask
        // the caller to retry once WebView2 has released it.
        let other = state
            .login_platform()
            .map(|open| open.label())
            .unwrap_or("其他平台");
        let _ = window.close();
        return Err(format!(
            "已关闭{other}的登录窗口，请再次点击连接{}",
            platform.label()
        ));
    }

    let config = login_config(platform);
    let data_dir = login_data_dir();
    state.start_login(platform, data_dir.clone());
    log::info!("opening {} login window", platform.label());

    let entry = Url::parse(config.entry).map_err(|error| format!("登录地址无效：{error}"))?;
    let builder = WebviewWindowBuilder::new(app, LOGIN_LABEL, WebviewUrl::External(entry))
        .title(config.title)
        .inner_size(1000.0, 800.0)
        .min_inner_size(860.0, 620.0)
        .center()
        .data_directory(data_dir.clone())
        .on_page_load(move |window, payload| {
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
            if !is_platform_page(platform, url) {
                return;
            }
            let app = window.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = try_finish_login(app, platform).await {
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

/// A page on the platform that can carry a usable session.
///
/// HUST: CAS pages run on `pass.hust.edu.cn`; the `/sso/` callback is skipped
/// because it immediately redirects to the portal.
///
/// Zhihuishu: the passport host and login/register pages are skipped; the
/// student portal and study pages are accepted.
///
/// Ulearning: the login SPA lives at `umooc.ulearning.cn/pc.html#/login`; the
/// hash route is skipped so only post-login pages trigger validation.
fn is_platform_page(platform: Platform, url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    match platform {
        Platform::Hust => {
            host == HUST_HOST
                && !url.path().starts_with("/passport")
                && !url.path().contains("/sso/")
        }
        Platform::Zhihuishu => {
            if !host.ends_with(ZHS_HOST_SUFFIX) {
                return false;
            }
            if host.starts_with("passport.") || host.starts_with("pass.") {
                return false;
            }
            let path = url.path().to_ascii_lowercase();
            !(path.contains("login")
                || path.contains("passport")
                || path.contains("register")
                || path.contains("protocol"))
        }
        Platform::Ulearning => {
            if !host.ends_with(UL_HOST_SUFFIX) {
                return false;
            }
            if host.starts_with("passport.") || host.starts_with("utest.") {
                return false;
            }
            let path = url.path().to_ascii_lowercase();
            let fragment = url.fragment().unwrap_or("").to_ascii_lowercase();
            !(path.contains("login")
                || path.contains("passport")
                || path.contains("register")
                || fragment.contains("login")
                || fragment.contains("passport")
                || fragment.contains("register"))
        }
    }
}

async fn try_finish_login(app: AppHandle, platform: Platform) -> Result<()> {
    let state = app.state::<AppState>();
    if state.platform() == Some(platform) {
        return Ok(());
    }
    let Some(_check) = state.begin_login_check() else {
        return Ok(());
    };

    let config = login_config(platform);
    let urls = config
        .cookie_urls
        .iter()
        .map(|url| Url::parse(url).context("invalid login cookie URL"))
        .collect::<Result<Vec<_>>>()?;
    let app_for_cookies = app.clone();
    let cookies =
        tauri::async_runtime::spawn_blocking(move || read_login_cookies(&app_for_cookies, &urls))
            .await
            .map_err(|error| anyhow!("cookie task failed: {error}"))??;

    if cookies.is_empty() {
        return Ok(());
    }

    match platform {
        Platform::Hust => finish_hust_login(&app, &state, cookies).await,
        Platform::Zhihuishu => finish_zhs_login(&app, &state, cookies).await,
        Platform::Ulearning => finish_ul_login(&app, &state, cookies).await,
    }
}

/// Read the webview's cookies (including HttpOnly) without crossing the IPC
/// boundary. Must run on a blocking worker: `cookies_for_url` deadlocks on the
/// main thread on Windows.
fn read_login_cookies(app: &AppHandle, urls: &[Url]) -> Result<Vec<CookieRecord>> {
    let window = app
        .get_webview_window(LOGIN_LABEL)
        .context("login window is already closed")?;
    read_cookies_from_window(&window, urls)
}

/// Cookies of one webview for every URL, deduplicated by name+value.
fn read_cookies_from_window(
    window: &tauri::WebviewWindow,
    urls: &[Url],
) -> Result<Vec<CookieRecord>> {
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for url in urls {
        let cookies = window
            .cookies_for_url(url.clone())
            .map_err(|error| anyhow!("{error}"))?;
        for cookie in cookies {
            let name = cookie.name().to_string();
            let value = cookie.value().to_string();
            // The same cookie is returned for every matching host URL.
            if !seen.insert((name.clone(), value.clone())) {
                continue;
            }
            records.push(CookieRecord {
                domain: cookie.domain().unwrap_or_default().to_string(),
                include_subdomains: cookie
                    .domain()
                    .is_some_and(|domain| domain.starts_with('.')),
                path: cookie.path().unwrap_or("/").to_string(),
                secure: cookie.secure().unwrap_or(false),
                expires: cookie
                    .expires_datetime()
                    .map(|time| time.unix_timestamp())
                    .unwrap_or(0),
                name,
                value,
            });
        }
    }
    Ok(records)
}

/// Merge cookie groups, deduping by name+domain (+path).
///
/// The same name can legitimately exist on several hosts (the exam engines each
/// set their own `JSESSIONID`), so a name-only dedupe would drop a live engine
/// session. A later capture replaces an earlier one with the same name and
/// domain; host cookies therefore override a platform-wide cookie only for that
/// host, exactly like a browser cookie store.
fn merge_cookie_groups(groups: impl IntoIterator<Item = Vec<CookieRecord>>) -> Vec<CookieRecord> {
    fn key(record: &CookieRecord) -> (String, String, String) {
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
    let mut merged: Vec<CookieRecord> = Vec::new();
    for group in groups {
        for record in group {
            let record_key = key(&record);
            match merged.iter().position(|item| key(item) == record_key) {
                Some(index) => merged[index] = record,
                None => merged.push(record),
            }
        }
    }
    merged
}

/// Merge the login captures into the session list (domains preserved so the
/// request jar reaches every exam host).
fn zhs_session_cookies(records: Vec<CookieRecord>) -> Vec<CookieRecord> {
    merge_cookie_groups([records])
}

/// Build a Zhihuishu client whose jar preserves the captured cookie domains so
/// requests to `studentexam-api` / `taurusexam-api` carry their cookies.
fn zhs_client_from_records(records: &[CookieRecord]) -> Result<ZhsClient> {
    let jar = jar_from_records(records.to_vec())?;
    ZhsClient::with_cookie_jar(jar)
}

async fn finish_hust_login(
    app: &AppHandle,
    state: &AppState,
    cookies: Vec<CookieRecord>,
) -> Result<()> {
    let cookie_count = cookies.len();
    let jar = jar_from_records(cookies)?;
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
        platform: Platform::Hust,
        cookie_source: "HUST 统一身份认证".to_string(),
        cookie_count,
    };
    log::info!(
        "login session captured: {cookie_count} cookies, {} courses",
        courses.len()
    );
    state.set_session(Session {
        info: info.clone(),
        client: SessionClient::Hust(HustSession { client, courses }),
    });
    let _ = app.emit("session-changed", info);
    close_login_window(app);
    Ok(())
}

/// Navigate the login webview to the exam-list page and capture the host
/// cookies set by the exam H5 / API hosts. Returns the merged cookie list; on
/// failure returns the base cookies so the plain session can still be adopted.
async fn warm_up_exam_cookies(app: &AppHandle, base: Vec<CookieRecord>) -> Vec<CookieRecord> {
    let Some(window) = app.get_webview_window(LOGIN_LABEL) else {
        return base;
    };
    let Ok(url) = Url::parse(ZHS_EXAM_WARMUP_URL) else {
        log::warn!("zhihuishu exam warm-up: invalid URL");
        return base;
    };
    if let Err(error) = window.navigate(url) {
        log::warn!("zhihuishu exam warm-up navigation failed: {error}");
        return base;
    }
    log::info!("zhihuishu exam warm-up: visiting the exam list page");
    let app_for_capture = app.clone();
    let base_for_capture = base.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        capture_exam_cookies(&app_for_capture, base_for_capture)
    })
    .await
    {
        Ok(merged) => merged,
        Err(error) => {
            log::warn!("zhihuishu exam warm-up task failed: {error}");
            base
        }
    }
}

/// Blocking capture loop: read exam-host cookies until the API hosts got their
/// cookies (or a timeout). Must run on a blocking worker.
fn capture_exam_cookies(app: &AppHandle, base: Vec<CookieRecord>) -> Vec<CookieRecord> {
    let start = std::time::Instant::now();
    let base_urls = ZHS_COOKIE_URLS
        .iter()
        .filter_map(|raw| Url::parse(raw).ok())
        .collect::<Vec<_>>();
    let exam_urls = ZHS_EXAM_COOKIE_URLS
        .iter()
        .filter_map(|raw| Url::parse(raw).ok())
        .collect::<Vec<_>>();
    let mut best = zhs_session_cookies(base);
    loop {
        let Some(window) = app.get_webview_window(LOGIN_LABEL) else {
            return best;
        };
        let base_groups = read_cookies_from_window(&window, &base_urls)
            .map(|records| vec![records])
            .unwrap_or_default();
        let mut live_exam_urls = exam_urls.clone();
        if let Ok(current) = window.url() {
            live_exam_urls.insert(0, current);
        }
        let exam_groups = read_cookies_from_window(&window, &live_exam_urls)
            .map(|records| vec![records])
            .unwrap_or_default();
        let exam_host_cookies = exam_groups.iter().flatten().count();
        let merged = merge_cookie_groups(
            base_groups
                .into_iter()
                .chain(exam_groups)
                .collect::<Vec<_>>(),
        );
        best = zhs_session_cookies(merged);
        let elapsed = start.elapsed();
        // Give the page JS time to call the exam API hosts after the H5 host
        // set its cookies; stop once we saw host cookies for a while or hit
        // the timeout.
        if (exam_host_cookies > 0 && elapsed >= Duration::from_secs(6))
            || elapsed >= Duration::from_secs(20)
        {
            log::info!(
                "zhihuishu exam warm-up: captured {} cookies ({} exam-host cookies)",
                best.len(),
                exam_host_cookies
            );
            return best;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

async fn finish_zhs_login(
    app: &AppHandle,
    state: &AppState,
    cookies: Vec<CookieRecord>,
) -> Result<()> {
    // `CASLOGC` is written by the Zhihuishu login handler and carries the
    // user id. Without it the page load is just an intermediate login step.
    if !cookies.iter().any(|cookie| cookie.name == "CASLOGC") {
        return Ok(());
    }

    let base_cookies = zhs_session_cookies(cookies.clone());
    let header = base_cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; ");
    let mut client = ZhsClient::from_cookie_header(&header)?;
    let mut user = client
        .login_user()
        .await
        .context("getLoginUserInfo 校验失败；知到会话可能未建立或加密常量已更新")?;

    if user.is_teacher {
        return Err(anyhow!("知到教师账号不支持秒刷，请使用学生账号登录知到"));
    }

    // Exam engines (`studentexam-api` / `taurusexam-api`) need the host cookies
    // that are only set after an authenticated visit to the exam H5 page. Visit
    // it once per login attempt, merge the captured cookies, rebuild the client
    // jar (domain cookies reach every zhihuishu host) and re-validate.
    let mut session_cookies = base_cookies.clone();
    if state.begin_zhs_exam_warmup() {
        session_cookies = warm_up_exam_cookies(app, cookies.clone()).await;
    } else {
        log::debug!("zhihuishu exam warm-up already ran in this login attempt");
    }

    // Rebuild the client from the merged captures: `jar_from_records` preserves
    // cookie domains, so `studentexam-api` / `taurusexam-api` requests carry
    // their host cookies. Re-validate before adopting the merged session.
    match zhs_client_from_records(&session_cookies) {
        Ok(warm_client) => match warm_client.login_user().await {
            Ok(warm_user) => {
                log::info!(
                    "zhihuishu exam warm-up merged: {} cookies",
                    session_cookies.len()
                );
                client = warm_client;
                user = warm_user;
            }
            Err(error) => {
                log::warn!(
                    "zhihuishu merged-cookie re-validation failed ({error:#}); keeping the plain session"
                );
                session_cookies = base_cookies;
            }
        },
        Err(error) => {
            log::warn!(
                "zhihuishu merged-cookie client build failed ({error:#}); keeping the plain session"
            );
            session_cookies = base_cookies;
        }
    }

    // The shared-course list endpoint is best effort; a failure must not block
    // the session. The UI offers the study-page URL fallback in that case.
    let courses = match client.list_courses().await {
        Ok(courses) => courses,
        Err(error) => {
            log::warn!("zhihuishu course list unavailable after login: {error:#}");
            Vec::new()
        }
    };

    if !state.mark_login_succeeded() {
        return Ok(());
    }

    let real_name = user.real_name.trim();
    let info = SessionInfo {
        platform: Platform::Zhihuishu,
        cookie_source: if real_name.is_empty() {
            "知到网页登录".to_string()
        } else {
            format!("知到网页登录（{real_name}）")
        },
        cookie_count: session_cookies.len(),
    };
    log::info!(
        "zhihuishu session captured: {} cookies, {} courses",
        session_cookies.len(),
        courses.len()
    );
    state.set_session(Session {
        info: info.clone(),
        client: SessionClient::Zhihuishu(ZhsSession {
            client,
            courses,
            cookies: session_cookies,
        }),
    });
    let _ = app.emit("session-changed", info);
    close_login_window(app);
    Ok(())
}
async fn finish_ul_login(
    app: &AppHandle,
    state: &AppState,
    cookies: Vec<CookieRecord>,
) -> Result<()> {
    // The session token is the `AUTHORIZATION` cookie; other cookies on the
    // domain are only supporting data. Without it the page load is just an
    // intermediate login step.
    if !cookies
        .iter()
        .any(|cookie| cookie.name == hust_course_hack::ulearning::AUTH_COOKIE)
    {
        return Ok(());
    }

    let header = cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; ");
    let client = UlearningClient::from_cookie_header(&header)?;
    let user = client
        .validate()
        .await
        .context("优学院会话校验失败（GET /user）；请确认已登录学生端")?;

    // The course-list endpoint is best effort; a failure must not block the
    // session. The UI offers the player-URL fallback in that case.
    let courses = match client.list_courses().await {
        Ok(courses) => courses,
        Err(error) => {
            log::warn!("ulearning course list unavailable after login: {error:#}");
            Vec::new()
        }
    };

    if !state.mark_login_succeeded() {
        return Ok(());
    }

    let name = user.name.trim();
    let info = SessionInfo {
        platform: Platform::Ulearning,
        cookie_source: if name.is_empty() {
            "优学院网页登录".to_string()
        } else {
            format!("优学院网页登录（{name}）")
        },
        cookie_count: cookies.len(),
    };
    log::info!(
        "ulearning session captured: {} cookies, {} courses",
        cookies.len(),
        courses.len()
    );
    state.set_session(Session {
        info: info.clone(),
        client: SessionClient::Ulearning(UlSession { client, courses }),
    });
    let _ = app.emit("session-changed", info);
    close_login_window(app);
    Ok(())
}

/// Close the login window, clearing browsing data first as a second line of
/// defence; the temporary profile directory is deleted on `Destroyed`.
fn close_login_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        let _ = window.clear_all_browsing_data();
        let _ = window.close();
    }
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
