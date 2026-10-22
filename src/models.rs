//! Data model for the SmartCourse (HUST) crawler.
//!
//! Everything here is plain `serde` data so it can be handed to the Tauri
//! frontend as JSON without extra conversion code.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A course as it appears in the student's course list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CourseSummary {
    /// Course (mooc) id, e.g. `17310000026063`.
    pub course_id: String,
    /// Teaching class id, e.g. `17310000023403`.
    pub class_id: String,
    /// Person id used by the platform (`cpi`).
    pub cpi: String,
    pub name: String,
    pub cover_url: Option<String>,
    pub source: Option<String>,
    pub kc_enc: Option<String>,
    pub ck_enc: Option<String>,
    pub clazz_enc: Option<String>,
    /// The `opencoursenewfy` URL that leads to the course home page.
    pub detail_url: String,
}

/// A fully crawled course: metadata plus its chapter tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CourseDetail {
    #[serde(flatten)]
    pub course: CourseSummary,
    /// Course title taken from the course home page.
    pub title: String,
    pub enc: Option<String>,
    pub old_enc: Option<String>,
    pub openc: Option<String>,
    /// Final URL after the `opencoursenewfy` redirect.
    pub final_url: String,
    pub chapters: Vec<Chapter>,
    pub stats: CourseStats,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CourseStats {
    pub chapter_nodes: usize,
    pub leaves: usize,
    pub cards: usize,
    pub task_points: usize,
    pub videos: usize,
    pub documents: usize,
    pub works: usize,
    pub questions: usize,
    /// Non-fatal problems collected while crawling this course.
    pub errors: Vec<String>,
}

/// A chapter / section / knowledge point node.
///
/// The platform models the catalog as a tree. Intermediate nodes are usually
/// units ("Unit 1") and leaves are knowledge points ("1.1 ..."). Task points
/// hang off cards, which hang off leaves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chapter {
    /// Numeric knowledge id, without the platform's `cur` prefix.
    pub id: String,
    pub title: String,
    /// Display number such as `1`, `1.1`, `1.1.1`.
    pub number: Option<String>,
    pub level: u32,
    pub is_leaf: bool,
    pub completed: Option<bool>,
    #[serde(default)]
    pub children: Vec<Chapter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cards: Vec<Card>,
}

/// One tab inside a knowledge point ("学习材料", "练习题", ...).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    /// 1-based index, matching the platform's `num` parameter.
    pub index: usize,
    pub card_id: Option<String>,
    pub title: String,
    pub task_points: Vec<TaskPoint>,
    /// Playback environment exposed by this card's `mArg.defaults`. Needed to
    /// report video progress; `None` when the card page did not expose it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback: Option<PlaybackEnv>,
}

/// Playback environment from the `defaults` object of `mArg`.
///
/// The platform uses `reportUrl` plus a per-video `dtoken` from
/// `/ananas/status` to build the progress-report URL.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlaybackEnv {
    pub user_id: Option<String>,
    pub clazz_id: Option<String>,
    pub course_id: Option<String>,
    pub fid: Option<String>,
    /// Usually `/mooc-ans/multimedia/log/a/{cpi}`.
    pub report_url: Option<String>,
    pub report_interval_secs: Option<u64>,
    pub ktoken: Option<String>,
}

/// A task point: a video, a document, a chapter quiz, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskPoint {
    pub kind: TaskKind,
    /// The platform's original attachment type, kept for forward compatibility.
    pub source_type: String,
    pub name: String,
    pub job_id: Option<String>,
    pub object_id: Option<String>,
    pub mid: Option<String>,
    pub size_bytes: Option<u64>,
    /// File extension such as `.mp4` or `.pdf`, when present.
    pub content_ext: Option<String>,
    /// Whether the platform reports this task point as completed.
    pub completed: Option<bool>,
    /// Video progress in milliseconds.
    pub played_ms: Option<u64>,
    /// Video duration in seconds.
    pub duration_secs: Option<u64>,
    pub work_id: Option<String>,
    pub work_type: Option<String>,
    /// `graded` (view-graded page) or `in_progress` (answering page), when the
    /// work page could be reached.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_status: Option<String>,
    pub enc: Option<String>,
    /// Signed `otherInfo` string from the attachment; the report endpoint
    /// echoes it back unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_info: Option<String>,
    /// Signature for `attDuration`, echoed by the report endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub att_duration_enc: Option<String>,
    /// Playback `rt` value from the attachment (usually `1`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_face_capture_enc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<VideoInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<Question>,
    /// Original attachment JSON, useful when the platform adds new fields.
    #[serde(default)]
    pub raw: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Video,
    Document,
    Work,
    Audio,
    Live,
    Other,
}

/// Video metadata from `/ananas/status/{objectid}`.
///
/// `download_url` / `stream_url` / `hd_stream_url` are time-limited signed
/// URLs. Fetch them shortly before use; do not treat them as permanent links.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VideoInfo {
    pub duration_secs: Option<u64>,
    pub size_bytes: Option<u64>,
    pub filename: Option<String>,
    /// Token used by the progress-report path (`/a/{cpi}/{dtoken}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dtoken: Option<String>,
    pub screenshot: Option<String>,
    pub thumbnails: Option<String>,
    pub download_url: Option<String>,
    pub stream_url: Option<String>,
    pub hd_stream_url: Option<String>,
    pub status: Option<String>,
}

/// One exercise question from a chapter quiz.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    /// For example `单选题`, `多选题`, `判断题`, `填空题`.
    pub question_type: Option<String>,
    pub stem: String,
    pub options: Vec<QuestionOption>,
    pub my_answer: Option<String>,
    pub correct_answer: Option<String>,
    pub score: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionOption {
    /// `A`, `B`, ... (the platform usually renders `A、`).
    pub label: String,
    pub text: String,
}

/// Optional switches for a course crawl.
#[derive(Debug, Clone)]
pub struct FetchOptions {
    /// Fetch chapter quiz questions through the work API.
    pub include_questions: bool,
    /// Fetch signed video URLs through `/ananas/status`.
    pub include_video_info: bool,
    /// Number of knowledge points fetched at the same time.
    pub concurrency: usize,
}

impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            include_questions: true,
            include_video_info: true,
            concurrency: 4,
        }
    }
}
