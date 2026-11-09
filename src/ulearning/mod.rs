//! 优学院（Ulearning / U学）学生端支持：课程目录、视频秒刷与章节练习秒刷。
//!
//! 协议与分析结论见 `docs/ulearning/web-analysis.md` 与
//! `docs/ulearning/miaoshua-plan.md`（2026-11-07 真实账号实测）。网络与解析全部留在
//! `hust_course_hack` crate 内，CLI/GUI/website 只做编排。
//!
//! 本模块不读取、不打印 `AUTHORIZATION` token；调用方通过 cookies 文件或
//! [`UlearningClient::from_cookie_header`] 传入会话，客户端只在请求头里注入它。
//!
//! Layout:
//!
//! * [`cipher`] — DES-ECB/PKCS#7/Base64 for the `sync` body;
//! * [`client`] — [`UlearningClient`] (cookie jar, auth headers, every endpoint);
//! * [`parse`] — pure response parsers (directory/wholepage/record/answers);
//! * [`models`] — `snake_case` DTOs shared by CLI/GUI;
//! * [`record`] — `sync` payload construction + submission;
//! * [`plan`] — batch planning and the delayed/verified executor.

pub mod cipher;
pub mod client;
pub mod models;
pub mod parse;
pub mod plan;
pub mod record;

pub use cipher::{DES_KEY, decrypt_ecb_base64, encrypt_ecb_base64};
pub use client::{UlError, UlearningClient};
pub use models::{
    UlAction, UlChapter, UlCourse, UlCourseDetail, UlPage, UlPageContent, UlPageKind, UlPagePlan,
    UlPlan, UlProgress, UlProgressStage, UlQuestion, UlQuestionAnswer, UlSection, UlSectionPlan,
    UlSectionRecord, UlSyncOutcome, UlTextbook, UlUser, UlVideo, UlWatchOptions, UlWatchOutcome,
    UlWatchState,
};
pub use parse::{
    parse_basic_information, parse_class_name, parse_course_list, parse_directory,
    parse_initialize, parse_page_content, parse_question_answer, parse_remaining,
    parse_section_pages, parse_section_record, parse_student_courses, parse_students_total,
    parse_textbook_list, parse_user,
};
pub use plan::{page_kind, page_plan, plan_course, run_watch};
pub use record::{build_record_payload, encrypt_record_payload, submit_record};

/// 优学院记录/课程 API 主机。
pub const API_BASE: &str = "https://api.ulearning.cn";

/// 播放器 / 学习页主机。
pub const WEB_BASE: &str = "https://ua.ulearning.cn";

/// 登录页（统一身份认证入口）。
pub const LOGIN_URL: &str = "https://umooc.ulearning.cn/pc.html#/login";

/// 会话 cookie 名（token 值，不打印）。
pub const AUTH_COOKIE: &str = "AUTHORIZATION";

/// 课程/资源服务主机（登录、课程门户 API）。
pub const COURSE_API_BASE: &str = "https://courseapi.ulearning.cn";

/// 课程门户 SPA 主机。
pub const PORTAL_BASE: &str = "https://courseweb.ulearning.cn";
