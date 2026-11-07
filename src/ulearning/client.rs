//! HTTP client for the Ulearning (优学院 / U学) student API.
//!
//! The session is a static token: the cookie `AUTHORIZATION` is copied into both
//! the `Authorization` and `UA-AUTHORIZATION` request headers, optionally with
//! `version: 1`. There is no request signing. The token is read lazily from the
//! cookie jar and is never logged, serialized into a model, or exposed through a
//! getter.
//!
//! All network code lives here so tests can point every request at a local mock
//! server with [`UlearningClient::with_cookie_jar_and_base`]. Parsing lives in
//! [`super::parse`].

use std::{
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use reqwest::{
    Client, StatusCode,
    cookie::{CookieStore, Jar},
    header::{ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, CONTENT_TYPE, HeaderName, USER_AGENT},
};
use serde_json::Value;
use url::Url;

use super::{
    API_BASE, AUTH_COOKIE, WEB_BASE,
    models::{
        UlCourse, UlCourseDetail, UlPage, UlPageContent, UlSectionRecord, UlSyncOutcome, UlUser,
    },
    parse,
};

/// Cookie hosts that receive the Ulearning cookies.
const COOKIE_HOSTS: [&str; 8] = [
    "https://api.ulearning.cn/",
    "https://ua.ulearning.cn/",
    "https://courseapi.ulearning.cn/",
    "https://www.ulearning.cn/",
    "https://umooc.ulearning.cn/",
    "https://courseweb.ulearning.cn/",
    "https://utest.ulearning.cn/",
    "https://docs.ulearning.cn/",
];

/// Fallback cookie that also carries the player token on some builds.
const PLAYER_TOKEN_COOKIE: &str = "token";

/// Browser user agent used for all requests.
const UL_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                             (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

/// Normalized Ulearning API error.
///
/// `endpoint` is the path only; it never contains the token, cookies or the
/// encrypted request body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UlError {
    /// Platform error code, when the response carried one.
    pub code: Option<i64>,
    /// Short, sanitized message.
    pub message: String,
    /// Request path (no query values).
    pub endpoint: String,
}

impl UlError {
    fn new(code: Option<i64>, message: impl Into<String>, endpoint: impl Into<String>) -> Self {
        let message = message.into();
        let flattened = message.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut message: String = flattened.chars().take(160).collect();
        if flattened.chars().count() > 160 {
            message.push('…');
        }
        Self {
            code,
            message,
            endpoint: endpoint.into(),
        }
    }
}

impl std::fmt::Display for UlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.code {
            Some(code) => write!(
                f,
                "ulearning {} failed (code {}): {}",
                self.endpoint, code, self.message
            ),
            None => write!(f, "ulearning {} failed: {}", self.endpoint, self.message),
        }
    }
}

impl std::error::Error for UlError {}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn login_expired(endpoint: &str, code: Option<i64>) -> UlError {
    UlError::new(
        code,
        "登录状态失效，请重新登录优学院或导出新的 cookies",
        endpoint,
    )
}

/// Authenticated Ulearning client.
#[derive(Clone)]
pub struct UlearningClient {
    http: Client,
    jar: Arc<Jar>,
    api_base: String,
    web_base: String,
}

impl UlearningClient {
    /// Build a client from an already populated cookie jar (production hosts).
    pub fn with_cookie_jar(jar: Arc<Jar>) -> Result<Self> {
        Self::with_cookie_jar_and_bases(jar, API_BASE, WEB_BASE)
    }

    /// Build a client from a cookie jar and an API base override.
    ///
    /// Integration tests use this to point the client at a local mock server;
    /// production callers should keep the default [`API_BASE`].
    pub fn with_cookie_jar_and_base(jar: Arc<Jar>, api_base: impl Into<String>) -> Result<Self> {
        Self::with_cookie_jar_and_bases(jar, api_base, WEB_BASE)
    }

    /// Build a client from a cookie jar and API/web base overrides.
    pub fn with_cookie_jar_and_bases(
        jar: Arc<Jar>,
        api_base: impl Into<String>,
        web_base: impl Into<String>,
    ) -> Result<Self> {
        let api_base = api_base.into();
        let web_base = web_base.into();
        if api_base.trim().is_empty() {
            bail!("优学院 API 地址不能为空");
        }
        let http = Client::builder()
            .cookie_provider(Arc::clone(&jar))
            .user_agent(UL_USER_AGENT)
            .timeout(std::time::Duration::from_secs(40))
            .redirect(reqwest::redirect::Policy::limited(8))
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(
                    ACCEPT_LANGUAGE,
                    "zh-CN,zh;q=0.9,en;q=0.8".parse().expect("static header"),
                );
                headers.insert(
                    ACCEPT,
                    "application/json, text/plain, */*"
                        .parse()
                        .expect("static header"),
                );
                headers
            })
            .build()
            .context("failed to build the Ulearning HTTP client")?;
        Ok(Self {
            http,
            jar,
            api_base: api_base.trim_end_matches('/').to_string(),
            web_base: web_base.trim_end_matches('/').to_string(),
        })
    }

    /// Load cookies from a browser-exported Netscape `cookies.txt` file.
    pub fn from_cookie_file(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_cookie_file_with_base(path, API_BASE)
    }

    /// Load a Netscape cookie file and use an API base override.
    pub fn from_cookie_file_with_base(
        path: impl AsRef<Path>,
        api_base: impl Into<String>,
    ) -> Result<Self> {
        let path = path.as_ref();
        let contents = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read cookie file {}", path.display()))?;
        let records = crate::cookie::parse_netscape_cookies(&contents);
        if records.is_empty() {
            bail!(
                "no cookies found in {} (expected a Netscape cookies.txt export for ulearning.cn)",
                path.display()
            );
        }
        let jar = jar_from_records(&records)?;
        Self::with_cookie_jar_and_base(jar, api_base)
    }

    /// Build a client from a raw `Cookie:` header value.
    pub fn from_cookie_header(header: &str) -> Result<Self> {
        Self::from_cookie_header_with_base(header, API_BASE)
    }

    /// Build a client from a raw `Cookie:` header and an API base override.
    pub fn from_cookie_header_with_base(header: &str, api_base: impl Into<String>) -> Result<Self> {
        let header = header
            .trim()
            .strip_prefix("Cookie:")
            .unwrap_or(header.trim());
        let mut pairs: Vec<(String, String)> = Vec::new();
        for part in header.split(';') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let Some((name, value)) = part.split_once('=') else {
                continue;
            };
            pairs.push((name.trim().to_string(), value.trim().to_string()));
        }
        if pairs.is_empty() {
            bail!("no cookies found in the Cookie header");
        }
        let jar = Jar::default();
        for host in COOKIE_HOSTS {
            let url = Url::parse(host).context("invalid built-in Ulearning cookie host")?;
            for (name, value) in &pairs {
                jar.add_cookie_str(&format!("{name}={value}"), &url);
            }
        }
        Self::with_cookie_jar_and_base(Arc::new(jar), api_base)
    }

    /// API base currently in use (production host unless overridden for tests).
    pub fn api_base(&self) -> &str {
        &self.api_base
    }

    /// Web/player base currently in use.
    pub fn web_base(&self) -> &str {
        &self.web_base
    }

    /// Read one cookie value from the jar.
    pub fn cookie_value(&self, name: &str) -> Option<String> {
        for host in COOKIE_HOSTS {
            let Ok(url) = Url::parse(host) else {
                continue;
            };
            let Some(header) = self.jar.cookies(&url) else {
                continue;
            };
            let Ok(text) = header.to_str() else {
                continue;
            };
            for part in text.split(';') {
                if let Some((key, value)) = part.trim().split_once('=')
                    && key == name
                {
                    return Some(value.to_string());
                }
            }
        }
        None
    }

    /// Session token (never logged or exposed through a public getter).
    fn auth_token(&self) -> Result<String> {
        self.cookie_value(AUTH_COOKIE)
            .or_else(|| self.cookie_value(PLAYER_TOKEN_COOKIE))
            .filter(|token| !token.trim().is_empty())
            .context("未找到优学院 AUTHORIZATION cookie，请先登录并导出 cookies")
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.api_base, path)
    }

    fn with_auth_headers(
        &self,
        request: reqwest::RequestBuilder,
        token: &str,
    ) -> reqwest::RequestBuilder {
        request
            .header(AUTHORIZATION, token)
            .header(HeaderName::from_static("ua-authorization"), token)
            .header(HeaderName::from_static("version"), "1")
            .header(USER_AGENT, UL_USER_AGENT)
    }

    /// GET one JSON endpoint with the session headers.
    async fn get_value(&self, path: &str) -> Result<Value> {
        let token = self.auth_token()?;
        let response = self
            .with_auth_headers(self.http.get(self.url(path)), &token)
            .send()
            .await
            .with_context(|| format!("request to {path} failed"))?;
        self.read_value(path, response).await
    }

    /// GET one endpoint and return its raw text (used for JSONJ/JSONP bodies).
    async fn read_value(&self, path: &str, response: reqwest::Response) -> Result<Value> {
        let status = response.status();
        let text = response
            .text()
            .await
            .with_context(|| format!("failed to read the response of {path}"))?;
        let text = text.trim();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(login_expired(path, Some(i64::from(status.as_u16()))).into());
        }
        if !status.is_success() {
            return Err(UlError::new(
                Some(i64::from(status.as_u16())),
                format!("HTTP {status}"),
                path,
            )
            .into());
        }
        if text.is_empty() {
            return Ok(Value::Null);
        }
        let value: Value = serde_json::from_str(text).with_context(|| {
            format!(
                "response of {path} is not JSON: {}",
                text.chars().take(120).collect::<String>()
            )
        })?;
        // Some course API errors use HTTP 200 with a `code` field.
        if let Some(code) = value.get("code").and_then(Value::as_i64)
            && code != 0
            && code != 200
        {
            let message = value
                .get("message")
                .or_else(|| value.get("msg"))
                .and_then(Value::as_str)
                .unwrap_or("platform error");
            let message = if matches!(code, 2001 | 2101 | 2201 | 2301) {
                format!("登录状态失效，请重新登录优学院（{message}）")
            } else {
                format!("platform code {code}: {message}")
            };
            return Err(UlError::new(Some(code), message, path).into());
        }
        Ok(value)
    }

    /// Validate the session and return the logged-in user (`GET /user`).
    pub async fn validate(&self) -> Result<UlUser> {
        let value = self.get_value("/user").await?;
        let user = parse::parse_user(&value);
        if user.user_id == 0 {
            bail!("优学院会话校验失败：未返回用户信息");
        }
        Ok(user)
    }

    /// Student course list (`GET /courseListStu`).
    ///
    /// The endpoint was not captured in the protocol analysis, so the result is
    /// best effort; callers can fall back to a player URL / `textbookId`.
    pub async fn list_courses(&self) -> Result<Vec<UlCourse>> {
        let value = self.get_value("/courseListStu").await?;
        Ok(parse::parse_course_list(&value))
    }

    /// Resolve a course reference into a [`UlCourse`] skeleton.
    ///
    /// Accepted forms: a player URL
    /// (`ua.ulearning.cn/learnCourse/learnCourse.html?courseId=&classId=`),
    /// `textbookId=47353&classId=1019700`, `47353;1019700`, `47353/1019700`
    /// or a bare `textbookId`.
    pub fn resolve_course(&self, reference: &str) -> Result<UlCourse> {
        let reference = reference.trim();
        if reference.is_empty() {
            bail!("课程引用为空");
        }

        if let Ok(url) = Url::parse(reference) {
            return resolve_course_url(&url);
        }
        // Query-like reference without a scheme.
        if reference.contains("textbookId=")
            || reference.contains("textbook_id=")
            || reference.contains("bookId=")
        {
            let pairs: Vec<(String, String)> = url::form_urlencoded::parse(reference.as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            let lookup = |names: &[&str]| -> Option<i64> {
                pairs
                    .iter()
                    .find(|(key, _)| names.contains(&key.as_str()))
                    .and_then(|(_, value)| value.trim().parse().ok())
            };
            let textbook_id = lookup(&["textbookId", "textbook_id", "bookId", "courseId"])
                .context("课程引用中缺少 textbookId")?;
            return Ok(UlCourse {
                textbook_id,
                oc_id: lookup(&["ocId", "oc_id"]),
                class_id: lookup(&["classId", "class_id", "classid"]),
                ..UlCourse::default()
            });
        }

        for separator in [';', '/', ','] {
            if let Some((left, right)) = reference.split_once(separator)
                && let (Ok(textbook_id), Ok(class_id)) =
                    (left.trim().parse::<i64>(), right.trim().parse::<i64>())
            {
                return Ok(UlCourse {
                    textbook_id,
                    class_id: Some(class_id),
                    ..UlCourse::default()
                });
            }
        }

        if let Ok(textbook_id) = reference.parse::<i64>() {
            return Ok(UlCourse {
                textbook_id,
                ..UlCourse::default()
            });
        }
        bail!(
            "无法识别的课程引用：{}（支持播放器 URL、textbookId=...&classId=...、textbookId;classId 或纯 textbookId）",
            reference.chars().take(80).collect::<String>()
        )
    }

    /// Fetch course metadata and the chapter tree.
    pub async fn course_detail(&self, course: &UlCourse) -> Result<UlCourseDetail> {
        let mut course = course.clone();
        let course_path = format!("/course/{}", course.textbook_id);

        if let Ok(value) = self
            .get_value(&format!("{course_path}/basicinformation"))
            .await
        {
            let (name, author) = parse::parse_basic_information(&value);
            if let Some(name) = name {
                course.name = name;
            }
            if author.is_some() {
                course.author = author;
            }
        }
        let remaining_secs = self
            .get_value(&format!("{course_path}/remaining"))
            .await
            .ok()
            .and_then(|value| parse::parse_remaining(&value));
        let class_name = match course.class_id {
            Some(class_id) => self
                .get_value(&format!("{course_path}/classes?classId={class_id}"))
                .await
                .ok()
                .and_then(|value| parse::parse_class_name(&value)),
            None => None,
        };
        let directory_path = match course.class_id {
            Some(class_id) => format!(
                "/course/stu/{}/directory?classId={class_id}",
                course.textbook_id
            ),
            None => format!("/course/stu/{}/directory", course.textbook_id),
        };
        let value = self
            .get_value(&directory_path)
            .await
            .with_context(|| format!("failed to fetch the directory of {}", course.label()))?;
        let chapters = parse::parse_directory(&value)?;

        if let Some(remaining) = remaining_secs {
            course.remaining_secs = Some(remaining);
        }
        Ok(UlCourseDetail {
            course,
            chapters,
            remaining_secs,
            class_name,
        })
    }

    /// Page list of one section (`GET /wholepage/item/stu/{sectionId}`).
    pub async fn section_pages(&self, section_id: i64) -> Result<Vec<UlPage>> {
        let value = self
            .get_value(&format!("/wholepage/item/stu/{section_id}"))
            .await
            .with_context(|| format!("failed to fetch pages of section {section_id}"))?;
        parse::parse_section_pages(&value)
    }

    /// Content of one page (`GET /wholepage/stu/{pageId}`).
    pub async fn page_content(&self, page_id: i64) -> Result<UlPageContent> {
        let value = self
            .get_value(&format!("/wholepage/stu/{page_id}"))
            .await
            .with_context(|| format!("failed to fetch content of page {page_id}"))?;
        parse::parse_page_content(&value)
    }

    /// Historical study record of one section.
    pub async fn section_record(&self, section_id: i64) -> Result<UlSectionRecord> {
        let value = self
            .get_value(&format!("/studyrecord/item/{section_id}?courseType=4"))
            .await
            .with_context(|| format!("failed to fetch the record of section {section_id}"))?;
        Ok(parse::parse_section_record(&value))
    }

    /// Server-issued study start timestamp (`GET /studyrecord/initialize/{id}`).
    ///
    /// Falls back to the current Unix time when the endpoint returns nothing;
    /// the captured protocol shows a missing value is tolerated by `sync`.
    pub async fn initialize_study(&self, section_id: i64) -> i64 {
        match self
            .get_value(&format!("/studyrecord/initialize/{section_id}"))
            .await
        {
            Ok(value) => parse::parse_initialize(&value).unwrap_or_else(unix_seconds),
            Err(error) => {
                log::debug!("initialize/{section_id} unavailable: {error:#}");
                unix_seconds()
            }
        }
    }

    /// Answer letters of one question (`GET /questionAnswer/{qid}?parentId={pageId}`).
    ///
    /// `parent_id` must be the *page* id, not the section id.
    pub async fn question_answer(&self, question_id: i64, parent_id: i64) -> Result<Vec<String>> {
        let value = self
            .get_value(&format!(
                "/questionAnswer/{question_id}?parentId={parent_id}"
            ))
            .await
            .with_context(|| format!("failed to fetch the answer of question {question_id}"))?;
        Ok(parse::parse_question_answer(&value))
    }

    /// POST an encrypted `sync` body and map the platform result code.
    pub(crate) async fn post_sync_cipher(&self, ciphertext: &str) -> Result<UlSyncOutcome> {
        let path = "/yws/api/personal/sync?courseType=4&platform=PC";
        let token = self.auth_token()?;
        let response = self
            .with_auth_headers(
                self.http
                    .post(self.url(path))
                    .header(CONTENT_TYPE, "application/json"),
                &token,
            )
            .body(ciphertext.to_string())
            .send()
            .await
            .context("request to /yws/api/personal/sync failed")?;
        let value = self.read_value(path, response).await?;
        Ok(parse_sync_outcome(&value))
    }
}

/// Map the `sync` response to [`UlSyncOutcome`] (`1` success, `2` cheat).
fn parse_sync_outcome(value: &Value) -> UlSyncOutcome {
    let code = value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        .or_else(|| value.get("result").and_then(Value::as_i64))
        .or_else(|| value.get("code").and_then(Value::as_i64));
    match code {
        Some(1) => UlSyncOutcome::Success,
        Some(2) => UlSyncOutcome::CheatDetected,
        Some(other) => UlSyncOutcome::Other(other),
        None => UlSyncOutcome::Other(-1),
    }
}

/// Resolve a player/portal URL into a course skeleton.
fn resolve_course_url(url: &Url) -> Result<UlCourse> {
    let mut params: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    // Portal URLs use a hash route; merge its query string too.
    if let Some(fragment) = url.fragment()
        && let Some((_, query)) = fragment.split_once('?')
    {
        params.extend(
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned())),
        );
    }
    let lookup = |names: &[&str]| -> Option<i64> {
        params
            .iter()
            .find(|(key, _)| names.contains(&key.as_str()))
            .and_then(|(_, value)| value.trim().parse().ok())
    };
    let host = url.host_str().unwrap_or_default();
    let is_player = host.contains("ua.ulearning");
    let explicit_textbook = lookup(&["textbookId", "textbook_id", "bookId"]);
    let course_id = lookup(&["courseId", "courseid", "id"]);
    let class_id = lookup(&["classId", "class_id", "classid"]);
    let oc_id = lookup(&["ocId", "oc_id"]);

    let textbook_id = explicit_textbook
        .or(if is_player { course_id } else { None })
        .context(
            "课程 URL 中缺少 textbookId/courseId；门户 URL 的 courseId 是 ocId，请改用播放器 URL（ua.ulearning.cn/learnCourse/...）或 textbookId",
        )?;

    let oc_id = if explicit_textbook.is_some() {
        oc_id.or(course_id)
    } else {
        oc_id
    };
    Ok(UlCourse {
        textbook_id,
        oc_id,
        class_id,
        ..UlCourse::default()
    })
}

/// Build a cookie jar from Netscape records, preserving domain attributes.
fn jar_from_records(records: &[crate::cookie::CookieRecord]) -> Result<Arc<Jar>> {
    let jar = Jar::default();
    let base = Url::parse("https://api.ulearning.cn/").context("invalid cookie base URL")?;
    for record in records {
        let mut header = format!("{}={}", record.name, record.value);
        if !record.domain.is_empty() {
            header.push_str("; Domain=");
            header.push_str(record.domain.trim_start_matches('.'));
        }
        if !record.path.is_empty() {
            header.push_str("; Path=");
            header.push_str(&record.path);
        }
        if record.secure {
            header.push_str("; Secure");
        }
        jar.add_cookie_str(&header, &base);
    }
    Ok(Arc::new(jar))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bare_client() -> UlearningClient {
        UlearningClient::with_cookie_jar(Arc::new(Jar::default())).unwrap()
    }

    #[test]
    fn resolves_player_urls() {
        let client = bare_client();
        let course = client
            .resolve_course(
                "https://ua.ulearning.cn/learnCourse/learnCourse.html?courseId=47353&chapterId=141351390&classId=1019700",
            )
            .unwrap();
        assert_eq!(course.textbook_id, 47353);
        assert_eq!(course.class_id, Some(1_019_700));
        assert_eq!(course.oc_id, None);
    }

    #[test]
    fn resolves_query_and_plain_ids() {
        let client = bare_client();
        let from_query = client
            .resolve_course("textbookId=47353&ocId=165508&classId=1019700")
            .unwrap();
        assert_eq!(from_query.textbook_id, 47353);
        assert_eq!(from_query.oc_id, Some(165508));
        assert_eq!(from_query.class_id, Some(1_019_700));

        let from_pairs = client.resolve_course("47353;1019700").unwrap();
        assert_eq!(from_pairs.textbook_id, 47353);
        assert_eq!(from_pairs.class_id, Some(1_019_700));

        let bare = client.resolve_course("47353").unwrap();
        assert_eq!(bare.textbook_id, 47353);
        assert!(bare.class_id.is_none());
    }

    #[test]
    fn rejects_portal_course_urls_without_textbook() {
        let client = bare_client();
        // Portal `courseId` is the external ocId, not the internal textbook id.
        assert!(
            client
                .resolve_course("https://courseweb.ulearning.cn/ulearning/index.html#/course/textbook?courseId=165508")
                .is_err()
        );
    }

    #[test]
    fn cookie_header_populates_token() {
        let client =
            UlearningClient::from_cookie_header("AUTHORIZATION=test-token; OTHER=1").unwrap();
        assert_eq!(client.auth_token().unwrap(), "test-token");
        assert_eq!(
            client.cookie_value("AUTHORIZATION").as_deref(),
            Some("test-token")
        );
    }

    #[test]
    fn missing_token_is_a_clear_error() {
        let client = bare_client();
        let error = client.auth_token().unwrap_err().to_string();
        assert!(error.contains("AUTHORIZATION"));
    }

    #[test]
    fn maps_sync_results() {
        assert_eq!(
            parse_sync_outcome(&serde_json::json!(1)),
            UlSyncOutcome::Success
        );
        assert_eq!(
            parse_sync_outcome(&serde_json::json!(2)),
            UlSyncOutcome::CheatDetected
        );
        assert_eq!(
            parse_sync_outcome(&serde_json::json!(0)),
            UlSyncOutcome::Other(0)
        );
        assert_eq!(
            parse_sync_outcome(&serde_json::json!({"result": 1})),
            UlSyncOutcome::Success
        );
        assert_eq!(
            parse_sync_outcome(&serde_json::json!("bad")),
            UlSyncOutcome::Other(-1)
        );
    }
}
