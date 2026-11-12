//! Data model for the Ulearning (优学院 / U学) student platform.
//!
//! Core models stay `snake_case`; the Tauri layer maps them to camelCase DTOs.
//! Nothing in this module performs I/O, so every type can be built from fixtures
//! and asserted in unit tests.

use serde::{Deserialize, Serialize};

/// Logged-in student identity (`GET /user`).
///
/// The session token (`AUTHORIZATION`) is deliberately *not* part of this type;
/// it must never cross the IPC boundary or appear in reports.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlUser {
    /// Numeric user id.
    pub user_id: i64,
    /// Display name.
    pub name: String,
    /// Organisation id.
    pub org_id: Option<i64>,
}

/// One course of the student (`GET /courseListStu`, or resolved from a URL).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlCourse {
    /// External course id (`ocId`, used by `courseweb` pages).
    pub oc_id: Option<i64>,
    /// Internal course id (`textbookId`, the `courseId` of the player/API).
    pub textbook_id: i64,
    /// Teaching class id.
    pub class_id: Option<i64>,
    /// Course name.
    pub name: String,
    /// Author / teacher name.
    pub author: Option<String>,
    /// Remaining validity in seconds (`course/{id}/remaining`); negative means
    /// the course has expired.
    pub remaining_secs: Option<i64>,
}

impl UlCourse {
    /// Human-readable label used in GUI output.
    pub fn label(&self) -> String {
        if self.name.trim().is_empty() {
            format!("课程 {}", self.textbook_id)
        } else {
            self.name.trim().to_string()
        }
    }

    /// True when the course passed its validity window.
    pub fn is_expired(&self) -> bool {
        self.remaining_secs.is_some_and(|remaining| remaining < 0)
    }
}

/// One textbook (教材) entry mapped from an `ocId`.
///
/// The student course list only exposes the external `ocId`; the internal
/// `textbookId` used by the player/API comes from
/// `GET /textbook/student/{ocId}/list`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlTextbook {
    /// Internal course id (`courseId` in the textbook response = textbookId).
    pub textbook_id: i64,
    /// Textbook / course name.
    pub name: String,
    /// Validity limit as a Unix millisecond timestamp, when exposed.
    pub limit_millis: Option<i64>,
}

impl UlTextbook {
    /// Remaining validity in seconds relative to `now_millis`, if a limit exists.
    pub fn remaining_secs(&self, now_millis: i64) -> Option<i64> {
        self.limit_millis.map(|limit| (limit - now_millis) / 1000)
    }
}

/// One chapter (讲).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlChapter {
    /// Chapter id (`nodeid`).
    pub id: i64,
    /// Chapter id relative to the class (`id`), used by player URLs.
    pub id_for_class: Option<i64>,
    /// Chapter title (`nodetitle`).
    pub name: String,
    /// Platform hide flag.
    pub hide: Option<i64>,
    /// Sections of this chapter.
    pub sections: Vec<UlSection>,
}

/// One section (节); its `id` is the `itemid` used by every record API.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlSection {
    /// Section id (`itemid`).
    pub id: i64,
    /// Section title (`title`).
    pub name: String,
    /// Section id relative to the class.
    pub id_for_class: Option<i64>,
    /// Platform hide flag / audition flag.
    pub hide: Option<i64>,
    /// Pages of this section (`coursepages` in the directory response).
    pub pages: Vec<UlPage>,
}

/// One page (页面) of a section.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlPage {
    /// Page id used by `GET /wholepage/stu/{pageId}` and the answer API.
    pub id: i64,
    /// Page id used as `pageid` in the study record (`relationid`).
    pub relation_id: i64,
    /// Page title.
    pub name: String,
    /// Page content type: `5` text/image, `6` video, `7` practice.
    pub content_type: i64,
}

impl UlPage {
    /// Whether the page is a video page (`contentType == 6`).
    pub fn is_video(&self) -> bool {
        self.content_type == 6
    }

    /// Whether the page is a practice page (`contentType == 7`).
    pub fn is_practice(&self) -> bool {
        self.content_type == 7
    }

    /// Whether the page is a text/image or document page (`contentType == 5`).
    pub fn is_document(&self) -> bool {
        self.content_type == 5
    }
}

/// One video element of a page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlVideo {
    /// Video id (`resourceid` of the video element).
    pub video_id: i64,
    /// Video length in seconds (`videoLength`).
    pub duration_secs: i64,
}

/// One question element of a practice page (no answer yet).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlQuestion {
    /// Question id.
    pub question_id: i64,
    /// Full score of the question.
    pub score: i64,
    /// Question type code.
    pub kind: i64,
    /// Stem / title.
    pub title: String,
}

/// One question with the answer fetched from `/questionAnswer`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlQuestionAnswer {
    /// Question id.
    pub question_id: i64,
    /// Full score of the question.
    pub score: i64,
    /// Answer letters (e.g. `["D"]`).
    pub answer: Vec<String>,
}

/// Parsed content of one page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlPageContent {
    /// Page id echoed by the API, when present.
    pub page_id: Option<i64>,
    /// Page relation id echoed by the API, when present.
    pub relation_id: Option<i64>,
    /// Page content type reported by the API (`5`/`6`/`7`).
    pub content_type: i64,
    /// Video elements on the page.
    pub videos: Vec<UlVideo>,
    /// Question elements on the page.
    pub questions: Vec<UlQuestion>,
    /// Exercise element id (`coursepageDTOid`) sent as `coursepageId`.
    pub coursepage_id: Option<i64>,
    /// Whether the page contains an element this module cannot complete safely.
    pub has_unsupported_element: bool,
}

impl UlPageContent {
    /// Whether the page contains a practice element.
    pub fn has_practice(&self) -> bool {
        !self.questions.is_empty()
    }
}

/// Historical study record of one section (`GET /studyrecord/item/{id}`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlSectionRecord {
    /// `completion_status`: `1` means the section is finished.
    pub completion_status: i64,
    /// Record version used for merge logic.
    pub version: Option<i64>,
    /// Recorded section study time.
    pub study_time: Option<i64>,
}

impl UlSectionRecord {
    /// Whether the platform already marks this section as finished.
    pub fn completed(&self) -> bool {
        self.completion_status == 1
    }
}

/// Result of the course metadata / tree call.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlCourseDetail {
    /// Course metadata merged with the API responses.
    pub course: UlCourse,
    /// Chapters in platform order.
    pub chapters: Vec<UlChapter>,
    /// Remaining validity in seconds (`time` from `/remaining`).
    pub remaining_secs: Option<i64>,
    /// Class name, when `/classes/{id}` exposes it.
    pub class_name: Option<String>,
}

impl UlCourseDetail {
    /// Whether the course has expired (`remaining < 0`).
    pub fn is_expired(&self) -> bool {
        self.remaining_secs.is_some_and(|remaining| remaining < 0) || self.course.is_expired()
    }

    /// Number of sections in the tree.
    pub fn section_count(&self) -> usize {
        self.chapters
            .iter()
            .map(|chapter| chapter.sections.len())
            .sum()
    }
}

/// Kind of one planned page.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UlPageKind {
    /// Video page (`contentType == 6`).
    Video,
    /// Practice page (`contentType == 7`) or a page with a practice element.
    Practice,
    /// Text/image or document page (`contentType == 5`).
    #[default]
    Document,
}

/// Planned work for one page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlPagePlan {
    /// Page metadata.
    pub page: UlPage,
    /// Page kind.
    pub kind: UlPageKind,
    /// Videos to report (empty for documents/practice-only pages).
    pub videos: Vec<UlVideo>,
    /// Questions with answers to report.
    pub questions: Vec<UlQuestionAnswer>,
    /// Exercise element id for practice pages.
    pub coursepage_id: Option<i64>,
    /// Page score reported to the platform (100 for complete pages).
    pub score: i64,
}

/// Action decided for one section.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UlAction {
    /// Pure video/document section that can be completed directly.
    Complete,
    /// Section that also contains a practice page with answers.
    CompletePractice,
    /// Platform already marks the section finished.
    SkipDone,
    /// Section contains content this module cannot complete safely.
    #[default]
    SkipUnsupported,
    /// Course expired before the section could be planned.
    SkipExpired,
}

impl UlAction {
    /// Whether the action sends a record.
    pub fn is_complete(self) -> bool {
        matches!(self, Self::Complete | Self::CompletePractice)
    }

    /// Chinese label for GUI output.
    pub fn label(self) -> &'static str {
        match self {
            Self::Complete => "可刷",
            Self::CompletePractice => "可刷（含练习）",
            Self::SkipDone => "已完成",
            Self::SkipUnsupported => "跳过（不支持）",
            Self::SkipExpired => "跳过（过期）",
        }
    }
}

/// Planned work for one section.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlSectionPlan {
    /// Chapter id.
    pub chapter_id: i64,
    /// Chapter name.
    pub chapter_name: String,
    /// Section id (`itemid`).
    pub section_id: i64,
    /// Section name.
    pub section_name: String,
    /// Planned pages.
    pub pages: Vec<UlPagePlan>,
    /// Decided action.
    pub action: UlAction,
    /// `studyStartTime` from `/studyrecord/initialize`.
    pub study_start_time: Option<i64>,
    /// Section score reported to the platform.
    pub score: i64,
    /// Human-readable reason for the decided action (never contains the token).
    pub note: String,
}

impl UlSectionPlan {
    /// Stable label for progress and outcomes.
    pub fn label(&self) -> String {
        if self.chapter_name.trim().is_empty() {
            self.section_name.clone()
        } else {
            format!("{} / {}", self.chapter_name, self.section_name)
        }
    }

    /// Whether this section will be submitted.
    pub fn is_actionable(&self) -> bool {
        self.action.is_complete()
    }

    /// Short summary of the payload (no token, no heavy values).
    pub fn summary(&self) -> String {
        let videos = self
            .pages
            .iter()
            .map(|page| page.videos.len())
            .sum::<usize>();
        let questions = self
            .pages
            .iter()
            .map(|page| page.questions.len())
            .sum::<usize>();
        format!(
            "{} 页（视频 {} 个、练习 {} 题）",
            self.pages.len(),
            videos,
            questions
        )
    }
}

/// Whole-course plan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlPlan {
    /// Course metadata.
    pub course: UlCourse,
    /// One entry per scanned section.
    pub sections: Vec<UlSectionPlan>,
    /// Remaining validity in seconds at planning time.
    pub remaining_secs: Option<i64>,
    /// True when the caller cancelled while the plan was being built.
    pub cancelled: bool,
}

impl UlPlan {
    /// Number of sections that will be submitted.
    pub fn actionable_count(&self) -> usize {
        self.sections.iter().filter(|s| s.is_actionable()).count()
    }

    /// Counts per action: `(complete, practice, done, unsupported)`.
    pub fn counts(&self) -> (usize, usize, usize, usize) {
        let mut complete = 0;
        let mut practice = 0;
        let mut done = 0;
        let mut unsupported = 0;
        for section in &self.sections {
            match section.action {
                UlAction::Complete => complete += 1,
                UlAction::CompletePractice => practice += 1,
                UlAction::SkipDone => done += 1,
                UlAction::SkipUnsupported | UlAction::SkipExpired => unsupported += 1,
            }
        }
        (complete, practice, done, unsupported)
    }
}

/// Options shared by planning and execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlWatchOptions {
    /// Only build the plan / print payload summaries; never POST.
    pub dry_run: bool,
    /// Re-submit sections the platform already marks as completed.
    pub include_completed: bool,
    /// Stop after this many actionable sections (planning and execution).
    pub max_sections: Option<usize>,
    /// Minimum delay between two sync calls, in milliseconds.
    pub delay_min_ms: u64,
    /// Maximum delay between two sync calls, in milliseconds.
    pub delay_max_ms: u64,
    /// Abort the batch on the first failed section.
    pub stop_on_error: bool,
    /// Re-read `/studyrecord/item` after each sync and require completion.
    pub verify: bool,
}

impl Default for UlWatchOptions {
    fn default() -> Self {
        Self {
            dry_run: true,
            include_completed: false,
            max_sections: None,
            delay_min_ms: 3_000,
            delay_max_ms: 5_000,
            stop_on_error: true,
            verify: true,
        }
    }
}

/// Terminal state of one section submission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UlWatchState {
    /// Submitted and (when enabled) verified.
    Ok,
    /// Planned but skipped (already completed / unsupported / expired).
    Skip,
    /// Dry run: nothing sent.
    DryRun,
    /// Submission or verification failed.
    Failed,
    /// The caller cancelled through the progress callback.
    Cancelled,
    /// The platform returned `2` (刷分判定); the batch stopped.
    CircuitBroken,
}

impl UlWatchState {
    /// Chinese label for GUI output.
    pub fn label(self) -> &'static str {
        match self {
            Self::Ok => "成功",
            Self::Skip => "跳过",
            Self::DryRun => "预演",
            Self::Failed => "失败",
            Self::Cancelled => "已取消",
            Self::CircuitBroken => "已熔断",
        }
    }
}

/// Outcome of one planned section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlWatchOutcome {
    /// Section label (`chapter / section`).
    pub label: String,
    /// Section id.
    pub section_id: i64,
    /// Planned action.
    pub action: UlAction,
    /// Terminal state.
    pub state: UlWatchState,
    /// Platform `completion_status` observed during verification.
    pub completion_status: Option<i64>,
    /// Human-readable message.
    pub message: String,
}

/// Result code of one `sync` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UlSyncOutcome {
    /// Server returned `1`.
    Success,
    /// Server returned `2` (anti-cheat / 刷分判定); stop the batch.
    CheatDetected,
    /// Any other code or malformed response.
    Other(i64),
}

/// Progress stages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UlProgressStage {
    /// Fetching course metadata and the chapter tree.
    Directory,
    /// Reading section records and page contents to build the plan.
    Plan,
    /// Submitting study records.
    Submit,
    /// Re-reading the section record after a submit.
    Verify,
}

impl UlProgressStage {
    /// Chinese label for GUI output.
    pub fn label(self) -> &'static str {
        match self {
            Self::Directory => "课程目录",
            Self::Plan => "计划",
            Self::Submit => "提交",
            Self::Verify => "复核",
        }
    }
}

/// Progress snapshot emitted through the cancellation callback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UlProgress {
    /// Current stage.
    pub stage: UlProgressStage,
    /// Items finished so far.
    pub done: usize,
    /// Items in this stage.
    pub total: usize,
    /// Human-readable item label (never contains the token).
    pub label: String,
    /// Human-readable status message.
    pub message: String,
}

impl UlProgress {
    /// Build one progress snapshot.
    pub fn new(
        stage: UlProgressStage,
        done: usize,
        total: usize,
        label: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            stage,
            done,
            total,
            label: label.into(),
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn course_labels_and_expiry() {
        let mut course = UlCourse {
            textbook_id: 47353,
            class_id: Some(1_019_700),
            name: String::new(),
            ..UlCourse::default()
        };
        assert_eq!(course.label(), "课程 47353");
        assert!(!course.is_expired());

        course.name = " 概论 ".to_string();
        assert_eq!(course.label(), "概论");
        course.remaining_secs = Some(-5);
        assert!(course.is_expired());
    }

    #[test]
    fn page_kind_helpers() {
        let video = UlPage {
            content_type: 6,
            ..UlPage::default()
        };
        assert!(video.is_video() && !video.is_practice() && !video.is_document());
        let practice = UlPage {
            content_type: 7,
            ..UlPage::default()
        };
        assert!(practice.is_practice());
        let doc = UlPage {
            content_type: 5,
            ..UlPage::default()
        };
        assert!(doc.is_document());
    }

    #[test]
    fn plan_counts_and_summaries() {
        let plan = UlPlan {
            sections: vec![
                UlSectionPlan {
                    action: UlAction::Complete,
                    ..UlSectionPlan::default()
                },
                UlSectionPlan {
                    action: UlAction::CompletePractice,
                    ..UlSectionPlan::default()
                },
                UlSectionPlan {
                    action: UlAction::SkipDone,
                    ..UlSectionPlan::default()
                },
                UlSectionPlan {
                    action: UlAction::SkipUnsupported,
                    ..UlSectionPlan::default()
                },
            ],
            ..UlPlan::default()
        };
        assert_eq!(plan.actionable_count(), 2);
        assert_eq!(plan.counts(), (1, 1, 1, 1));

        let section = UlSectionPlan {
            chapter_name: "第一讲".to_string(),
            section_name: "第一节".to_string(),
            pages: vec![UlPagePlan {
                videos: vec![UlVideo {
                    video_id: 1,
                    duration_secs: 60,
                }],
                ..UlPagePlan::default()
            }],
            ..UlSectionPlan::default()
        };
        assert_eq!(section.label(), "第一讲 / 第一节");
        assert_eq!(section.summary(), "1 页（视频 1 个、练习 0 题）");
    }

    #[test]
    fn default_watch_options_are_safe() {
        let opts = UlWatchOptions::default();
        assert!(opts.dry_run);
        assert!(!opts.include_completed);
        assert_eq!(opts.delay_min_ms, 3_000);
        assert_eq!(opts.delay_max_ms, 5_000);
        assert!(opts.stop_on_error);
        assert!(opts.verify);
    }
}
