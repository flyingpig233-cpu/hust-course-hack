//! Thin Tauri commands for Ulearning (优学院 / U学).
//!
//! Every command only does session/state bookkeeping and progress events; all
//! HTTP, DES encryption, answer resolution and pacing logic stays in
//! `hust_course_hack::ulearning`. Progress is emitted on the shared
//! `job-progress` channel with the `ulPlan`, `ulStage` and `ulTarget` kinds.
//! The `AUTHORIZATION` token and the DES payloads never cross the IPC boundary.

use crate::{events::JobProgress, state::AppState};
use hust_course_hack::ulearning::{
    UlAction, UlChapter, UlCourse, UlCourseDetail, UlPage, UlPageKind, UlProgress, UlProgressStage,
    UlWatchOptions, UlWatchOutcome, UlWatchState, UlearningClient, plan_course, run_watch,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

/// Job id for the section completion queue.
pub const UL_WATCH_JOB: &str = "ul-watch";
/// Job id for the read-only completion scan.
pub const UL_CHECK_JOB: &str = "ul-check";

/// Sections fetched per batch when scanning completion records.
const CHECK_CONCURRENCY: usize = 6;

// ---- Requests --------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UlWatchRequest {
    /// Course reference: `textbookId`, `textbookId;classId`, player URL or an
    /// id from the course list.
    pub course: String,
    /// Build the plan only; never send a `sync`. Defaults to `true` so a
    /// missing field can never trigger a real submission.
    pub dry_run: bool,
    pub include_completed: bool,
    pub max_sections: Option<usize>,
    pub delay_min_ms: Option<u64>,
    pub delay_max_ms: Option<u64>,
    pub stop_on_error: Option<bool>,
    /// Re-read `/studyrecord/item` after each section.
    pub verify: Option<bool>,
}

impl Default for UlWatchRequest {
    fn default() -> Self {
        Self {
            course: String::new(),
            dry_run: true,
            include_completed: false,
            max_sections: None,
            delay_min_ms: None,
            delay_max_ms: None,
            stop_on_error: Some(true),
            verify: Some(true),
        }
    }
}

impl UlWatchRequest {
    fn options(&self) -> UlWatchOptions {
        let defaults = UlWatchOptions::default();
        let delay_min_ms = self.delay_min_ms.unwrap_or(defaults.delay_min_ms);
        let delay_max_ms = self
            .delay_max_ms
            .unwrap_or(defaults.delay_max_ms)
            .max(delay_min_ms);
        UlWatchOptions {
            dry_run: self.dry_run,
            include_completed: self.include_completed,
            max_sections: self.max_sections,
            delay_min_ms,
            delay_max_ms,
            stop_on_error: self.stop_on_error.unwrap_or(defaults.stop_on_error),
            verify: self.verify.unwrap_or(defaults.verify),
        }
    }
}

// ---- DTOs ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UlCourseDto {
    pub textbook_id: i64,
    pub oc_id: Option<i64>,
    pub class_id: Option<i64>,
    pub name: String,
    pub author: Option<String>,
    pub remaining_secs: Option<i64>,
    pub expired: bool,
}

impl From<UlCourse> for UlCourseDto {
    fn from(course: UlCourse) -> Self {
        let expired = course.is_expired();
        Self {
            textbook_id: course.textbook_id,
            oc_id: course.oc_id,
            class_id: course.class_id,
            name: course.name,
            author: course.author,
            remaining_secs: course.remaining_secs,
            expired,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UlPageDto {
    pub id: i64,
    pub relation_id: i64,
    pub name: String,
    pub content_type: i64,
    /// `video`, `practice` or `document`.
    pub kind: String,
}

impl From<UlPage> for UlPageDto {
    fn from(page: UlPage) -> Self {
        let kind = if page.is_video() {
            "video"
        } else if page.is_practice() {
            "practice"
        } else {
            "document"
        };
        Self {
            id: page.id,
            relation_id: page.relation_id,
            name: page.name,
            content_type: page.content_type,
            kind: kind.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UlSectionDto {
    pub id: i64,
    pub id_for_class: Option<i64>,
    pub name: String,
    pub hide: Option<i64>,
    pub pages: Vec<UlPageDto>,
    /// `completion_status == 1`; `None` until the completion scan runs.
    pub completed: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UlChapterDto {
    pub id: i64,
    pub id_for_class: Option<i64>,
    pub name: String,
    pub hide: Option<i64>,
    pub sections: Vec<UlSectionDto>,
}

fn chapters_dto(
    chapters: Vec<UlChapter>,
    completion: &HashMap<i64, Option<bool>>,
) -> Vec<UlChapterDto> {
    chapters
        .into_iter()
        .map(|chapter| UlChapterDto {
            id: chapter.id,
            id_for_class: chapter.id_for_class,
            name: chapter.name,
            hide: chapter.hide,
            sections: chapter
                .sections
                .into_iter()
                .map(|section| UlSectionDto {
                    id: section.id,
                    id_for_class: section.id_for_class,
                    name: section.name,
                    hide: section.hide,
                    pages: section.pages.into_iter().map(UlPageDto::from).collect(),
                    completed: completion.get(&section.id).copied().flatten(),
                })
                .collect(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UlCourseDetailDto {
    pub course: UlCourseDto,
    pub chapters: Vec<UlChapterDto>,
    pub remaining_secs: Option<i64>,
    pub class_name: Option<String>,
    pub expired: bool,
}

impl From<UlCourseDetail> for UlCourseDetailDto {
    fn from(detail: UlCourseDetail) -> Self {
        let expired = detail.is_expired();
        Self {
            course: detail.course.into(),
            chapters: chapters_dto(detail.chapters, &HashMap::new()),
            remaining_secs: detail.remaining_secs,
            class_name: detail.class_name,
            expired,
        }
    }
}

/// Read-only course status: tree annotated with `completion_status` plus
/// element counts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UlCheckDto {
    pub course: UlCourseDto,
    pub chapters: Vec<UlChapterDto>,
    pub remaining_secs: Option<i64>,
    pub class_name: Option<String>,
    pub expired: bool,
    pub section_count: usize,
    pub completed_sections: usize,
    pub video_pages: usize,
    pub practice_pages: usize,
    pub document_pages: usize,
    /// True when the scan was stopped through `ul_cancel_job`.
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UlOutcomeDto {
    pub label: String,
    pub section_id: i64,
    /// `complete`, `complete_practice`, `skip_done`, `skip_unsupported` or
    /// `skip_expired`.
    pub action: String,
    /// `ok`, `skip`, `dry_run`, `failed`, `cancelled` or `circuit_broken`.
    pub state: String,
    pub completion_status: Option<i64>,
    pub message: String,
}

impl From<UlWatchOutcome> for UlOutcomeDto {
    fn from(outcome: UlWatchOutcome) -> Self {
        Self {
            label: outcome.label,
            section_id: outcome.section_id,
            action: action_key(outcome.action).to_string(),
            state: watch_state_key(outcome.state).to_string(),
            completion_status: outcome.completion_status,
            message: outcome.message,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UlWatchSummaryDto {
    pub total: usize,
    pub ok: usize,
    pub skipped: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub dry_run: bool,
    pub outcomes: Vec<UlOutcomeDto>,
    pub errors: Vec<String>,
}

// ---- Commands --------------------------------------------------------------

/// Student course list of the connected Ulearning account.
#[tauri::command]
pub async fn ul_list_courses(state: State<'_, AppState>) -> Result<Vec<UlCourseDto>, String> {
    let client = ul_client(&state)?;
    let courses = client.list_courses().await.map_err(|error| {
        format!("优学院课程列表接口暂不可用：{error:#}；可粘贴播放器链接手动添加课程")
    })?;
    state.set_ul_courses(courses.clone());
    Ok(courses.into_iter().map(UlCourseDto::from).collect())
}

/// Chapter / section / page tree of one course.
///
/// `course_id` accepts a course-list id or any reference `resolve_course`
/// understands (player URL, `textbookId=...&classId=...`, `textbookId;classId`),
/// so the UI can add a course manually when the list endpoint fails.
#[tauri::command]
pub async fn ul_course_detail(
    state: State<'_, AppState>,
    course_id: String,
) -> Result<UlCourseDetailDto, String> {
    let client = ul_client(&state)?;
    let course = find_course(&state, &client, &course_id)?;
    let detail = client
        .course_detail(&course)
        .await
        .map_err(|error| format!("抓取优学院课程目录失败：{error:#}"))?;
    state.upsert_ul_course(detail.course.clone());
    Ok(detail.into())
}

/// Read-only scan: annotate every section with its `completion_status`.
///
/// This takes the same job slot as the report queue so a running watch job and
/// a scan cannot interleave; it honors `ul_cancel_job` between batches.
#[tauri::command]
pub async fn ul_check(
    app: AppHandle,
    state: State<'_, AppState>,
    course_id: String,
) -> Result<UlCheckDto, String> {
    let _job = state.begin_job()?;
    let client = ul_client(&state)?;
    let app_state: &AppState = &state;
    let course = find_course(&state, &client, &course_id)?;

    let detail = client
        .course_detail(&course)
        .await
        .map_err(|error| format!("抓取优学院课程目录失败：{error:#}"))?;
    state.upsert_ul_course(detail.course.clone());

    let sections = flatten_sections(&detail.chapters);
    let total = sections.len();
    let mut completion: HashMap<i64, Option<bool>> = HashMap::new();
    let mut done = 0usize;
    let mut cancelled = false;

    for chunk in sections.chunks(CHECK_CONCURRENCY) {
        if app_state.is_cancelled() {
            cancelled = true;
            break;
        }
        let mut tasks = Vec::with_capacity(chunk.len());
        for (section_id, label) in chunk {
            let client = client.clone();
            let section_id = *section_id;
            tasks.push((
                section_id,
                label.clone(),
                tauri::async_runtime::spawn(async move {
                    client
                        .section_record(section_id)
                        .await
                        .map(|record| record.completed())
                }),
            ));
        }
        for (section_id, label, task) in tasks {
            match task.await {
                Ok(Ok(completed)) => {
                    completion.insert(section_id, Some(completed));
                }
                Ok(Err(error)) => {
                    log::warn!("ulearning section record {section_id} failed: {error:#}");
                    completion.insert(section_id, None);
                }
                Err(error) => {
                    log::warn!("ulearning section record task failed: {error}");
                    completion.insert(section_id, None);
                }
            }
            done += 1;
            emit(
                &app,
                JobProgress::UlStage {
                    job: UL_CHECK_JOB.to_string(),
                    stage: "verify".to_string(),
                    done,
                    total,
                    label,
                    message: "读取学习记录".to_string(),
                },
            );
        }
    }

    let (video_pages, practice_pages, document_pages) = count_pages(&detail.chapters);
    let completed_sections = completion
        .values()
        .filter(|completed| **completed == Some(true))
        .count();
    let cancelled = cancelled || app_state.is_cancelled();
    let expired = detail.is_expired();
    Ok(UlCheckDto {
        course: detail.course.into(),
        chapters: chapters_dto(detail.chapters, &completion),
        remaining_secs: detail.remaining_secs,
        class_name: detail.class_name,
        expired,
        section_count: total,
        completed_sections,
        video_pages,
        practice_pages,
        document_pages,
        cancelled,
    })
}

/// Plan and (unless `dryRun`) submit completion records for every section.
#[tauri::command]
pub async fn ul_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    request: UlWatchRequest,
) -> Result<UlWatchSummaryDto, String> {
    let _job = state.begin_job()?;
    let client = ul_client(&state)?;
    let app_state: &AppState = &state;
    let course = find_course(&state, &client, &request.course)?;
    let options = request.options();

    let progress_app = app.clone();
    let progress = move |progress: UlProgress| {
        emit(
            &progress_app,
            JobProgress::UlStage {
                job: UL_WATCH_JOB.to_string(),
                stage: stage_key(progress.stage).to_string(),
                done: progress.done,
                total: progress.total,
                label: progress.label,
                message: progress.message,
            },
        );
        !app_state.is_cancelled()
    };

    let plan = plan_course(&client, &course, &options, &progress)
        .await
        .map_err(job_error)?;
    if plan.cancelled {
        return Ok(UlWatchSummaryDto {
            total: 0,
            ok: 0,
            skipped: 0,
            failed: 0,
            cancelled: true,
            dry_run: options.dry_run,
            outcomes: Vec::new(),
            errors: Vec::new(),
        });
    }
    let total = plan.sections.len();
    let actionable = plan.actionable_count();
    emit(
        &app,
        JobProgress::UlPlan {
            job: UL_WATCH_JOB.to_string(),
            total,
            actionable,
            skipped: total.saturating_sub(actionable),
            dry_run: options.dry_run,
        },
    );

    let outcomes = run_watch(&client, &plan, &options, &progress)
        .await
        .map_err(job_error)?;

    for (offset, outcome) in outcomes.iter().enumerate() {
        emit(
            &app,
            JobProgress::UlTarget {
                job: UL_WATCH_JOB.to_string(),
                index: offset + 1,
                total,
                label: outcome.label.clone(),
                status: watch_state_key(outcome.state).to_string(),
                message: Some(outcome.message.clone()),
                completion_status: outcome.completion_status,
            },
        );
    }

    Ok(summarize_watch(total, &outcomes, options.dry_run))
}

/// Cancel the running job. Alias of `cancel_job` for the Ulearning screens.
#[tauri::command]
pub fn ul_cancel_job(state: State<'_, AppState>) {
    state.cancel();
}

// ---- Helpers ---------------------------------------------------------------

fn ul_client(state: &AppState) -> Result<UlearningClient, String> {
    state.ul_client().ok_or_else(|| {
        if state.has_session() {
            "当前连接的不是优学院平台，请先在连接页切换到优学院并登录".to_string()
        } else {
            "尚未连接优学院账号，请先在连接页登录优学院".to_string()
        }
    })
}

fn find_course(
    state: &AppState,
    client: &UlearningClient,
    reference: &str,
) -> Result<UlCourse, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("课程参数为空".to_string());
    }
    if let Some(course) = state.ul_course(reference) {
        return Ok(course);
    }
    let course = client
        .resolve_course(reference)
        .map_err(|error| format!("解析优学院课程失败：{error:#}"))?;
    state.upsert_ul_course(course.clone());
    Ok(course)
}

/// `(section id, chapter / section label)` for every section of the tree.
fn flatten_sections(chapters: &[UlChapter]) -> Vec<(i64, String)> {
    let mut sections = Vec::new();
    for chapter in chapters {
        for section in &chapter.sections {
            let label = if chapter.name.trim().is_empty() {
                section.name.clone()
            } else {
                format!("{} / {}", chapter.name, section.name)
            };
            sections.push((section.id, label));
        }
    }
    sections
}

fn count_pages(chapters: &[UlChapter]) -> (usize, usize, usize) {
    let mut videos = 0usize;
    let mut practices = 0usize;
    let mut documents = 0usize;
    for chapter in chapters {
        for section in &chapter.sections {
            for page in &section.pages {
                match page_kind(page) {
                    UlPageKind::Video => videos += 1,
                    UlPageKind::Practice => practices += 1,
                    UlPageKind::Document => documents += 1,
                }
            }
        }
    }
    (videos, practices, documents)
}

fn page_kind(page: &UlPage) -> UlPageKind {
    if page.is_practice() {
        UlPageKind::Practice
    } else if page.is_video() {
        UlPageKind::Video
    } else {
        UlPageKind::Document
    }
}

fn summarize_watch(total: usize, outcomes: &[UlWatchOutcome], dry_run: bool) -> UlWatchSummaryDto {
    let mut ok = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut cancelled = false;
    for outcome in outcomes {
        match outcome.state {
            UlWatchState::Ok => ok += 1,
            UlWatchState::Skip | UlWatchState::DryRun => skipped += 1,
            UlWatchState::Failed | UlWatchState::CircuitBroken => failed += 1,
            UlWatchState::Cancelled => cancelled = true,
        }
    }
    let errors = outcomes
        .iter()
        .filter(|outcome| {
            matches!(
                outcome.state,
                UlWatchState::Failed | UlWatchState::CircuitBroken
            )
        })
        .map(|outcome| format!("{}：{}", outcome.label, outcome.message))
        .collect();
    UlWatchSummaryDto {
        total,
        ok,
        skipped,
        failed,
        cancelled,
        dry_run,
        outcomes: outcomes.iter().cloned().map(UlOutcomeDto::from).collect(),
        errors,
    }
}

fn action_key(action: UlAction) -> &'static str {
    match action {
        UlAction::Complete => "complete",
        UlAction::CompletePractice => "complete_practice",
        UlAction::SkipDone => "skip_done",
        UlAction::SkipUnsupported => "skip_unsupported",
        UlAction::SkipExpired => "skip_expired",
    }
}

fn watch_state_key(state: UlWatchState) -> &'static str {
    match state {
        UlWatchState::Ok => "ok",
        UlWatchState::Skip => "skip",
        UlWatchState::DryRun => "dry_run",
        UlWatchState::Failed => "failed",
        UlWatchState::Cancelled => "cancelled",
        UlWatchState::CircuitBroken => "circuit_broken",
    }
}

fn stage_key(stage: UlProgressStage) -> &'static str {
    match stage {
        UlProgressStage::Directory => "directory",
        UlProgressStage::Plan => "plan",
        UlProgressStage::Submit => "submit",
        UlProgressStage::Verify => "verify",
    }
}

fn emit(app: &AppHandle, progress: JobProgress) {
    let _ = app.emit("job-progress", progress);
}

fn job_error(error: anyhow::Error) -> String {
    let text = format!("{error:#}");
    if text.contains("cancelled") || text.contains("已取消") {
        "已取消".to_string()
    } else {
        text
    }
}
