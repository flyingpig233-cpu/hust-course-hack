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
}
