//! Core crawler for the HUST SmartCourse platform.
//!
//! This crate intentionally contains no Tauri or UI code, so the whole data
//! pipeline can be exercised from a CLI and unit-tested without launching the
//! desktop app.

pub mod answers;
pub mod client;
pub mod cookie;
pub mod models;
pub mod parse;
pub mod playback;
pub mod submit;

/// Version marker printed by watch/dry-run so a stale binary is obvious.
pub const REPORT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub use answers::{AnswerBank, BankAnswer, DEFAULT_ANSWER_BANK_JSON, normalize_stem};
pub use client::{CrawlProgress, DEFAULT_BASE_URL, SmartCourseClient, fetch_courses};
pub use models::{
    Card, Chapter, CourseDetail, CourseStats, CourseSummary, FetchOptions, PlaybackEnv, Question,
    QuestionOption, TaskKind, TaskPoint, VideoInfo,
};
pub use playback::{
    ReportReply, WatchOptions, WatchSummary, WatchTarget, collect_targets, video_enc, watch_target,
};
pub use submit::{
    CourseSubmissionPlan, PlannedWork, QuestionAnswer, QuestionPlan, SubmissionRequest,
    SubmitProgress, SubmitReply, WorkForm, WorkPage, WorkStatus, WorkSubmitOutcome, WorkTarget,
    build_submission_fields, parse_submit_reply, parse_work_form, plan_course, plan_questions,
    prepare_submission, question_type_code, submission_url,
};

/// Tampermonkey helper script for completing videos inside the browser player.
pub const VIDEO_HELPER_SCRIPT: &str =
    include_str!("../userscripts/hust-course-video-helper.user.js");
