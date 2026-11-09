//! Zhihuishu (智慧树 / 知到) support: shared-course video and meet-course replay completion.
//!
//! The module mirrors the layout of the SmartCourse client: HTTP and parsing live
//! here, the CLI and the Tauri shell only orchestrate. See
//! `docs/zhihuishu-miaoshua-plan.md` for the verified request protocol, the
//! encryption constants and the completion semantics.
//!
//! The wire protocol has three pieces of shared state:
//!
//! * `secretStr` — AES-128-CBC (fixed IV, PKCS#7) over a JSON body, keyed by the
//!   module key (`cKey`). The video module key is stable and known, the meet
//!   module key is fetched at runtime through the RSA handshake in [`crypto`].
//! * `sdsew` / `paramSecret` — XOR-encoded field lists (`zzpttjd` for the video
//!   report, `zhihuishu` for the meet replay report). See [`crypto::xor_encode`].
//! * `ewssw` — the synthetic watch-point sequence. See [`crypto::watch_points`].
//!
//! Nothing in this module logs cookies, full `secretStr` values or signed URLs.

pub mod api;
pub mod crypto;
pub mod exam;
pub mod meet;
pub mod models;
pub mod watch;

pub use api::{ZhsClient, ZhsEndpoints, ZhsError, parse_course_reference};
pub use crypto::{
    ModuleKey, ModuleKeyCache, crypto_self_check, decrypt_module_key_blob, decrypt_secret,
    encrypt_secret, fetch_module_key, hms, parse_hms, watch_points, xor_decode, xor_encode,
};
pub use exam::{
    DEFAULT_ANSWER_BANK_JSON, DEFAULT_ANSWER_BANK_PATH, ZhsAnswerBank, ZhsAnswerSource,
    ZhsBankEntry, ZhsExamClient, ZhsExamContext, ZhsExamOption, ZhsExamPaper, ZhsExamPart,
    ZhsExamPlan, ZhsExamQuestion, ZhsFinalExam, ZhsHomework, ZhsQuestionPlan, ZhsSubmitResult,
    ZhsSubmittedAnswer, parse_ai_analysis, plan_exam,
};
pub use meet::{ZhsMeetWatchOptions, plan_meet_minutes, run_meet_watch};
pub use models::{
    ZhsChapter, ZhsCourse, ZhsCourseDetail, ZhsCourseKind, ZhsExceptionStatus, ZhsLesson, ZhsMeet,
    ZhsMeetOutcome, ZhsMeetProgress, ZhsMeetVideo, ZhsPrelearningNote, ZhsProgress,
    ZhsProgressStage, ZhsUser, ZhsVideo, ZhsVideoStudy, ZhsVideoTarget, ZhsWatchOptions,
    ZhsWatchOutcome, ZhsWatchState,
};
pub use watch::{plan_videos, run_video_watch};

/// Alias kept for the short name used in the design document.
pub type ZhsStage = ZhsProgressStage;

/// RSA public key (SPKI, base64) used by the `c/has` module-key handshake.
///
/// Recovered from the live site and verified against a captured `rt.sl` blob:
/// `public_op_unpad(blob)` yields `{"cKey": ..., "module": 11, ...}`.
pub const PUBLIC_KEY_B64: &str = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCgfZmpLpPEpEFRKBe+\
ZjWJUjPe+7qg7pGqcfN3j2egJ8H2mrKwaEqZEnPnpi2O3hN8HRyaFozDOp8gwZiYfiIZjWy0Jr/FNAiiKYh5bq\
0GsEn+ieMmRyJg/+i1rqizhvCXvFdrdGhFTw5EBwTpsGdwe1utdlrvIJUAFWj9Yh4qbQIDAQAB";

/// Fixed AES-CBC IV used by every `secretStr` request.
pub const AES_IV: &str = "1g3qqdh4jvbskb9x";

/// Current video-module (`module = 11`) AES key.
///
/// The key is normally derived from the live `c/has` blob at runtime; this
/// constant is only the offline fallback when that bootstrap request fails.
/// [`crypto::crypto_self_check`] proves the fallback still matches the current
/// protocol, and [`api::ZhsClient`] warns when the live blob disagrees with it.
pub const VIDEO_MODULE_KEY_FALLBACK: &str = "azp53h0kft7qi78q";

/// Video-course module id.
pub const MODULE_VIDEO: u32 = 11;

/// Meet-course (live replay) module id.
pub const MODULE_MEET: u32 = 9;

/// Shared-course list module id (measured 2026-11-08: `queryShareCourseInfo`
/// encrypts with the runtime module-13 key, not module 11).
pub const MODULE_COURSE_LIST: u32 = 13;

/// Homework / exam module id (measured 2026-11-09: the exam APIs encrypt with
/// the runtime module-3 key).
pub const MODULE_EXAM: u32 = 3;

/// Main exam-engine API base (`studentExam`).
pub const EXAM_API_BASE: &str = "https://studentexam-api.zhihuishu.com/studentExam/gateway/t/v1";

/// Taurus exam-engine API base, used by the final-exam list.
pub const TAURUS_EXAM_API_BASE: &str =
    "https://taurusexam-api.zhihuishu.com/taurusExam/gateway/t/v1";

/// XOR key for the video `sdsew` report.
pub const XOR_KEY_VIDEO: &str = "zzpttjd";

/// XOR key for the `recruitAndCourseId` course secret and meet `paramSecret`.
pub const XOR_KEY_COURSE: &str = "zhihuishu";

/// XOR key for the meet replay `paramSecret`.
pub const XOR_KEY_MEET: &str = "zhihuishu";

/// Persisted module key lifetime; the site keeps keys for roughly 30 minutes.
pub const MODULE_KEY_TTL_SECS: u64 = 30 * 60;

/// Study API host (`studyservice-api`).
pub const STUDY_BASE: &str = "https://studyservice-api.zhihuishu.com";

/// Study page origin used as `Referer`/`Origin`.
pub const STUDY_REFERER: &str = "https://studyvideoh5.zhihuishu.com/";

/// Live/replay API host (`appcomm-live-api`).
pub const LIVE_BASE: &str = "https://appcomm-live-api.zhihuishu.com";

/// Replay page origin used as `Referer`/`Origin`.
pub const LIVE_REFERER: &str = "https://lc.zhihuishu.com/";

/// Module-key handshake host (`appcomm-user`).
pub const APPCOMM_USER_BASE: &str = "https://appcomm-user.zhihuishu.com";

/// Online service host (`onlineservice-api`); used by the course list.
pub const ONLINE_SERVICE_BASE: &str = "https://onlineservice-api.zhihuishu.com";

/// Student portal host (`online`) used by the meet list.
pub const ONLINE_BASE: &str = "https://online.zhihuishu.com";

/// Legacy student portal host (`stuonline`), kept as a meet-list fallback.
pub const STUONLINE_BASE: &str = "https://stuonline.zhihuishu.com";

/// Referer/origin of the student portal.
pub const ONLINE_REFERER: &str = "https://online.zhihuishu.com/";

/// Referer/origin of `onlineservice-api` (shared-course list).
pub const ONLINE_SERVICE_REFERER: &str = "https://onlineweb.zhihuishu.com/";

/// Replay page host (`lc`).
pub const LC_BASE: &str = "https://lc.zhihuishu.com";

/// Live IM host; used as the replay-duration fallback.
pub const IM_BASE: &str = "https://im.zhihuishu.com";

/// Browser user agent used for all requests.
pub const ZHS_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                                  (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

/// Login/session validation.
pub const LOGIN_USER_INFO_PATH: &str = "/gateway/t/v1/login/getLoginUserInfo";
/// Shared-course chapter/video tree.
pub const VIDEO_LIST_PATH: &str = "/gateway/t/v1/learning/videolist";
/// Per-video study note; returns the `noteId` (`studiedLessonDto.id`).
pub const PRELEARNING_NOTE_PATH: &str = "/gateway/t/v1/learning/prelearningNote";
/// Per-video study state (`watchState`, `studyTotalTime`).
pub const QUERY_STUY_INFO_PATH: &str = "/gateway/t/v1/learning/queryStuyInfo";
/// Video completion report.
pub const SAVE_INTERVAL_PATH: &str = "/gateway/t/v1/learning/saveDatabaseIntervalTimeV2";
/// Video anti-cheat status.
pub const VIDEO_EXCEPTION_PATH: &str = "/gateway/t/v1/cheat/exceptionActionDetail";
/// Meet anti-cheat status.
pub const MEET_EXCEPTION_PATH: &str = "/app-commserv-live/gateway/t/v1/chect/exceptionActionDetail";
/// Meet replay watched-minute list.
pub const MEET_HISTORY_PATH: &str = "/app-commserv-live/gateway/t/v1/pc/live/getWatchHistory";
/// Meet replay minute report.
pub const MEET_SUBMIT_PATH: &str = "/app-commserv-live/gateway/t/v1/pc/live/setWatchHistorySecret";
/// Meet course list (plain form POST, no `secretStr`).
///
/// Verified live on 2026-11-08: the student portal serves it at
/// `stuonline.zhihuishu.com/stuonline/json/teachMeeting/listTeachMeetingStu?examV2=ss`
/// with the form fields `recruitId`, `page.pageNo`, `page.pageSize` and an
/// `X-Requested-With: XMLHttpRequest` header. The response is a JSON object
/// whose `maps` array holds the sessions (and `mapCount` the total).
pub const MEET_LIST_PATH: &str = "/stuonline/json/teachMeeting/listTeachMeetingStu?examV2=ss";
/// Legacy meet-list path on the `online` host, tried when the primary fails.
pub const MEET_LIST_FALLBACK_PATH: &str =
    "/onlineSchool/json/teachMeeting/listTeachMeetingStu?examV2=ss";
/// Shared-course list (verified live on 2026-11-08).
pub const COURSE_LIST_PATH: &str = "/gateway/t/v1/student/course/share/queryShareCourseInfo";
/// AI 智课 / 智慧课程 list (verified live on 2026-11-09; AES module **13**,
/// plaintext `{"status":3}`, outer `date` field).
pub const AI_COURSE_LIST_PATH: &str = "/gateway/t/v1/student/queryStudentAICourseList";
/// Micro / flipped-course list (module 13; plaintext `{"pageNo":1,"pageSize":5}`).
pub const MICRO_COURSE_LIST_PATH: &str = "/gateway/t/v1/student/course/share/queryMicroCourseInfo";
/// Elective-course list (module 13; plaintext `{"schoolId":...}`).
pub const SELECT_COURSE_LIST_PATH: &str =
    "/gateway/t/v1/student/course/share/querySelectCourseInfo";
/// In-school smart-course list (plain GET on `school-platform`).
pub const SCHOOL_COURSE_LIST_PATH: &str = "/spCourse/queryStudentSchoolCourseList";
/// Online (hike) course list (best effort; empty for the measured account).
pub const HIKE_COURSE_LIST_PATH: &str = "/gateway/t/v1/student/online/course/getCourseList";
/// B2C course list (plain form POST; empty for the measured account).
pub const B2C_COURSE_LIST_PATH: &str = "/b2cpush/courseDetail/query2CCourseList";
/// POLYMAS 智能体课 list (plain JSON POST; captured 2026-11-08, returns
/// 大学生批判性思维 for the account).
pub const POLYMAS_COURSE_LIST_PATH: &str =
    "/student-course/student/index/teacherQueryStudentCourse";
/// `cloudapi.polymas.com` host (POLYMAS 智能体课).
pub const POLYMAS_BASE: &str = "https://cloudapi.polymas.com";
/// `school-platform` host (in-school smart courses).
pub const SCHOOL_PLATFORM_BASE: &str = "https://school-platform.zhihuishu.com";
/// `hike-teaching-api` host (online course list).
pub const HIKE_TEACHING_BASE: &str = "https://hike-teaching-api.zhihuishu.com";
/// `b2cpush` host (B2C course list).
pub const B2C_BASE: &str = "https://b2cpush.zhihuishu.com";
/// Shared-course metadata (best effort; used for `isApply`/`classId`).
pub const QUERY_COURSE_PATH: &str = "/gateway/t/v1/learning/queryCourse";
/// Replay duration fallback (JSONP, live page endpoint).
pub const IM_LIVE_VIDEOS_PATH: &str = "/livehome/getVideosByLiveId";
