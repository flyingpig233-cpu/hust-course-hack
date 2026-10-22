//! Tauri commands. All network access goes through `SmartCourseClient`.

use crate::{
    events::JobProgress,
    state::{AppState, SessionInfo},
};
use hust_course_hack::{
    AnswerBank, CourseDetail, CourseSummary, CrawlProgress, FetchOptions, PlannedWork,
    REPORT_VERSION, VIDEO_HELPER_SCRIPT, WatchOptions, collect_targets, plan_course, watch_target,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CrawlOptions {
    pub include_questions: Option<bool>,
    pub include_video_info: Option<bool>,
    pub concurrency: Option<usize>,
}

impl CrawlOptions {
    fn to_fetch_options(&self) -> FetchOptions {
        FetchOptions {
            include_questions: self.include_questions.unwrap_or(true),
            include_video_info: self.include_video_info.unwrap_or(true),
            concurrency: self.concurrency.unwrap_or(4).clamp(1, 8),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchRequest {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSummaryDto {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub errors: Vec<String>,
    pub cancelled: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuizRequest {
    /// Course id, class id, or exact course name.
    pub course: String,
    /// Only process this work id or job id.
    pub work: Option<String>,
    /// Build the plan and skip every network submission.
    pub dry_run: bool,
    /// Process at most this many works (for a cautious first run).
    pub max_works: Option<usize>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerBankInfoDto {
    pub questions: usize,
    pub version: Option<u32>,
}

#[tauri::command]
pub async fn open_login_window(app: AppHandle) -> Result<(), String> {
    // Must be async: creating a WebView2 window blocks until the main event
    // loop creates the webview. A synchronous command runs on the main thread
    // and would deadlock there, leaving the login window blank and unresponsive.
    crate::login::open_login_window(&app)
}

#[tauri::command]
pub fn session_info(state: State<'_, AppState>) -> Option<SessionInfo> {
    state.info()
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>) {
    state.clear_session();
}

#[tauri::command]
pub async fn list_courses(state: State<'_, AppState>) -> Result<Vec<CourseSummary>, String> {
    let client = state.client().ok_or_else(not_connected)?;
    let courses = client
        .list_courses()
        .await
        .map_err(|error| format!("刷新课程列表失败：{error:#}"))?;
    state.set_courses(courses.clone());
    Ok(courses)
}

#[tauri::command]
pub async fn fetch_course(
    app: AppHandle,
    state: State<'_, AppState>,
    course_id: String,
    options: CrawlOptions,
) -> Result<CourseDetail, String> {
    let _job = state.begin_job()?;
    let client = state.client().ok_or_else(not_connected)?;
    let course = state.course(&course_id).ok_or_else(course_not_found)?;
    let options = options.to_fetch_options();
    let app_state: &AppState = &state;
    let progress = |progress: CrawlProgress| {
        emit(
            &app,
            JobProgress::Crawl {
                done: progress.done_leaves,
                total: progress.total_leaves,
            },
        );
        !app_state.is_cancelled()
    };

    client
        .fetch_course_with_progress(&course, &options, &progress)
        .await
        .map_err(job_error)
}

#[tauri::command]
pub async fn watch_course(
    app: AppHandle,
    state: State<'_, AppState>,
    request: WatchRequest,
) -> Result<WatchSummaryDto, String> {
    let _job = state.begin_job()?;
    let client = state.client().ok_or_else(not_connected)?;
    let course = state.course(&request.course).ok_or_else(course_not_found)?;
    let app_state: &AppState = &state;

    // `dtoken`, `otherInfo` and `attDurationEnc` are session/video bound, so
    // every run refreshes the course and video details first.
    let fetch_options = FetchOptions {
        include_questions: false,
        include_video_info: true,
        concurrency: 4,
    };
    let progress = |progress: CrawlProgress| {
        emit(
            &app,
            JobProgress::Crawl {
                done: progress.done_leaves,
                total: progress.total_leaves,
            },
        );
        !app_state.is_cancelled()
    };
    let detail = client
        .fetch_course_with_progress(&course, &fetch_options, &progress)
        .await
        .map_err(job_error)?;

    let watch_options = WatchOptions {
        include_completed: request.include_completed,
        job: request.job.clone(),
        max_videos: request.max_videos,
        step_secs: request.step_secs,
        delay_ms: request.delay_ms,
    };
    let targets = collect_targets(&client, &detail, &watch_options).map_err(job_error)?;
    let total = targets.len();
    emit(
        &app,
        JobProgress::WatchPlan {
            total,
            dry_run: request.dry_run,
        },
    );

    let mut passed = 0usize;
    let mut failed = 0usize;
    let mut errors = Vec::new();
    let mut cancelled = false;

    for (offset, target) in targets.iter().enumerate() {
        if app_state.is_cancelled() {
            cancelled = true;
            break;
        }
        let index = offset + 1;
        let label = target.label();
        let job_id = target.job_id.clone();
        emit(
            &app,
            JobProgress::Watch {
                index,
                total,
                label: label.clone(),
                job_id: job_id.clone(),
                status: "running".to_string(),
                message: None,
            },
        );

        if request.dry_run {
            let end = target.duration_secs.max(1);
            let start = target.played_secs.min(end);
            let start_url = target
                .report_url(client.base_url(), start, 4)
                .map_err(job_error)?;
            let end_url = target
                .report_url(client.base_url(), end, 4)
                .map_err(job_error)?;
            emit(
                &app,
                JobProgress::Watch {
                    index,
                    total,
                    label,
                    job_id,
                    status: "dry_run".to_string(),
                    message: Some(format!(
                        "report v{REPORT_VERSION}\nstart: {start_url}\nend: {end_url}"
                    )),
                },
            );
            continue;
        }

        match watch_target(&client, target, &watch_options).await {
            Ok(true) => {
                passed += 1;
                emit(
                    &app,
                    JobProgress::Watch {
                        index,
                        total,
                        label,
                        job_id,
                        status: "passed".to_string(),
                        message: None,
                    },
                );
            }
            Ok(false) => {
                failed += 1;
                emit(
                    &app,
                    JobProgress::Watch {
                        index,
                        total,
                        label,
                        job_id,
                        status: "failed".to_string(),
                        message: Some("服务端返回 isPassed=false".to_string()),
                    },
                );
            }
            Err(error) => {
                failed += 1;
                let message = format!("{error:#}");
                errors.push(format!("{label}: {message}"));
                emit(
                    &app,
                    JobProgress::Watch {
                        index,
                        total,
                        label,
                        job_id,
                        status: "error".to_string(),
                        message: Some(message),
                    },
                );
            }
        }
    }

    Ok(WatchSummaryDto {
        total,
        passed,
        failed,
        errors,
        cancelled,
    })
}

/// One-click quiz completion: refresh the course, match every in-progress
/// work against the embedded answer bank, then submit complete works.
///
/// Works whose questions were not fetched or whose answers are missing from
/// the bank are reported as skipped and never partially submitted.
#[tauri::command]
pub async fn complete_quizzes(
    app: AppHandle,
    state: State<'_, AppState>,
    request: QuizRequest,
) -> Result<QuizSummaryDto, String> {
    let _job = state.begin_job()?;
    let client = state.client().ok_or_else(not_connected)?;
    let course = state.course(&request.course).ok_or_else(course_not_found)?;
    let bank = AnswerBank::builtin().map_err(|error| format!("加载内置题库失败：{error:#}"))?;

    // Questions are needed for the plan; video signatures are not.
    let fetch_options = FetchOptions {
        include_questions: true,
        include_video_info: false,
        concurrency: 4,
    };
    let app_state: &AppState = &state;
    let progress = |progress: CrawlProgress| {
        emit(
            &app,
            JobProgress::Crawl {
                done: progress.done_leaves,
                total: progress.total_leaves,
            },
        );
        !app_state.is_cancelled()
    };
    let detail = client
        .fetch_course_with_progress(&course, &fetch_options, &progress)
        .await
        .map_err(job_error)?;

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
    emit(
        &app,
        JobProgress::QuizPlan {
            total,
            skipped_graded: plan.skipped_graded,
            incomplete,
            dry_run: request.dry_run,
            bank_questions: bank.len(),
        },
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
        if app_state.is_cancelled() {
            summary.cancelled = true;
            break;
        }
        let index = offset + 1;
        let question_count = work.answers.len().max(work.question_count);

        if !work.is_complete() {
            let reason = quiz_skip_reason(work);
            summary.skipped += 1;
            summary.works.push(QuizWorkResultDto {
                work_id: work.work_id.clone(),
                work_name: work.work_name.clone(),
                chapter: work.chapter_title.clone(),
                question_count,
                status: "skipped".to_string(),
                message: Some(reason.clone()),
            });
            emit(
                &app,
                JobProgress::Quiz {
                    index,
                    total,
                    work_id: work.work_id.clone(),
                    work_name: work.work_name.clone(),
                    chapter: work.chapter_title.clone(),
                    question_count,
                    status: "skipped".to_string(),
                    message: Some(reason),
                },
            );
            continue;
        }

        if request.dry_run {
            let message = format!("题库已匹配 {} 道题，可提交", work.answers.len());
            summary.works.push(QuizWorkResultDto {
                work_id: work.work_id.clone(),
                work_name: work.work_name.clone(),
                chapter: work.chapter_title.clone(),
                question_count,
                status: "dry_run".to_string(),
                message: Some(message.clone()),
            });
            emit(
                &app,
                JobProgress::Quiz {
                    index,
                    total,
                    work_id: work.work_id.clone(),
                    work_name: work.work_name.clone(),
                    chapter: work.chapter_title.clone(),
                    question_count,
                    status: "dry_run".to_string(),
                    message: Some(message),
                },
            );
            continue;
        }

        emit(
            &app,
            JobProgress::Quiz {
                index,
                total,
                work_id: work.work_id.clone(),
                work_name: work.work_name.clone(),
                chapter: work.chapter_title.clone(),
                question_count,
                status: "running".to_string(),
                message: None,
            },
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
                    work_id: work.work_id.clone(),
                    work_name: work.work_name.clone(),
                    chapter: work.chapter_title.clone(),
                    question_count,
                    status: "submitted".to_string(),
                    message: Some(message.clone()),
                });
                emit(
                    &app,
                    JobProgress::Quiz {
                        index,
                        total,
                        work_id: work.work_id.clone(),
                        work_name: work.work_name.clone(),
                        chapter: work.chapter_title.clone(),
                        question_count,
                        status: "submitted".to_string(),
                        message: Some(message),
                    },
                );
            }
            Err(error) => {
                summary.failed += 1;
                let message = format!("{error:#}");
                summary.errors.push(format!(
                    "{} / {}: {message}",
                    work.chapter_title, work.work_name
                ));
                summary.works.push(QuizWorkResultDto {
                    work_id: work.work_id.clone(),
                    work_name: work.work_name.clone(),
                    chapter: work.chapter_title.clone(),
                    question_count,
                    status: "failed".to_string(),
                    message: Some(message.clone()),
                });
                emit(
                    &app,
                    JobProgress::Quiz {
                        index,
                        total,
                        work_id: work.work_id.clone(),
                        work_name: work.work_name.clone(),
                        chapter: work.chapter_title.clone(),
                        question_count,
                        status: "failed".to_string(),
                        message: Some(message),
                    },
                );
            }
        }
    }

    Ok(summary)
}

#[tauri::command]
pub async fn answer_bank_info() -> Result<AnswerBankInfoDto, String> {
    let bank = AnswerBank::builtin().map_err(|error| format!("加载内置题库失败：{error:#}"))?;
    Ok(AnswerBankInfoDto {
        questions: bank.len(),
        version: bank.version,
    })
}

fn quiz_skip_reason(work: &PlannedWork) -> String {
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

#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>) {
    state.cancel();
}

#[tauri::command]
pub fn helper_script() -> String {
    VIDEO_HELPER_SCRIPT.to_string()
}

#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|error| format!("写入文件失败：{error}"))
}

fn emit(app: &AppHandle, progress: JobProgress) {
    let _ = app.emit("job-progress", progress);
}

fn job_error(error: anyhow::Error) -> String {
    let text = format!("{error:#}");
    if text.contains("cancelled") {
        "已取消".to_string()
    } else {
        text
    }
}

fn not_connected() -> String {
    "尚未连接账号，请先导入 Cookie".to_string()
}

fn course_not_found() -> String {
    "找不到该课程，请刷新课程列表后重试".to_string()
}
