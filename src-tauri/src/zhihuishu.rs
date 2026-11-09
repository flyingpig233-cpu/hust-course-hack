//! Thin Tauri commands for the Zhihuishu (智慧树 / 知到) platform.
//!
//! Every command only does session/state bookkeeping and progress events; all
//! HTTP, encryption and completion logic stays in `hust_course_hack::zhihuishu`.
//! Progress is emitted on the shared `job-progress` channel with the `zhsPlan`,
//! `zhsStage` and `zhsTarget` kinds. Cookie values never cross the IPC boundary.

use crate::{events::JobProgress, state::AppState};
use hust_course_hack::zhihuishu::{
    ZhsChapter, ZhsClient, ZhsCourse, ZhsCourseDetail, ZhsExceptionStatus, ZhsLesson, ZhsMeet,
    ZhsMeetOutcome, ZhsMeetProgress, ZhsMeetWatchOptions, ZhsProgress, ZhsProgressStage, ZhsVideo,
    ZhsWatchOptions, ZhsWatchOutcome, ZhsWatchState,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Job id for the shared-course video queue.
pub const ZHS_WATCH_JOB: &str = "zhs-watch";
/// Job id for the meet replay queue.
pub const ZHS_MEET_JOB: &str = "zhs-meet-watch";
/// Job id used while the course tree and its completion state are loaded.
pub const ZHS_LOAD_JOB: &str = "zhs-load";

// ---- Requests --------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ZhsWatchRequest {
    /// Course id, recruit id, study-page URL or `recruitAndCourseId`.
    pub course: String,
    /// Build the plan only; never send a report. Defaults to `true` so a
    /// missing field can never trigger a real report.
    pub dry_run: bool,
    pub include_completed: bool,
    pub max_videos: Option<usize>,
    /// Re-query `queryStuyInfo` after each report.
    pub verify: Option<bool>,
}

impl Default for ZhsWatchRequest {
    fn default() -> Self {
        Self {
            course: String::new(),
            dry_run: true,
            include_completed: false,
            max_videos: None,
            verify: Some(true),
        }
    }
}

impl ZhsWatchRequest {
    fn options(&self) -> ZhsWatchOptions {
        ZhsWatchOptions {
            dry_run: self.dry_run,
            include_completed: self.include_completed,
            max_videos: self.max_videos,
            verify: self.verify.unwrap_or(true),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ZhsMeetWatchRequest {
    /// Course id, recruit id, study-page URL or `recruitAndCourseId`.
    pub course: String,
    /// Only process this `meetCourseId`; omit to process every replay.
    pub meet: Option<u64>,
    /// Compute the coverage plan only; never report a minute.
    pub dry_run: bool,
    /// Coverage window as percent (`90`) or fraction (`0.9`).
    pub coverage_min: Option<f64>,
    pub coverage_max: Option<f64>,
    pub delay_min_ms: Option<u64>,
    pub delay_max_ms: Option<u64>,
    pub circuit_breaker: Option<bool>,
    pub check_every: Option<usize>,
}

impl Default for ZhsMeetWatchRequest {
    fn default() -> Self {
        Self {
            course: String::new(),
            meet: None,
            dry_run: true,
            coverage_min: None,
            coverage_max: None,
            delay_min_ms: None,
            delay_max_ms: None,
            circuit_breaker: None,
            check_every: None,
        }
    }
}

impl ZhsMeetWatchRequest {
    fn options(&self) -> ZhsMeetWatchOptions {
        let defaults = ZhsMeetWatchOptions::default();
        let coverage_min = coverage(self.coverage_min, defaults.coverage_min);
        let coverage_max = coverage(self.coverage_max, defaults.coverage_max).max(coverage_min);
        let delay_min_ms = self.delay_min_ms.unwrap_or(defaults.delay_min_ms);
        let delay_max_ms = self
            .delay_max_ms
            .unwrap_or(defaults.delay_max_ms)
            .max(delay_min_ms);
        ZhsMeetWatchOptions {
            dry_run: self.dry_run,
            coverage_min,
            coverage_max,
            delay_min_ms,
            delay_max_ms,
            circuit_breaker: self.circuit_breaker.unwrap_or(defaults.circuit_breaker),
            check_every: self.check_every.unwrap_or(defaults.check_every).max(1),
        }
    }
}

/// Normalize a coverage value that may be a percent (`90`) or a fraction.
fn coverage(value: Option<f64>, fallback: f64) -> f64 {
    let raw = value.unwrap_or(fallback);
    let value = if raw > 1.0 { raw / 100.0 } else { raw };
    value.clamp(0.01, 1.0)
}

// ---- DTOs ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsCourseDto {
    pub recruit_id: u64,
    pub course_id: u64,
    pub class_id: Option<u64>,
    pub school_id: Option<u64>,
    pub name: String,
    pub teacher: String,
    pub secret: Option<String>,
    pub is_apply: Option<i64>,
    pub course_type: Option<String>,
    pub progress: Option<f64>,
    pub studied_lesson_count: Option<usize>,
    pub total_lesson_count: Option<usize>,
    pub status: Option<i64>,
}

impl From<ZhsCourse> for ZhsCourseDto {
    fn from(course: ZhsCourse) -> Self {
        Self {
            recruit_id: course.recruit_id,
            course_id: course.course_id,
            class_id: course.class_id,
            school_id: course.school_id,
            name: course.name,
            teacher: course.teacher,
            secret: course.secret,
            is_apply: course.is_apply,
            course_type: course.course_type,
            progress: course.progress,
            studied_lesson_count: course.studied_lesson_count,
            total_lesson_count: course.total_lesson_count,
            status: course.status,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsVideoDto {
    pub video_id: u64,
    pub lesson_video_id: u64,
    pub video_sec: u64,
    pub is_studied: Option<i64>,
    pub name: String,
}

impl From<ZhsVideo> for ZhsVideoDto {
    fn from(video: ZhsVideo) -> Self {
        Self {
            video_id: video.video_id,
            lesson_video_id: video.lesson_video_id,
            video_sec: video.video_sec,
            is_studied: video.is_studied,
            name: video.name,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsLessonDto {
    pub lesson_id: u64,
    pub name: String,
    pub is_studied: Option<i64>,
    pub video_id: Option<u64>,
    pub video_sec: Option<u64>,
    pub videos: Vec<ZhsVideoDto>,
}

impl From<ZhsLesson> for ZhsLessonDto {
    fn from(lesson: ZhsLesson) -> Self {
        Self {
            lesson_id: lesson.lesson_id,
            name: lesson.name,
            is_studied: lesson.is_studied,
            video_id: lesson.video_id,
            video_sec: lesson.video_sec,
            videos: lesson.videos.into_iter().map(ZhsVideoDto::from).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsChapterDto {
    pub chapter_id: Option<u64>,
    pub name: String,
    pub learning_lesson_status: Option<i64>,
    pub is_pass: Option<i64>,
    pub limit_checked: Option<bool>,
    pub lessons: Vec<ZhsLessonDto>,
}

impl From<ZhsChapter> for ZhsChapterDto {
    fn from(chapter: ZhsChapter) -> Self {
        Self {
            chapter_id: chapter.chapter_id,
            name: chapter.name,
            learning_lesson_status: chapter.learning_lesson_status,
            is_pass: chapter.is_pass,
            limit_checked: chapter.limit_checked,
            lessons: chapter
                .lessons
                .into_iter()
                .map(ZhsLessonDto::from)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsCourseDetailDto {
    pub course: ZhsCourseDto,
    pub chapters: Vec<ZhsChapterDto>,
    /// Total playable videos (small lessons) in the tree.
    pub total_videos: usize,
    /// Videos the platform records as finished (`watchState == 1`).
    ///
    /// This is computed from a fresh `queryStuyInfo` read, not from the
    /// `videolist` `isStudiedLesson` flag, which the platform does not refresh
    /// after a completion report.
    pub completed_videos: usize,
}

impl From<ZhsCourseDetail> for ZhsCourseDetailDto {
    fn from(detail: ZhsCourseDetail) -> Self {
        let total_videos = detail.total_videos();
        let completed_videos = detail.completed_videos();
        Self {
            course: detail.course.into(),
            chapters: detail
                .chapters
                .into_iter()
                .map(ZhsChapterDto::from)
                .collect(),
            total_videos,
            completed_videos,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsExceptionStatusDto {
    pub lock: bool,
    pub abnormal: bool,
    pub message: String,
}

impl From<ZhsExceptionStatus> for ZhsExceptionStatusDto {
    fn from(status: ZhsExceptionStatus) -> Self {
        Self {
            lock: status.lock,
            abnormal: status.abnormal,
            message: status.message,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsMeetDto {
    pub meet_course_id: u64,
    pub live_id: u64,
    pub video_id: Option<u64>,
    pub recruit_id: u64,
    pub course_id: u64,
    pub name: String,
    pub teacher: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub replay_url: Option<String>,
    pub exam_url: Option<String>,
    pub duration_secs: Option<u64>,
    pub status: Option<i64>,
}

impl From<ZhsMeet> for ZhsMeetDto {
    fn from(meet: ZhsMeet) -> Self {
        Self {
            meet_course_id: meet.meet_course_id,
            live_id: meet.live_id,
            video_id: meet.video_id,
            recruit_id: meet.recruit_id,
            course_id: meet.course_id,
            name: meet.name,
            teacher: meet.teacher,
            start_time: meet.start_time,
            end_time: meet.end_time,
            replay_url: meet.replay_url,
            exam_url: meet.exam_url,
            duration_secs: meet.duration_secs,
            status: meet.status,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsMeetProgressDto {
    pub total_minutes: u32,
    pub watched_minutes: Vec<u32>,
    pub watched_count: usize,
    pub percent: u32,
}

impl From<ZhsMeetProgress> for ZhsMeetProgressDto {
    fn from(progress: ZhsMeetProgress) -> Self {
        Self {
            total_minutes: progress.total_minutes,
            watched_minutes: progress.watched_minutes,
            watched_count: progress.watched_count,
            percent: progress.percent,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsVideoOutcomeDto {
    pub label: String,
    pub state: String,
    pub watch_state: Option<i64>,
    pub message: String,
}

impl From<ZhsWatchOutcome> for ZhsVideoOutcomeDto {
    fn from(outcome: ZhsWatchOutcome) -> Self {
        Self {
            label: outcome.label,
            state: watch_state_key(outcome.state).to_string(),
            watch_state: outcome.watch_state,
            message: outcome.message,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsWatchSummaryDto {
    pub total: usize,
    pub ok: usize,
    pub skipped: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub dry_run: bool,
    pub outcomes: Vec<ZhsVideoOutcomeDto>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsMeetOutcomeDto {
    pub label: String,
    pub target_minutes: u32,
    pub watched_before: usize,
    pub submitted: usize,
    pub skipped: usize,
    pub failed: usize,
    pub watched_after: Option<usize>,
    pub state: String,
    pub message: String,
}

impl From<ZhsMeetOutcome> for ZhsMeetOutcomeDto {
    fn from(outcome: ZhsMeetOutcome) -> Self {
        Self {
            label: outcome.label,
            target_minutes: outcome.target_minutes,
            watched_before: outcome.watched_before,
            submitted: outcome.submitted,
            skipped: outcome.skipped,
            failed: outcome.failed,
            watched_after: outcome.watched_after,
            state: watch_state_key(outcome.state).to_string(),
            message: outcome.message,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsMeetWatchSummaryDto {
    pub meets: usize,
    pub submitted: usize,
    pub skipped: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub dry_run: bool,
    pub outcomes: Vec<ZhsMeetOutcomeDto>,
    pub errors: Vec<String>,
}

// ---- Commands --------------------------------------------------------------

/// Shared-course list for the connected Zhihuishu account.
#[tauri::command]
pub async fn zhs_list_courses(state: State<'_, AppState>) -> Result<Vec<ZhsCourseDto>, String> {
    let client = zhs_client(&state)?;
    let courses = client.list_courses().await.map_err(|error| {
        format!("知到课程列表接口暂不可用：{error:#}；可粘贴学习页链接手动添加课程")
    })?;
    state.set_zhs_courses(courses.clone());
    Ok(courses.into_iter().map(ZhsCourseDto::from).collect())
}

/// Resolve and store one course from a study-page URL / `recruitAndCourseId`.
///
/// The shared-course list endpoint is not verified live, so the UI needs this
/// fallback to add a course manually.
#[tauri::command]
pub async fn zhs_add_course(
    state: State<'_, AppState>,
    reference: String,
) -> Result<ZhsCourseDto, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("请输入学习页链接或 recruitAndCourseId".to_string());
    }
    let client = zhs_client(&state)?;
    let course = client
        .resolve_course(reference)
        .await
        .map_err(|error| format!("解析知到课程失败：{error:#}"))?;
    state.upsert_zhs_course(course.clone());
    Ok(course.into())
}

/// Chapter / lesson / video tree of one shared course.
///
/// `completedVideos` comes from a fresh `queryStuyInfo` read (`watchState == 1`)
/// because the `videolist` `isStudiedLesson` flag stays stale after a report.
#[tauri::command]
pub async fn zhs_course_detail(
    app: AppHandle,
    state: State<'_, AppState>,
    course_id: String,
) -> Result<ZhsCourseDetailDto, String> {
    let client = zhs_client(&state)?;
    let course = find_course(&state, &client, &course_id).await?;

    emit(
        &app,
        JobProgress::ZhsStage {
            job: ZHS_LOAD_JOB.to_string(),
            stage: "loading".to_string(),
            done: 0,
            total: 1,
            label: course.label(),
            message: "抓取视频树并复核平台完成状态".to_string(),
        },
    );
    let detail = client
        .course_detail_with_states(&course)
        .await
        .map_err(|error| format!("抓取知到视频树失败：{error:#}"))?;
    emit(
        &app,
        JobProgress::ZhsStage {
            job: ZHS_LOAD_JOB.to_string(),
            stage: "loading".to_string(),
            done: 1,
            total: 1,
            label: course.label(),
            message: "完成状态已按 watchState 校正".to_string(),
        },
    );
    state.upsert_zhs_course(detail.course.clone());
    Ok(detail.into())
}

/// Plan and (unless `dryRun`) report completion for every shared-course video.
#[tauri::command]
pub async fn zhs_watch_videos(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ZhsWatchRequest,
) -> Result<ZhsWatchSummaryDto, String> {
    let _job = state.begin_job()?;
    let client = zhs_client(&state)?;
    let course = find_course(&state, &client, &request.course).await?;
    let options = request.options();
    let app_state: &AppState = &state;

    emit(
        &app,
        JobProgress::ZhsStage {
            job: ZHS_WATCH_JOB.to_string(),
            stage: "loading".to_string(),
            done: 0,
            total: 1,
            label: course.label(),
            message: "抓取视频树并复核平台完成状态".to_string(),
        },
    );
    // Plan against `watchState`, otherwise a course that the platform already
    // records as finished would still show every video as pending here.
    let detail = client
        .course_detail_with_states(&course)
        .await
        .map_err(job_error)?;
    emit(
        &app,
        JobProgress::ZhsStage {
            job: ZHS_WATCH_JOB.to_string(),
            stage: "loading".to_string(),
            done: 1,
            total: 1,
            label: course.label(),
            message: "完成状态已按 watchState 校正".to_string(),
        },
    );
    let targets = client
        .plan_videos(&detail, &options)
        .await
        .map_err(job_error)?;
    let skipped = targets
        .iter()
        .filter(|target| target.completed && !options.include_completed)
        .count();
    emit(
        &app,
        JobProgress::ZhsPlan {
            job: ZHS_WATCH_JOB.to_string(),
            stage: "videos".to_string(),
            total: targets.len(),
            dry_run: options.dry_run,
            skipped,
        },
    );

    let progress_app = app.clone();
    let progress = move |progress: ZhsProgress| {
        emit(
            &progress_app,
            JobProgress::ZhsStage {
                job: ZHS_WATCH_JOB.to_string(),
                stage: zhs_stage_key(progress.stage).to_string(),
                done: progress.done,
                total: progress.total,
                label: progress.label,
                message: progress.message,
            },
        );
        !app_state.is_cancelled()
    };
    let outcomes = client
        .watch_videos(&targets, &options, &progress)
        .await
        .map_err(job_error)?;

    let total = targets.len();
    for (offset, outcome) in outcomes.iter().enumerate() {
        emit(
            &app,
            JobProgress::ZhsTarget {
                job: ZHS_WATCH_JOB.to_string(),
                index: offset + 1,
                total,
                label: outcome.label.clone(),
                status: watch_state_key(outcome.state).to_string(),
                message: Some(outcome.message.clone()),
                target_minutes: None,
                watched_before: None,
            },
        );
    }

    let summary = summarize_watch(total, &outcomes, options.dry_run);
    Ok(summary)
}

/// Meet-course (见面课) list of one shared course.
#[tauri::command]
pub async fn zhs_meet_list(
    state: State<'_, AppState>,
    course_id: String,
) -> Result<Vec<ZhsMeetDto>, String> {
    let client = zhs_client(&state)?;
    let course = find_course(&state, &client, &course_id).await?;
    let meets = client
        .meet_list(&course)
        .await
        .map_err(|error| format!("获取见面课列表失败：{error:#}"))?;
    Ok(meets.into_iter().map(ZhsMeetDto::from).collect())
}

/// Replay attendance progress (watched / total minutes) of one meet course.
#[tauri::command]
pub async fn zhs_meet_progress(
    state: State<'_, AppState>,
    course_id: String,
    meet_id: u64,
) -> Result<ZhsMeetProgressDto, String> {
    let client = zhs_client(&state)?;
    let course = find_course(&state, &client, &course_id).await?;
    let meets = client
        .meet_list(&course)
        .await
        .map_err(|error| format!("获取见面课列表失败：{error:#}"))?;
    let meet = meets
        .into_iter()
        .find(|meet| meet.meet_course_id == meet_id)
        .ok_or_else(|| format!("找不到见面课 {meet_id}，请刷新见面课列表后重试"))?;
    let progress = client
        .meet_progress(&meet)
        .await
        .map_err(|error| format!("获取回放进度失败：{error:#}"))?;
    Ok(progress.into())
}

/// Anti-cheat status of one shared course.
#[tauri::command]
pub async fn zhs_exception_status(
    state: State<'_, AppState>,
    course_id: String,
) -> Result<ZhsExceptionStatusDto, String> {
    let client = zhs_client(&state)?;
    let course = find_course(&state, &client, &course_id).await?;
    let status = client
        .exception_status(&course)
        .await
        .map_err(|error| format!("查询风控状态失败：{error:#}"))?;
    Ok(status.into())
}

/// Report replay attendance for one meet or every replay of the course.
#[tauri::command]
pub async fn zhs_meet_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ZhsMeetWatchRequest,
) -> Result<ZhsMeetWatchSummaryDto, String> {
    let _job = state.begin_job()?;
    let client = zhs_client(&state)?;
    let course = find_course(&state, &client, &request.course).await?;
    let options = request.options();
    let app_state: &AppState = &state;

    emit(
        &app,
        JobProgress::ZhsStage {
            job: ZHS_MEET_JOB.to_string(),
            stage: "loading".to_string(),
            done: 0,
            total: 1,
            label: course.label(),
            message: "抓取见面课列表".to_string(),
        },
    );
    let meets = client.meet_list(&course).await.map_err(job_error)?;
    let replayable = meets
        .iter()
        .filter(|meet| meet.has_replay())
        .cloned()
        .collect::<Vec<_>>();
    let selected = match request.meet {
        Some(meet_id) => {
            let found = replayable
                .into_iter()
                .filter(|meet| meet.meet_course_id == meet_id)
                .collect::<Vec<_>>();
            if found.is_empty() {
                return Err(format!(
                    "找不到可回放的见面课 {meet_id}，请刷新见面课列表后重试"
                ));
            }
            found
        }
        None => replayable,
    };
    emit(
        &app,
        JobProgress::ZhsPlan {
            job: ZHS_MEET_JOB.to_string(),
            stage: "meet".to_string(),
            total: selected.len(),
            dry_run: options.dry_run,
            skipped: meets.len().saturating_sub(selected.len()),
        },
    );

    let total = selected.len();
    let mut outcomes = Vec::with_capacity(total);
    let mut errors = Vec::new();
    let mut cancelled = false;

    for (offset, meet) in selected.iter().enumerate() {
        if app_state.is_cancelled() {
            cancelled = true;
            break;
        }
        let index = offset + 1;
        emit(
            &app,
            JobProgress::ZhsTarget {
                job: ZHS_MEET_JOB.to_string(),
                index,
                total,
                label: meet.label(),
                status: "running".to_string(),
                message: Some("读取回放进度与已看分钟".to_string()),
                target_minutes: None,
                watched_before: None,
            },
        );

        let progress_app = app.clone();
        let progress = move |progress: ZhsProgress| {
            emit(
                &progress_app,
                JobProgress::ZhsStage {
                    job: ZHS_MEET_JOB.to_string(),
                    stage: zhs_stage_key(progress.stage).to_string(),
                    done: progress.done,
                    total: progress.total,
                    label: progress.label,
                    message: progress.message,
                },
            );
            !app_state.is_cancelled()
        };

        match client.meet_watch(meet, &options, &progress).await {
            Ok(outcome) => {
                emit(
                    &app,
                    JobProgress::ZhsTarget {
                        job: ZHS_MEET_JOB.to_string(),
                        index,
                        total,
                        label: outcome.label.clone(),
                        status: watch_state_key(outcome.state).to_string(),
                        message: Some(outcome.message.clone()),
                        target_minutes: Some(outcome.target_minutes),
                        watched_before: Some(outcome.watched_before),
                    },
                );
                outcomes.push(ZhsMeetOutcomeDto::from(outcome));
            }
            Err(error) => {
                let message = format!("{error:#}");
                errors.push(format!("{}：{message}", meet.label()));
                emit(
                    &app,
                    JobProgress::ZhsTarget {
                        job: ZHS_MEET_JOB.to_string(),
                        index,
                        total,
                        label: meet.label(),
                        status: "failed".to_string(),
                        message: Some(message.clone()),
                        target_minutes: None,
                        watched_before: None,
                    },
                );
                outcomes.push(ZhsMeetOutcomeDto {
                    label: meet.label(),
                    target_minutes: 0,
                    watched_before: 0,
                    submitted: 0,
                    skipped: 0,
                    failed: 1,
                    watched_after: None,
                    state: "failed".to_string(),
                    message,
                });
            }
        }
    }

    cancelled = cancelled || app_state.is_cancelled();
    let submitted = outcomes
        .iter()
        .filter(|outcome| outcome.state == "ok")
        .count();
    let skipped = outcomes
        .iter()
        .filter(|outcome| outcome.state == "skip" || outcome.state == "dry_run")
        .count();
    let failed = outcomes
        .iter()
        .filter(|outcome| outcome.state == "failed" || outcome.state == "circuit_broken")
        .count();
    let cancelled = cancelled || outcomes.iter().any(|outcome| outcome.state == "cancelled");

    Ok(ZhsMeetWatchSummaryDto {
        meets: total,
        submitted,
        skipped,
        failed,
        cancelled,
        dry_run: options.dry_run,
        outcomes,
        errors,
    })
}

/// Cancel the running job. Alias of `cancel_job` for the Zhihuishu screens.
#[tauri::command]
pub fn zhs_cancel_job(state: State<'_, AppState>) {
    state.cancel();
}

// ---- Helpers ---------------------------------------------------------------

fn zhs_client(state: &AppState) -> Result<ZhsClient, String> {
    state.zhs_client().ok_or_else(|| {
        if state.has_session() {
            "当前连接的不是知到平台，请先在连接页切换到知到并登录".to_string()
        } else {
            "尚未连接知到账号，请先在连接页登录知到".to_string()
        }
    })
}

async fn find_course(
    state: &AppState,
    client: &ZhsClient,
    reference: &str,
) -> Result<ZhsCourse, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("课程参数为空".to_string());
    }
    if let Some(course) = state.zhs_course(reference) {
        return Ok(course);
    }
    let course = client
        .resolve_course(reference)
        .await
        .map_err(|error| format!("解析知到课程失败：{error:#}"))?;
    state.upsert_zhs_course(course.clone());
    Ok(course)
}

fn summarize_watch(
    total: usize,
    outcomes: &[ZhsWatchOutcome],
    dry_run: bool,
) -> ZhsWatchSummaryDto {
    let mut ok = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut cancelled = false;
    for outcome in outcomes {
        match outcome.state {
            ZhsWatchState::Ok => ok += 1,
            ZhsWatchState::Skip | ZhsWatchState::DryRun => skipped += 1,
            ZhsWatchState::Failed | ZhsWatchState::CircuitBroken => failed += 1,
            ZhsWatchState::Cancelled => cancelled = true,
        }
    }
    let errors = outcomes
        .iter()
        .filter(|outcome| {
            matches!(
                outcome.state,
                ZhsWatchState::Failed | ZhsWatchState::CircuitBroken
            )
        })
        .map(|outcome| format!("{}：{}", outcome.label, outcome.message))
        .collect();
    ZhsWatchSummaryDto {
        total,
        ok,
        skipped,
        failed,
        cancelled,
        dry_run,
        outcomes: outcomes
            .iter()
            .cloned()
            .map(ZhsVideoOutcomeDto::from)
            .collect(),
        errors,
    }
}

fn watch_state_key(state: ZhsWatchState) -> &'static str {
    match state {
        ZhsWatchState::Ok => "ok",
        ZhsWatchState::Skip => "skip",
        ZhsWatchState::DryRun => "dry_run",
        ZhsWatchState::Failed => "failed",
        ZhsWatchState::Cancelled => "cancelled",
        ZhsWatchState::CircuitBroken => "circuit_broken",
    }
}

fn zhs_stage_key(stage: ZhsProgressStage) -> &'static str {
    match stage {
        ZhsProgressStage::Videos => "videos",
        ZhsProgressStage::MeetList => "meet_list",
        ZhsProgressStage::MeetMinutes => "meet_minutes",
        ZhsProgressStage::Verify => "verify",
        ZhsProgressStage::CircuitCheck => "circuit_check",
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
