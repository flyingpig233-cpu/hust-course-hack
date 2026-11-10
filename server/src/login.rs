//! Unified-authentication login relay.
//!
//! The web version has no embedded webview, so the server relays the official
//! HUST CAS pages instead: the browser opens `/login/`, which proxies
//! `https://smartcourse.hust.edu.cn/passport` (redirecting to
//! `pass.hust.edu.cn/cas/login`), rewriting every URL back through the proxy.
//! The user types their credentials on the official page; the official JS
//! encrypts them; the server only shuttles bytes. When the CAS flow lands back
//! on a smartcourse page, the server reads the session cookies captured in its
//! per-login cookie jar, verifies them against the course-list API (the same
//! check the desktop login window performs), adopts the session, and answers
//! with a small completion page.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

use reqwest::cookie::CookieStore as _;

use hust_course_hack::SmartCourseClient;

use crate::state::{SessionData, SessionInfo, Shared};

const LOGIN_ENTRY: &str = "https://smartcourse.hust.edu.cn/passport";
const PLATFORM_HOST: &str = "smartcourse.hust.edu.cn";
const LOGIN_COOKIE: &str = "coursehack_login";
const LOGIN_TTL: Duration = Duration::from_secs(20 * 60);
const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/// Only school hosts are ever fetched; everything else is refused.
fn host_allowed(host: &str) -> bool {
    host == "smartcourse.hust.edu.cn"
        || host == "pass.hust.edu.cn"
        || host.ends_with(".hust.edu.cn")
}

fn target_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(host_allowed)
}

/// A page on the platform that can carry a usable session (mirrors the
/// desktop login window: CAS pages run on `pass.hust.edu.cn`, `/passport` and
/// `/sso/` are intermediate hops).
fn is_platform_page(url: &Url) -> bool {
    url.host_str() == Some(PLATFORM_HOST)
        && !url.path().starts_with("/passport")
        && !url.path().contains("/sso/")
}

struct LoginAttempt {
    client: reqwest::Client,
    jar: Arc<reqwest::cookie::Jar>,
    created: Instant,
    /// `Ok` once the session was captured and adopted, `Err` on fatal errors.
    outcome: Mutex<Option<Result<(String, SessionInfo), String>>>,
    validated: AtomicBool,
}

impl LoginAttempt {
    fn new() -> Result<Self, String> {
        let jar = Arc::new(reqwest::cookie::Jar::default());
        let client = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .user_agent(DESKTOP_UA)
            .build()
            .map_err(|error| format!("创建登录会话失败：{error}"))?;
        Ok(Self {
            client,
            jar,
            created: Instant::now(),
            outcome: Mutex::new(None),
            validated: AtomicBool::new(false),
        })
    }

    fn expired(&self) -> bool {
        self.created.elapsed() > LOGIN_TTL
    }
}

/// At most one login attempt exists at a time; opening the login page again
/// replaces it (stale popups lose their cookie and are rejected).
#[derive(Default)]
pub struct LoginRegistry {
    current: Mutex<Option<Arc<LoginAttempt>>>,
}

fn current_attempt(registry: &LoginRegistry) -> Option<Arc<LoginAttempt>> {
    let current = registry
        .current
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    current
        .as_ref()
        .filter(|attempt| !attempt.expired())
        .cloned()
}

fn set_outcome(attempt: &LoginAttempt, outcome: Result<(String, SessionInfo), String>) {
    let mut slot = attempt
        .outcome
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if slot.is_none() {
        *slot = Some(outcome);
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct StartParams {
    /// Access passcode, required when the server runs with `--token`.
    t: Option<String>,
}

/// `GET /login` → `/login/` (keep the query).
pub async fn login_redirect(uri: Uri) -> Response {
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    (
        StatusCode::PERMANENT_REDIRECT,
        [(header::LOCATION, format!("/login/{query}"))],
    )
        .into_response()
}

/// `GET /login/` — start a login attempt and relay the CAS entry page.
pub async fn login_start(
    State(shared): State<Arc<Shared>>,
    Query(params): Query<StartParams>,
) -> Response {
    if let Some(expected) = shared.access_token.as_deref() {
        match params.t.as_deref() {
            Some(provided) if provided == expected => {}
            _ => return login_error_page(StatusCode::UNAUTHORIZED, "缺少或错误的访问口令"),
        }
    }

    let attempt = match LoginAttempt::new() {
        Ok(attempt) => Arc::new(attempt),
        Err(error) => return login_error_page(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };
    *shared
        .login
        .current
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(attempt.clone());

    let mut response = relay(
        &shared,
        &attempt,
        Method::GET,
        LOGIN_ENTRY,
        &HeaderMap::new(),
        Bytes::new(),
    )
    .await;
    response.headers_mut().append(
        header::SET_COOKIE,
        format!(
            "{LOGIN_COOKIE}={}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=1200",
            crate::random_token(),
        )
        .parse()
        .unwrap(),
    );
    response
}

#[derive(Debug, Deserialize)]
pub struct ProxyParams {
    url: String,
}

/// `ANY /login/p?url=<encoded absolute URL>` — relay one request through the
/// per-login cookie jar.
pub async fn login_proxy(
    State(shared): State<Arc<Shared>>,
    method: Method,
    Query(params): Query<ProxyParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !matches!(method, Method::GET | Method::HEAD | Method::POST) {
        return login_error_page(StatusCode::METHOD_NOT_ALLOWED, "不支持的请求方法");
    }
    let Some(attempt) = login_attempt_from_headers(&shared, &headers) else {
        return login_error_page(
            StatusCode::GONE,
            "登录会话不存在或已过期，请回到课程助手重新打开登录窗口",
        );
    };
    let Ok(target) = Url::parse(&params.url) else {
        return login_error_page(StatusCode::BAD_REQUEST, "无效的登录跳转地址");
    };
    if !target_allowed(&target) {
        return login_error_page(StatusCode::FORBIDDEN, "只允许中转学校 (*.hust.edu.cn) 页面");
    }
    relay(
        &shared,
        &attempt,
        method,
        params.url.as_str(),
        &headers,
        body,
    )
    .await
}

/// `GET /api/login/status` — polled by the page that opened the popup.
pub async fn login_status(State(shared): State<Arc<Shared>>) -> Json<Value> {
    let Some(attempt) = current_attempt(&shared.login) else {
        return Json(json!({ "state": "idle" }));
    };
    if attempt.expired() {
        set_outcome(&attempt, Err("登录已超时，请重新打开登录窗口".to_string()));
    }
    let outcome = attempt
        .outcome
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    match outcome {
        None => Json(json!({ "state": "pending" })),
        Some(Err(error)) => Json(json!({ "state": "failed", "error": error })),
        Some(Ok((token, info))) => Json(json!({
            "state": "done",
            "sessionToken": token,
            "cookieSource": info.cookie_source,
            "cookieCount": info.cookie_count,
        })),
    }
}

fn login_attempt_from_headers(shared: &Shared, headers: &HeaderMap) -> Option<Arc<LoginAttempt>> {
    let attempt = current_attempt(&shared.login)?;
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    let prefix = format!("{LOGIN_COOKIE}=");
    // The cookie only correlates the popup with the live attempt; there is
    // exactly one attempt at a time and `/login/p` never fetches anything
    // outside *.hust.edu.cn.
    cookie
        .split(';')
        .map(str::trim)
        .any(|part| part.starts_with(&prefix))
        .then_some(attempt)
}

// ---------------------------------------------------------------------------
// Relay core
// ---------------------------------------------------------------------------

async fn relay(
    shared: &Shared,
    attempt: &Arc<LoginAttempt>,
    method: Method,
    target: &str,
    browser_headers: &HeaderMap,
    body: Bytes,
) -> Response {
    let url = match Url::parse(target) {
        Ok(url) => url,
        Err(_) => return login_error_page(StatusCode::BAD_REQUEST, "无效的登录跳转地址"),
    };

    let mut request = attempt.client.request(method.clone(), url.clone());
    for name in [header::USER_AGENT, header::ACCEPT, header::ACCEPT_LANGUAGE] {
        if let Some(value) = browser_headers.get(&name) {
            request = request.header(name, value);
        }
    }
    if !body.is_empty() {
        if let Some(content_type) = browser_headers.get(header::CONTENT_TYPE) {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        request = request.body(body);
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return login_error_page(
                StatusCode::BAD_GATEWAY,
                &format!("无法访问学校服务器：{error}"),
            );
        }
    };
    let final_url = response.url().clone();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // The CAS flow landed back on the platform: try to capture the session
    // before rendering anything.
    if is_platform_page(&final_url)
        && !attempt.validated.load(Ordering::SeqCst)
        && let Some(response) = try_capture_session(shared, attempt).await
    {
        return response;
    }

    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            return login_error_page(
                StatusCode::BAD_GATEWAY,
                &format!("读取学校服务器响应失败：{error}"),
            );
        }
    };

    let kind = content_type.split(';').next().unwrap_or("").trim();
    let payload = match kind {
        "text/html" | "application/xhtml+xml" => rewrite_html(
            &String::from_utf8_lossy(&bytes),
            &final_url,
            &shared.url_prefix,
        )
        .into_bytes(),
        "text/css" => rewrite_css(
            &String::from_utf8_lossy(&bytes),
            &final_url,
            &shared.url_prefix,
        )
        .into_bytes(),
        _ => bytes.to_vec(),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        payload,
    )
        .into_response()
}

/// Read the smartcourse cookies captured in the login jar and, when they form
/// a working session, adopt it and answer with the completion page.
async fn try_capture_session(shared: &Shared, attempt: &Arc<LoginAttempt>) -> Option<Response> {
    attempt.validated.store(true, Ordering::SeqCst);
    let base = Url::parse("https://smartcourse.hust.edu.cn/").ok()?;
    let cookies = attempt.jar.cookies(&base)?.to_str().ok()?.to_string();
    if cookies.trim().is_empty() {
        attempt.validated.store(false, Ordering::SeqCst);
        return None;
    }

    let client = match SmartCourseClient::from_cookie_header(&cookies) {
        Ok(client) => client,
        Err(_) => {
            attempt.validated.store(false, Ordering::SeqCst);
            return None;
        }
    };
    let (courses, final_url) = match client.list_courses_with_url().await {
        Ok(result) => result,
        // A network hiccup should not burn the single validation; allow a
        // retry on the next platform-page landing.
        Err(_) => {
            attempt.validated.store(false, Ordering::SeqCst);
            return None;
        }
    };
    // The course-list endpoint redirects to the public landing page when
    // there is no session; staying on the API path means the request was
    // authorized even if the account has no current courses.
    let authenticated = !courses.is_empty() || final_url.path().contains("getStudyCourse");
    if !authenticated {
        attempt.validated.store(false, Ordering::SeqCst);
        return None;
    }

    let token = crate::random_token();
    let info = SessionInfo {
        cookie_source: "HUST 统一身份认证".to_string(),
        cookie_count: cookies.split(';').filter(|p| !p.trim().is_empty()).count(),
    };
    *shared
        .session
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(SessionData {
        token: token.clone(),
        info: info.clone(),
        client,
        courses,
    });
    set_outcome(attempt, Ok((token, info)));
    Some(completion_page())
}

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

fn proxy_url(prefix: &str, target: &Url) -> String {
    let encoded = utf8_percent_encode(target.as_str(), NON_ALPHANUMERIC);
    format!("{prefix}/login/p?url={encoded}")
}

/// Rewrite one attribute value: resolve it against the page URL and, when it
/// points at a school host, route it through the proxy.
fn rewrite_value(value: &str, base: &Url, prefix: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with('?')
        || trimmed.starts_with("data:")
        || trimmed.starts_with("javascript:")
        || trimmed.starts_with("mailto:")
        || trimmed.starts_with("tel:")
        || trimmed.starts_with("about:")
    {
        return value.to_string();
    }
    let Ok(absolute) = base.join(trimmed) else {
        return value.to_string();
    };
    if target_allowed(&absolute) {
        proxy_url(prefix, &absolute)
    } else {
        value.to_string()
    }
}

fn quoted_attr_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        // The regex crate has no backreferences, so the closing quote is its
        // own capture; mismatched quotes only occur in malformed HTML.
        Regex::new(r#"(?i)(\b(?:href|src|action|formaction|poster)\s*=\s*)(["'])([^"']*)(["'])"#)
            .expect("login rewrite regex")
    })
}

fn bare_attr_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?i)(\b(?:href|src|action|formaction|poster)\s*=\s*)([^\s<>"']+)"#)
            .expect("login rewrite regex (bare)")
    })
}

pub fn rewrite_html(html: &str, base: &Url, prefix: &str) -> String {
    let quoted = quoted_attr_regex().replace_all(html, |caps: &regex::Captures| {
        format!(
            "{}{}{}{}",
            &caps[1],
            &caps[2],
            rewrite_value(&caps[3], base, prefix),
            &caps[4]
        )
    });
    bare_attr_regex()
        .replace_all(&quoted, |caps: &regex::Captures| {
            format!("{}{}", &caps[1], rewrite_value(&caps[2], base, prefix))
        })
        .into_owned()
}

pub fn rewrite_css(css: &str, base: &Url, prefix: &str) -> String {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = REGEX.get_or_init(|| {
        Regex::new(r#"(?i)(url\(\s*)(["']?)([^"')]+)(["']?\s*\))"#).expect("css rewrite regex")
    });
    regex
        .replace_all(css, |caps: &regex::Captures| {
            format!(
                "{}{}{}{}",
                &caps[1],
                &caps[2],
                rewrite_value(&caps[3], base, prefix),
                &caps[4]
            )
        })
        .into_owned()
}

// ---------------------------------------------------------------------------
// Small pages
// ---------------------------------------------------------------------------

fn login_error_page(status: StatusCode, message: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>登录</title><body style=\"font:15px/1.7 system-ui,sans-serif;color:#334;padding:32px;text-align:center\">\
         <p style=\"font-size:40px;margin:0\">⚠️</p><p>{message}</p>\
         <p style=\"color:#889\">请回到课程助手页面重新打开登录窗口。</p></body>"
    );
    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string())],
        body,
    )
        .into_response()
}

fn completion_page() -> Response {
    let body = "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
        <title>登录成功</title><body style=\"font:15px/1.7 system-ui,sans-serif;color:#334;padding:32px;text-align:center\">\
        <p style=\"font-size:40px;margin:0\">✅</p><p><b>登录成功</b></p>\
        <p>正在返回课程助手，此窗口将自动关闭。</p>\
        <script>setTimeout(function(){window.close()},1200)</script></body>";
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://pass.hust.edu.cn/cas/login?service=http://smartcourse.hust.edu.cn/x")
            .unwrap()
    }

    #[test]
    fn rewrites_relative_and_absolute_school_urls() {
        let html = r#"<form action="/cas/login" method="post"></form>
            <link href="/cas/hust/css/style/login-style.css" rel="stylesheet">
            <img src="/cas/code">
            <a href="https://pass.hust.edu.cn/cas/newpwd">forget</a>
            <a href="https://example.com/x">external</a>
            <a href="javascript:void(0)">js</a>"#;
        let out = rewrite_html(html, &base(), "/course-hack");
        assert!(
            out.contains(r#"action="/course-hack/login/p?url=http"#),
            "{out}"
        );
        assert!(
            out.contains(r#"src="/course-hack/login/p?url=https"#),
            "{out}"
        );
        assert!(
            out.contains(r#"href="/course-hack/login/p?url=http"#),
            "{out}"
        );
        // external and non-http values stay untouched
        assert!(out.contains(r#"href="https://example.com/x""#), "{out}");
        assert!(out.contains(r#"href="javascript:void(0)""#), "{out}");
        // an empty prefix serves the app from the root path
        let root = rewrite_html(r#"<img src="/cas/code">"#, &base(), "");
        assert!(root.contains(r#"src="/login/p?url=http"#), "{root}");
    }

    #[test]
    fn proxy_url_round_trips() {
        let target = Url::parse("https://pass.hust.edu.cn/cas/login?a=b c&d=/x").unwrap();
        let encoded = proxy_url("/course-hack", &target);
        assert!(encoded.starts_with("/course-hack/login/p?url="));
        let value = encoded.trim_start_matches("/course-hack/login/p?url=");
        let decoded = percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .unwrap()
            .into_owned();
        assert_eq!(decoded, target.as_str());
    }

    #[test]
    fn css_urls_are_rewritten() {
        let css = "body{background:url(/cas/hust/image/bg.png)}";
        let out = rewrite_css(css, &base(), "/course-hack");
        assert!(out.contains("url(/course-hack/login/p?url=http"), "{out}");
    }

    #[test]
    fn platform_page_detection_matches_desktop() {
        let url =
            Url::parse("https://smartcourse.hust.edu.cn/fyportal-smartcourse/wfw/index").unwrap();
        assert!(is_platform_page(&url));
        let passport = Url::parse("https://smartcourse.hust.edu.cn/passport").unwrap();
        assert!(!is_platform_page(&passport));
        let sso =
            Url::parse("http://smartcourse.hust.edu.cn/fyportal-smartcourse/sso/hust?ticket=1")
                .unwrap();
        assert!(!is_platform_page(&sso));
        let cas = Url::parse("https://pass.hust.edu.cn/cas/login").unwrap();
        assert!(!is_platform_page(&cas));
    }
}
