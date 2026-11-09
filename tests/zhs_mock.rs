//! End-to-end tests for the Zhihuishu client against a local mock server.
//!
//! The mock speaks the real wire format: `secretStr` bodies/queries are
//! AES-128-CBC encrypted with the module key, GET parameters are parsed from the
//! query string, and the `c/has` module-key handshake returns a captured RSA
//! blob. The client is pointed at the loopback listener through
//! `ZhsClient::with_cookie_jar_and_endpoints`, so no request leaves the machine
//! and no real cookie or signature is needed.
//!
//! Covered flows:
//! * video: login -> course detail (videolist) -> prelearningNote ->
//!   saveDatabaseIntervalTimeV2 -> queryStuyInfo verify; platform error codes,
//!   401, transport failure and cancelled progress callbacks;
//! * meet: meet list (`maps` page model) -> getWatchHistory -> setWatchHistorySecret
//!   per minute with rate-limit timestamps, coverage range, retry, circuit
//!   breaker and cancellation.
//!
//! The deterministic crypto/planning checks live in `zhs_core.rs`; the protocol
//! self-tests at the bottom of this file exercise the mock itself.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use hust_course_hack::zhihuishu::{
    VIDEO_MODULE_KEY_FALLBACK, ZhsAnswerBank, ZhsClient, ZhsEndpoints, ZhsExamClient, ZhsHomework,
    ZhsMeet, ZhsMeetWatchOptions, ZhsProgress, ZhsWatchOptions, ZhsWatchState,
    decrypt_module_key_blob, decrypt_secret, encrypt_secret, plan_exam, xor_decode, xor_encode,
};
use reqwest::cookie::Jar;
use serde_json::{Value, json};

/// AES key every mock module returns: the live module-11 `cKey`, which the
/// captured module blob decodes to. The mock uses it for module 9 as well, since
/// the blob fixture is only valid for module 11 and the tests only need a key the
/// mock and the client agree on.
pub const MOCK_MODULE_KEY: &str = "azp53h0kft7qi78q";

/// Captured `c/has` blob (module 11) returned by the mock handshake.
const CAPTURED_MODULE_BLOB: &str = "bHh4XnFfDYprnOcYwUpPfxFfE2DWlEXbz4AIwEeJ5QvUkNjkGRJcdwSab6PKDibGkMOBLOT9or/\
nas7MyMrjLzof8VaWOsdTBn/vgDM14M+ubEo3itu051bjGWizlMwtgJ2mEli/uspItbefvVIKkeTc5hzhn5m14uCxxH3ZLHM=";

/// Replay meeting id / video id used by the mock page model.
const MOCK_LIVE_ID: u64 = 13_416_762;
const MOCK_REPLAY_VIDEO_ID: u64 = 97_501_867;
const MOCK_RECRUIT_ID: u64 = 463_667;
const MOCK_COURSE_ID: u64 = 1_000_011_214;
const MOCK_USER_ID: u64 = 904_405_607;
const MOCK_NOTE_ID: u64 = 13_191_360_047;

/// One request captured by the mock server, with `secretStr` already decrypted.
#[derive(Clone, Debug)]
pub struct CapturedRequest {
    /// HTTP method as sent by the client.
    pub method: String,
    /// Request path (no query string).
    pub path: String,
    /// Decoded query parameters.
    pub query: BTreeMap<String, String>,
    /// Decoded form body parameters.
    pub body: BTreeMap<String, String>,
    /// Decrypted `secretStr` payload, when the request carried one.
    pub secret: Option<Value>,
    /// Why `secretStr` could not be decrypted, for assertion messages.
    pub secret_error: Option<String>,
    /// When the request reached the mock (used by the rate-limit assertions).
    pub at: Instant,
}

impl CapturedRequest {
    /// Parameter from the query string or the form body.
    pub fn param(&self, name: &str) -> Option<&str> {
        self.query
            .get(name)
            .or_else(|| self.body.get(name))
            .map(String::as_str)
    }

    /// Decrypted `secretStr` payload, panicking with a useful message.
    pub fn secret(&self) -> &Value {
        self.secret.as_ref().unwrap_or_else(|| {
            panic!(
                "{} {} did not carry a usable secretStr: {:?}",
                self.method, self.path, self.secret_error
            )
        })
    }
}

/// Mutable mock behaviour; tests rewrite it between phases.
#[derive(Debug)]
pub struct MockState {
    requests: Vec<CapturedRequest>,
    /// Watched minutes returned by `getWatchHistory`.
    pub history: Vec<u32>,
    /// `watchState` returned by `queryStuyInfo`.
    pub video_watch_state: i64,
    /// Anti-cheat lock for the video endpoints.
    pub video_lock: bool,
    /// Anti-cheat lock for the meet endpoints.
    pub meet_lock: bool,
    /// Whether `saveDatabaseIntervalTimeV2` reports success.
    pub save_ok: bool,
    /// Reply with a non-zero platform code for study requests.
    pub study_error_code: i64,
    /// Reply with this HTTP status for every request (e.g. 401).
    pub http_status: u16,
    /// Close the socket without replying (network-failure simulation).
    pub drop_connections: bool,
    /// Remaining `setWatchHistorySecret` requests that must fail (retry tests).
    pub fail_set_minute: usize,
    /// Replay duration reported by the meet list and the IM fallback.
    pub replay_duration_secs: u64,
    /// Fail the `c/has` module-key handshake (video fallback / meet error tests).
    pub fail_module_key: bool,
    /// Return an empty `rt` from `lookHomework` (forces the `openExam` fallback).
    pub fail_look_homework: bool,
    /// Return a videolist with no chapters (empty-course boundary test).
    pub empty_video_tree: bool,
}

impl Default for MockState {
    fn default() -> Self {
        Self {
            requests: Vec::new(),
            history: vec![1, 2, 3],
            video_watch_state: 1,
            video_lock: false,
            meet_lock: false,
            save_ok: true,
            study_error_code: 0,
            http_status: 200,
            drop_connections: false,
            fail_set_minute: 0,
            replay_duration_secs: 7_195,
            fail_module_key: false,
            fail_look_homework: false,
            empty_video_tree: false,
        }
    }
}

/// Loopback HTTP mock server speaking the Zhihuishu protocol.
pub struct MockServer {
    base: String,
    state: Arc<Mutex<MockState>>,
}

impl MockServer {
    /// Start the mock on an ephemeral loopback port.
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");
        let state = Arc::new(Mutex::new(MockState::default()));
        let server_state = Arc::clone(&state);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let state = Arc::clone(&server_state);
                thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, &state) {
                        // A dropped connection is a deliberate failure mode; the
                        // tests assert on the surfaced client error.
                        let _ = error;
                    }
                });
            }
        });
        Self {
            base: format!("http://{address}"),
            state,
        }
    }

    /// API root without a trailing slash.
    pub fn base(&self) -> &str {
        &self.base
    }

    /// Mutate mock behaviour (between phases of a test).
    pub fn configure(&self, update: impl FnOnce(&mut MockState)) {
        update(&mut self.state.lock().expect("lock mock state"));
    }

    /// Snapshot of every captured request.
    pub fn requests(&self) -> Vec<CapturedRequest> {
        self.state.lock().expect("lock mock state").requests.clone()
    }

    /// Captured requests whose path contains `needle`.
    pub fn requests_for(&self, needle: &str) -> Vec<CapturedRequest> {
        self.requests()
            .into_iter()
            .filter(|request| request.path.contains(needle))
            .collect()
    }

    /// Build a real `ZhsClient` whose API roots all point at this mock.
    pub fn client(&self) -> ZhsClient {
        let base = self.base().to_string();
        let endpoints = ZhsEndpoints {
            study: base.clone(),
            live: base.clone(),
            appcomm_user: base.clone(),
            online: base.clone(),
            stuonline: base.clone(),
            online_service: base.clone(),
            im: base,
        };
        ZhsClient::with_cookie_jar_and_endpoints(Arc::new(Jar::default()), endpoints)
            .expect("build mock client")
    }
}

/// Read one HTTP/1.1 request from `stream` and reply with the routed response.
fn handle_connection(mut stream: TcpStream, state: &Arc<Mutex<MockState>>) -> std::io::Result<()> {
    let Some(request) = read_request(&mut stream)? else {
        return Ok(());
    };

    let captured = capture_request(&request);
    let (dropped, status, content_type, body) = {
        let mut state = state.lock().expect("lock mock state");
        let dropped = state.drop_connections;
        let response = if dropped {
            (200u16, "application/json".to_string(), String::new())
        } else {
            route(&request, &captured, &mut state)
        };
        state.requests.push(captured);
        (dropped, response.0, response.1, response.2)
    };

    if dropped {
        // Simulate a transport failure: close without a response.
        drop(stream);
        return Ok(());
    }

    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

#[derive(Debug)]
struct MockRequest {
    method: String,
    path: String,
    query: BTreeMap<String, String>,
    body: BTreeMap<String, String>,
}

impl MockRequest {
    fn param(&self, name: &str) -> Option<&str> {
        self.query
            .get(name)
            .or_else(|| self.body.get(name))
            .map(String::as_str)
    }
}

/// Read one request; `None` when the client closed the connection early.
fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<MockRequest>> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 64 * 1024 {
            return Ok(None);
        }
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut body = buffer[header_end..].to_vec();
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    while body.len() < content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }

    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default();
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), parse_pairs(query)),
        None => (target.to_string(), BTreeMap::new()),
    };
    let raw_body = String::from_utf8_lossy(&body[..content_length.min(body.len())]).to_string();
    let body = if raw_body.is_empty() {
        BTreeMap::new()
    } else {
        parse_pairs(&raw_body)
    };

    Ok(Some(MockRequest {
        method,
        path,
        query,
        body,
    }))
}

fn parse_pairs(text: &str) -> BTreeMap<String, String> {
    url::form_urlencoded::parse(text.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

fn capture_request(request: &MockRequest) -> CapturedRequest {
    let (secret, secret_error) = match request.param("secretStr") {
        Some(secret_text) => match decrypt_secret(MOCK_MODULE_KEY, secret_text) {
            Ok(plaintext) => match serde_json::from_str::<Value>(&plaintext) {
                Ok(value) => (Some(value), None),
                Err(error) => (None, Some(format!("secretStr is not JSON: {error}"))),
            },
            Err(error) => (None, Some(format!("secretStr decrypt failed: {error}"))),
        },
        None => (None, None),
    };
    let request_method = request.method.clone();
    let path = request.path.clone();
    let query = request.query.clone();
    let body = request.body.clone();
    CapturedRequest {
        method: request_method,
        path,
        query,
        body,
        secret,
        secret_error,
        at: Instant::now(),
    }
}

/// Study (`{code,message,data}`) response envelope.
fn study_ok(data: Value) -> String {
    json!({"code": 0, "message": "请求成功", "data": data}).to_string()
}

/// Live (`{status,msg,rt,success}`) response envelope.
fn live_ok(rt: Value) -> String {
    json!({
        "currentTime": 1_794_000_000_000u64,
        "status": "200",
        "msg": "请求成功",
        "rt": rt,
        "success": true,
    })
    .to_string()
}

fn study_error(code: i64) -> String {
    json!({"code": code, "message": "mock platform error"}).to_string()
}

/// Exam (`{currentTime,msg,rt,status}`) response envelope.
fn exam_ok(rt: Value) -> String {
    json!({
        "currentTime": 1_794_219_638_650u64,
        "msg": "请求成功",
        "rt": rt,
        "status": "200",
    })
    .to_string()
}

/// Sanitized homework list entry used by the exam mock.
fn mock_homework(submitted: bool) -> Value {
    if submitted {
        json!({
            "id": "stu-DONE",
            "state": 1,
            "score": "100",
            "achieveCount": 1,
            "achieve": 100,
            "backNum": 0,
            "isCheckAnswer": 1,
            "courseId": MOCK_COURSE_ID,
            "courseName": "测试课程",
            "examName": "已提交单元测试",
            "examId": "exam-DONE",
            "totalScore": "100",
            "problemNum": 3,
            "examUserName": "测试老师",
            "meetCourseType": 0,
            "chapterId": 1000116293,
        })
    } else {
        json!({
            "id": "stu-EXAM1",
            "state": 1,
            "score": null,
            "achieveCount": 0,
            "achieve": 0,
            "backNum": 3,
            "isCheckAnswer": 0,
            "courseId": MOCK_COURSE_ID,
            "courseName": "测试课程",
            "examName": "第一章单元测试",
            "examId": "exam-EXAM1",
            "totalScore": "100",
            "problemNum": 3,
            "examUserName": "测试老师",
            "meetCourseType": 0,
            "chapterId": 1000116293,
        })
    }
}

/// Sanitized paper payload (three questions: single, multiple, judge).
fn mock_paper_rt() -> Value {
    json!({
        "id": null,
        "score": "100",
        "examBase": {
            "id": "exam-EXAM1",
            "name": "第一章单元测试",
            "courseName": "测试课程",
            "problemNum": 3,
            "totalScore": "100",
            "chapterId": 1000116293,
            "workExamParts": [{
                "id": null,
                "startSort": 1,
                "questionCount": 3,
                "questionDtos": [{
                    "id": 7001,
                    "name": "测试单选题干（ ）。",
                    "questionType": {"id": 1, "name": "单选题"},
                    "questionOptions": [
                        {"id": 9001, "content": "甲选项"},
                        {"id": 9002, "content": "乙选项"},
                        {"id": 9003, "content": "丙选项"},
                        {"id": 9004, "content": "丁选项"}
                    ],
                    "questionScore": "10",
                    "eid": null
                }, {
                    "id": 7002,
                    "name": "测试多选题干（ ）。",
                    "questionType": {"id": 2, "name": "多选题"},
                    "questionOptions": [
                        {"id": 9101, "content": "多选甲"},
                        {"id": 9102, "content": "多选乙"},
                        {"id": 9103, "content": "多选丙"}
                    ],
                    "questionScore": "20"
                }, {
                    "id": 7003,
                    "name": "测试判断题干（ ）。",
                    "questionType": {"id": 3, "name": "判断题"},
                    "questionOptions": [
                        {"id": 9201, "content": "正确"},
                        {"id": 9202, "content": "错误"}
                    ],
                    "questionScore": "10"
                }]
            }]
        }
    })
}

/// Route one request to the mock handler.
fn route(
    request: &MockRequest,
    captured: &CapturedRequest,
    state: &mut MockState,
) -> (u16, String, String) {
    if state.http_status != 200 {
        return (
            state.http_status,
            "application/json".to_string(),
            json!({"code": state.http_status, "message": "mock http error"}).to_string(),
        );
    }
    if let Some(secret_error) = &captured.secret_error {
        return (
            400,
            "application/json".to_string(),
            json!({"code": 400, "message": secret_error}).to_string(),
        );
    }

    let path = request.path.as_str();

    if path.contains("/app-commserv-user/c/has") {
        if state.fail_module_key {
            return (
                500,
                "application/json".to_string(),
                json!({"status": 500, "msg": "mock module-key failure"}).to_string(),
            );
        }
        return (
            200,
            "application/json".to_string(),
            json!({
                "currentTime": 1_794_000_000_000u64,
                "msg": "请求成功",
                "rt": {"sl": CAPTURED_MODULE_BLOB},
                "status": "200",
            })
            .to_string(),
        );
    }

    if path.contains("/login/getLoginUserInfo") {
        if state.study_error_code != 0 {
            return (
                200,
                "application/json".to_string(),
                study_error(state.study_error_code),
            );
        }
        return (
            200,
            "application/json".to_string(),
            study_ok(json!({
                "userId": MOCK_USER_ID,
                "uuid": "abcdefgh",
                "realName": "测试用户",
                "schoolId": 360,
            })),
        );
    }

    if path.contains("/learning/queryCourse") {
        return (
            200,
            "application/json".to_string(),
            study_ok(json!({
                "isApply": 1,
                "classId": 13_640_013u64,
                "schoolId": 360,
                "courseName": "军事理论-综合版",
            })),
        );
    }

    if path.contains("/learning/videolist") {
        if state.study_error_code != 0 {
            return (
                200,
                "application/json".to_string(),
                study_error(state.study_error_code),
            );
        }
        if state.empty_video_tree {
            return (
                200,
                "application/json".to_string(),
                study_ok(json!({
                    "recruitId": MOCK_RECRUIT_ID,
                    "courseId": MOCK_COURSE_ID,
                    "videoChapterDtos": [],
                })),
            );
        }
        return (
            200,
            "application/json".to_string(),
            study_ok(json!({
                "recruitId": MOCK_RECRUIT_ID,
                "courseId": MOCK_COURSE_ID,
                "videoChapterDtos": [{
                    "id": 1_000_116_293u64,
                    "name": "第一章",
                    "videoLessons": [{
                        "id": 1_000_337_356u64,
                        "name": "第一节",
                        "chapterId": 1_000_116_293u64,
                        "videoSmallLessons": [{
                            "id": 1_000_244_477u64,
                            "lessonId": 1_000_337_356u64,
                            "videoId": 71_192_505u64,
                            "videoSec": 826u64,
                            "isStudiedLesson": 0,
                            "name": "小节一",
                        }, {
                            "id": 1_000_244_476u64,
                            "lessonId": 1_000_337_356u64,
                            "videoId": 74_150_643u64,
                            "videoSec": 492u64,
                            "isStudiedLesson": 0,
                            "name": "小节二",
                        }],
                    }],
                }],
            })),
        );
    }

    if path.contains("/learning/prelearningNote") {
        return (
            200,
            "application/json".to_string(),
            study_ok(json!({
                "studiedLessonDto": {
                    "id": MOCK_NOTE_ID,
                    "watchState": 2,
                    "studyTotalTime": 0,
                    "isStudiedLesson": 0,
                },
            })),
        );
    }

    if path.contains("/learning/saveDatabaseIntervalTimeV2") {
        return (
            200,
            "application/json".to_string(),
            study_ok(json!({"submitSuccess": state.save_ok})),
        );
    }

    if path.contains("/learning/queryStuyInfo") {
        let mut lv = serde_json::Map::new();
        let watch_state = state.video_watch_state;
        if let Some(secret) = &captured.secret
            && let Some(ids) = secret.get("lessonVideoIds").and_then(Value::as_array)
        {
            for id in ids.iter().filter_map(Value::as_u64) {
                lv.insert(
                    id.to_string(),
                    json!({"watchState": watch_state, "studyTotalTime": 826}),
                );
            }
        }
        return (
            200,
            "application/json".to_string(),
            study_ok(json!({"lesson": [], "lv": Value::Object(lv)})),
        );
    }

    if path.contains("/cheat/exceptionActionDetail") && !path.contains("/chect/") {
        return (
            200,
            "application/json".to_string(),
            study_ok(json!({
                "whetherDate": true,
                "lock": state.video_lock,
                "count": 0,
                "punishType": if state.video_lock { 1 } else { 0 },
                "tipStr": if state.video_lock { "mock 风控" } else { "" },
            })),
        );
    }

    if path.contains("/stuonline/json/teachMeeting/listTeachMeetingStu")
        || path.contains("/onlineSchool/json/teachMeeting/listTeachMeetingStu")
    {
        return (
            200,
            "application/json".to_string(),
            json!({
                "courseId": MOCK_COURSE_ID,
                "recruitId": MOCK_RECRUIT_ID,
                "classId": 13_640_013u64,
                "mapCount": 1,
                "maps": [{
                    "liveCourseId": MOCK_LIVE_ID.to_string(),
                    "videoId": MOCK_REPLAY_VIDEO_ID.to_string(),
                    "courseId": MOCK_COURSE_ID.to_string(),
                    "recruitId": MOCK_RECRUIT_ID.to_string(),
                    "taskName": "俄乌战争及对世界格局的影响",
                    "speakerJson": "[{\"name\":\"孙景伟\"}]",
                    "startTime": "2026-10-12 18:30:00",
                    "endTime": "2026-10-12 20:30:00",
                    "courseEndTime": "2026-12-15 23:59:59",
                    "replayCourseUrl": "//lc.zhihuishu.com/live/vod_room.html?t=1&liveId=13416762&courseId=1000011214&recruitId=463667",
                    "liveCourseUrl": "//lc.zhihuishu.com/live/live_room.html?t=1&liveId=13416762",
                    "examH5Url": "https://example.invalid/exam",
                    "taskStatus": "3",
                    "courseEndStatus": "1",
                    "duration": state.replay_duration_secs,
                }],
            })
            .to_string(),
        );
    }

    if path.contains("/livehome/getVideosByLiveId") {
        // JSONP response shape used by the live page.
        return (
            200,
            "application/javascript".to_string(),
            format!(
                "jsonpCallBack({})",
                json!({
                    "videoList": [{
                        "videoId": MOCK_REPLAY_VIDEO_ID,
                        "duration": state.replay_duration_secs,
                    }],
                })
            ),
        );
    }

    if path.contains("/pc/live/getWatchHistory") {
        let rt = state
            .history
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        return (
            200,
            "application/json".to_string(),
            live_ok(Value::String(rt)),
        );
    }

    if path.contains("/pc/live/setWatchHistorySecret") {
        if state.fail_set_minute > 0 {
            state.fail_set_minute -= 1;
            return (
                200,
                "application/json".to_string(),
                json!({
                    "currentTime": 1_794_000_000_000u64,
                    "status": "200",
                    "msg": "mock 上报失败",
                    "success": false,
                })
                .to_string(),
            );
        }
        return (
            200,
            "application/json".to_string(),
            live_ok(json!({"historySum": state.history.len()})),
        );
    }

    if path.contains("/chect/exceptionActionDetail") {
        return (
            200,
            "application/json".to_string(),
            live_ok(json!({"lock": state.meet_lock})),
        );
    }

    if path.contains("/exam/getLoginSchoolInfo") {
        return (
            200,
            "application/json".to_string(),
            exam_ok(json!({"schoolId": 360})),
        );
    }

    if path.contains("/student/getStudentHomework") {
        let flag = captured
            .secret
            .as_ref()
            .and_then(|secret| secret.get("flag"))
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let list = if flag == 2 {
            vec![mock_homework(true)]
        } else {
            vec![mock_homework(false)]
        };
        return (
            200,
            "application/json".to_string(),
            exam_ok(json!({
                "result": "success",
                "next": -1,
                "studentHomeworkList": list,
            })),
        );
    }

    if path.contains("/student/getStudentFinalExam") {
        return (
            200,
            "application/json".to_string(),
            exam_ok(json!([{
                "id": "stu-FINAL",
                "state": 1,
                "examId": "exam-FINAL",
                "examName": "教程考试",
                "problemNum": 3,
                "totalScore": "100",
                "limitTime": 90,
                "faStudentExamRemainCount": 1,
                "courseId": MOCK_COURSE_ID,
            }])),
        );
    }

    if path.contains("/student/lookHomework") {
        if state.fail_look_homework {
            return (200, "application/json".to_string(), exam_ok(Value::Null));
        }
        return (
            200,
            "application/json".to_string(),
            exam_ok(mock_paper_rt()),
        );
    }

    if path.contains("/student/openExam") {
        return (
            200,
            "application/json".to_string(),
            exam_ok(mock_paper_rt()),
        );
    }

    if path.contains("/answer/getStuAnswerInfo") {
        return (
            200,
            "application/json".to_string(),
            exam_ok(json!({
                "7001": {"score": "10", "isCurrent": "1", "questionId": "7001", "answer": "9004", "stuExamId": "stu-DONE"},
                "7002": {"score": "20", "isCurrent": "1", "questionId": "7002", "answer": "9101,9103", "stuExamId": "stu-DONE"},
                "7003": {"score": "10", "isCurrent": "1", "questionId": "7003", "answer": "9201", "stuExamId": "stu-DONE"},
            })),
        );
    }

    if path.contains("/answer/checkAnswerSheetInfo") {
        return (
            200,
            "application/json".to_string(),
            exam_ok(json!({
                "7001": {"score": "10", "isCurrent": "1", "totalScore": ""},
                "7002": {"score": "20", "isCurrent": "1", "totalScore": ""},
                "7003": {"score": "10", "isCurrent": "1", "totalScore": ""},
            })),
        );
    }

    if path.contains("/answer/saveStudentAnswer") {
        return (
            200,
            "application/json".to_string(),
            exam_ok(json!({"statu": "1"})),
        );
    }

    if path.contains("/answer/submit") {
        return (
            200,
            "application/json".to_string(),
            exam_ok(json!({"msg": "提交成功", "score": "30", "statu": "0"})),
        );
    }

    (
        404,
        "application/json".to_string(),
        json!({"status": 404, "msg": format!("mock has no route for {}", request.path)})
            .to_string(),
    )
}

// -------------------------------------------------------------------------
// Shared test fixtures
// -------------------------------------------------------------------------

fn mock_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("build test http client")
}

async fn resolve_mock_course(client: &ZhsClient) -> hust_course_hack::zhihuishu::ZhsCourse {
    client
        .resolve_course(&format!("{MOCK_RECRUIT_ID};{MOCK_COURSE_ID}"))
        .await
        .expect("resolve course reference")
}

fn no_progress(_progress: ZhsProgress) -> bool {
    true
}

/// Options for tests that must actually submit.
///
/// The core default is now dry-run, so every real-submission flow has to opt in
/// explicitly; keeping the live settings in one place makes that audit easy.
fn real_video_options() -> ZhsWatchOptions {
    ZhsWatchOptions {
        dry_run: false,
        ..ZhsWatchOptions::default()
    }
}

// -------------------------------------------------------------------------
// Video course flow
// -------------------------------------------------------------------------

#[tokio::test]
async fn video_flow_logs_in_lists_tree_and_completes_videos() {
    let server = MockServer::start();
    let client = server.client();

    let user = client.login_user().await.expect("login");
    assert_eq!(user.user_id, MOCK_USER_ID);
    assert_eq!(user.uuid, "abcdefgh");

    let course = resolve_mock_course(&client).await;
    let detail = client.course_detail(&course).await.expect("course detail");
    assert_eq!(detail.chapters.len(), 1);
    assert_eq!(detail.total_videos(), 2);
    assert_eq!(detail.completed_videos(), 0);

    let options = real_video_options();
    let targets = client.plan_videos(&detail, &options).await.expect("plan");
    assert_eq!(targets.len(), 2);

    let outcomes = client
        .watch_videos(&targets, &options, &no_progress)
        .await
        .expect("watch videos");
    assert_eq!(outcomes.len(), 2);
    for outcome in &outcomes {
        assert_eq!(outcome.state, ZhsWatchState::Ok, "{outcome:?}");
        assert_eq!(outcome.watch_state, Some(1), "{outcome:?}");
    }

    // Every request must have arrived with a decryptable secretStr.
    let videolist = server.requests_for("/learning/videolist");
    assert_eq!(videolist.len(), 1);
    assert_eq!(
        videolist[0].secret()["recruitAndCourseId"],
        "4e5e5a5e435e4859454a585959445b425c"
    );

    let notes = server.requests_for("/learning/prelearningNote");
    assert_eq!(notes.len(), 2);
    for note in &notes {
        let secret = note.secret();
        assert_eq!(secret["ccCourseId"], MOCK_COURSE_ID);
        assert_eq!(secret["recruitId"], MOCK_RECRUIT_ID);
        assert_eq!(secret["isApply"], 1);
        assert_eq!(secret["chapterId"], 1_000_116_293u64);
        assert_eq!(secret["lessonId"], 1_000_337_356u64);
    }

    let saves = server.requests_for("/saveDatabaseIntervalTimeV2");
    assert_eq!(saves.len(), 2);
    let mut reported_videos = Vec::new();
    for save in &saves {
        let secret = save.secret();
        assert_eq!(secret["courseId"], MOCK_COURSE_ID);
        let ewssw = secret["ewssw"].as_str().expect("ewssw");
        assert!(ewssw.starts_with("0,1,"), "ewssw = {ewssw}");
        let zwsds = secret["zwsds"].as_str().expect("zwsds");
        assert_eq!(
            zwsds, "MTMxOTEzNjAwNDc=",
            "zwsds is base64(noteId), the mock note id is 13191360047"
        );

        let decoded =
            xor_decode(secret["sdsew"].as_str().expect("sdsew"), "zzpttjd").expect("decode sdsew");
        let fields: Vec<&str> = decoded.split(';').collect();
        assert_eq!(fields.len(), 10, "sdsew = {decoded}");
        assert_eq!(fields[0], MOCK_RECRUIT_ID.to_string());
        assert_eq!(fields[1], "1000337356");
        assert_eq!(fields[4], "1000116293");
        assert_eq!(fields[5], "0", "field 6 is the zero sentinel");
        let video_sec: u64 = fields[6].parse().expect("total seconds");
        assert_eq!(fields[7], fields[6], "total is repeated");
        assert_eq!(fields[8], hust_course_hack::zhihuishu::hms(video_sec));
        assert_eq!(fields[9], "abcdefghzhs", "uuid + literal `zhs`");
        assert_eq!(
            ewssw,
            hust_course_hack::zhihuishu::watch_points(video_sec),
            "ewssw must match the reported video"
        );
        reported_videos.push(fields[2].to_string());
    }
    reported_videos.sort();
    assert_eq!(reported_videos, vec!["1000244476", "1000244477"]);

    // Verification query after every report.
    let stuy = server.requests_for("/learning/queryStuyInfo");
    assert_eq!(stuy.len(), 2);
    for query in &stuy {
        assert_eq!(query.secret()["recruitId"], MOCK_RECRUIT_ID);
        assert_eq!(
            query.secret()["lessonVideoIds"].as_array().map(Vec::len),
            Some(1)
        );
    }

    // Anti-cheat check after every report.
    let checks = server.requests_for("/cheat/exceptionActionDetail");
    assert_eq!(checks.len(), 2);
}

#[tokio::test]
async fn video_flow_can_be_cancelled_between_videos() {
    let server = MockServer::start();
    let client = server.client();
    let course = resolve_mock_course(&client).await;
    let detail = client.course_detail(&course).await.expect("course detail");
    let options = real_video_options();
    let targets = client.plan_videos(&detail, &options).await.expect("plan");

    let cancel = |_progress: ZhsProgress| false;
    let outcomes = client
        .watch_videos(&targets, &options, &cancel)
        .await
        .expect("cancelled watch");
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].state, ZhsWatchState::Cancelled);
    assert!(
        server.requests_for("/learning/prelearningNote").is_empty(),
        "cancellation before the first item must not send reports"
    );
    assert!(
        server
            .requests_for("/saveDatabaseIntervalTimeV2")
            .is_empty()
    );
}

#[tokio::test]
async fn video_flow_surfaces_platform_errors() {
    let server = MockServer::start();
    server.configure(|state| state.study_error_code = 500);
    let client = server.client();
    let course = resolve_mock_course(&client).await;
    let error = client
        .course_detail(&course)
        .await
        .expect_err("videolist error code must surface");
    let text = format!("{error:#}");
    assert!(text.contains("500"), "error = {text}");
}

#[tokio::test]
async fn video_flow_surfaces_401_and_transport_failures() {
    let server = MockServer::start();
    let client = server.client();

    server.configure(|state| state.http_status = 401);
    let error = client.login_user().await.expect_err("401 must surface");
    let text = format!("{error:#}");
    assert!(
        text.contains("登录") || text.contains("401"),
        "error = {text}"
    );

    let server = MockServer::start();
    let client = server.client();
    server.configure(|state| state.drop_connections = true);
    assert!(
        client.login_user().await.is_err(),
        "dropped socket must surface"
    );

    // A failed completion report must not be reported as success.
    let server = MockServer::start();
    let client = server.client();
    server.configure(|state| state.save_ok = false);
    let course = resolve_mock_course(&client).await;
    let detail = client.course_detail(&course).await.expect("course detail");
    let options = real_video_options();
    let targets = client.plan_videos(&detail, &options).await.expect("plan");
    let outcomes = client
        .watch_videos(&targets, &options, &no_progress)
        .await
        .expect("watch run completes with per-video failures");
    assert!(
        outcomes
            .iter()
            .all(|outcome| outcome.state == ZhsWatchState::Failed),
        "outcomes = {outcomes:?}"
    );
}

#[tokio::test]
async fn transport_errors_strip_signed_request_urls() {
    // A dropped socket makes reqwest carry the request URL (which contains the
    // encrypted `secretStr`/`uid` signature) into the error chain. Callers such
    // as `run_meet_watch` print that chain with `{error:#}`, so the client must
    // strip the URL before the error is surfaced.
    let server = MockServer::start();
    let client = server.client();
    server.configure(|state| state.drop_connections = true);

    // `login_user` goes through `get_secret`: the GET URL carries `secretStr`.
    let error = client
        .login_user()
        .await
        .expect_err("dropped socket must surface");
    let text = format!("{error:#}").to_ascii_lowercase();
    assert!(
        !text.contains("secretstr"),
        "error chain leaks secretStr: {text}"
    );
    assert!(
        !text.contains("http://") && !text.contains("https://"),
        "error chain leaks the request URL: {text}"
    );
    assert!(
        !text.contains("uid="),
        "error chain leaks the module-key blob: {text}"
    );

    // `meet_exception_status` goes through the live `get_live_secret` path and
    // the `c/has` handshake; neither URL may leak either.
    let meet = ZhsMeet {
        recruit_id: MOCK_RECRUIT_ID,
        course_id: MOCK_COURSE_ID,
        live_id: MOCK_LIVE_ID,
        ..ZhsMeet::default()
    };
    let error = client
        .meet_exception_status(&meet)
        .await
        .expect_err("dropped socket must surface for live endpoints too");
    let text = format!("{error:#}").to_ascii_lowercase();
    assert!(
        !text.contains("secretstr"),
        "live error chain leaks secretStr: {text}"
    );
    assert!(
        !text.contains("http://") && !text.contains("https://"),
        "live error chain leaks the request URL: {text}"
    );
    assert!(
        !text.contains("uid="),
        "live error chain leaks the module-key blob: {text}"
    );
}

#[tokio::test]
async fn video_flow_trips_the_circuit_breaker_on_a_lock() {
    let server = MockServer::start();
    let client = server.client();
    server.configure(|state| state.video_lock = true);
    let course = resolve_mock_course(&client).await;
    let detail = client.course_detail(&course).await.expect("course detail");
    let options = real_video_options();
    let targets = client.plan_videos(&detail, &options).await.expect("plan");

    let outcomes = client
        .watch_videos(&targets, &options, &no_progress)
        .await
        .expect("watch run");
    assert!(
        outcomes
            .iter()
            .any(|outcome| outcome.state == ZhsWatchState::CircuitBroken),
        "outcomes = {outcomes:?}"
    );
    assert_eq!(
        server.requests_for("/saveDatabaseIntervalTimeV2").len(),
        1,
        "the breaker must stop after the first report"
    );
}

#[tokio::test]
async fn video_flow_falls_back_to_the_embedded_module_key() {
    assert_eq!(MOCK_MODULE_KEY, VIDEO_MODULE_KEY_FALLBACK);
    let server = MockServer::start();
    server.configure(|state| state.fail_module_key = true);
    let client = server.client();

    let user = client
        .login_user()
        .await
        .expect("module-key handshake failure must fall back to the embedded video key");
    assert_eq!(user.user_id, MOCK_USER_ID);
    assert!(
        !server.requests_for("/c/has").is_empty(),
        "the client must still attempt the handshake"
    );

    let login = server.requests_for("/login/getLoginUserInfo");
    assert_eq!(login.len(), 1);
    assert!(
        login[0].secret()["dateFormate"].is_number(),
        "the fallback key must produce a decryptable secretStr"
    );
}

#[tokio::test]
async fn video_flow_handles_an_empty_course_tree() {
    let server = MockServer::start();
    server.configure(|state| state.empty_video_tree = true);
    let client = server.client();
    let course = resolve_mock_course(&client).await;
    let detail = client.course_detail(&course).await.expect("empty tree");
    assert_eq!(detail.total_videos(), 0);
    assert_eq!(detail.chapters.len(), 0);

    let options = real_video_options();
    let targets = client.plan_videos(&detail, &options).await.expect("plan");
    assert!(targets.is_empty());
    let outcomes = client
        .watch_videos(&targets, &options, &no_progress)
        .await
        .expect("empty plan is a no-op");
    assert!(outcomes.is_empty());
}

// -------------------------------------------------------------------------
// Meet course flow
// -------------------------------------------------------------------------

async fn meet_fixture(server: &MockServer) -> (ZhsClient, hust_course_hack::zhihuishu::ZhsMeet) {
    let client = server.client();
    let course = resolve_mock_course(&client).await;
    let meets = client.meet_list(&course).await.expect("meet list");
    assert_eq!(meets.len(), 1, "mock page model has one meeting");
    (client, meets.into_iter().next().expect("meeting"))
}

fn fast_meet_options() -> ZhsMeetWatchOptions {
    ZhsMeetWatchOptions {
        dry_run: false,
        coverage_min: 0.9,
        coverage_max: 0.9,
        delay_min_ms: 15,
        delay_max_ms: 30,
        circuit_breaker: false,
        check_every: 100,
    }
}

#[tokio::test]
async fn meet_flow_lists_the_meeting_and_reports_minutes() {
    let server = MockServer::start();
    server.configure(|state| {
        state.replay_duration_secs = 600; // 10 minute slots
        state.history = vec![1, 2, 3];
    });
    let (client, meet) = meet_fixture(&server).await;

    assert_eq!(meet.live_id, MOCK_LIVE_ID);
    assert_eq!(meet.video_id, Some(MOCK_REPLAY_VIDEO_ID));
    assert_eq!(meet.duration_secs, Some(600));
    assert_eq!(meet.name, "俄乌战争及对世界格局的影响");
    assert_eq!(meet.teacher, "孙景伟");
    assert_eq!(meet.status, Some(3));
    assert_eq!(meet.start_time.as_deref(), Some("2026-10-12 18:30:00"));

    let progress = client.meet_progress(&meet).await.expect("meet progress");
    assert_eq!(progress.total_minutes, 10);
    assert_eq!(progress.watched_minutes, vec![1, 2, 3]);
    assert_eq!(progress.watched_count, 3);

    let options = fast_meet_options();
    let outcome = client
        .meet_watch(&meet, &options, &no_progress)
        .await
        .expect("meet watch");
    assert_eq!(outcome.state, ZhsWatchState::Ok, "{outcome:?}");
    assert_eq!(outcome.target_minutes, 9, "ceil(10 * 0.9)");
    assert_eq!(outcome.submitted, 6, "9 target minutes - 3 already watched");
    assert_eq!(outcome.failed, 0);

    let submits = server.requests_for("/setWatchHistorySecret");
    assert_eq!(submits.len(), 6);
    let mut reported_minutes = Vec::new();
    for submit in &submits {
        let secret = submit.secret();
        assert_eq!(secret["jsonpCallBack"], "jsonpCallBack");
        let param_secret = secret["paramSecret"].as_str().expect("paramSecret");
        let decoded = xor_decode(param_secret, "zhihuishu").expect("decode paramSecret");
        let fields: Vec<&str> = decoded.split(';').collect();
        assert_eq!(fields.len(), 6, "paramSecret = {decoded}");
        assert_eq!(fields[0], MOCK_RECRUIT_ID.to_string());
        assert_eq!(fields[1], MOCK_LIVE_ID.to_string());
        assert_eq!(fields[2], MOCK_USER_ID.to_string());
        assert_eq!(fields[4], "2", "watchType");
        assert_eq!(fields[5], MOCK_REPLAY_VIDEO_ID.to_string());
        let minute: u32 = fields[3].parse().expect("minute");
        assert!((1..=10).contains(&minute));
        assert!(![1, 2, 3].contains(&minute), "watched minutes are skipped");
        reported_minutes.push(minute);
    }
    reported_minutes.sort_unstable();
    reported_minutes.dedup();
    assert_eq!(reported_minutes.len(), 6);

    // Rate limiting: every report after the first waits within the configured
    // window (allowing a small scheduling margin below the minimum).
    for pair in submits.windows(2) {
        let delta = pair[1].at.duration_since(pair[0].at);
        assert!(
            delta >= Duration::from_millis(10),
            "report interval {delta:?} is below the configured minimum"
        );
    }

    // The run re-reads the watched minutes at the end.
    assert!(
        server.requests_for("/pc/live/getWatchHistory").len() >= 2,
        "progress must be verified after the run"
    );
}

#[tokio::test]
async fn meet_flow_retries_a_single_failed_minute() {
    let server = MockServer::start();
    server.configure(|state| {
        state.replay_duration_secs = 600;
        state.history = vec![1, 2, 3];
        state.fail_set_minute = 1;
    });
    let (client, meet) = meet_fixture(&server).await;
    let mut options = fast_meet_options();
    options.delay_min_ms = 1;
    options.delay_max_ms = 2;
    let outcome = client
        .meet_watch(&meet, &options, &no_progress)
        .await
        .expect("meet watch");
    assert_eq!(outcome.state, ZhsWatchState::Ok, "{outcome:?}");
    assert_eq!(outcome.submitted, 6);
    assert_eq!(
        server.requests_for("/setWatchHistorySecret").len(),
        7,
        "one transient failure is retried once"
    );
}

#[tokio::test]
async fn meet_flow_trips_the_circuit_breaker_on_a_lock() {
    let server = MockServer::start();
    server.configure(|state| {
        state.replay_duration_secs = 600;
        state.history = vec![];
        state.meet_lock = true;
    });
    let (client, meet) = meet_fixture(&server).await;
    let options = ZhsMeetWatchOptions {
        dry_run: false,
        coverage_min: 0.9,
        coverage_max: 0.9,
        delay_min_ms: 1,
        delay_max_ms: 2,
        circuit_breaker: true,
        check_every: 1,
    };
    let outcome = client
        .meet_watch(&meet, &options, &no_progress)
        .await
        .expect("meet watch");
    assert_eq!(outcome.state, ZhsWatchState::CircuitBroken, "{outcome:?}");
    assert_eq!(
        outcome.submitted, 1,
        "the lock is seen after the first report"
    );
    assert_eq!(server.requests_for("/setWatchHistorySecret").len(), 1);
    assert!(
        !server
            .requests_for("/chect/exceptionActionDetail")
            .is_empty()
    );
}

#[tokio::test]
async fn meet_flow_dry_run_reports_no_minutes_and_stays_in_coverage() {
    let server = MockServer::start();
    server.configure(|state| state.history = vec![]);
    let (client, meet) = meet_fixture(&server).await;
    let mut targets = Vec::new();
    for _ in 0..8 {
        let options = ZhsMeetWatchOptions {
            dry_run: true,
            coverage_min: 0.9,
            coverage_max: 1.0,
            delay_min_ms: 1,
            delay_max_ms: 2,
            circuit_breaker: false,
            check_every: 10,
        };
        let outcome = client
            .meet_watch(&meet, &options, &no_progress)
            .await
            .expect("dry run");
        assert_eq!(outcome.state, ZhsWatchState::DryRun);
        assert!(
            (108..=120).contains(&outcome.target_minutes),
            "target {} outside ceil(120*0.9)..=120",
            outcome.target_minutes
        );
        targets.push(outcome.target_minutes);
    }
    assert!(
        server.requests_for("/setWatchHistorySecret").is_empty(),
        "dry run must never report a minute"
    );
    assert!(
        targets.iter().any(|target| *target != targets[0]),
        "coverage target must be random: {targets:?}"
    );
}

#[tokio::test]
async fn meet_flow_can_be_cancelled_before_the_first_report() {
    let server = MockServer::start();
    server.configure(|state| state.history = vec![]);
    let (client, meet) = meet_fixture(&server).await;
    let cancel = |_progress: ZhsProgress| false;
    let outcome = client
        .meet_watch(&meet, &fast_meet_options(), &cancel)
        .await
        .expect("cancelled run");
    assert_eq!(outcome.state, ZhsWatchState::Cancelled);
    assert!(server.requests_for("/setWatchHistorySecret").is_empty());
}

#[tokio::test]
async fn meet_flow_requires_the_meet_module_key() {
    let server = MockServer::start();
    let (client, meet) = meet_fixture(&server).await;
    server.configure(|state| state.fail_module_key = true);
    let error = client
        .meet_watch_history(&meet)
        .await
        .expect_err("module 9 has no embedded fallback");
    let text = format!("{error:#}");
    assert!(
        text.contains("module") || text.contains("key"),
        "error = {text}"
    );
}

// -------------------------------------------------------------------------
// Mock protocol self-tests (these also cover the mock itself)
// -------------------------------------------------------------------------

#[tokio::test]
async fn mock_serves_a_decodable_module_key_blob() {
    let server = MockServer::start();
    let client = mock_http_client();
    let response = client
        .get(format!(
            "{}/app-commserv-user/c/has?uid=dGVzdA==",
            server.base()
        ))
        .send()
        .await
        .expect("module key request");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("module key json");
    let blob = body["rt"]["sl"].as_str().expect("rt.sl");
    let key = decrypt_module_key_blob(blob).expect("decode mock module blob");
    assert_eq!(key.c_key, MOCK_MODULE_KEY);

    let captured = server.requests_for("/c/has");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, "GET");
    assert_eq!(captured[0].param("uid"), Some("dGVzdA=="));
}

#[tokio::test]
async fn mock_decrypts_study_secretstr_payloads() {
    let server = MockServer::start();
    let client = mock_http_client();
    let payload = json!({"recruitAndCourseId": "4e5e5a5e435e4859454a585959445b425c"});
    let secret = encrypt_secret(MOCK_MODULE_KEY, &payload.to_string()).expect("encrypt payload");
    let response = client
        .post(format!("{}/gateway/t/v1/learning/videolist", server.base()))
        .form(&[
            ("secretStr", secret.as_str()),
            ("dateFormate", "1794000000000"),
        ])
        .send()
        .await
        .expect("videolist request");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("videolist json");
    assert_eq!(body["code"], 0);
    assert_eq!(body["data"]["recruitId"], MOCK_RECRUIT_ID);

    let captured = server.requests_for("/learning/videolist");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].method, "POST");
    assert_eq!(
        captured[0].secret.as_ref(),
        Some(&payload),
        "mock must decrypt the AES secretStr body"
    );
    assert_eq!(
        captured[0].body.get("dateFormate").map(String::as_str),
        Some("1794000000000")
    );
}

#[tokio::test]
async fn mock_decrypts_live_secretstr_and_xor_paramsecret() {
    let server = MockServer::start();
    server.configure(|state| state.history = vec![1, 2, 3, 4, 5]);
    let client = mock_http_client();

    // getWatchHistory: secretStr over {"courseId": <liveId>, "userId": <id>}.
    let history_payload = json!({"courseId": MOCK_LIVE_ID, "userId": MOCK_USER_ID});
    let history_secret =
        encrypt_secret(MOCK_MODULE_KEY, &history_payload.to_string()).expect("encrypt history");
    let response = client
        .get(format!(
            "{}/app-commserv-live/gateway/t/v1/pc/live/getWatchHistory?secretStr={}&_=1",
            server.base(),
            url::form_urlencoded::byte_serialize(history_secret.as_bytes()).collect::<String>()
        ))
        .send()
        .await
        .expect("watch history request");
    let body: Value = response.json().await.expect("history json");
    assert_eq!(body["success"], true);
    assert_eq!(body["rt"], "1,2,3,4,5");

    // setWatchHistorySecret: secretStr over {"paramSecret": xor(...), "jsonpCallBack": ..}.
    let param_secret = xor_encode_fields(&[
        MOCK_RECRUIT_ID,
        MOCK_LIVE_ID,
        MOCK_USER_ID,
        12,
        2,
        MOCK_REPLAY_VIDEO_ID,
    ]);
    let submit_payload = json!({
        "paramSecret": param_secret,
        "jsonpCallBack": "jsonpCallBack",
    });
    let submit_secret =
        encrypt_secret(MOCK_MODULE_KEY, &submit_payload.to_string()).expect("encrypt submit");
    let response = client
        .get(format!(
            "{}/app-commserv-live/gateway/t/v1/pc/live/setWatchHistorySecret?secretStr={}&_=2",
            server.base(),
            url::form_urlencoded::byte_serialize(submit_secret.as_bytes()).collect::<String>()
        ))
        .send()
        .await
        .expect("set minute request");
    let body: Value = response.json().await.expect("set minute json");
    assert_eq!(body["success"], true);

    let captured = server.requests_for("/setWatchHistorySecret");
    assert_eq!(captured.len(), 1);
    let secret = captured[0].secret();
    let param_secret = secret["paramSecret"].as_str().expect("paramSecret");
    assert_eq!(
        xor_decode(param_secret, "zhihuishu").expect("decode paramSecret"),
        "463667;13416762;904405607;12;2;97501867"
    );
    assert_eq!(secret["jsonpCallBack"], "jsonpCallBack");
    assert!(
        captured[0].query.contains_key("_"),
        "live GET keeps the `_` cache-buster"
    );
}

#[tokio::test]
async fn mock_supports_error_and_transport_failure_modes() {
    let server = MockServer::start();
    let client = mock_http_client();

    // Platform code failure (study envelope).
    server.configure(|state| state.study_error_code = 500);
    let secret =
        encrypt_secret(MOCK_MODULE_KEY, r#"{"recruitAndCourseId":"x"}"#).expect("encrypt payload");
    let response = client
        .post(format!("{}/gateway/t/v1/learning/videolist", server.base()))
        .form(&[("secretStr", secret.as_str())])
        .send()
        .await
        .expect("request");
    let body: Value = response.json().await.expect("json");
    assert_eq!(body["code"], 500);

    // HTTP 401 (expired session).
    server.configure(|state| {
        state.http_status = 401;
        state.study_error_code = 0;
    });
    let response = client
        .get(format!(
            "{}/gateway/t/v1/login/getLoginUserInfo",
            server.base()
        ))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), 401);

    // Transport failure.
    server.configure(|state| {
        state.http_status = 200;
        state.drop_connections = true;
    });
    let error = client
        .get(format!(
            "{}/gateway/t/v1/login/getLoginUserInfo",
            server.base()
        ))
        .send()
        .await
        .expect_err("dropped connection must surface as an error");
    assert!(!error.to_string().is_empty());
}

#[tokio::test]
async fn mock_records_report_timestamps_for_rate_limit_assertions() {
    let server = MockServer::start();
    let client = mock_http_client();
    for minute in 1..=3u32 {
        let param_secret = xor_encode_fields(&[
            MOCK_RECRUIT_ID,
            MOCK_LIVE_ID,
            MOCK_USER_ID,
            u64::from(minute),
        ]);
        let payload = json!({"paramSecret": param_secret, "jsonpCallBack": "jsonpCallBack"});
        let secret = encrypt_secret(MOCK_MODULE_KEY, &payload.to_string()).expect("encrypt");
        client
            .get(format!(
                "{}/app-commserv-live/gateway/t/v1/pc/live/setWatchHistorySecret?secretStr={}",
                server.base(),
                url::form_urlencoded::byte_serialize(secret.as_bytes()).collect::<String>()
            ))
            .send()
            .await
            .expect("set minute");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let captured = server.requests_for("/setWatchHistorySecret");
    assert_eq!(captured.len(), 3);
    for pair in captured.windows(2) {
        assert!(
            pair[1].at.duration_since(pair[0].at) >= Duration::from_millis(4),
            "mock timestamps must allow interval assertions"
        );
    }
}

// -------------------------------------------------------------------------
// XOR helpers for the protocol self-tests
// -------------------------------------------------------------------------

fn xor_encode_fields(fields: &[u64]) -> String {
    let fields: Vec<String> = fields.iter().map(u64::to_string).collect();
    xor_encode(&fields, "zhihuishu")
}

// -------------------------------------------------------------------------
// Exam / homework flow (module 3 secretStr)
// -------------------------------------------------------------------------

fn exam_client(server: &MockServer, client: &ZhsClient) -> ZhsExamClient {
    // Both exam engines are routed at the same mock listener.
    ZhsExamClient::with_bases(client.clone(), server.base(), server.base())
}

#[tokio::test]
async fn exam_flow_reads_lists_paper_answers_and_submits() {
    let server = MockServer::start();
    let client = server.client();
    let exams = exam_client(&server, &client);

    let homeworks = exams
        .list_homework(MOCK_RECRUIT_ID, MOCK_COURSE_ID, false)
        .await
        .expect("homework list");
    assert_eq!(homeworks.len(), 1);
    let homework = &homeworks[0];
    assert_eq!(homework.exam_id, "exam-EXAM1");
    assert_eq!(homework.stu_exam_id, "stu-EXAM1");
    assert_eq!(homework.name, "第一章单元测试");
    assert_eq!(homework.problem_num, Some(3));
    assert_eq!(homework.back_num, Some(3));

    // Measured `getStudentHomework` payload: recruitId string, courseId number,
    // no timestamp field.
    let requests = server.requests_for("/student/getStudentHomework");
    assert_eq!(requests.len(), 1);
    let secret = requests[0].secret();
    assert_eq!(secret["recruitId"], "463667");
    assert_eq!(secret["courseId"], MOCK_COURSE_ID);
    assert_eq!(secret["flag"], 1);
    assert_eq!(secret["pageSize"], 100);
    assert_eq!(secret["pageNum"], 0);
    assert!(secret.get("dateFormate").is_none());

    let paper = exams.paper(homework).await.expect("paper");
    assert_eq!(paper.question_count(), 3);
    let questions: Vec<_> = paper.questions().collect();
    assert!(questions[0].stem.contains("单选题干"));
    assert_eq!(questions[0].kind_name, "单选题");
    assert_eq!(questions[0].options[3].content, "丁选项");
    assert!(questions[1].is_multiple());
    assert_eq!(questions[1].score, 20);

    // Measured `lookHomework` payload uses string ids.
    let look = server.requests_for("/student/lookHomework");
    assert_eq!(look.len(), 1);
    let secret = look[0].secret();
    assert_eq!(secret["recruitId"], "463667");
    assert_eq!(secret["studentExamId"], "stu-EXAM1");
    assert_eq!(secret["examId"], "exam-EXAM1");
    assert_eq!(secret["schoolId"], "360");
    assert_eq!(secret["courseId"], "1000011214");

    let submitted_homework = ZhsHomework {
        stu_exam_id: "stu-DONE".to_string(),
        exam_id: "exam-DONE".to_string(),
        ..homework.clone()
    };
    let answers = exams
        .submitted_answers(&submitted_homework, &paper)
        .await
        .expect("submitted answers");
    assert_eq!(answers.len(), 3);
    let multiple = answers
        .iter()
        .find(|answer| answer.question_id == "7002")
        .expect("multiple answer");
    assert_eq!(multiple.option_ids, vec!["9101", "9103"]);
    assert_eq!(multiple.score, 20.0);
    let answer_info = server.requests_for("/answer/getStuAnswerInfo");
    assert_eq!(answer_info.len(), 1);
    assert_eq!(
        answer_info[0].secret()["questionIds"],
        "7001,7002,7003",
        "getStuAnswerInfo requires the paper questionIds"
    );

    let saved = exams
        .save_answer(
            homework,
            questions[0],
            &[questions[0].options[3].id.clone()],
        )
        .await
        .expect("save answer");
    assert!(saved);
    let saves = server.requests_for("/answer/saveStudentAnswer");
    assert_eq!(saves.len(), 1);
    let secret = saves[0].secret();
    assert_eq!(secret["recruitId"], "463667");
    let raw = secret["stuExamAnswer"].as_str().expect("stuExamAnswer");
    let parsed: Value = serde_json::from_str(raw).expect("stuExamAnswer JSON");
    let record = &parsed[0];
    assert_eq!(record["examId"], "exam-EXAM1");
    assert_eq!(record["recruitId"], "463667");
    assert_eq!(record["stuExamId"], "stu-EXAM1");
    assert_eq!(record["eid"], "7001");
    assert_eq!(record["schoolId"], "360");
    assert_eq!(record["examType"], "");
    assert_eq!(record["fromType"], 3);
    assert_eq!(record["answer"], "9004");
    assert_eq!(record["questionType"], 1);

    let result = exams.submit(homework).await.expect("submit");
    assert_eq!(result.statu, "0");
    assert_eq!(result.score, Some(30.0));
    assert_eq!(result.message, "提交成功");
    let submits = server.requests_for("/answer/submit");
    assert_eq!(submits.len(), 1);
    assert_eq!(submits[0].secret()["studentExamId"], "stu-EXAM1");
}

#[tokio::test]
async fn exam_flow_lists_finals_and_grows_the_bank_from_submission() {
    let server = MockServer::start();
    let client = server.client();
    let exams = exam_client(&server, &client);

    let finals = exams
        .list_final_exams(MOCK_RECRUIT_ID, MOCK_COURSE_ID)
        .await
        .expect("final exams");
    assert_eq!(finals.len(), 1);
    assert_eq!(finals[0].exam_id, "exam-FINAL");
    assert_eq!(finals[0].limit_time, Some(90));
    assert_eq!(finals[0].remain_count, Some(1));

    let submitted = exams
        .list_homework(MOCK_RECRUIT_ID, MOCK_COURSE_ID, true)
        .await
        .expect("submitted homework");
    assert_eq!(submitted.len(), 1);
    assert_eq!(submitted[0].exam_id, "exam-DONE");

    let paper = exams.paper(&submitted[0]).await.expect("submitted paper");
    let answers = exams
        .submitted_answers(&submitted[0], &paper)
        .await
        .expect("submitted answers");
    let mut bank = ZhsAnswerBank::builtin();
    let recorded = bank.record_submitted(&paper, &answers, 1_794_219_638);
    assert_eq!(recorded, 3, "all mock questions are full marks");
    assert_eq!(bank.len(), 3);

    let unsubmitted = exams
        .list_homework(MOCK_RECRUIT_ID, MOCK_COURSE_ID, false)
        .await
        .expect("unsubmitted homework");
    let paper = exams.paper(&unsubmitted[0]).await.expect("paper");
    let context = exams
        .context_for(&unsubmitted[0])
        .await
        .expect("exam context");
    let plan = plan_exam(&paper, &context, &bank);
    assert!(plan.is_complete(), "plan: {plan:?}");
    assert_eq!(plan.questions.len(), 3);
    assert_eq!(
        plan.questions[0].option_contents,
        vec!["丁选项".to_string()]
    );
    assert_eq!(
        plan.questions[1].option_contents,
        vec!["多选甲".to_string(), "多选丙".to_string()]
    );
    assert_eq!(plan.questions[2].option_contents, vec!["正确".to_string()]);
}

#[tokio::test]
async fn exam_paper_falls_back_to_open_exam() {
    let server = MockServer::start();
    server.configure(|state| state.fail_look_homework = true);
    let client = server.client();
    let exams = exam_client(&server, &client);

    let homeworks = exams
        .list_homework(MOCK_RECRUIT_ID, MOCK_COURSE_ID, false)
        .await
        .expect("homework list");
    let paper = exams
        .paper_for_answering(&homeworks[0])
        .await
        .expect("openExam fallback");
    assert_eq!(paper.question_count(), 3);
    let open = server.requests_for("/student/openExam");
    assert_eq!(open.len(), 1);
    let secret = open[0].secret();
    assert_eq!(secret["recruitId"], "463667");
    assert_eq!(secret["examId"], "exam-EXAM1");
    assert_eq!(secret["studentExamId"], "stu-EXAM1");
    assert_eq!(secret["schoolId"], "360");
    assert_eq!(secret["courseId"], "1000011214");
}
