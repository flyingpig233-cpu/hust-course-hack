//! axum web server exposing `SmartCourseClient` over HTTP so the course
//! helper runs from a browser — no desktop app, no userscript.
//!
//! Shape: the browser pastes a logged-in session Cookie once (`POST
//! /api/session`), the server validates it against the course list endpoint
//! and keeps the client in memory. Long operations (crawl, video report, quiz
//! submit) run as background jobs; the frontend polls `/api/jobs/current`
//! with a cursor and replays the same progress events the GUI gets.
//!
//! When `COURSEHACK_TOKEN` / `--token` is set, every API request except
//! `GET /api/config` must send it as `X-Access-Token`.

mod jobs;
mod login;
mod state;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::RwLock;

use anyhow::Context;
use axum::Json;
use axum::Router;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};

use jobs::{CrawlOptionsBody, JobPlan, QuizBody, WatchBody};
use state::Shared;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

fn unauthorized(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, message.into())
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// Shared-secret gate in front of the API. `/api/config` is public and the
/// `/login` relay authenticates itself (start page via `?t=`, proxied requests
/// via the login cookie) and may only ever reach school hosts.
async fn access_guard(State(shared): State<Arc<Shared>>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let exempt = path == "/api/config" || path == "/login" || path.starts_with("/login/");
    if !exempt && let Some(expected) = shared.access_token.as_deref() {
        let provided = request
            .headers()
            .get("x-access-token")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if provided.is_empty() {
            return unauthorized("缺少访问口令").into_response();
        }
        if provided != expected {
            return unauthorized("访问口令无效").into_response();
        }
    }
    next.run(request).await
}

/// Validate the session token header and clone the session's client.
fn session_parts(
    shared: &Shared,
    headers: &HeaderMap,
) -> Result<
    (
        hust_course_hack::SmartCourseClient,
        Vec<hust_course_hack::CourseSummary>,
    ),
    ApiError,
> {
    let session = shared
        .session
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(session) = session.as_ref() else {
        return Err(unauthorized("尚未连接账号，请先登录统一身份认证"));
    };
    let provided = headers
        .get("x-session-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if provided.is_empty() || provided != session.token {
        return Err(unauthorized("会话不存在或已失效，请重新登录"));
    }
    Ok((session.client.clone(), session.courses.clone()))
}

pub(crate) fn random_token() -> String {
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn config(State(shared): State<Arc<Shared>>) -> Json<Value> {
    let bank = hust_course_hack::AnswerBank::builtin().ok();
    Json(json!({
        "tokenRequired": shared.access_token.is_some(),
        "bankQuestions": bank.as_ref().map(|bank| bank.len()).unwrap_or(0),
        "bankVersion": bank.as_ref().and_then(|bank| bank.version),
        "sessionActive": shared.has_session(),
    }))
}

async fn get_session(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let session = shared
        .session
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match session.as_ref() {
        None => Ok(Json(Value::Null)),
        Some(session) => {
            let provided = headers
                .get("x-session-token")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if provided.is_empty() || provided != session.token {
                return Err(unauthorized("会话不存在或已失效，请重新导入 Cookie"));
            }
            Ok(Json(json!({
                "cookieSource": session.info.cookie_source,
                "cookieCount": session.info.cookie_count,
            })))
        }
    }
}

async fn delete_session(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    {
        let session = shared
            .session
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(session) = session.as_ref() {
            let provided = headers
                .get("x-session-token")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if provided.is_empty() || provided != session.token {
                return Err(unauthorized("会话不存在或已失效，请重新导入 Cookie"));
            }
        }
    }
    *shared
        .session
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    Ok(Json(json!({ "ok": true })))
}

async fn list_courses(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
) -> Result<Json<Vec<hust_course_hack::CourseSummary>>, ApiError> {
    let (client, _) = session_parts(&shared, &headers)?;
    let courses = client.list_courses().await.map_err(|error| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("刷新课程列表失败：{error:#}"),
        )
    })?;
    if let Some(session) = shared
        .session
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_mut()
    {
        session.courses = courses.clone();
    }
    Ok(Json(courses))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum JobRequest {
    Fetch {
        #[serde(rename = "courseId")]
        course_id: String,
        #[serde(default)]
        options: Option<CrawlOptionsBody>,
    },
    Watch(WatchBody),
    Quiz(QuizBody),
}

async fn start_job(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Json(request): Json<JobRequest>,
) -> Result<Json<Value>, ApiError> {
    let (client, courses) = session_parts(&shared, &headers)?;

    // Resolve the course selector before claiming the job slot so a bad
    // selector cannot leave the slot marked busy.
    let plan = match request {
        JobRequest::Fetch { course_id, options } => {
            let course = jobs::lookup_course(&courses, &course_id).map_err(bad_request)?;
            JobPlan::Fetch { course, options }
        }
        JobRequest::Watch(body) => {
            let course = jobs::lookup_course(&courses, &body.course).map_err(bad_request)?;
            JobPlan::Watch { course, body }
        }
        JobRequest::Quiz(body) => {
            let course = jobs::lookup_course(&courses, &body.course).map_err(bad_request)?;
            JobPlan::Quiz { course, body }
        }
    };

    let (cancel, history) = shared
        .jobs
        .begin()
        .map_err(|message| ApiError(StatusCode::CONFLICT, message))?;

    // `builtin()` hands out a `&'static` bank, so the spawned task can hold
    // it without borrowing from this handler.
    let bank = hust_course_hack::AnswerBank::builtin().map_err(|error| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("加载内置题库失败：{error:#}"),
        )
    })?;
    let course_id = plan.course_id().to_string();
    tokio::spawn(async move {
        jobs::execute(plan, cancel, history, client, bank).await;
    });

    Ok(Json(json!({ "started": true, "courseId": course_id })))
}

#[derive(Debug, Deserialize)]
struct JobCursor {
    cursor: Option<usize>,
}

async fn current_job(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Query(cursor): Query<JobCursor>,
) -> Result<Json<Value>, ApiError> {
    session_parts(&shared, &headers)?;
    Ok(Json(shared.jobs.snapshot(cursor.cursor.unwrap_or(0))))
}

async fn cancel_job(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    session_parts(&shared, &headers)?;
    shared.jobs.cancel();
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "404").into_response()
}

async fn serve_static(State(shared): State<Arc<Shared>>, uri: Uri) -> Response {
    let path = uri.path();
    let rel = if path == "/" || path.is_empty() {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };
    if rel.split('/').any(|segment| segment == "..") {
        return not_found();
    }
    let mut file = shared.web_dir.join(rel);
    if file.is_dir() {
        file = file.join("index.html");
    }
    match tokio::fs::read(&file).await {
        Ok(bytes) => {
            let cache = if rel.starts_with("assets/") {
                // Vite content-hashes everything under assets/.
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                [
                    (header::CONTENT_TYPE, mime_for(&file)),
                    (header::CACHE_CONTROL, cache),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => not_found(),
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/api/config", get(config))
        .route("/api/session", get(get_session).delete(delete_session))
        .route("/api/login/status", get(login::login_status))
        .route("/api/courses", get(list_courses))
        .route("/api/jobs", post(start_job))
        .route("/api/jobs/current", get(current_job))
        .route("/api/jobs/cancel", post(cancel_job))
        .route("/login", get(login::login_redirect))
        .route("/login/", get(login::login_start))
        .route("/login/p", axum::routing::any(login::login_proxy))
        .layer(middleware::from_fn_with_state(shared.clone(), access_guard))
        .fallback(get(serve_static))
        .with_state(shared)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut listen: SocketAddr = "127.0.0.1:8787".parse().unwrap();
    let mut web_dir = PathBuf::from("web");
    let mut url_prefix = "/course-hack".to_string();
    let mut token = std::env::var("COURSEHACK_TOKEN").ok();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => {
                listen = args
                    .next()
                    .context("--listen 需要一个地址，如 127.0.0.1:8787")?
                    .parse()
                    .context("无效的 --listen 地址")?;
            }
            "--web-dir" => {
                web_dir = PathBuf::from(args.next().context("--web-dir 需要一个目录")?);
            }
            "--url-prefix" => {
                url_prefix = args
                    .next()
                    .context("--url-prefix 需要一个路径前缀（可为空字符串）")?
                    .trim_end_matches('/')
                    .to_string();
            }
            "--token" => {
                token = Some(args.next().context("--token 需要一个口令")?);
            }
            other => anyhow::bail!(
                "未知参数 {other}（支持 --listen / --web-dir / --url-prefix / --token）"
            ),
        }
    }
    let access_token = token.filter(|token| !token.trim().is_empty());
    // Fail fast if the embedded bank is broken; the quiz job depends on it.
    hust_course_hack::AnswerBank::builtin().context("加载内置题库失败")?;

    let shared = Arc::new(Shared {
        access_token,
        web_dir: web_dir.clone(),
        url_prefix,
        session: RwLock::new(None),
        jobs: state::JobSlot::default(),
        login: login::LoginRegistry::default(),
    });

    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .with_context(|| format!("监听 {listen} 失败"))?;
    println!(
        "hust-course-web listening on http://{listen} (web dir: {}, access token: {})",
        web_dir.display(),
        if shared.access_token.is_some() {
            "enabled"
        } else {
            "disabled"
        }
    );
    axum::serve(listener, router(shared)).await?;
    Ok(())
}
