//! Long-running jobs: course crawl, video progress reporting, quiz
//! submission. A faithful port of the Tauri commands; the only difference is
//! that progress events go into a polled history instead of Tauri events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use hust_course_hack::{
    AnswerBank, CourseSummary, FetchOptions, REPORT_VERSION, SmartCourseClient, WatchOptions,
    collect_targets, plan_course, watch_target,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::state::{JobHistory, push_event};

// ---------------------------------------------------------------------------
// Request bodies (camelCase, same shapes the GUI sends over IPC)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CrawlOptionsBody {
    pub include_questions: Option<bool>,
    pub include_video_info: Option<bool>,
    pub concurrency: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchBody {
    /// Course id, class id, or exact course name.
    pub course: String,
    /// Only report this job id.
    pub job: Option<String>,
    pub include_completed: bool,
    pub step_secs: u64,
    pub delay_ms: u64,
    pub max_videos: Option<usize>,
    /// Build signed report URLs without sending them.
    pub dry_run: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuizBody {
    /// Course id, class id, or exact course name.
    pub course: String,
    /// Only process this work id or job id.
    pub work: Option<String>,
    /// Build the plan and skip every network submission.
    pub dry_run: bool,
    /// Process at most this many works (for a cautious first run).
    pub max_works: Option<usize>,
}

// ---------------------------------------------------------------------------
// Result DTOs (camelCase, same shapes the GUI receives over IPC)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSummaryDto {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub errors: Vec<String>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizWorkResultDto {
    pub work_id: String,
    pub work_name: String,
    pub chapter: String,
    pub question_count: usize,
    /// `submitted`, `failed`, `skipped`, or `dry_run`.
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizSummaryDto {
    pub total: usize,
    pub submitted: usize,
    pub failed: usize,
    pub skipped: usize,
    pub cancelled: bool,
    pub dry_run: bool,
    pub skipped_graded: usize,
    pub bank_questions: usize,
    pub plan_errors: Vec<String>,
    pub errors: Vec<String>,
    pub works: Vec<QuizWorkResultDto>,
}

/// Map a crawl/report failure to the user-facing message. The UI matches on
/// "已取消" to render the cancelled state.
pub fn job_message(error: anyhow::Error) -> String {
    let text = format!("{error:#}");
    if text.contains("cancelled") {
        "已取消".to_string()
    } else {
        text
    }
}

fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Job runners
// ---------------------------------------------------------------------------

/// Fetch one course's chapters, cards, task points, questions, and video info.
pub async fn run_fetch(
    cancel: &AtomicBool,
    history: &Mutex<JobHistory>,
    client: &SmartCourseClient,
    course: CourseSummary,
    options: Option<CrawlOptionsBody>,
) -> Result<Value, String> {
    let options = options.unwrap_or_default();
    let fetch_options = FetchOptions {
        include_questions: options.include_questions.unwrap_or(true),
        include_video_info: options.include_video_info.unwrap_or(true),
        concurrency: options.concurrency.unwrap_or(4).clamp(1, 8),
    };
    let progress = |progress: hust_course_hack::CrawlProgress| {
        push_event(
            history,
            json!({
                "kind": "crawl",
                "done": progress.done_leaves,
                "total": progress.total_leaves,
            }),
        );
        !is_cancelled(cancel)
    };
    let detail = client
        .fetch_course_with_progress(&course, &fetch_options, &progress)
        .await
        .map_err(job_message)?;
    serde_json::to_value(detail).map_err(|error| format!("序列化课程数据失败：{error}"))
}

/// Report video progress for a whole course or a single job id.
pub async fn run_watch(
    cancel: &AtomicBool,
    history: &Mutex<JobHistory>,
    client: &SmartCourseClient,
    course: CourseSummary,
    request: WatchBody,
) -> Result<Value, String> {
    // `dtoken`, `otherInfo` and `attDurationEnc` are session/video bound, so
    // every run refreshes the course and video details first.
    let fetch_options = FetchOptions {
        include_questions: false,
        include_video_info: true,
        concurrency: 4,
    };
    let progress = |progress: hust_course_hack::CrawlProgress| {
        push_event(
            history,
            json!({
                "kind": "crawl",
                "done": progress.done_leaves,
                "total": progress.total_leaves,
            }),
        );
        !is_cancelled(cancel)
    };
    let detail = client
        .fetch_course_with_progress(&course, &fetch_options, &progress)
        .await
        .map_err(job_message)?;

    let watch_options = WatchOptions {
        include_completed: request.include_completed,
        job: request.job.clone(),
        max_videos: request.max_videos,
        step_secs: request.step_secs,
        delay_ms: request.delay_ms,
    };
    let targets = collect_targets(client, &detail, &watch_options).map_err(job_message)?;
    let total = targets.len();
    push_event(
        history,
        json!({
            "kind": "watchPlan",
            "total": total,
            "dryRun": request.dry_run,
        }),
    );

    let mut passed = 0usize;
    let mut failed = 0usize;
    let mut errors = Vec::new();
    let mut was_cancelled = false;

    for (offset, target) in targets.iter().enumerate() {
        if is_cancelled(cancel) {
            was_cancelled = true;
            break;
        }
        let index = offset + 1;
        let label = target.label();
        let job_id = target.job_id.clone();
        push_event(
            history,
            json!({
                "kind": "watch",
                "index": index,
                "total": total,
                "label": label,
                "jobId": job_id,
                "status": "running",
                "message": Value::Null,
            }),
        );

        if request.dry_run {
            let end = target.duration_secs.max(1);
            let start = target.played_secs.min(end);
            let start_url = target
                .report_url(client.base_url(), start, 4)
                .map_err(job_message)?;
            let end_url = target
                .report_url(client.base_url(), end, 4)
                .map_err(job_message)?;
            push_event(
                history,
                json!({
                    "kind": "watch",
                    "index": index,
                    "total": total,
                    "label": label,
                    "jobId": job_id,
                    "status": "dry_run",
                    "message": format!("report v{REPORT_VERSION}\nstart: {start_url}\nend: {end_url}"),
                }),
            );
            continue;
        }

        match watch_target(client, target, &watch_options).await {
            Ok(true) => {
                passed += 1;
                push_event(
                    history,
                    json!({
                        "kind": "watch",
                        "index": index,
                        "total": total,
                        "label": label,
                        "jobId": job_id,
                        "status": "passed",
                        "message": Value::Null,
                    }),
                );
            }
            Ok(false) => {
                failed += 1;
                push_event(
                    history,
                    json!({
                        "kind": "watch",
                        "index": index,
                        "total": total,
                        "label": label,
                        "jobId": job_id,
                        "status": "failed",
                        "message": "服务端返回 isPassed=false",
                    }),
                );
            }
            Err(error) => {
                failed += 1;
                let message = format!("{error:#}");
                errors.push(format!("{label}: {message}"));
                push_event(
                    history,
                    json!({
                        "kind": "watch",
                        "index": index,
                        "total": total,
                        "label": label,
                        "jobId": job_id,
                        "status": "error",
                        "message": message,
                    }),
                );
            }
        }
    }

    serde_json::to_value(WatchSummaryDto {
        total,
        passed,
        failed,
        errors,
        cancelled: was_cancelled,
    })
    .map_err(|error| format!("序列化结果失败：{error}"))
}

/// One-click quiz completion: refresh the course, match every in-progress
/// work against the answer bank, then submit complete works.
///
/// Works whose questions were not fetched or whose answers are missing from
/// the bank are reported as skipped and never partially submitted.
pub async fn run_quiz(
    cancel: &AtomicBool,
    history: &Mutex<JobHistory>,
    client: &SmartCourseClient,
    course: CourseSummary,
    request: QuizBody,
    bank: &AnswerBank,
) -> Result<Value, String> {
    // Questions are needed for the plan; video signatures are not.
    let fetch_options = FetchOptions {
        include_questions: true,
        include_video_info: false,
        concurrency: 4,
    };
    let progress = |progress: hust_course_hack::CrawlProgress| {
        push_event(
            history,
            json!({
                "kind": "crawl",
                "done": progress.done_leaves,
                "total": progress.total_leaves,
            }),
        );
        !is_cancelled(cancel)
    };
    let detail = client
        .fetch_course_with_progress(&course, &fetch_options, &progress)
        .await
        .map_err(job_message)?;

    let mut plan = plan_course(&detail, bank);
    if let Some(selector) = request
        .work
        .as_deref()
        .map(str::trim)
        .filter(|selector| !selector.is_empty())
    {
        plan.works
            .retain(|work| work.work_id == selector || work.target.job_id == selector);
        if plan.works.is_empty() {
            return Err(format!("没有找到作业 {selector}，请刷新课程后重试"));
        }
    }
    if let Some(max_works) = request.max_works {
        plan.works.truncate(max_works.max(1));
    }

    let total = plan.works.len();
    let incomplete = plan.works.iter().filter(|work| !work.is_complete()).count();
    push_event(
        history,
        json!({
            "kind": "quizPlan",
            "total": total,
            "skippedGraded": plan.skipped_graded,
            "incomplete": incomplete,
            "dryRun": request.dry_run,
            "bankQuestions": bank.len(),
        }),
    );

    let mut summary = QuizSummaryDto {
        total,
        submitted: 0,
        failed: 0,
        skipped: 0,
        cancelled: false,
        dry_run: request.dry_run,
        skipped_graded: plan.skipped_graded,
        bank_questions: bank.len(),
        plan_errors: plan.errors.clone(),
        errors: Vec::new(),
        works: Vec::with_capacity(total),
    };

    for (offset, work) in plan.works.iter().enumerate() {
        if is_cancelled(cancel) {
            summary.cancelled = true;
            break;
        }
        let index = offset + 1;
        let question_count = work.answers.len().max(work.question_count);
        let work_id = work.work_id.clone();
        let work_name = work.work_name.clone();
        let chapter = work.chapter_title.clone();

        if !work.is_complete() {
            let reason = quiz_skip_reason(work);
            summary.skipped += 1;
            summary.works.push(QuizWorkResultDto {
                work_id: work_id.clone(),
                work_name: work_name.clone(),
                chapter: chapter.clone(),
                question_count,
                status: "skipped".to_string(),
                message: Some(reason.clone()),
            });
            push_event(
                history,
                json!({
                    "kind": "quiz",
                    "index": index,
                    "total": total,
                    "workId": work_id,
                    "workName": work_name,
                    "chapter": chapter,
                    "questionCount": question_count,
                    "status": "skipped",
                    "message": reason,
                }),
            );
            continue;
        }

        if request.dry_run {
            let message = format!("题库已匹配 {} 道题，可提交", work.answers.len());
            summary.works.push(QuizWorkResultDto {
                work_id: work_id.clone(),
                work_name: work_name.clone(),
                chapter: chapter.clone(),
                question_count,
                status: "dry_run".to_string(),
                message: Some(message.clone()),
            });
            push_event(
                history,
                json!({
                    "kind": "quiz",
                    "index": index,
                    "total": total,
                    "workId": work_id,
                    "workName": work_name,
                    "chapter": chapter,
                    "questionCount": question_count,
                    "status": "dry_run",
                    "message": message,
                }),
            );
            continue;
        }

        push_event(
            history,
            json!({
                "kind": "quiz",
                "index": index,
                "total": total,
                "workId": work_id,
                "workName": work_name,
                "chapter": chapter,
                "questionCount": question_count,
                "status": "running",
                "message": Value::Null,
            }),
        );

        match client.submit_planned_work(work).await {
            Ok(reply) => {
                summary.submitted += 1;
                let message = if reply.message.trim().is_empty() {
                    "提交成功".to_string()
                } else {
                    reply.message
                };
                summary.works.push(QuizWorkResultDto {
                    work_id: work_id.clone(),
                    work_name: work_name.clone(),
                    chapter: chapter.clone(),
                    question_count,
                    status: "submitted".to_string(),
                    message: Some(message.clone()),
                });
                push_event(
                    history,
                    json!({
                        "kind": "quiz",
                        "index": index,
                        "total": total,
                        "workId": work_id,
                        "workName": work_name,
                        "chapter": chapter,
                        "questionCount": question_count,
                        "status": "submitted",
                        "message": message,
                    }),
                );
            }
            Err(error) => {
                summary.failed += 1;
                let message = format!("{error:#}");
                summary
                    .errors
                    .push(format!("{chapter} / {work_name}: {message}"));
                summary.works.push(QuizWorkResultDto {
                    work_id: work_id.clone(),
                    work_name: work_name.clone(),
                    chapter: chapter.clone(),
                    question_count,
                    status: "failed".to_string(),
                    message: Some(message.clone()),
                });
                push_event(
                    history,
                    json!({
                        "kind": "quiz",
                        "index": index,
                        "total": total,
                        "workId": work_id,
                        "workName": work_name,
                        "chapter": chapter,
                        "questionCount": question_count,
                        "status": "failed",
                        "message": message,
                    }),
                );
            }
        }
    }

    serde_json::to_value(summary).map_err(|error| format!("序列化结果失败：{error}"))
}

fn quiz_skip_reason(work: &hust_course_hack::PlannedWork) -> String {
    let mut reasons = Vec::new();
    if work.question_count == 0 {
        reasons.push("没有抓到题目".to_string());
    }
    if !work.missing_question_ids.is_empty() {
        reasons.push(format!(
            "题库缺少 {} 道题的答案：{}",
            work.missing_question_ids.len(),
            work.missing_question_ids.join(", ")
        ));
    }
    if !work.errors.is_empty() {
        reasons.push(work.errors.join("；"));
    }
    if work.answers.len() != work.question_count {
        reasons.push(format!(
            "已匹配 {} / {} 道题",
            work.answers.len(),
            work.question_count
        ));
    }
    if reasons.is_empty() {
        reasons.push("作业计划不完整".to_string());
    }
    reasons.join("；")
}

/// Resolve a course selector against the session's course list.
pub fn lookup_course(courses: &[CourseSummary], selector: &str) -> Result<CourseSummary, String> {
    let selector = selector.trim();
    courses
        .iter()
        .find(|course| {
            course.course_id == selector || course.class_id == selector || course.name == selector
        })
        .cloned()
        .ok_or_else(|| "找不到该课程，请刷新课程列表后重试".to_string())
}

/// The resolved course plus runner inputs for one started job.
pub enum JobPlan {
    Fetch {
        course: CourseSummary,
        options: Option<CrawlOptionsBody>,
    },
    Watch {
        course: CourseSummary,
        body: WatchBody,
    },
    Quiz {
        course: CourseSummary,
        body: QuizBody,
    },
}

impl JobPlan {
    pub fn course_id(&self) -> &str {
        match self {
            JobPlan::Fetch { course, .. }
            | JobPlan::Watch { course, .. }
            | JobPlan::Quiz { course, .. } => &course.course_id,
        }
    }
}

/// Execute the planned job. Runs inside a spawned task; progress events go
/// into `history`, the final value into `finish_job`.
pub async fn execute(
    plan: JobPlan,
    cancel: Arc<AtomicBool>,
    history: Arc<Mutex<JobHistory>>,
    client: SmartCourseClient,
    shared_bank: &AnswerBank,
) {
    let result = match plan {
        JobPlan::Fetch { course, options } => {
            run_fetch(&cancel, &history, &client, course, options).await
        }
        JobPlan::Watch { course, body } => {
            run_watch(&cancel, &history, &client, course, body).await
        }
        JobPlan::Quiz { course, body } => {
            run_quiz(&cancel, &history, &client, course, body, shared_bank).await
        }
    };
    crate::state::finish_job(&history, result);
}
