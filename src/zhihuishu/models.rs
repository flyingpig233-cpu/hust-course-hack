//! Serializable data model for the Zhihuishu (智慧树 / 知到) module.
//!
//! The core model keeps `snake_case` field names; the Tauri layer maps these to
//! camelCase DTOs. Nothing here performs I/O, so the types can be unit-tested
//! and embedded in CLI reports without a network session.

use serde::{Deserialize, Serialize};

/// Logged-in student identity.
///
/// Most fields come from the `CASLOGC` cookie, which the site itself parses on
/// every page; `getLoginUserInfo` is used to confirm the session is alive.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsUser {
    /// Numeric platform user id (`userId` in `CASLOGC`).
    pub user_id: u64,
    /// Short opaque user token (`uuid` in `CASLOGC`, 8 characters).
    pub uuid: String,
    /// Display name, when available.
    pub real_name: String,
    /// School id used by the anti-cheat endpoints.
    pub school_id: Option<u64>,
    /// Whether the account is a teacher (teacher accounts cannot watch).
    pub is_teacher: bool,
}

/// Where a Zhihuishu course came from.
///
/// `Shared` is the historical 共享课 list (`queryShareCourseInfo`), which is the
/// only kind the video/meet/exam protocols currently support. The other kinds
/// are listed for discovery and are marked as unsupported until their own
/// protocol is captured.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZhsCourseKind {
    /// 共享课 (`queryShareCourseInfo`).
    #[default]
    Shared,
    /// AI 智课 / 智慧课程 (`queryStudentAICourseList`).
    Ai,
    /// 校内智慧课程 (`queryStudentSchoolCourseList`).
    School,
    /// 微课 / 翻转课 / 兴趣课 / B2C 等其他来源.
    Other,
}

impl ZhsCourseKind {
    /// Chinese label used by the CLI and the GUI.
    pub fn label(self) -> &'static str {
        match self {
            Self::Shared => "共享课",
            Self::Ai => "AI 智课",
            Self::School => "智慧课程",
            Self::Other => "其他",
        }
    }
}

/// A shared course (共享课) the student is enrolled in.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ZhsCourse {
    /// Which list endpoint produced this course (defaults to 共享课 for old data).
    #[serde(default)]
    pub kind: ZhsCourseKind,
    /// Recruit id (`recruitId`), the enrollment id used by every video API.
    pub recruit_id: u64,
    /// Course id (`courseId`).
    pub course_id: u64,
    /// Teaching class id, when the course list exposes it.
    pub class_id: Option<u64>,
    /// School id, when the course list exposes it.
    pub school_id: Option<u64>,
    /// Course name.
    pub name: String,
    /// Teacher display name.
    pub teacher: String,
    /// `recruitAndCourseId` secret from a study page URL, when the course was
    /// resolved from a URL instead of the course list.
    pub secret: Option<String>,
    /// Opaque platform course id for sources whose ids are not numeric
    /// (POLYMAS 智能体课, e.g. 大学生批判性思维). `course_id` stays `0` for these.
    #[serde(default)]
    pub external_id: Option<String>,
    /// Whether the course must be applied to (`isApply`).
    pub is_apply: Option<i64>,
    /// Course type reported by the platform (polymas courses are unsupported).
    pub course_type: Option<String>,
    /// Study progress in percent, when reported.
    pub progress: Option<f64>,
    /// Number of finished lessons, when reported.
    pub studied_lesson_count: Option<usize>,
    /// Number of lessons in the course, when reported.
    pub total_lesson_count: Option<usize>,
    /// Platform course status code.
    pub status: Option<i64>,
}

impl ZhsCourse {
    /// Build the shortest human-readable label (`name` or `course <id>`).
    pub fn label(&self) -> String {
        if self.name.trim().is_empty() {
            format!("课程 {}（recruit {}）", self.course_id, self.recruit_id)
        } else {
            self.name.trim().to_string()
        }
    }

    /// `recruitAndCourseId` value: XOR of `recruitId;courseId` with the
    /// Zhihuishu secret key. Verified against a captured study-page URL.
    pub fn course_secret(&self) -> String {
        crate::zhihuishu::crypto::xor_encode(
            &[self.recruit_id.to_string(), self.course_id.to_string()],
            crate::zhihuishu::XOR_KEY_COURSE,
        )
    }

    /// Secret captured from a URL if present, otherwise derived locally.
    pub fn secret_or_derive(&self) -> String {
        self.secret
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| self.course_secret())
    }

    /// True when the course looks like a polymas / flipped course this module
    /// does not support.
    pub fn is_polymas(&self) -> bool {
        self.course_type
            .as_deref()
            .map(|t| t.to_ascii_lowercase().contains("polymas"))
            .unwrap_or(false)
    }
}

/// One chapter (章) in the shared-course video tree.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ZhsChapter {
    /// Chapter id (`videoChapterDtos[].id`), when exposed.
    pub chapter_id: Option<u64>,
    /// Chapter name.
    pub name: String,
    /// Platform learning status code.
    pub learning_lesson_status: Option<i64>,
    /// Whether the whole chapter is passed.
    pub is_pass: Option<i64>,
    /// Whether the chapter is locked by teaching limits.
    pub limit_checked: Option<bool>,
    /// Lessons in this chapter.
    pub lessons: Vec<ZhsLesson>,
}

/// One lesson (节) in a chapter.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ZhsLesson {
    /// Lesson id (`videoLessons[].id`).
    pub lesson_id: u64,
    /// Lesson name.
    pub name: String,
    /// Whether the lesson is flagged as studied by the platform.
    pub is_studied: Option<i64>,
    /// Video id for lessons without small lessons.
    pub video_id: Option<u64>,
    /// Video length in seconds for lessons without small lessons.
    pub video_sec: Option<u64>,
    /// Small lessons (小节), the normal case for shared courses.
    pub videos: Vec<ZhsVideo>,
}

impl ZhsLesson {
    /// All videos of the lesson. Lessons without small lessons expose their own
    /// `videoId`, so synthesize a single item for them.
    pub fn all_videos(&self) -> Vec<ZhsVideo> {
        if !self.videos.is_empty() {
            return self.videos.clone();
        }
        match (self.video_id, self.video_sec) {
            (Some(video_id), Some(video_sec)) => vec![ZhsVideo {
                video_id,
                lesson_video_id: self.lesson_id,
                video_sec,
                is_studied: self.is_studied,
                name: self.name.clone(),
            }],
            _ => Vec::new(),
        }
    }
}

/// One playable video (小节).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsVideo {
    /// Video id (`videoId`).
    pub video_id: u64,
    /// Small-lesson id (`videoSmallLessons[].id`, also called `lessonVideoId`).
    pub lesson_video_id: u64,
    /// Video length in seconds.
    pub video_sec: u64,
    /// Platform study flag (`isStudiedLesson`).
    pub is_studied: Option<i64>,
    /// Video name when the platform exposes it separately.
    pub name: String,
}

/// Course tree returned by [`crate::zhihuishu::ZhsClient::course_detail`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ZhsCourseDetail {
    /// Course metadata.
    pub course: ZhsCourse,
    /// Chapters in platform order.
    pub chapters: Vec<ZhsChapter>,
}

impl ZhsCourseDetail {
    /// Total number of playable videos.
    pub fn total_videos(&self) -> usize {
        self.chapters
            .iter()
            .flat_map(|c| &c.lessons)
            .map(|l| l.all_videos().len())
            .sum()
    }

    /// Number of videos the platform currently marks as studied.
    pub fn completed_videos(&self) -> usize {
        self.chapters
            .iter()
            .flat_map(|c| &c.lessons)
            .flat_map(|l| l.all_videos())
            .filter(|v| v.is_studied.unwrap_or(0) != 0)
            .count()
    }

    /// `(lessonId, lessonVideoId)` of every playable video, in platform order.
    ///
    /// `queryStuyInfo` takes both ids and keys its reply by `lessonVideoId`, so
    /// this is the batch shape the completion refresh needs. Lessons without
    /// small lessons expose their own id as `lessonVideoId`.
    pub fn lesson_video_pairs(&self) -> Vec<(u64, u64)> {
        self.chapters
            .iter()
            .flat_map(|chapter| &chapter.lessons)
            .flat_map(|lesson| {
                lesson
                    .all_videos()
                    .into_iter()
                    .map(|video| (lesson.lesson_id, video.lesson_video_id))
            })
            .collect()
    }
}

/// Anti-cheat / exception status returned by the `exceptionActionDetail`
/// endpoints.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsExceptionStatus {
    /// True when the platform has locked further study for the course.
    pub lock: bool,
    /// True when the account has a recent abnormal-behaviour record.
    pub abnormal: bool,
    /// Sanitized platform message (never contains cookies or signatures).
    pub message: String,
}

/// A meet course (见面课) replay entry.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ZhsMeet {
    /// Meet course id (`meetCourseId`).
    pub meet_course_id: u64,
    /// Live id used by the replay APIs (`liveId` / `liveCourseId`).
    pub live_id: u64,
    /// Replay video id (`videoId`), when exposed.
    pub video_id: Option<u64>,
    /// Parent recruit id.
    pub recruit_id: u64,
    /// Parent course id.
    pub course_id: u64,
    /// Meet title.
    pub name: String,
    /// Speaker / teacher name.
    pub teacher: String,
    /// Start time as reported by the platform.
    pub start_time: Option<String>,
    /// End time as reported by the platform.
    pub end_time: Option<String>,
    /// Replay page URL, when exposed.
    pub replay_url: Option<String>,
    /// Quiz (测验) page URL, when exposed.
    pub exam_url: Option<String>,
    /// Replay length in seconds, when the list endpoint exposes it.
    pub duration_secs: Option<u64>,
    /// Platform status code (`examStatus` / `status`).
    pub status: Option<i64>,
}

impl ZhsMeet {
    /// Stable label used in progress events and CLI output.
    pub fn label(&self) -> String {
        let name = if self.name.trim().is_empty() {
            format!("见面课 {}", self.live_id)
        } else {
            self.name.trim().to_string()
        };
        match &self.start_time {
            Some(start) if !start.trim().is_empty() => format!("{name}（{start}）"),
            _ => name,
        }
    }

    /// Whether the replay APIs can be used for this entry.
    pub fn has_replay(&self) -> bool {
        self.live_id != 0
            && self
                .replay_url
                .as_deref()
                .is_some_and(|u| !u.trim().is_empty())
    }
}

/// One replay video of a meet course.
///
/// A meet replay can contain several videos; the minute report must carry the
/// `videoId` of the video the minute belongs to. `duration_secs` is `0` when the
/// platform did not expose a length (then only single-video replays are exact).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsMeetVideo {
    /// Replay video id.
    pub video_id: u64,
    /// Video length in seconds, `0` when unknown.
    pub duration_secs: u64,
}

/// Replay attendance progress of one meet course.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsMeetProgress {
    /// Total number of one-minute slots in the replay.
    pub total_minutes: u32,
    /// Watched minute numbers, ascending and de-duplicated.
    pub watched_minutes: Vec<u32>,
    /// Number of watched slots.
    pub watched_count: usize,
    /// Watched coverage in percent (0-100).
    pub percent: u32,
}

impl ZhsMeetProgress {
    /// Build a progress snapshot from a total and a raw minute list.
    pub fn new(total_minutes: u32, mut watched_minutes: Vec<u32>) -> Self {
        watched_minutes.sort_unstable();
        watched_minutes.dedup();
        let watched_count = watched_minutes.len();
        let percent = if total_minutes == 0 {
            0
        } else {
            ((watched_count.min(total_minutes as usize) * 100) / total_minutes as usize) as u32
        };
        Self {
            total_minutes,
            watched_minutes,
            watched_count,
            percent,
        }
    }
}

/// Per-video watch options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsWatchOptions {
    /// Only build the plan; never send a completion report.
    pub dry_run: bool,
    /// Re-report videos the platform already marks as finished.
    pub include_completed: bool,
    /// Stop after this many videos (0 or `None` means no limit).
    pub max_videos: Option<usize>,
    /// Re-query `queryStuyInfo` after each report to confirm `watchState == 1`.
    pub verify: bool,
}

impl Default for ZhsWatchOptions {
    fn default() -> Self {
        Self {
            // The core default is read-only; callers must opt in to real
            // submissions. This keeps CLI/GUI dry-run-by-default even if a
            // future call site forgets to pass the flag through.
            dry_run: true,
            include_completed: false,
            max_videos: None,
            verify: true,
        }
    }
}

/// Video-course progress stages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZhsProgressStage {
    /// Building or executing the video plan.
    Videos,
    /// Fetching the meet course list.
    MeetList,
    /// Reporting replay minutes.
    MeetMinutes,
    /// Verifying the server-side state.
    Verify,
    /// Checking the anti-cheat endpoint.
    CircuitCheck,
}

impl ZhsProgressStage {
    /// Chinese label for CLI/GUI display.
    pub fn label(self) -> &'static str {
        match self {
            Self::Videos => "视频课",
            Self::MeetList => "见面课列表",
            Self::MeetMinutes => "回放考勤",
            Self::Verify => "复核",
            Self::CircuitCheck => "风控检查",
        }
    }
}

/// Progress snapshot emitted through the cancellation callback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsProgress {
    /// Current stage.
    pub stage: ZhsProgressStage,
    /// Items finished so far.
    pub done: usize,
    /// Items in this stage.
    pub total: usize,
    /// Human-readable item label (never contains cookies or signatures).
    pub label: String,
    /// Human-readable status message.
    pub message: String,
}

impl ZhsProgress {
    /// Build one progress snapshot.
    pub fn new(
        stage: ZhsProgressStage,
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

/// Terminal state of one video target or one meet watch run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZhsWatchState {
    /// Execution succeeded (and was verified unless verification was disabled).
    Ok,
    /// Nothing sent: already completed, excluded by options, or plan-only.
    Skip,
    /// Dry run: plan printed, nothing sent.
    DryRun,
    /// The server rejected the report or verification failed.
    Failed,
    /// The caller cancelled through the progress callback.
    Cancelled,
    /// Anti-cheat or repeated failures aborted the whole batch.
    CircuitBroken,
}

impl ZhsWatchState {
    /// Chinese label for CLI/GUI display.
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

/// One planned video target.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsVideoTarget {
    /// Enrollment id.
    pub recruit_id: u64,
    /// Course id.
    pub course_id: u64,
    /// Chapter id.
    pub chapter_id: u64,
    /// Lesson id.
    pub lesson_id: u64,
    /// Small-lesson id (`lessonVideoId`).
    pub lesson_video_id: u64,
    /// Video id.
    pub video_id: u64,
    /// Video length in seconds.
    pub video_sec: u64,
    /// `course / chapter / lesson` label for output.
    pub label: String,
    /// Platform says the video is already finished.
    pub completed: bool,
}

impl ZhsVideoTarget {
    /// Whether a plan/execution should skip this target.
    pub fn skip_reason(&self, opts: &ZhsWatchOptions) -> Option<&'static str> {
        if self.video_id == 0 || self.lesson_video_id == 0 || self.video_sec == 0 {
            return Some("视频信息不完整，跳过");
        }
        if self.completed && !opts.include_completed {
            return Some("平台已标记完成，跳过");
        }
        None
    }
}

/// Study note returned by `prelearningNote`.
///
/// The `noteId` (`studiedLessonDto.id`) is required by the completion report and
/// must be fetched fresh for every report; `watch_state` is the value observed
/// before the report was sent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsPrelearningNote {
    /// `studiedLessonDto.id`.
    pub note_id: u64,
    /// `studiedLessonDto.watchState` observed before reporting.
    pub watch_state: Option<i64>,
    /// `studiedLessonDto.studyTotalTime` observed before reporting.
    pub study_total_time: Option<u64>,
    /// `studiedLessonDto.isStudiedLesson` observed before reporting.
    pub is_studied: Option<i64>,
}

impl ZhsPrelearningNote {
    /// Whether the platform already considers this video finished.
    pub fn completed(&self) -> bool {
        self.watch_state == Some(1)
    }
}

/// Per-video study state returned by `queryStuyInfo`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsVideoStudy {
    /// Video id the state belongs to (`lessonVideoId`).
    pub video_id: u64,
    /// `watchState`: `1` means finished, `2` means in progress.
    pub watch_state: Option<i64>,
    /// Total watched seconds.
    pub study_total_time: Option<u64>,
}

impl ZhsVideoStudy {
    /// Whether the platform marks the video as finished.
    pub fn completed(&self) -> bool {
        self.watch_state == Some(1)
    }
}

/// Result of one video target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsWatchOutcome {
    /// Target label.
    pub label: String,
    /// Terminal state.
    pub state: ZhsWatchState,
    /// `watchState` observed during verification, when available.
    pub watch_state: Option<i64>,
    /// Human-readable message.
    pub message: String,
}

/// Result of one meet replay watch run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsMeetOutcome {
    /// Meet label.
    pub label: String,
    /// Target coverage in minutes.
    pub target_minutes: u32,
    /// Watched minutes before this run.
    pub watched_before: usize,
    /// Minutes successfully reported in this run.
    pub submitted: usize,
    /// Minutes skipped because they were already watched.
    pub skipped: usize,
    /// Reports that failed after retries.
    pub failed: usize,
    /// Watched count re-read after the run, when verification ran.
    pub watched_after: Option<usize>,
    /// Terminal state.
    pub state: ZhsWatchState,
    /// Human-readable message.
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_options_default_to_read_only() {
        let opts = ZhsWatchOptions::default();
        assert!(opts.dry_run, "core default must never submit for real");
        assert!(!opts.include_completed);
        assert!(opts.max_videos.is_none());
        assert!(opts.verify);
        // Opting in is explicit.
        let live = ZhsWatchOptions {
            dry_run: false,
            ..ZhsWatchOptions::default()
        };
        assert!(!live.dry_run);
    }

    #[test]
    fn course_label_and_secret_round_trip() {
        let course = ZhsCourse {
            recruit_id: 463_667,
            course_id: 1_000_011_214,
            name: "军事理论".to_string(),
            ..ZhsCourse::default()
        };
        assert_eq!(course.label(), "军事理论");
        assert_eq!(course.course_secret(), "4e5e5a5e435e4859454a585959445b425c");
        let unsupported = ZhsCourse {
            course_type: Some("POLYMAS".to_string()),
            ..course
        };
        assert!(unsupported.is_polymas());
    }

    #[test]
    fn course_kind_defaults_to_shared_for_old_payloads() {
        let course = ZhsCourse {
            recruit_id: 1,
            course_id: 2,
            ..ZhsCourse::default()
        };
        assert_eq!(course.kind, ZhsCourseKind::Shared);
        let mut value = serde_json::to_value(&course).unwrap();
        assert_eq!(value["kind"], "shared");
        value.as_object_mut().unwrap().remove("kind");
        let parsed: ZhsCourse = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.kind, ZhsCourseKind::Shared);
        assert_eq!(ZhsCourseKind::Ai.label(), "AI 智课");
        assert_eq!(ZhsCourseKind::School.label(), "智慧课程");
        assert_eq!(ZhsCourseKind::Other.label(), "其他");
    }

    #[test]
    fn skip_reason_ignores_completed_unless_requested() {
        let target = ZhsVideoTarget {
            recruit_id: 1,
            course_id: 2,
            chapter_id: 3,
            lesson_id: 4,
            lesson_video_id: 5,
            video_id: 6,
            video_sec: 7,
            completed: true,
            label: "x".to_string(),
        };
        assert!(target.skip_reason(&ZhsWatchOptions::default()).is_some());
        let include_completed = ZhsWatchOptions {
            include_completed: true,
            ..ZhsWatchOptions::default()
        };
        assert!(target.skip_reason(&include_completed).is_none());
    }
}
