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
use crate::zhs_exam::{base64_encode, exam_log};
use anyhow::{Context, Result, anyhow};
use hust_course_hack::{
    SmartCourseClient,
    cookie::{CookieRecord, jar_from_records},
    ulearning::UlearningClient,
    zhihuishu::{ZhsClient, ZhsCourse, ZhsCourseKind},
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

/// WebView2/Chromium args for the login and shared-profile exam windows.
///
/// The CAS chain (`onlineexamh5new → studentexam-api/gologin → passport`) is
/// cross-site, so third-party cookie blocking is disabled explicitly (plus the
/// wry defaults, which must be repeated when custom args are used). Windows-only
/// setting; both windows that share the login profile use the same args, as
/// WebView2 requires identical browser arguments for a shared user-data folder.
pub(crate) const WEBVIEW2_EXAM_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,ThirdPartyCookieBlocking";

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

/// Fallback exam-list page. The real warm-up appends
/// `?recruitId=<base64(recruitAndCourseId)>` from the first shared course so the
/// SPA calls the exam APIs (and sets the engine `JSESSIONID`).
const ZHS_EXAM_WARMUP_URL: &str =
    "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList";
/// Hosts whose cookies take part in the exam SSO; read individually on every
/// poll so host cookies are not collapsed across hosts.
const ZHS_SSO_HOSTS: [(&str, &str); 7] = [
    ("onlineweb", "https://onlineweb.zhihuishu.com/onlinestuh5"),
    ("www", "https://www.zhihuishu.com/"),
    ("passport", "https://passport.zhihuishu.com/"),
    ("login", "https://login.zhihuishu.com/"),
    ("onlineexamh5new", "https://onlineexamh5new.zhihuishu.com/"),
    ("studentexam-api", "https://studentexam-api.zhihuishu.com/"),
    ("taurusexam-api", "https://taurusexam-api.zhihuishu.com/"),
];
// The exam warm-up reads per-host cookies directly (H5 host, both exam-engine
// hosts and the onlineweb portal); see `capture_exam_cookies`.

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

    // Logging into another platform means the stored Zhihuishu exam profile is
    // no longer useful; delete it now so it does not linger in %TEMP%.
    if platform != Platform::Zhihuishu
        && let Some(dir) = state.take_zhs_webview_dir()
    {
        cleanup_login_dir(dir);
    }

    let config = login_config(platform);
    let data_dir = login_data_dir();
    state.start_login(platform, data_dir.clone());
    log::info!("opening {} login window", platform.label());

    let entry = Url::parse(config.entry).map_err(|error| format!("登录地址无效：{error}"))?;
    log::info!("webview2 args: {WEBVIEW2_EXAM_BROWSER_ARGS}");
    let builder = WebviewWindowBuilder::new(app, LOGIN_LABEL, WebviewUrl::External(entry))
        .title(config.title)
        .inner_size(1000.0, 800.0)
        .min_inner_size(860.0, 620.0)
        .center()
        .additional_browser_args(WEBVIEW2_EXAM_BROWSER_ARGS)
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

/// Show a non-blocking one-line prompt inside the login window (used when the
/// exam SSO needs one extra manual login).
fn show_login_window_prompt(window: &tauri::WebviewWindow, text: &str) {
    let Ok(text) = serde_json::to_string(text) else {
        return;
    };
    let script = format!(
        "(function(){{if(document.getElementById('__zhs_login_prompt'))return;\
         var p=document.createElement('div');p.id='__zhs_login_prompt';\
         p.setAttribute('style','position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#1d4ed8;color:#fff;font:13px/1.5 \\\"Microsoft YaHei\\\",system-ui,sans-serif;pointer-events:none');\
         p.textContent={text};document.documentElement.appendChild(p);}})();"
    );
    let _ = window.eval(script);
}

/// Whether the login window currently sits on a passport/login page.
fn is_login_url(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = url.path().to_ascii_lowercase();
    host.contains("login")
        || host.starts_with("passport.")
        || host.starts_with("pass.")
        || path.contains("login")
        || path.contains("passport")
}

/// Ask the login webview whether the exam list SPA rendered (`#examStateTabYsj`).
/// Authenticated-content probe for the exam list SPA.
///
/// The SPA shell (`#examStateTabYsj`) can render even when the engine session is
/// invalid, so the marker requires real list content (homework names/actions).
fn login_window_authenticated_marker(window: &tauri::WebviewWindow) -> bool {
    let (sender, receiver) = std::sync::mpsc::channel();
    let script = "(function(){try{var t=(document.body&&document.body.innerText)||'';\
        return /单元测试|见面课测验|题目数量|申请重做/.test(t)?'true':'false';}catch(e){return 'false';}})();";
    if window
        .eval_with_callback(script, move |value| {
            let _ = sender.send(value);
        })
        .is_err()
    {
        return false;
    }
    match receiver.recv_timeout(Duration::from_millis(800)) {
        Ok(value) => {
            let value = value.trim().trim_matches('"').to_ascii_lowercase();
            value == "true" || value == "1"
        }
        Err(_) => false,
    }
}

/// Read cookies for the base portal URLs plus every SSO host, merge them with
/// `base` and report whether the exam engines got a `JSESSIONID`.
fn capture_sso_cookies(
    window: &tauri::WebviewWindow,
    base: &[CookieRecord],
) -> (Vec<CookieRecord>, bool) {
    let mut groups: Vec<Vec<CookieRecord>> = vec![base.to_vec()];
    for url in ZHS_COOKIE_URLS
        .iter()
        .filter_map(|raw| Url::parse(raw).ok())
    {
        if let Ok(records) = read_cookies_from_window(window, &[url]) {
            groups.push(records);
        }
    }
    let mut has_jsession = false;
    for (name, raw) in ZHS_SSO_HOSTS {
        let Ok(url) = Url::parse(raw) else {
            continue;
        };
        match read_cookies_from_window(window, &[url]) {
            Ok(records) => {
                if name == "studentexam-api" || name == "taurusexam-api" {
                    has_jsession = records.iter().any(|cookie| cookie.name == "JSESSIONID");
                }
                groups.push(records);
            }
            Err(error) => {
                log::warn!("zhihuishu exam SSO: reading {name} cookies failed: {error}");
            }
        }
    }
    if let Ok(current) = window.url()
        && let Ok(records) = read_cookies_from_window(window, &[current])
    {
        groups.push(records);
    }
    (
        zhs_session_cookies(merge_cookie_groups(groups)),
        has_jsession,
    )
}

/// Red error panel inside the login window (the login window has no diagnostic
/// bootstrap script, so this is built here).
fn show_login_window_error(window: &tauri::WebviewWindow, title: &str, detail: &str) {
    let Ok(title) = serde_json::to_string(title) else {
        return;
    };
    let Ok(detail) = serde_json::to_string(detail) else {
        return;
    };
    let script = format!(
        "(function(){{var old=document.getElementById('__zhs_login_error');if(old)old.remove();\
         var p=document.createElement('div');p.id='__zhs_login_error';\
         p.setAttribute('style','position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.96);color:#e5e7eb;font:14px/1.7 \\\"Microsoft YaHei\\\",system-ui,sans-serif;padding:44px;box-sizing:border-box;overflow:auto');\
         var h=document.createElement('h2');h.textContent={title};h.style.color='#fca5a5';h.style.margin='0 0 14px';\
         var d=document.createElement('div');d.textContent={detail};d.style.whiteSpace='pre-wrap';d.style.fontSize='13px';\
         p.appendChild(h);p.appendChild(d);document.documentElement.appendChild(p);}})();"
    );
    let _ = window.eval(script);
}

/// Poll the login webview until the exam list shows authenticated content.
///
/// Every poll is logged with the current URL and marker. Ready requires both a
/// real content marker and the URL staying on the expected exam host for at
/// least two consecutive seconds. Cookie presence and the SPA shell are not used
/// as readiness signals.
fn wait_for_authenticated_exam(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    expected_host: &str,
    timeout: Duration,
    best: &mut Vec<CookieRecord>,
) -> bool {
    let started = std::time::Instant::now();
    let mut stable_since: Option<std::time::Instant> = None;
    while started.elapsed() < timeout {
        let (captured, _) = capture_sso_cookies(window, best);
        *best = captured;
        let current = window.url().ok();
        let url_text = current
            .as_ref()
            .map(|url| url.to_string())
            .unwrap_or_default();
        let marker = login_window_authenticated_marker(window);
        exam_log(
            app,
            format!(
                "login SSO: url={url_text} marker={marker} (+{}ms)",
                started.elapsed().as_millis()
            ),
        );
        let on_exam_host = current
            .as_ref()
            .and_then(|url| url.host_str())
            .is_some_and(|host| host.eq_ignore_ascii_case(expected_host));
        if marker && on_exam_host {
            let since = *stable_since.get_or_insert_with(std::time::Instant::now);
            if since.elapsed() >= Duration::from_secs(2) {
                exam_log(
                    app,
                    format!(
                        "login SSO: authenticated exam list marker found (+{}ms)",
                        started.elapsed().as_millis()
                    ),
                );
                return true;
            }
        } else {
            stable_since = None;
        }
        if current.as_ref().is_some_and(is_login_url) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    let current = window
        .url()
        .ok()
        .map(|url| url.to_string())
        .unwrap_or_default();
    let marker = login_window_authenticated_marker(window);
    exam_log(
        app,
        format!(
            "login SSO: authenticated marker timeout; url={current} marker={marker} (+{}ms)",
            started.elapsed().as_millis()
        ),
    );
    false
}

/// Complete the exam-engine SSO during login.
///
/// Navigates the login webview to the exam list and requires authenticated
/// content. A passport/login redirect keeps the window there with a banner for
/// one extra login (up to two rounds) before re-navigating and verifying again.
fn complete_exam_sso(
    app: &AppHandle,
    base: Vec<CookieRecord>,
    exam_url: Url,
) -> (Vec<CookieRecord>, bool) {
    let Some(window) = app.get_webview_window(LOGIN_LABEL) else {
        return (base, false);
    };
    let started = std::time::Instant::now();
    let expected_host = exam_url.host_str().unwrap_or_default().to_ascii_lowercase();
    let (captured, _) = capture_sso_cookies(&window, &base);
    let mut best = captured;
    exam_log(
        app,
        format!(
            "login SSO: captured {} cookies before navigation",
            best.len()
        ),
    );
    if let Err(error) = window.navigate(exam_url.clone()) {
        exam_log(app, format!("login SSO: navigation failed: {error}"));
        return (best, false);
    }
    exam_log(
        app,
        format!(
            "login SSO: navigation -> {exam_url} (+{}ms)",
            started.elapsed().as_millis()
        ),
    );

    // Phase 1: automatic SSO. Ready only on authenticated content, not cookies.
    if wait_for_authenticated_exam(
        app,
        &window,
        &expected_host,
        Duration::from_secs(25),
        &mut best,
    ) {
        show_login_window_prompt(&window, "考试系统验证完成，正在进入…");
        return (best, true);
    }

    let current = window.url().ok();
    if !current.as_ref().is_some_and(is_login_url) {
        let url_text = current
            .as_ref()
            .map(|url| url.to_string())
            .unwrap_or_default();
        let marker = login_window_authenticated_marker(&window);
        exam_log(
            app,
            format!(
                "login SSO: exam list did not show authenticated content; final url={url_text} marker={marker}"
            ),
        );
        show_login_window_error(
            &window,
            "知到考试系统验证失败",
            &format!(
                "考试页已打开，但没有检测到已登录的作业/测验内容。\n\n最后地址：{url_text}\n内容标记：{marker}\n日志：%APPDATA%\\hust-course-hack\\logs\\zhs-exam.log\n\n请关闭窗口后重新登录知到重试。"
            ),
        );
        std::thread::sleep(Duration::from_secs(8));
        return (best, false);
    }

    // Phase 2: manual login in this window, then re-verify (up to 2 rounds).
    let mut rounds = 0u32;
    while rounds < 2 {
        rounds += 1;
        show_login_window_prompt(
            &window,
            "知到考试系统需要一次额外登录（与本窗口同一账号），登录后会自动继续",
        );
        exam_log(
            app,
            format!("login SSO: waiting for the extra login (round {rounds})"),
        );
        let wait_start = std::time::Instant::now();
        loop {
            let current = window.url().ok();
            if !current.as_ref().is_some_and(is_login_url) {
                break;
            }
            if wait_start.elapsed() > Duration::from_secs(300) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if wait_start.elapsed() > Duration::from_secs(300) {
            exam_log(app, "login SSO: manual login timeout");
            break;
        }
        exam_log(
            app,
            format!("login SSO: extra login finished; re-navigating exam list (round {rounds})"),
        );
        if window.navigate(exam_url.clone()).is_err() {
            break;
        }
        if wait_for_authenticated_exam(
            app,
            &window,
            &expected_host,
            Duration::from_secs(25),
            &mut best,
        ) {
            show_login_window_prompt(&window, "考试系统验证完成，正在进入…");
            exam_log(
                app,
                format!(
                    "login SSO: authenticated exam list marker found after manual login (+{}ms)",
                    started.elapsed().as_millis()
                ),
            );
            return (best, true);
        }
        if !window.url().ok().as_ref().is_some_and(is_login_url) {
            // No marker and no login page: another manual round cannot help.
            break;
        }
    }

    let current = window
        .url()
        .ok()
        .map(|url| url.to_string())
        .unwrap_or_default();
    let marker = login_window_authenticated_marker(&window);
    exam_log(
        app,
        format!(
            "login SSO: manual login rounds failed; final url={current} marker={marker} (+{}ms)",
            started.elapsed().as_millis()
        ),
    );
    show_login_window_error(
        &window,
        "知到考试系统验证失败",
        &format!(
            "额外登录后仍未检测到已登录的考试列表内容。\n\n最后地址：{current}\n内容标记：{marker}\n日志：%APPDATA%\\hust-course-hack\\logs\\zhs-exam.log\n\n请关闭窗口后重新登录知到重试。"
        ),
    );
    std::thread::sleep(Duration::from_secs(8));
    (best, false)
}

/// Run the exam SSO completion on a blocking worker (window cookie/DOM reads).
async fn warm_up_exam_cookies(
    app: &AppHandle,
    base: Vec<CookieRecord>,
    exam_url: Url,
) -> (Vec<CookieRecord>, bool) {
    let app_for_capture = app.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        complete_exam_sso(&app_for_capture, base, exam_url)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            log::warn!("zhihuishu exam SSO task failed: {error}");
            (Vec::new(), false)
        }
    }
}
fn exam_list_url_for_courses(courses: &[ZhsCourse]) -> Url {
    let secret = courses
        .iter()
        .find(|course| course.kind == ZhsCourseKind::Shared)
        .map(ZhsCourse::secret_or_derive)
        .filter(|secret| !secret.trim().is_empty());
    match secret {
        Some(secret) => {
            let raw = format!(
                "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId={}",
                base64_encode(&secret)
            );
            Url::parse(&raw)
                .unwrap_or_else(|_| Url::parse(ZHS_EXAM_WARMUP_URL).expect("static exam URL"))
        }
        None => Url::parse(ZHS_EXAM_WARMUP_URL).expect("static exam URL"),
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

    let login_started = std::time::Instant::now();
    exam_log(app, "login: zhihuishu session validated; starting exam SSO");

    // The shared-course list is needed first: the exam list URL carries the
    // first course's `recruitAndCourseId` secret, and without it the SPA may not
    // call the exam APIs (no engine JSESSIONID). Best effort — a failure must
    // not block the session.
    let mut courses = match client.list_courses().await {
        Ok(courses) => courses,
        Err(error) => {
            log::warn!("zhihuishu course list unavailable before exam SSO: {error:#}");
            Vec::new()
        }
    };
    let exam_url = exam_list_url_for_courses(&courses);

    let mut session_cookies = base_cookies.clone();
    let sso_ready = if state.begin_zhs_exam_warmup() {
        let (merged, ready) = warm_up_exam_cookies(app, cookies.clone(), exam_url).await;
        if !merged.is_empty() {
            session_cookies = merged;
        }
        exam_log(
            app,
            format!(
                "login: exam SSO phase finished ready={ready} (+{}ms, {} cookies)",
                login_started.elapsed().as_millis(),
                session_cookies.len()
            ),
        );
        ready
    } else {
        log::debug!("zhihuishu exam warm-up already ran in this login attempt");
        state.zhs_exam_sso_ready()
    };

    // Rebuild the client from the merged captures: `jar_from_records` preserves
    // cookie domains, so `studentexam-api` / `taurusexam-api` requests carry
    // their host cookies. Re-validate before adopting the merged session.
    match zhs_client_from_records(&session_cookies) {
        Ok(warm_client) => match warm_client.login_user().await {
            Ok(warm_user) => {
                log::info!(
                    "zhihuishu exam SSO merged: {} cookies, ready={sso_ready}",
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

    if courses.is_empty() {
        courses = match client.list_courses().await {
            Ok(courses) => courses,
            Err(error) => {
                log::warn!("zhihuishu course list unavailable after login: {error:#}");
                Vec::new()
            }
        };
    }
    // Readiness is only the authenticated-content signal from the login phase;
    // cookie presence is never used as a fallback (it produced false positives).
    state.set_zhs_exam_sso_ready(sso_ready);
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
    if sso_ready {
        // Reuse this WebView2 profile for exam windows: CAS/SSO state is in the
        // profile itself and cannot be reproduced by injecting cookies.
        if let Some(old) = state.adopt_zhs_webview_dir() {
            cleanup_login_dir(old);
        }
        exam_log(
            app,
            "login: keeping the login WebView2 profile for exam windows",
        );
    }
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
pub(crate) fn cleanup_login_dir_sync(path: PathBuf) {
    for _ in 0..20 {
        if std::fs::remove_dir_all(&path).is_ok() || !path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

pub(crate) fn cleanup_login_dir(path: PathBuf) {
    std::thread::spawn(move || cleanup_login_dir_sync(path));
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
