//! Progress events streamed to the frontend during long-running jobs.

use serde::Serialize;

/// One message on the `job-progress` channel.
///
/// The frontend discriminates on `kind`. Fields are camelCase to match the
/// TypeScript types in `ui/src/types.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobProgress {
    /// Knowledge points crawled so far for the selected course.
    Crawl { done: usize, total: usize },
    /// The course data was refreshed and video targets were collected.
    WatchPlan { total: usize, dry_run: bool },
    /// State change for one video in the report queue.
    Watch {
        /// 1-based position in the queue.
        index: usize,
        total: usize,
        label: String,
        job_id: String,
        /// `running`, `passed`, `failed`, `error`, or `dry_run`.
        status: String,
        message: Option<String>,
    },
    /// The course was refreshed and quiz works were planned.
    QuizPlan {
        total: usize,
        skipped_graded: usize,
        incomplete: usize,
        dry_run: bool,
        bank_questions: usize,
    },
    /// State change for one quiz work in the submit queue.
    Quiz {
        /// 1-based position in the queue.
        index: usize,
        total: usize,
        work_id: String,
        work_name: String,
        chapter: String,
        question_count: usize,
        /// `running`, `submitted`, `failed`, `skipped`, or `dry_run`.
        status: String,
        message: Option<String>,
    },
    /// A Zhihuishu job planned its targets.
    ///
    /// `job` is `zhs-watch` or `zhs-meet-watch`; `stage` is `videos` or `meet`.
    ZhsPlan {
        job: String,
        stage: String,
        total: usize,
        dry_run: bool,
        skipped: usize,
    },
    /// One Zhihuishu progress transition (video target, replay minute, …).
    ///
    /// Never carries cookies, `secretStr` values or signed URLs.
    ZhsStage {
        job: String,
        /// `loading`, `videos`, `meet_list`, `meet_minutes`, `verify`, or
        /// `circuit_check`.
        stage: String,
        done: usize,
        total: usize,
        label: String,
        message: String,
    },
    /// Terminal state of one Zhihuishu target (a video or a meet replay).
    ZhsTarget {
        job: String,
        /// 1-based position in the queue.
        index: usize,
        total: usize,
        label: String,
        /// `running`, `ok`, `skip`, `dry_run`, `failed`, `cancelled`, or
        /// `circuit_broken`.
        status: String,
        message: Option<String>,
        /// Replay goal in minutes (meet jobs only).
        target_minutes: Option<u32>,
        /// Watched minutes before the run (meet jobs only).
        watched_before: Option<usize>,
    },
}
