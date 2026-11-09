//! Authenticated HTTP client for the Zhihuishu (智慧树 / 知到) APIs.
//!
//! Every request goes through [`ZhsClient`]: cookies live in a `reqwest` cookie
//! jar, `secretStr` bodies are encrypted with the per-module key, and errors are
//! normalized into [`ZhsError`]. The video/meet orchestration lives in
//! [`crate::zhihuishu::watch`] and [`crate::zhihuishu::meet`]; this module only
//! knows how to talk to the platform.
//!
//! Endpoint paths and request shapes were recovered from the live site; see the
//! plan's appendix A. The course-list endpoint is the one item that is still
//! unconfirmed, so [`ZhsClient::resolve_course`] offers the URL / secret
//! fallback the CLI and GUI use when [`ZhsClient::list_courses`] is unavailable.

use std::{
    collections::HashMap,
    fmt, fs,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use reqwest::{
    Client, StatusCode,
    cookie::{CookieStore, Jar},
    header::{ACCEPT, ACCEPT_LANGUAGE, CONTENT_TYPE, ORIGIN, REFERER, USER_AGENT},
};
use serde_json::{Value, json};
use url::Url;

use super::{
    APPCOMM_USER_BASE, COURSE_LIST_PATH, IM_BASE, IM_LIVE_VIDEOS_PATH, LIVE_BASE, LIVE_REFERER,
    LOGIN_USER_INFO_PATH, MEET_EXCEPTION_PATH, MEET_HISTORY_PATH, MEET_LIST_FALLBACK_PATH,
    MEET_LIST_PATH, MEET_SUBMIT_PATH, MODULE_COURSE_LIST, MODULE_MEET, MODULE_VIDEO, ONLINE_BASE,
    ONLINE_REFERER, ONLINE_SERVICE_BASE, ONLINE_SERVICE_REFERER, PRELEARNING_NOTE_PATH,
    QUERY_COURSE_PATH, QUERY_STUY_INFO_PATH, SAVE_INTERVAL_PATH, STUDY_BASE, STUDY_REFERER,
    STUONLINE_BASE, VIDEO_EXCEPTION_PATH, VIDEO_LIST_PATH, VIDEO_MODULE_KEY_FALLBACK,
    XOR_KEY_COURSE, XOR_KEY_MEET, ZHS_USER_AGENT,
};
use super::{
    crypto::{self, ModuleKeyCache},
    meet::{self, ZhsMeetWatchOptions},
    models::{
        ZhsCourse, ZhsCourseDetail, ZhsExceptionStatus, ZhsMeet, ZhsMeetProgress, ZhsMeetVideo,
        ZhsPrelearningNote, ZhsUser, ZhsVideoStudy, ZhsVideoTarget, ZhsWatchOptions,
        ZhsWatchOutcome,
    },
    watch,
};

/// Hosts that receive the Zhihuishu cookies.
const ZHS_COOKIE_HOSTS: [&str; 11] = [
    "https://www.zhihuishu.com/",
    "https://studyvideoh5.zhihuishu.com/",
    "https://studyservice-api.zhihuishu.com/",
    "https://appcomm-live-api.zhihuishu.com/",
    "https://appcomm-user.zhihuishu.com/",
    "https://onlineservice-api.zhihuishu.com/",
    "https://online.zhihuishu.com/",
    "https://stuonline.zhihuishu.com/",
    "https://lc.zhihuishu.com/",
    "https://im.zhihuishu.com/",
    "https://onlineweb.zhihuishu.com/",
];

/// Normalized Zhihuishu API error.
///
/// `endpoint` is the path only; it never contains cookies or `secretStr`
/// values. The client maps HTTP status failures and `code != 0` replies here so
/// the CLI and GUI can report a single, safe message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZhsError {
    /// Platform `code` (`0`/`200` mean success and never produce this error).
    pub code: i64,
    /// Platform message, sanitized to a short single line.
    pub message: String,
    /// Request path (no query string).
    pub endpoint: String,
}

impl ZhsError {
    fn new(code: i64, message: impl Into<String>, endpoint: impl Into<String>) -> Self {
        Self {
            code,
            message: sanitize_text(&message.into(), 160),
            endpoint: endpoint.into(),
        }
    }
}

impl fmt::Display for ZhsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "zhihuishu {} failed (code {}): {}",
            self.endpoint, self.code, self.message
        )
    }
}

impl std::error::Error for ZhsError {}

/// Remote bases the client talks to.
///
/// The defaults are the production Zhihuishu hosts. Integration tests replace
/// them with a local mock server through
/// [`ZhsClient::with_cookie_jar_and_endpoints`]; production callers should keep
/// [`ZhsEndpoints::default`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZhsEndpoints {
    /// `studyservice-api` (video course APIs and login validation).
    pub study: String,
    /// `appcomm-live-api` (meet replay APIs).
    pub live: String,
    /// `appcomm-user` (module-key handshake).
    pub appcomm_user: String,
    /// `online` (meet course list).
    pub online: String,
    /// `stuonline` (legacy meet list fallback).
    pub stuonline: String,
    /// `onlineservice-api` (shared-course list).
    pub online_service: String,
    /// `im.zhihuishu.com` (replay duration/video fallback).
    pub im: String,
}

impl Default for ZhsEndpoints {
    fn default() -> Self {
        Self {
            study: STUDY_BASE.to_string(),
            live: LIVE_BASE.to_string(),
            appcomm_user: APPCOMM_USER_BASE.to_string(),
            online: ONLINE_BASE.to_string(),
            stuonline: STUONLINE_BASE.to_string(),
            online_service: ONLINE_SERVICE_BASE.to_string(),
            im: IM_BASE.to_string(),
        }
    }
}

/// Short numeric id parsed from a JSON number or numeric string.
fn as_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_str()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|n| *n > 0)
    })
}

/// Signed id parsed from a JSON number or numeric string.
fn as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
}

/// First present key with a non-zero id.
fn get_u64(item: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(as_u64)
}

/// First present key with an integer value.
fn get_i64(item: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(as_i64)
}

/// First present key with a non-empty value; numbers are rendered as text so
/// numeric fields such as `courseType` keep working.
fn get_str(item: &Value, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(|value| match value {
            Value::String(text) => Some(text.trim().to_string()),
            Value::Number(_) => Some(value.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Parse a percentage that may be a number or a `"10.9%"` string.
fn parse_percent(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().trim_end_matches('%').trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// First present key with a boolean value.
fn get_bool(item: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(|value| match value {
            Value::Bool(b) => Some(*b),
            Value::Number(n) => Some(n.as_i64().unwrap_or(0) != 0),
            _ => None,
        })
}

/// First present key holding a JSON array.
fn get_array<'a>(item: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(Value::as_array)
}

/// `page.list` pagination envelope used by the student portal.
fn get_page_list(value: &Value) -> Option<&Vec<Value>> {
    value
        .get("page")
        .and_then(|page| get_array(page, &["list", "rows", "records"]))
}

/// Locate the first object under `rt`, `data` or `result`, falling back to the
/// root value. Zhihuishu endpoints are inconsistent across modules.
fn reply_object(value: &Value) -> &Value {
    for key in ["rt", "data", "result"] {
        if let Some(inner) = value.get(key)
            && inner.is_object()
        {
            return inner;
        }
    }
    value
}

/// Platform success codes: `0` for most APIs, `200` for the anti-cheat API.
fn is_success_code(code: i64) -> bool {
    code == 0 || code == 200
}

/// Extract the platform `code`, treating a missing field as success.
fn reply_code(value: &Value) -> i64 {
    ["code", "status", "resultCode"]
        .iter()
        .filter_map(|key| value.get(*key))
        .find_map(as_i64)
        .unwrap_or(0)
}

fn success_message(value: &Value) -> String {
    ["message", "msg", "errorMsg", "error_message"]
        .iter()
        .filter_map(|key| value.get(*key))
        .find_map(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Truncate and flatten text so error messages never contain newlines or long
/// payloads.
fn sanitize_text(text: &str, max_chars: usize) -> String {
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flattened.chars().take(max_chars).collect();
    if flattened.chars().count() > max_chars {
        out.push('…');
    }
    out
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Drop the request URL from a transport error before it enters the error chain.
///
/// Zhihuishu `secretStr` GET URLs carry the encrypted signature (and the
/// module-key handshake URL carries its RSA blob). Callers such as
/// `watch::run_video_watch` and `meet::run_meet_watch` format the full chain with
/// `{error:#}`, so a `reqwest::Error` source that keeps its URL would leak the
/// signature into logs. `without_url` keeps the error type and wording while
/// removing the URL.
fn strip_error_url(error: reqwest::Error) -> reqwest::Error {
    error.without_url()
}

/// Percent-encode a list of query/form pairs the way the site does.
fn form_encode(pairs: &[(&str, &str)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

/// `scheme://host` origin for a referer, used for `Origin` headers.
fn origin_of(referer: &str) -> String {
    Url::parse(referer)
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| format!("{}://{host}", url.scheme()))
        })
        .unwrap_or_default()
}

/// Strip a JSONP callback wrapper (`callback({...})`).
fn strip_jsonp(text: &str) -> Result<&str> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return Ok(trimmed);
    }
    let start = trimmed
        .find('(')
        .context("JSONP response is missing the callback parenthesis")?;
    let end = trimmed
        .rfind(')')
        .context("JSONP response is missing the closing parenthesis")?;
    if end <= start {
        bail!("invalid JSONP response");
    }
    Ok(trimmed[start + 1..end].trim())
}

fn json_array(value: &Value) -> Option<&Vec<Value>> {
    value.as_array()
}

/// Parse a `getWatchHistory` payload (`rt` string, array or nested object).
fn parse_minutes(value: &Value) -> Vec<u32> {
    match value {
        Value::Null => Vec::new(),
        Value::String(text) => text
            .split(',')
            .filter_map(|part| part.trim().parse::<u32>().ok())
            .collect(),
        Value::Number(number) => number.as_u64().map(|n| vec![n as u32]).unwrap_or_default(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::Number(n) => n.as_u64().map(|n| n as u32),
                Value::String(s) => s.trim().parse::<u32>().ok(),
                _ => None,
            })
            .collect(),
        Value::Object(map) => ["rt", "data", "history", "watchHistory", "list"]
            .iter()
            .filter_map(|key| map.get(*key))
            .find_map(|inner| {
                let minutes = parse_minutes(inner);
                (!minutes.is_empty()).then_some(minutes)
            })
            .unwrap_or_default(),
        Value::Bool(_) => Vec::new(),
    }
}

/// Parse the shared-course list payload, tolerating the several shapes the
/// platform uses for list endpoints.
fn parse_course_list(value: &Value) -> Vec<ZhsCourse> {
    let data = value.get("data").unwrap_or(value);
    let items: &Vec<Value> = data
        .as_array()
        .or_else(|| {
            get_array(
                data,
                &[
                    "courseList",
                    "courseOpenDtos",
                    "shareCourseDtos",
                    "list",
                    "rows",
                ],
            )
        })
        .or_else(|| {
            get_array(
                reply_object(value),
                &[
                    "courseList",
                    "courseOpenDtos",
                    "shareCourseDtos",
                    "list",
                    "rows",
                ],
            )
        })
        .or_else(|| {
            value
                .get("rt")
                .and_then(json_array)
                .or_else(|| value.get("result").and_then(json_array))
        })
        .unwrap_or(&EMPTY_ARRAY);

    items
        .iter()
        .filter_map(|item| {
            // Some list responses nest the ids under `courseInfo` / `course`.
            let nested = ["courseInfo", "course", "recruitCourseDto"]
                .iter()
                .filter_map(|key| item.get(*key))
                .find(|v| v.is_object());
            let sources: Vec<&Value> = nested.into_iter().chain(std::iter::once(item)).collect();
            let pick = |keys: &[&str]| -> Option<u64> {
                sources.iter().find_map(|source| get_u64(source, keys))
            };
            let text = |keys: &[&str]| -> String {
                sources
                    .iter()
                    .map(|source| get_str(source, keys))
                    .find(|text| !text.is_empty())
                    .unwrap_or_default()
            };

            let recruit_id = pick(&["recruitId", "recruit_id"])?;
            let course_id = pick(&["courseId", "course_id"])?;
            let secret = sources
                .iter()
                .map(|source| get_str(source, &["secret", "recruitAndCourseId"]))
                .find(|text| !text.is_empty());
            Some(ZhsCourse {
                recruit_id,
                course_id,
                class_id: pick(&["classId", "class_id", "teachingClassId"]),
                school_id: pick(&["schoolId", "school_id"]),
                name: text(&["courseName", "name", "title"]),
                teacher: text(&["teacherName", "teacher", "speakerUserName"]),
                secret,
                is_apply: get_i64(item, &["isApply", "is_apply"]),
                course_type: Some(text(&["courseType", "courseTypeName", "type"]))
                    .filter(|t| !t.is_empty()),
                progress: item
                    .get("progress")
                    .or_else(|| item.get("studyProgress"))
                    .and_then(parse_percent),
                studied_lesson_count: get_u64(item, &["studiedLessonCount", "finishedLessonCount"])
                    .map(|n| n as usize),
                total_lesson_count: get_u64(item, &["totalLessonCount", "lessonCount"])
                    .map(|n| n as usize),
                status: get_i64(item, &["status", "courseStatus"]),
            })
        })
        .collect()
}

static EMPTY_ARRAY: Vec<Value> = Vec::new();

/// `totalCount` of the measured `queryShareCourseInfo` response.
fn parse_course_list_total(value: &Value) -> Option<u64> {
    value
        .pointer("/result/totalCount")
        .or_else(|| value.get("totalCount"))
        .or_else(|| value.get("total"))
        .and_then(Value::as_u64)
}

/// Payload of one measured shared-course list page.
///
/// Field names are `pageNo`/`pageSize` (not `pageNum`), and there is **no**
/// `dateFormate` inside the plaintext.
fn course_list_payload(page_no: u64, page_size: u64) -> Value {
    json!({
        "status": 0,
        "pageNo": page_no,
        "pageSize": page_size,
    })
}

/// Parse the `videolist` chapter tree.
fn parse_chapters(data: &Value) -> Result<Vec<super::models::ZhsChapter>> {
    let chapters = get_array(
        data,
        &[
            "videoChapterDtos",
            "videoChapterDtoList",
            "chapters",
            "videoChapters",
        ],
    )
    .or_else(|| data.as_array())
    .context("videolist response is missing videoChapterDtos")?;

    let mut out = Vec::with_capacity(chapters.len());
    for chapter in chapters {
        let lessons = get_array(chapter, &["videoLessons", "lessons", "videoLessonDtos"])
            .map(|items| parse_lessons(items))
            .unwrap_or_default();
        out.push(super::models::ZhsChapter {
            chapter_id: get_u64(chapter, &["id", "chapterId", "chapter_id"]),
            name: get_str(chapter, &["name", "chapterName"]),
            learning_lesson_status: get_i64(chapter, &["learningLessonStatus"]),
            is_pass: get_i64(chapter, &["isPass"]),
            limit_checked: get_bool(chapter, &["limitChecked", "limit_checked"]),
            lessons,
        });
    }
    Ok(out)
}

fn parse_lessons(items: &[Value]) -> Vec<super::models::ZhsLesson> {
    items
        .iter()
        .map(|lesson| super::models::ZhsLesson {
            lesson_id: get_u64(lesson, &["id", "lessonId"]).unwrap_or(0),
            name: get_str(lesson, &["name", "lessonName"]),
            is_studied: get_i64(lesson, &["isStudiedLesson", "isStudied"]),
            video_id: get_u64(lesson, &["videoId"]),
            video_sec: get_u64(lesson, &["videoSec", "videoLength"]),
            videos: get_array(
                lesson,
                &["videoSmallLessons", "videoSmallLessonDtos", "smallLessons"],
            )
            .map(|videos| parse_videos(videos))
            .unwrap_or_default(),
        })
        .collect()
}

fn parse_videos(items: &[Value]) -> Vec<super::models::ZhsVideo> {
    items
        .iter()
        .filter_map(|video| {
            let video_id = get_u64(video, &["videoId"])?;
            let lesson_video_id = get_u64(video, &["id", "lessonVideoId", "videoSmallLessonId"])?;
            Some(super::models::ZhsVideo {
                video_id,
                lesson_video_id,
                video_sec: get_u64(video, &["videoSec", "videoLength", "duration"]).unwrap_or(0),
                is_studied: get_i64(video, &["isStudiedLesson", "isStudied"]),
                name: get_str(video, &["name", "videoName", "smallLessonName"]),
            })
        })
        .collect()
}

/// Parse a meet list payload into [`ZhsMeet`] entries.
///
/// The live student portal returns the four meet sessions in a **top-level
/// `maps` array** (confirmed by the userscript against a logged-in capture on
/// 2026-11-07). The other envelopes and keys below are compatibility aliases
/// kept for older builds; `maps` is the layout to rely on.
fn parse_meets(value: &Value, course: &ZhsCourse) -> Vec<ZhsMeet> {
    let data = value.get("data").unwrap_or(value);
    let items: &Vec<Value> = data
        .as_array()
        .or_else(|| {
            get_array(
                data,
                &[
                    "list",
                    "meetList",
                    "meetingList",
                    "teachMeetingList",
                    "teachMeetingStuList",
                    "rows",
                ],
            )
        })
        .or_else(|| get_page_list(data))
        .or_else(|| get_array(data, &["maps"]))
        .or_else(|| {
            get_array(
                reply_object(value),
                &[
                    "list",
                    "meetList",
                    "meetingList",
                    "teachMeetingList",
                    "teachMeetingStuList",
                    "rows",
                ],
            )
        })
        .or_else(|| get_page_list(reply_object(value)))
        .or_else(|| value.get("maps").and_then(json_array))
        .or_else(|| value.get("rt").and_then(json_array))
        .or_else(|| value.get("result").and_then(json_array))
        .unwrap_or(&EMPTY_ARRAY);

    items
        .iter()
        .filter_map(|item| {
            let live_id = get_u64(
                item,
                &[
                    "liveId",
                    "liveCourseId",
                    "liveCourseID",
                    "liveRoomId",
                    "courseId",
                ],
            )?;
            let meet_course_id =
                get_u64(item, &["meetCourseId", "meetCourseID", "id", "meetId"]).unwrap_or(live_id);
            let replay_url = Some(get_str(
                item,
                &[
                    "replayCourseUrl",
                    "replayUrl",
                    "replayCourse",
                    "playbackUrl",
                ],
            ))
            .filter(|text| !text.is_empty());
            let exam_url = Some(get_str(
                item,
                &["examH5Url", "examUrl", "examH5", "quizUrl"],
            ))
            .filter(|text| !text.is_empty());
            Some(ZhsMeet {
                meet_course_id,
                live_id,
                video_id: get_u64(item, &["videoId", "replayVideoId", "curVideoId"]),
                recruit_id: course.recruit_id,
                course_id: course.course_id,
                name: get_str(
                    item,
                    &[
                        "meetName",
                        "taskName",
                        "courseName",
                        "name",
                        "title",
                        "teachMeetingName",
                    ],
                ),
                teacher: parse_speaker_name(item),
                start_time: Some(get_str(
                    item,
                    &["startTime", "startTimeStr", "liveStartTime", "startDate"],
                ))
                .filter(|text| !text.is_empty()),
                end_time: Some(get_str(
                    item,
                    &["endTime", "endTimeStr", "liveEndTime", "endDate"],
                ))
                .filter(|text| !text.is_empty()),
                replay_url,
                exam_url,
                duration_secs: get_u64(
                    item,
                    &[
                        "duration",
                        "videoDuration",
                        "replayDuration",
                        "durationSec",
                        "totalTime",
                    ],
                ),
                status: get_i64(item, &["status", "taskStatus", "examStatus", "meetStatus"]),
            })
        })
        .collect()
}

/// Speaker name of a meet list entry.
///
/// The real response stores the speaker as a JSON **string** in `speakerJson`
/// (`[{"name":..}]` or `{"name":..}`), while older builds expose flat
/// `teacherName` / `speakerName` keys; support both.
fn parse_speaker_name(item: &Value) -> String {
    let direct = get_str(
        item,
        &[
            "teacherName",
            "speakerUserName",
            "speakerName",
            "teacher",
            "hostName",
        ],
    );
    if !direct.is_empty() {
        return direct;
    }
    let raw = get_str(item, &["speakerJson", "speakerInfo"]);
    if raw.is_empty() {
        return String::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return raw.trim().to_string();
    };
    match value {
        Value::Array(items) => items
            .iter()
            .find_map(|entry| {
                let name = get_str(entry, &["name", "speakerName", "userName", "realName"]);
                (!name.is_empty()).then_some(name)
            })
            .unwrap_or_default(),
        Value::Object(_) => get_str(&value, &["name", "speakerName", "userName", "realName"]),
        Value::String(text) => text.trim().to_string(),
        _ => String::new(),
    }
}

/// Parse an anti-cheat status reply.
fn parse_exception(value: &Value, label: &str) -> ZhsExceptionStatus {
    let object = reply_object(value);
    let lock = get_bool(
        object,
        &["lock", "isLock", "locked", "forbid", "restricted"],
    )
    .or_else(|| get_bool(value, &["lock", "isLock"]))
    .unwrap_or(false);
    let end_time = get_str(object, &["endTime", "end_time", "lockEndTime"]);
    let abnormal_field = get_bool(object, &["abnormal", "isAbnormal", "exception", "punished"]);
    let abnormal = abnormal_field.unwrap_or(!end_time.is_empty()) || lock;
    let message = {
        let text = success_message(object);
        if text.is_empty() {
            success_message(value)
        } else {
            text
        }
    };
    let tip = get_str(object, &["tipStr", "tip", "actionTip"]);
    let message = if !tip.is_empty() { tip } else { message };
    ZhsExceptionStatus {
        lock,
        abnormal,
        message: if message.is_empty() {
            format!("{label}风控状态正常")
        } else {
            sanitize_text(&message, 160)
        },
    }
}

/// Authenticated Zhihuishu client.
#[derive(Clone)]
pub struct ZhsClient {
    http: Client,
    jar: Arc<Jar>,
    keys: Arc<ModuleKeyCache>,
    user: Arc<Mutex<Option<ZhsUser>>>,
    endpoints: ZhsEndpoints,
}

impl ZhsClient {
    /// Build a client from an already populated cookie jar.
    pub fn with_cookie_jar(jar: Arc<Jar>) -> Result<Self> {
        Self::with_cookie_jar_and_endpoints(jar, ZhsEndpoints::default())
    }

    /// Build a client from a cookie jar and non-default endpoints.
    ///
    /// Integration tests use this hook to point every base URL at a local mock
    /// server; production code should keep [`ZhsEndpoints::default`].
    pub fn with_cookie_jar_and_endpoints(jar: Arc<Jar>, endpoints: ZhsEndpoints) -> Result<Self> {
        crypto::crypto_self_check()?;
        let http = Client::builder()
            .cookie_provider(Arc::clone(&jar))
            .user_agent(ZHS_USER_AGENT)
            .timeout(Duration::from_secs(40))
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
            .context("failed to build the Zhihuishu HTTP client")?;
        Ok(Self {
            http,
            jar,
            keys: Arc::new(ModuleKeyCache::default()),
            user: Arc::new(Mutex::new(None)),
            endpoints,
        })
    }

    /// Endpoints this client talks to (production hosts by default).
    pub fn endpoints(&self) -> &ZhsEndpoints {
        &self.endpoints
    }

    /// Load cookies from a browser-exported Netscape `cookies.txt` file.
    pub fn from_cookie_file(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_cookie_file_with_endpoints(path, ZhsEndpoints::default())
    }

    /// Load a Netscape cookie file and use non-default endpoints.
    pub fn from_cookie_file_with_endpoints(
        path: impl AsRef<Path>,
        endpoints: ZhsEndpoints,
    ) -> Result<Self> {
        let path = path.as_ref();
        let contents = fs::read_to_string(path)
            .with_context(|| format!("failed to read cookie file {}", path.display()))?;
        let records = crate::cookie::parse_netscape_cookies(&contents);
        if records.is_empty() {
            bail!(
                "no cookies found in {} (expected a Netscape cookies.txt export for zhihuishu.com)",
                path.display()
            );
        }
        let jar = jar_from_records(&records)?;
        Self::with_cookie_jar_and_endpoints(jar, endpoints)
    }

    /// Build a client from a raw `Cookie:` header value.
    pub fn from_cookie_header(header: &str) -> Result<Self> {
        Self::from_cookie_header_with_endpoints(header, ZhsEndpoints::default())
    }

    /// Build a client from a raw `Cookie:` header and non-default endpoints.
    pub fn from_cookie_header_with_endpoints(
        header: &str,
        endpoints: ZhsEndpoints,
    ) -> Result<Self> {
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
        for host in ZHS_COOKIE_HOSTS {
            let url = Url::parse(host).context("invalid built-in Zhihuishu cookie host")?;
            for (name, value) in &pairs {
                jar.add_cookie_str(&format!("{name}={value}"), &url);
            }
        }
        Self::with_cookie_jar_and_endpoints(Arc::new(jar), endpoints)
    }

    /// Read a cookie value from the jar.
    pub fn cookie_value(&self, name: &str) -> Option<String> {
        for host in ZHS_COOKIE_HOSTS {
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

    /// Parse the `CASLOGC` cookie into a [`ZhsUser`] skeleton.
    fn user_from_cookie(&self) -> Result<ZhsUser> {
        let raw = self.cookie_value("CASLOGC").context(
            "CASLOGC cookie is missing; log in to zhihuishu.com in the browser and export fresh cookies",
        )?;
        let decoded = percent_encoding::percent_decode_str(&raw).decode_utf8_lossy();
        let value: Value =
            serde_json::from_str(decoded.trim()).context("CASLOGC cookie is not JSON")?;
        let mut user = ZhsUser::default();
        merge_user(&mut user, &value);
        if user.user_id == 0 || user.uuid.is_empty() {
            bail!("CASLOGC cookie does not contain userId/uuid");
        }
        Ok(user)
    }

    /// Validate the session and return the logged-in user.
    pub async fn login_user(&self) -> Result<ZhsUser> {
        let value = self
            .get_secret(
                &self.endpoints.study,
                LOGIN_USER_INFO_PATH,
                MODULE_VIDEO,
                &json!({}),
                STUDY_REFERER,
            )
            .await
            .context("getLoginUserInfo failed; the Zhihuishu session may be missing or expired")?;
        let mut user = self.user_from_cookie().unwrap_or_default();
        let data = value
            .get("data")
            .filter(|v| v.is_object())
            .or_else(|| value.get("rt").filter(|v| v.is_object()))
            .unwrap_or(&value);
        merge_user(&mut user, data);
        if user.user_id == 0 || user.uuid.is_empty() {
            bail!("知到登录状态无效：未找到用户标识，请重新登录知到或更新 cookies");
        }
        {
            let mut cached = self.user.lock().unwrap_or_else(|e| e.into_inner());
            *cached = Some(user.clone());
        }
        Ok(user)
    }

    /// Logged-in user, using the cached copy when available.
    pub async fn current_user(&self) -> Result<ZhsUser> {
        if let Some(user) = self.user.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Ok(user);
        }
        self.login_user().await
    }

    /// Shared-course list for the current account.
    ///
    /// Measured 2026-11-08:
    /// `POST onlineservice-api/.../queryShareCourseInfo` with
    /// `secretStr=AES(module 13, {"status":0,"pageNo":N,"pageSize":M})&date=<ms>`;
    /// the response is `{"result":{"totalCount":N,"courseOpenDtos":[...]},"code":200}`.
    /// Pages are fetched until `totalCount` is reached.
    pub async fn list_courses(&self) -> Result<Vec<ZhsCourse>> {
        const PAGE_SIZE: u64 = 50;
        let mut courses = Vec::new();
        let mut total_count = None;

        for page_no in 1..=20u64 {
            let payload = course_list_payload(page_no, PAGE_SIZE);
            let value = self
                .post_secret_dated(
                    &self.endpoints.online_service,
                    COURSE_LIST_PATH,
                    MODULE_COURSE_LIST,
                    &payload,
                    ONLINE_SERVICE_REFERER,
                )
                .await
                .with_context(
                    || "知到课程列表接口不可用；请改用学习页 URL 或 recruitAndCourseId 指定课程",
                )?;

            if total_count.is_none() {
                total_count = parse_course_list_total(&value);
            }
            let page = parse_course_list(&value);
            let fetched = page.len();
            courses.extend(page);
            let total = total_count.unwrap_or(courses.len() as u64);
            if fetched == 0
                || courses.len() as u64 >= total
                || fetched < PAGE_SIZE as usize
                || page_no == 20
            {
                break;
            }
        }

        if courses.is_empty() {
            bail!(
                "知到课程列表返回为空或格式未知；请改用学习页 URL 或 recruitAndCourseId 指定课程"
            );
        }
        Ok(courses)
    }

    /// Resolve a course reference into a [`ZhsCourse`].
    ///
    /// Accepted forms: a study-page URL (with `recruitAndCourseId` or
    /// `recruitId`/`courseId` query parameters), a `recruitAndCourseId` secret,
    /// `recruitId;courseId`, `recruitId/courseId`, or a bare id that must match
    /// the course list.
    pub async fn resolve_course(&self, reference: &str) -> Result<ZhsCourse> {
        let reference = reference.trim();
        if reference.is_empty() {
            bail!("课程引用为空");
        }
        if let Some(course) = parse_course_reference(reference) {
            return Ok(course);
        }
        if reference.chars().all(|ch| ch.is_ascii_digit()) {
            let target = reference
                .parse::<u64>()
                .context("invalid numeric course id")?;
            let courses = self.list_courses().await?;
            return courses
                .into_iter()
                .find(|course| course.course_id == target || course.recruit_id == target)
                .with_context(|| {
                    format!(
                        "在课程列表中未找到 id {target}；请改用学习页 URL 或 recruitId;courseId"
                    )
                });
        }
        bail!(
            "无法识别的课程引用：{}（支持学习页 URL、recruitAndCourseId、recruitId;courseId）",
            sanitize_text(reference, 80)
        )
    }

    /// Fetch the chapter/video tree of one shared course.
    pub async fn course_detail(&self, course: &ZhsCourse) -> Result<ZhsCourseDetail> {
        if course.is_polymas() {
            bail!("暂不支持 polymas/翻转课：{}", course.label());
        }
        // `queryCourse` is best effort: it supplies `isApply`/`classId` when the
        // course list did not, and a failure must not block the video tree.
        let mut course = course.clone();
        if course.is_apply.is_none() {
            match self.query_course(&course).await {
                Ok(updated) => course = updated,
                Err(error) => log::debug!("queryCourse unavailable: {error:#}"),
            }
        }
        let payload = json!({ "recruitAndCourseId": course.secret_or_derive() });
        let value = self
            .post_secret(
                &self.endpoints.study,
                VIDEO_LIST_PATH,
                MODULE_VIDEO,
                &payload,
                STUDY_REFERER,
            )
            .await
            .with_context(|| format!("failed to fetch the video tree of {}", course.label()))?;
        let data = value.get("data").unwrap_or(&value);
        let chapters = parse_chapters(data)?;
        Ok(ZhsCourseDetail { course, chapters })
    }

    /// Best-effort shared-course metadata (`isApply`, `classId`, name).
    ///
    /// The exact `queryCourse` payload is not captured yet; the
    /// `recruitAndCourseId` shape matches the sibling `queryCourseDispMode`
    /// request and is tolerated by the endpoint. Callers treat a failure as
    /// non-fatal.
    pub async fn query_course(&self, course: &ZhsCourse) -> Result<ZhsCourse> {
        let payload = json!({ "recruitAndCourseId": course.secret_or_derive() });
        let value = self
            .post_secret(
                &self.endpoints.study,
                QUERY_COURSE_PATH,
                MODULE_VIDEO,
                &payload,
                STUDY_REFERER,
            )
            .await?;
        let data = value.get("data").unwrap_or(&value);
        let mut updated = course.clone();
        if let Some(is_apply) = get_i64(data, &["isApply", "is_apply"]) {
            updated.is_apply = Some(is_apply);
        }
        if let Some(class_id) = get_u64(data, &["classId", "class_id", "teachingClassId"]) {
            updated.class_id = Some(class_id);
        }
        if let Some(school_id) = get_u64(data, &["schoolId", "school_id"]) {
            updated.school_id = Some(school_id);
        }
        if updated.name.trim().is_empty() {
            let name = get_str(data, &["courseName", "name", "title"]);
            if !name.is_empty() {
                updated.name = name;
            }
        }
        Ok(updated)
    }

    /// Build the video plan for one course.
    pub async fn plan_videos(
        &self,
        detail: &ZhsCourseDetail,
        opts: &ZhsWatchOptions,
    ) -> Result<Vec<ZhsVideoTarget>> {
        Ok(watch::plan_videos(detail, opts))
    }

    /// Execute a video plan with progress reporting and cancellation.
    pub async fn watch_videos(
        &self,
        targets: &[ZhsVideoTarget],
        opts: &ZhsWatchOptions,
        progress: &(dyn Fn(super::models::ZhsProgress) -> bool + Send + Sync),
    ) -> Result<Vec<ZhsWatchOutcome>> {
        watch::run_video_watch(self, targets, opts, progress).await
    }

    /// Fetch the fresh study note (`noteId`) of one video.
    pub async fn prelearning_note(
        &self,
        course: &ZhsCourse,
        target: &ZhsVideoTarget,
    ) -> Result<ZhsPrelearningNote> {
        let payload = json!({
            "ccCourseId": course.course_id,
            "chapterId": target.chapter_id,
            "isApply": course.is_apply.unwrap_or(1),
            "lessonId": target.lesson_id,
            "lessonVideoId": target.lesson_video_id,
            "recruitId": target.recruit_id,
            "videoId": target.video_id,
        });
        let value = self
            .post_secret(
                &self.endpoints.study,
                PRELEARNING_NOTE_PATH,
                MODULE_VIDEO,
                &payload,
                STUDY_REFERER,
            )
            .await?;
        let dto = value
            .pointer("/data/studiedLessonDto")
            .context("prelearningNote response is missing data.studiedLessonDto")?;
        let note_id = dto
            .get("id")
            .and_then(as_u64)
            .context("prelearningNote response is missing studiedLessonDto.id")?;
        Ok(ZhsPrelearningNote {
            note_id,
            watch_state: dto.get("watchState").and_then(as_i64),
            study_total_time: dto.get("studyTotalTime").and_then(as_u64),
            is_studied: dto.get("isStudiedLesson").and_then(as_i64),
        })
    }

    /// Query per-video study state (`watchState`).
    pub async fn query_stuy_info(
        &self,
        recruit_id: u64,
        lesson_ids: &[u64],
        video_ids: &[u64],
    ) -> Result<HashMap<u64, ZhsVideoStudy>> {
        let payload = json!({
            "lessonIds": lesson_ids,
            "lessonVideoIds": video_ids,
            "recruitId": recruit_id,
        });
        let value = self
            .post_secret(
                &self.endpoints.study,
                QUERY_STUY_INFO_PATH,
                MODULE_VIDEO,
                &payload,
                STUDY_REFERER,
            )
            .await?;
        let lv = value
            .pointer("/data/lv")
            .and_then(Value::as_object)
            .context("queryStuyInfo response is missing data.lv")?;
        let mut states = HashMap::with_capacity(lv.len());
        for (key, item) in lv {
            let Ok(video_id) = key.parse::<u64>() else {
                continue;
            };
            states.insert(
                video_id,
                ZhsVideoStudy {
                    video_id,
                    watch_state: item.get("watchState").and_then(as_i64),
                    study_total_time: item.get("studyTotalTime").and_then(as_u64),
                },
            );
        }
        Ok(states)
    }

    /// Send one video completion report.
    pub async fn save_interval(
        &self,
        course: &ZhsCourse,
        ewssw: &str,
        sdsew: &str,
        zwsds: &str,
    ) -> Result<bool> {
        let payload = json!({
            "ewssw": ewssw,
            "sdsew": sdsew,
            "zwsds": zwsds,
            "courseId": course.course_id,
        });
        let value = self
            .post_secret(
                &self.endpoints.study,
                SAVE_INTERVAL_PATH,
                MODULE_VIDEO,
                &payload,
                STUDY_REFERER,
            )
            .await?;
        Ok(value
            .pointer("/data/submitSuccess")
            .and_then(Value::as_bool)
            .unwrap_or(true))
    }

    /// Video-course anti-cheat status.
    pub async fn exception_status(&self, course: &ZhsCourse) -> Result<ZhsExceptionStatus> {
        let mut payload = json!({ "recruitId": course.recruit_id });
        if let Some(school_id) = course
            .school_id
            .or_else(|| self.user_from_cookie().ok().and_then(|u| u.school_id))
        {
            payload["schoolId"] = json!(school_id);
        }
        let value = self
            .get_secret(
                &self.endpoints.study,
                VIDEO_EXCEPTION_PATH,
                MODULE_VIDEO,
                &payload,
                STUDY_REFERER,
            )
            .await?;
        Ok(parse_exception(&value, "视频课"))
    }

    /// Meet course (见面课) list of one shared course.
    ///
    /// Verified live on 2026-11-08: the student portal serves the list from
    /// `stuonline.zhihuishu.com/stuonline/json/teachMeeting/listTeachMeetingStu?examV2=ss`
    /// with the form fields `recruitId`, `page.pageNo`, `page.pageSize` and an
    /// `X-Requested-With: XMLHttpRequest` header. The response is a JSON object
    /// whose `maps` array holds the sessions and whose `mapCount` is the total.
    /// The legacy `online.zhihuishu.com/onlineSchool/...` host is kept as a
    /// fallback. Entries without a `liveId` are dropped, and replay-only
    /// filtering is left to the caller through [`ZhsMeet::has_replay`].
    pub async fn meet_list(&self, course: &ZhsCourse) -> Result<Vec<ZhsMeet>> {
        let referer = format!(
            "https://stuonline.zhihuishu.com/stuonline/teachMeeting/stuListV2?recruitId={}",
            course.recruit_id
        );
        let recruit_id = course.recruit_id.to_string();
        let mut meets = Vec::new();
        let mut page: u32 = 0;
        let mut total: u64 = u64::MAX;
        loop {
            let page_no = page.to_string();
            let body = form_encode(&[
                ("recruitId", recruit_id.as_str()),
                ("page.pageNo", page_no.as_str()),
                ("page.pageSize", "10"),
            ]);
            let primary = self
                .post_form(&self.endpoints.stuonline, MEET_LIST_PATH, &body, &referer)
                .await;
            let value = match primary {
                Ok(value) => value,
                Err(primary_error) => {
                    log::debug!(
                        "meet-list primary endpoint failed ({primary_error:#}); trying the online fallback"
                    );
                    self.post_form(
                        &self.endpoints.online,
                        MEET_LIST_FALLBACK_PATH,
                        &body,
                        ONLINE_REFERER,
                    )
                    .await
                    .with_context(|| format!("failed to list meet courses of {}", course.label()))?
                }
            };
            if let Some(count) = value.get("mapCount").and_then(Value::as_u64) {
                total = count;
            }
            let page_meets = parse_meets(&value, course);
            let empty = page_meets.is_empty();
            meets.extend(page_meets);
            if empty || meets.len() as u64 >= total || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(meets)
    }

    /// Replay length in seconds of one meet course.
    ///
    /// The meet list usually exposes it directly; when it does not, fall back to
    /// the live-page video list endpoint. The endpoint reports milliseconds on
    /// some accounts and seconds on others, so implausibly large totals are
    /// converted from milliseconds.
    pub async fn meet_duration_secs(&self, meet: &ZhsMeet) -> Result<u64> {
        if let Some(secs) = meet.duration_secs.filter(|secs| *secs > 0) {
            // Durations above ~27 hours only happen when the field is
            // milliseconds; normalize them to seconds.
            return Ok(if secs > 100_000 { secs / 1000 } else { secs });
        }
        let value = self.fetch_live_videos(meet).await?;
        let total = collect_durations(&value);
        if total == 0 {
            bail!(
                "无法获取见面课「{}」的回放时长，无法计算考勤分钟数",
                meet.label()
            );
        }
        // Durations above ~27 hours only happen when the field is milliseconds.
        Ok(if total > 100_000 { total / 1000 } else { total })
    }

    /// Replay video list with durations of one meet course.
    ///
    /// Multi-video replays need this: the minute report carries the `videoId` of
    /// the video the minute belongs to, and the caller maps minutes to ids with
    /// the durations. When the meet list only exposes one `videoId` the returned
    /// entry has whatever duration the meet list reported (`0` when unknown).
    pub async fn meet_video_infos(&self, meet: &ZhsMeet) -> Result<Vec<ZhsMeetVideo>> {
        if let Some(video_id) = meet.video_id.filter(|video_id| *video_id > 0) {
            let duration_secs = meet
                .duration_secs
                .filter(|secs| *secs > 0)
                .map(|secs| if secs > 100_000 { secs / 1000 } else { secs })
                .unwrap_or(0);
            return Ok(vec![ZhsMeetVideo {
                video_id,
                duration_secs,
            }]);
        }
        let value = self.fetch_live_videos(meet).await?;
        let mut infos = Vec::new();
        collect_video_infos(&value, &mut infos);
        if infos.is_empty() {
            bail!("无法获取见面课「{}」的回放视频 id", meet.label());
        }
        Ok(infos)
    }

    /// Replay video ids of one meet course.
    ///
    /// The minute report needs an actual replay `videoId`; use the id from the
    /// meet list when present, otherwise read the live-page video list. The
    /// first id is the one the page reports for `watchType=2`.
    pub async fn meet_video_ids(&self, meet: &ZhsMeet) -> Result<Vec<u64>> {
        let mut ids: Vec<u64> = self
            .meet_video_infos(meet)
            .await?
            .into_iter()
            .map(|video| video.video_id)
            .collect();
        ids.sort_unstable();
        ids.dedup();
        Ok(ids)
    }

    /// Fetch the live-page replay video list (JSONP).
    async fn fetch_live_videos(&self, meet: &ZhsMeet) -> Result<Value> {
        let url = format!("{}{IM_LIVE_VIDEOS_PATH}", self.endpoints.im);
        let response = self
            .http
            .get(&url)
            .query(&[
                ("liveId", meet.live_id.to_string()),
                ("jsonpCallBack", "jsonpCallBack".to_string()),
                ("_", unix_millis().to_string()),
            ])
            .header(REFERER, LIVE_REFERER)
            .header(ORIGIN, origin_of(LIVE_REFERER))
            .header(USER_AGENT, ZHS_USER_AGENT)
            .send()
            .await
            .map_err(strip_error_url)
            .context("failed to fetch the replay video list")?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(strip_error_url)
            .context("failed to read the replay video list")?;
        if !status.is_success() {
            bail!("replay video list returned HTTP {status}");
        }
        serde_json::from_str(strip_jsonp(&text)?).context("replay video list is not JSON")
    }

    /// Replay attendance progress of one meet course.
    pub async fn meet_progress(&self, meet: &ZhsMeet) -> Result<ZhsMeetProgress> {
        let total_secs = self.meet_duration_secs(meet).await?;
        let total_minutes = total_secs.div_ceil(60).max(1) as u32;
        let watched = self.meet_watch_history(meet).await?;
        Ok(ZhsMeetProgress::new(total_minutes, watched))
    }

    /// Watched minute numbers of one meet replay.
    pub async fn meet_watch_history(&self, meet: &ZhsMeet) -> Result<Vec<u32>> {
        let user = self.current_user().await?;
        let payload = json!({
            "courseId": meet.live_id,
            "userId": user.user_id,
        });
        let value = self
            .get_live_secret(MEET_HISTORY_PATH, &payload, LIVE_REFERER)
            .await?;
        let minutes = if value.get("rt").is_some() {
            parse_minutes(value.get("rt").unwrap_or(&Value::Null))
        } else if value.get("data").is_some() {
            parse_minutes(value.get("data").unwrap_or(&Value::Null))
        } else {
            parse_minutes(&value)
        };
        let mut minutes = minutes;
        minutes.sort_unstable();
        minutes.dedup();
        Ok(minutes)
    }

    /// Report one watched minute of a meet replay.
    ///
    /// Verified form (userscript + live test): `GET setWatchHistorySecret` with
    /// `secretStr = AES(module 9, {"paramSecret":..,"jsonpCallBack":..})`; the
    /// plain `paramSecret` query form is rejected by the server.
    ///
    /// This convenience overload uses the meet list `videoId`; multi-video
    /// replays must use [`Self::meet_set_minute_for_video`].
    pub async fn meet_set_minute(&self, meet: &ZhsMeet, minute: u32) -> Result<()> {
        self.meet_set_minute_for_video(meet, minute, meet.video_id.unwrap_or(0))
            .await
    }

    /// Report one watched minute of a specific replay video.
    ///
    /// Multi-video replays map each minute to the video it belongs to (see
    /// [`crate::zhihuishu::meet::video_id_for_minute`]); the `videoId` is part of
    /// the XOR `paramSecret`.
    pub async fn meet_set_minute_for_video(
        &self,
        meet: &ZhsMeet,
        minute: u32,
        video_id: u64,
    ) -> Result<()> {
        let user = self.current_user().await?;
        let fields: Vec<String> = vec![
            meet.recruit_id.to_string(),
            meet.live_id.to_string(),
            user.user_id.to_string(),
            minute.to_string(),
            "2".to_string(),
            video_id.to_string(),
        ];
        let param_secret = crypto::xor_encode(&fields, XOR_KEY_MEET);
        let payload = json!({
            "paramSecret": param_secret,
            "jsonpCallBack": "jsonpCallBack",
        });
        self.get_live_secret(MEET_SUBMIT_PATH, &payload, LIVE_REFERER)
            .await
            .map(|_| ())
    }

    /// Meet-course anti-cheat status.
    pub async fn meet_exception_status(&self, meet: &ZhsMeet) -> Result<ZhsExceptionStatus> {
        let user = self.current_user().await?;
        let payload = json!({
            "uuid": user.uuid,
            "recruitId": meet.recruit_id,
        });
        let value = self
            .get_live_secret(MEET_EXCEPTION_PATH, &payload, LIVE_REFERER)
            .await?;
        Ok(parse_exception(&value, "见面课"))
    }

    /// Execute one meet replay watch run.
    pub async fn meet_watch(
        &self,
        meet: &ZhsMeet,
        opts: &ZhsMeetWatchOptions,
        progress: &(dyn Fn(super::models::ZhsProgress) -> bool + Send + Sync),
    ) -> Result<super::models::ZhsMeetOutcome> {
        meet::run_meet_watch(self, meet, opts, progress).await
    }

    /// Current AES key of a module, fetched at runtime (video module has an
    /// embedded fallback for offline use).
    async fn module_key(&self, module: u32) -> Result<String> {
        if let Some(key) = self.keys.get(module) {
            return Ok(key);
        }
        match crypto::fetch_module_key(&self.http, &self.endpoints.appcomm_user, module).await {
            Ok(key) => {
                if module == MODULE_VIDEO && key != VIDEO_MODULE_KEY_FALLBACK {
                    log::warn!(
                        "Zhihuishu video module key changed at runtime; using the blob-derived key"
                    );
                }
                self.keys.put(module, key.clone());
                Ok(key)
            }
            Err(error) => {
                if module == MODULE_VIDEO {
                    log::warn!(
                        "Zhihuishu module-key handshake failed ({error:#}); falling back to the embedded video key"
                    );
                    self.keys.put(module, VIDEO_MODULE_KEY_FALLBACK.to_string());
                    Ok(VIDEO_MODULE_KEY_FALLBACK.to_string())
                } else {
                    Err(error)
                        .with_context(|| format!("failed to obtain Zhihuishu module {module} key"))
                }
            }
        }
    }

    /// POST a `secretStr` payload.
    async fn post_secret(
        &self,
        base: &str,
        path: &str,
        module: u32,
        payload: &Value,
        referer: &str,
    ) -> Result<Value> {
        let key = self.module_key(module).await?;
        // One timestamp is reused inside the encrypted JSON and in the outer
        // form field, matching the page crypto wrapper.
        let now = unix_millis();
        let mut body = payload.clone();
        if !body.is_object() {
            bail!("secret payload must be a JSON object");
        }
        if body.get("dateFormate").is_none() {
            body["dateFormate"] = json!(now);
        }
        let secret = crypto::encrypt_secret_json(&key, &body)?;
        let date_formate = now.to_string();
        let encoded = form_encode(&[
            ("secretStr", secret.as_str()),
            ("dateFormate", date_formate.as_str()),
        ]);
        let url = format!("{base}{path}");
        let response = self
            .http
            .post(&url)
            .header(
                CONTENT_TYPE,
                "application/x-www-form-urlencoded; charset=UTF-8",
            )
            .header(REFERER, referer)
            .header(ORIGIN, origin_of(referer))
            .header(USER_AGENT, ZHS_USER_AGENT)
            .body(encoded)
            .send()
            .await
            .map_err(strip_error_url)
            .with_context(|| format!("request to {path} failed"))?;
        self.read_json_response(path, response).await
    }

    /// POST a `secretStr` payload whose outer timestamp field is `date` and whose
    /// plaintext is encrypted exactly as given.
    ///
    /// Measured 2026-11-08 on `queryShareCourseInfo`: the form is
    /// `secretStr=<AES(module 13, payload)>&date=<unix millis>`, the plaintext has
    /// **no** `dateFormate` and the timestamp field is `date` (not `dateFormate`).
    async fn post_secret_dated(
        &self,
        base: &str,
        path: &str,
        module: u32,
        payload: &Value,
        referer: &str,
    ) -> Result<Value> {
        let key = self.module_key(module).await?;
        let secret = crypto::encrypt_secret_json(&key, payload)?;
        let date = unix_millis().to_string();
        let encoded = form_encode(&[("secretStr", secret.as_str()), ("date", date.as_str())]);
        let url = format!("{base}{path}");
        let response = self
            .http
            .post(&url)
            .header(
                CONTENT_TYPE,
                "application/x-www-form-urlencoded; charset=UTF-8",
            )
            .header(REFERER, referer)
            .header(ORIGIN, origin_of(referer))
            .header(USER_AGENT, ZHS_USER_AGENT)
            .body(encoded)
            .send()
            .await
            .map_err(strip_error_url)
            .with_context(|| format!("request to {path} failed"))?;
        self.read_json_response(path, response).await
    }

    /// GET a `secretStr` payload.
    async fn get_secret(
        &self,
        base: &str,
        path: &str,
        module: u32,
        payload: &Value,
        referer: &str,
    ) -> Result<Value> {
        let key = self.module_key(module).await?;
        // One timestamp is reused inside the encrypted JSON and in the outer
        // query fields, matching the page crypto wrapper.
        let now = unix_millis();
        let mut body = payload.clone();
        if !body.is_object() {
            bail!("secret payload must be a JSON object");
        }
        if body.get("dateFormate").is_none() {
            body["dateFormate"] = json!(now);
        }
        let secret = crypto::encrypt_secret_json(&key, &body)?;
        let date_formate = now.to_string();
        let query = form_encode(&[
            ("secretStr", secret.as_str()),
            ("dateFormate", date_formate.as_str()),
            ("_", date_formate.as_str()),
        ]);
        let url = format!("{base}{path}?{query}");
        let response = self
            .http
            .get(&url)
            .header(REFERER, referer)
            .header(ORIGIN, origin_of(referer))
            .header(USER_AGENT, ZHS_USER_AGENT)
            .send()
            .await
            .map_err(strip_error_url)
            .with_context(|| format!("request to {path} failed"))?;
        self.read_json_response(path, response).await
    }

    /// GET a `secretStr` payload on a live (`appcomm-live-api`) endpoint.
    ///
    /// The live-page crypto helper encrypts exactly the passed object and adds
    /// only the `_` cache-buster parameter; it does **not** inject
    /// `dateFormate` (verified by the userscript on a real replay page).
    async fn get_live_secret(&self, path: &str, payload: &Value, referer: &str) -> Result<Value> {
        let key = self.module_key(MODULE_MEET).await?;
        let secret = crypto::encrypt_secret_json(&key, payload)?;
        let query = form_encode(&[
            ("secretStr", secret.as_str()),
            ("_", unix_millis().to_string().as_str()),
        ]);
        let url = format!("{}{path}?{query}", self.endpoints.live);
        let response = self
            .http
            .get(&url)
            .header(REFERER, referer)
            .header(ORIGIN, origin_of(referer))
            .header(USER_AGENT, ZHS_USER_AGENT)
            .send()
            .await
            .map_err(strip_error_url)
            .with_context(|| format!("request to {path} failed"))?;
        self.read_json_response(path, response).await
    }

    /// Plain form POST used by the meet-course list.
    async fn post_form(&self, base: &str, path: &str, body: &str, referer: &str) -> Result<Value> {
        let url = format!("{base}{path}");
        let response = self
            .http
            .post(&url)
            .header(
                CONTENT_TYPE,
                "application/x-www-form-urlencoded; charset=UTF-8",
            )
            .header(REFERER, referer)
            .header(ORIGIN, origin_of(referer))
            .header(USER_AGENT, ZHS_USER_AGENT)
            .header("X-Requested-With", "XMLHttpRequest")
            .body(body.to_string())
            .send()
            .await
            .map_err(strip_error_url)
            .with_context(|| format!("request to {path} failed"))?;
        self.read_json_response(path, response).await
    }

    /// Read a JSON response and normalize platform errors.
    async fn read_json_response(&self, path: &str, response: reqwest::Response) -> Result<Value> {
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(strip_error_url)
            .with_context(|| format!("failed to read the response of {path}"))?;
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(ZhsError::new(
                i64::from(status.as_u16()),
                "登录状态失效，请重新登录知到",
                path,
            )
            .into());
        }
        if !status.is_success() {
            return Err(
                ZhsError::new(i64::from(status.as_u16()), format!("HTTP {status}"), path).into(),
            );
        }
        let value: Value = serde_json::from_str(text.trim()).with_context(|| {
            format!(
                "response of {path} is not JSON: {}",
                sanitize_text(&text, 120)
            )
        })?;
        let code = reply_code(&value);
        if !is_success_code(code) {
            let message = success_message(&value);
            let message = if message.is_empty() {
                format!("platform code {code}")
            } else {
                message
            };
            let message = if message.contains("登录") || message.contains("login") || code == 401
            {
                format!("登录状态失效，请重新登录知到（{message}）")
            } else {
                message
            };
            return Err(ZhsError::new(code, message, path).into());
        }
        if value.get("success").and_then(Value::as_bool) == Some(false) {
            return Err(ZhsError::new(code, "platform reported success=false", path).into());
        }
        Ok(value)
    }
}

/// Merge user fields from a `loginUserInfo` / `CASLOGC` JSON object.
fn merge_user(user: &mut ZhsUser, value: &Value) {
    if let Some(id) = get_u64(value, &["userId", "id"]) {
        user.user_id = id;
    }
    if let Some(uuid) = value.get("uuid").and_then(Value::as_str)
        && !uuid.trim().is_empty()
    {
        user.uuid = uuid.trim().to_string();
    }
    let real_name = get_str(value, &["realName", "userName", "name"]);
    if !real_name.is_empty() {
        user.real_name = real_name;
    }
    if let Some(school_id) = get_u64(value, &["schoolId", "school_id"]) {
        user.school_id = Some(school_id);
    }
    if let Some(is_teacher) = get_bool(value, &["isTeacher", "teacher"]) {
        user.is_teacher = is_teacher;
    }
}

/// Build a cookie jar from Netscape records, preserving domain attributes.
fn jar_from_records(records: &[crate::cookie::CookieRecord]) -> Result<Arc<Jar>> {
    let jar = Jar::default();
    let base = Url::parse("https://www.zhihuishu.com/").context("invalid cookie base URL")?;
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

/// Pure parser for [`ZhsClient::resolve_course`] references.
///
/// Returns `None` when the reference is not URL/secret/`recruitId;courseId`
/// shaped, so the caller can fall back to the course list.
pub fn parse_course_reference(reference: &str) -> Option<ZhsCourse> {
    let reference = reference.trim();
    if reference.is_empty() {
        return None;
    }

    // Study page URL: prefer recruitAndCourseId, then explicit query ids.
    let url = Url::parse(reference).ok().or_else(|| {
        Url::parse(&format!("https://{reference}"))
            .ok()
            .filter(|_| reference.contains("zhihuishu.com"))
    });
    if let Some(url) = url {
        let mut secret = None;
        let mut recruit_id = None;
        let mut course_id = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "recruitAndCourseId" | "recruitAndCourseID" => secret = Some(value.into_owned()),
                "recruitId" | "recruit_id" => recruit_id = value.parse().ok(),
                "courseId" | "course_id" => course_id = value.parse().ok(),
                _ => {}
            }
        }
        if let Some(secret) = secret.as_deref()
            && let Some((recruit, course)) = decode_course_secret(secret)
        {
            return Some(course_from_ids(recruit, course, Some(secret.to_string())));
        }
        if let (Some(recruit), Some(course)) = (recruit_id, course_id) {
            return Some(course_from_ids(recruit, course, None));
        }
        if let Some(secret) = secret
            && let Some((recruit, course)) = decode_course_secret(&secret)
        {
            return Some(course_from_ids(recruit, course, Some(secret)));
        }
    }

    // Inline `recruitAndCourseId=` (relative URL or bare query fragment).
    if let Some(index) = reference.find("recruitAndCourseId=") {
        let rest = &reference[index + "recruitAndCourseId=".len()..];
        let value = rest.split(['&', '#', ' ']).next().unwrap_or("");
        if let Some((recruit, course)) = decode_course_secret(value) {
            return Some(course_from_ids(recruit, course, Some(value.to_string())));
        }
    }

    // Bare `recruitId;courseId` or `recruitId/courseId`.
    for separator in [';', '/', ','] {
        if let Some((left, right)) = reference.split_once(separator)
            && let (Ok(recruit), Ok(course)) =
                (left.trim().parse::<u64>(), right.trim().parse::<u64>())
        {
            return Some(course_from_ids(recruit, course, None));
        }
    }

    // Bare XOR secret.
    if reference.len() >= 4
        && reference.len().is_multiple_of(2)
        && reference.chars().all(|c| c.is_ascii_hexdigit())
        && let Some((recruit, course)) = decode_course_secret(reference)
    {
        return Some(course_from_ids(
            recruit,
            course,
            Some(reference.to_string()),
        ));
    }
    None
}

fn course_from_ids(recruit_id: u64, course_id: u64, secret: Option<String>) -> ZhsCourse {
    ZhsCourse {
        recruit_id,
        course_id,
        secret,
        ..ZhsCourse::default()
    }
}

/// Decode a `recruitAndCourseId` secret into `(recruitId, courseId)`.
fn decode_course_secret(secret: &str) -> Option<(u64, u64)> {
    let decoded = crypto::xor_decode(secret, XOR_KEY_COURSE).ok()?;
    let (recruit, course) = decoded.split_once(';')?;
    Some((recruit.trim().parse().ok()?, course.trim().parse().ok()?))
}

/// Sum replay durations found anywhere in a `getVideosByLiveId` payload.
fn collect_durations(value: &Value) -> u64 {
    const DURATION_KEYS: [&str; 7] = [
        "duration",
        "videoDuration",
        "timeLong",
        "videoTime",
        "durationSec",
        "totalDuration",
        "historySum",
    ];
    match value {
        Value::Array(items) => items.iter().map(collect_durations).sum(),
        Value::Object(map) => {
            // Prefer summing the per-video list when present.
            for key in ["videoList", "videos", "list", "data", "rt", "result"] {
                if let Some(inner) = map.get(key)
                    && inner.is_array()
                {
                    return collect_durations(inner);
                }
            }
            let mut total = 0u64;
            for key in DURATION_KEYS {
                if let Some(secs) = map.get(key).and_then(as_u64) {
                    total += secs;
                    break;
                }
            }
            if total > 0 {
                return total;
            }
            map.values().map(collect_durations).sum()
        }
        _ => 0,
    }
}

/// Collect replay video ids and durations from a `getVideosByLiveId` payload.
///
/// Per-item durations above ~27 hours are treated as milliseconds, matching the
/// total-duration heuristic in [`ZhsClient::meet_duration_secs`].
fn collect_video_infos(value: &Value, out: &mut Vec<ZhsMeetVideo>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_video_infos(item, out);
            }
        }
        Value::Object(map) => {
            let looks_like_video = ["videoId", "videoUrl", "duration", "videoDuration"]
                .iter()
                .any(|key| map.contains_key(*key));
            if looks_like_video {
                if let Some(video_id) = get_u64(
                    value,
                    &["videoId", "id", "curVideoId", "videoSmallLessonId"],
                ) {
                    let raw = get_u64(
                        value,
                        &[
                            "duration",
                            "videoDuration",
                            "timeLong",
                            "videoTime",
                            "durationSec",
                        ],
                    )
                    .unwrap_or(0);
                    let duration_secs = if raw > 100_000 { raw / 1000 } else { raw };
                    out.push(ZhsMeetVideo {
                        video_id,
                        duration_secs,
                    });
                }
                return;
            }
            for inner in map.values() {
                collect_video_infos(inner, out);
            }
        }
        _ => {}
    }
}

/// Ids-only view of [`collect_video_infos`], used by tests.
#[cfg(test)]
fn collect_video_ids(value: &Value, out: &mut Vec<u64>) {
    let mut infos = Vec::new();
    collect_video_infos(value, &mut infos);
    out.extend(infos.into_iter().map(|video| video.video_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_course_references() {
        let from_url = parse_course_reference(
            "https://studyvideoh5.zhihuishu.com/stuStudy?courseId=1000011214&recruitId=463667",
        )
        .unwrap();
        assert_eq!(from_url.recruit_id, 463667);
        assert_eq!(from_url.course_id, 1000011214);

        let from_secret = parse_course_reference(
            "https://wisdom-mooc.zhihuishu.com/study/index?recruitAndCourseId=4e5e5a5e435e4859454a585959445b425c",
        )
        .unwrap();
        assert_eq!(from_secret.recruit_id, 463667);
        assert_eq!(from_secret.course_id, 1000011214);
        assert_eq!(
            from_secret.secret.as_deref(),
            Some("4e5e5a5e435e4859454a585959445b425c")
        );

        let from_pairs = parse_course_reference("463667;1000011214").unwrap();
        assert_eq!(from_pairs.recruit_id, 463667);
        assert_eq!(from_pairs.course_id, 1000011214);

        let from_slash = parse_course_reference("463667/1000011214").unwrap();
        assert_eq!(from_slash.recruit_id, 463667);

        let from_bare_secret =
            parse_course_reference("4e5e5a5e435e4859454a585959445b425c").unwrap();
        assert_eq!(from_bare_secret.course_id, 1000011214);

        assert!(parse_course_reference("not-a-course").is_none());
        assert!(parse_course_reference("").is_none());
    }

    #[test]
    fn course_secret_round_trips() {
        let course = course_from_ids(463667, 1000011214, None);
        assert_eq!(course.course_secret(), "4e5e5a5e435e4859454a585959445b425c");
    }

    #[test]
    fn parses_chapter_tree_from_videolist_shape() {
        let json = serde_json::json!({
            "code": 0,
            "data": {
                "videoChapterDtos": [{
                    "id": 1000116293,
                    "name": "第一章",
                    "learningLessonStatus": 1,
                    "isPass": 1,
                    "limitChecked": false,
                    "videoLessons": [{
                        "id": 1000337356,
                        "name": "第一节",
                        "isStudiedLesson": 1,
                        "videoSmallLessons": [{
                            "id": 1000244477,
                            "videoId": 71192505,
                            "videoSec": 826,
                            "isStudiedLesson": 0
                        }]
                    }, {
                        "id": 1000337351,
                        "name": "纯视频节",
                        "videoId": 74150643,
                        "videoSec": 492,
                        "isStudiedLesson": 1
                    }]
                }]
            }
        });
        let chapters = parse_chapters(&json["data"]).unwrap();
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].chapter_id, Some(1000116293));
        assert_eq!(chapters[0].lessons.len(), 2);
        let videos = chapters[0].lessons[0].all_videos();
        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].lesson_video_id, 1000244477);
        assert_eq!(videos[0].video_id, 71192505);
        assert_eq!(videos[0].video_sec, 826);
        let synthetic = chapters[0].lessons[1].all_videos();
        assert_eq!(synthetic.len(), 1);
        assert_eq!(synthetic[0].video_id, 74150643);
    }

    #[test]
    fn parses_minutes_from_all_known_shapes() {
        assert_eq!(parse_minutes(&serde_json::json!("1,2,3")), vec![1, 2, 3]);
        assert_eq!(
            parse_minutes(&serde_json::json!([1, "2", 3])),
            vec![1, 2, 3]
        );
        assert_eq!(parse_minutes(&serde_json::json!({"rt": "1,2"})), vec![1, 2]);
        assert!(parse_minutes(&serde_json::json!(null)).is_empty());
    }

    #[test]
    fn strips_jsonp_wrappers() {
        assert_eq!(
            strip_jsonp("jsonpCallBack({\"a\":1})").unwrap(),
            "{\"a\":1}"
        );
        assert_eq!(strip_jsonp("{\"a\":1}").unwrap(), "{\"a\":1}");
        assert!(strip_jsonp("plain text").is_err());
    }

    #[test]
    fn parses_exception_status() {
        let normal = parse_exception(
            &serde_json::json!({"code": 200, "rt": {"lock": false}}),
            "视频课",
        );
        assert!(!normal.lock && !normal.abnormal);

        let locked = parse_exception(
            &serde_json::json!({"code": 200, "rt": {"lock": true, "endTime": "2026-11-08 12:00:00"}}),
            "见面课",
        );
        assert!(locked.lock && locked.abnormal);

        let ended = parse_exception(
            &serde_json::json!({"code": 200, "rt": {"endTime": "2026-11-08 12:00:00"}}),
            "视频课",
        );
        assert!(ended.abnormal);
    }

    #[test]
    fn parses_course_list_shapes() {
        let value = serde_json::json!({
            "code": 0,
            "data": [{
                "recruitId": 463667,
                "courseId": 1000011214,
                "courseName": "军事理论",
                "teacherName": "张老师",
                "schoolId": 360,
                "classId": 123
            }]
        });
        let courses = parse_course_list(&value);
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].name, "军事理论");
        assert_eq!(courses[0].recruit_id, 463667);
        assert_eq!(courses[0].course_id, 1000011214);
        assert_eq!(courses[0].class_id, Some(123));
    }

    #[test]
    fn collects_replay_video_ids() {
        let value = serde_json::json!({
            "data": {
                "videoList": [
                    {"id": 70000002, "duration": 1200},
                    {"videoId": 70000003, "videoDuration": 600}
                ]
            }
        });
        let mut ids = Vec::new();
        collect_video_ids(&value, &mut ids);
        assert_eq!(ids, vec![70000002, 70000003]);
    }

    #[test]
    fn parses_meet_list_maps_shape() {
        let value = serde_json::json!({
            "maps": [{
                "liveId": 99887766,
                "meetCourseId": 99,
                "videoId": 70000001,
                "taskName": "第一次见面课",
                "speakerJson": "[{\"name\":\"李老师\"}]",
                "taskStatus": 2,
                "startTime": "2026-11-09 10:00",
                "endTime": "2026-11-09 11:40"
            }]
        });
        let course = course_from_ids(463667, 1000011214, None);
        let meets = parse_meets(&value, &course);
        assert_eq!(meets.len(), 1);
        assert_eq!(meets[0].name, "第一次见面课");
        assert_eq!(meets[0].teacher, "李老师");
        assert_eq!(meets[0].status, Some(2));
        assert_eq!(meets[0].live_id, 99887766);
        assert_eq!(meets[0].video_id, Some(70000001));
    }

    #[test]
    fn parses_meet_list_page_shape() {
        let value = serde_json::json!({
            "rt": {
                "page": {
                    "list": [{
                        "liveId": 99887766,
                        "meetCourseId": 99,
                        "videoId": 70000001,
                        "startTime": "2026-11-09 10:00",
                        "endTime": "2026-11-09 11:40",
                        "teacherName": "张老师",
                        "duration": 6000,
                        "replayCourseUrl": "https://lc.zhihuishu.com/live/vod_room.html?courseId=99887766"
                    }]
                }
            }
        });
        let course = course_from_ids(463667, 1000011214, None);
        let meets = parse_meets(&value, &course);
        assert_eq!(meets.len(), 1);
        assert_eq!(meets[0].meet_course_id, 99);
        assert_eq!(meets[0].live_id, 99887766);
        assert_eq!(meets[0].video_id, Some(70000001));
        assert_eq!(meets[0].duration_secs, Some(6000));
        assert!(meets[0].has_replay());
        assert!(meets[0].label().contains("张老师") || meets[0].label().contains("见面课"));
    }

    #[test]
    fn sums_replay_durations() {
        let value = serde_json::json!({
            "data": {
                "videoList": [
                    {"duration": 1200},
                    {"videoDuration": "600"}
                ]
            }
        });
        assert_eq!(collect_durations(&value), 1800);
        assert_eq!(
            collect_durations(&serde_json::json!({"rt": [{"duration": 60}]})),
            60
        );
        assert_eq!(collect_durations(&serde_json::json!({"data": {}})), 0);
    }

    #[test]
    fn form_encoding_round_trips() {
        let encoded = form_encode(&[("secretStr", "a+b/c="), ("dateFormate", "1")]);
        assert!(encoded.contains("secretStr=a%2Bb%2Fc%3D"));
        assert!(encoded.contains("dateFormate=1"));
    }

    #[test]
    fn normalizes_error_messages() {
        let error = ZhsError::new(1001, "登录已失效\n请重新登录", "/x");
        assert_eq!(
            error.to_string(),
            "zhihuishu /x failed (code 1001): 登录已失效 请重新登录"
        );
    }

    #[test]
    fn sanitizes_long_text() {
        let text = "a".repeat(300);
        let sanitized = sanitize_text(&text, 10);
        assert_eq!(sanitized.chars().count(), 11);
        assert!(sanitized.ends_with('…'));
    }

    #[test]
    fn course_list_contract_matches_the_measured_capture() {
        // Measured 2026-11-08: module 13, `pageNo` (not `pageNum`), and the
        // outer timestamp field is `date` — no `dateFormate` in the plaintext.
        assert_eq!(MODULE_COURSE_LIST, 13);
        let payload = course_list_payload(1, 50);
        assert_eq!(
            payload,
            serde_json::json!({"status": 0, "pageNo": 1, "pageSize": 50})
        );
        assert!(payload.get("dateFormate").is_none());
        assert!(payload.get("pageNum").is_none());
    }

    #[test]
    fn parses_measured_course_open_list() {
        // Sanitized fixture of the live `queryShareCourseInfo` response shape.
        let value = serde_json::json!({
            "result": {
                "totalCount": 1,
                "courseOpenDtos": [{
                    "courseId": 12_345_678,
                    "courseName": "测试课程-综合版",
                    "teacherName": "测试老师、另一位老师",
                    "recruitId": 877_665,
                    "secret": "0123456789abcdef0123456789abcdef",
                    "classId": null,
                    "progress": "42.5%",
                    "courseType": 1,
                    "schoolName": "测试大学",
                    "courseStatus": 2,
                    "status": 0,
                    "termId": 26,
                    "termName": null,
                    "lessonId": null
                }]
            },
            "code": 200,
            "message": null
        });
        let courses = parse_course_list(&value);
        assert_eq!(courses.len(), 1);
        let course = &courses[0];
        assert_eq!(course.recruit_id, 877_665);
        assert_eq!(course.course_id, 12_345_678);
        assert_eq!(course.name, "测试课程-综合版");
        assert_eq!(course.teacher, "测试老师、另一位老师");
        assert_eq!(
            course.secret.as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert_eq!(course.progress, Some(42.5));
        assert_eq!(course.course_type.as_deref(), Some("1"));
        assert_eq!(course.class_id, None);
        assert_eq!(course.status, Some(0));
        assert_eq!(parse_course_list_total(&value), Some(1));
    }
}
