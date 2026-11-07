//! Batch planning and execution for Ulearning video/practice completion.
//!
//! Planning is read-only: it walks the directory, skips sections the platform
//! already marks as completed (`/studyrecord/item` -> `completion_status == 1`),
//! fetches page contents and practice answers, and produces one
//! [`UlSectionPlan`] per section. Execution only happens in [`run_watch`], which
//! enforces the delay window, the "stop on error" policy, per-section
//! verification and the `sync` code-2 circuit breaker.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use rand::{Rng, SeedableRng, rngs::StdRng};

use super::{
    client::UlearningClient,
    models::{
        UlAction, UlChapter, UlCourse, UlPage, UlPageContent, UlPageKind, UlPagePlan, UlPlan,
        UlProgress, UlProgressStage, UlQuestionAnswer, UlSection, UlSectionPlan, UlSyncOutcome,
        UlVideo, UlWatchOptions, UlWatchOutcome, UlWatchState,
    },
    record::{build_record_payload, submit_record},
};

/// Delay before the verification read so the server-side write is visible.
const VERIFY_DELAY_MS: u64 = 500;

/// Classify one page from its metadata and parsed content.
pub fn page_kind(page: &UlPage, content: &UlPageContent) -> UlPageKind {
    if page.is_practice() || content.has_practice() {
        UlPageKind::Practice
    } else if page.is_video() || !content.videos.is_empty() {
        UlPageKind::Video
    } else {
        UlPageKind::Document
    }
}

/// Build one page plan and validate that it is safe to submit.
pub fn page_plan(
    page: &UlPage,
    content: &UlPageContent,
    answers: Vec<UlQuestionAnswer>,
) -> Result<UlPagePlan> {
    let kind = page_kind(page, content);
    let videos: Vec<UlVideo> = content
        .videos
        .iter()
        .filter(|video| video.video_id > 0 && video.duration_secs > 0)
        .cloned()
        .collect();
    match kind {
        UlPageKind::Video => {
            if videos.is_empty() {
                bail!("视频页「{}」缺少可用的 resourceid/videoLength", page.name);
            }
        }
        UlPageKind::Practice => {
            if answers.is_empty() {
                bail!("练习页「{}」缺少答案", page.name);
            }
            if content.coursepage_id.is_none() {
                bail!("练习页「{}」缺少练习组件 id", page.name);
            }
        }
        UlPageKind::Document => {}
    }
    Ok(UlPagePlan {
        page: page.clone(),
        kind,
        videos,
        questions: answers,
        coursepage_id: content.coursepage_id,
        score: 100,
    })
}

/// Build the plan of one course (read-only; no `sync` request is sent).
///
/// The progress callback is invoked for every section; returning `false` stops
/// planning and returns the partial plan with [`UlPlan::cancelled`] set.
pub async fn plan_course(
    client: &UlearningClient,
    course: &UlCourse,
    opts: &UlWatchOptions,
    progress: &(dyn Fn(UlProgress) -> bool + Send + Sync),
) -> Result<UlPlan> {
    let detail = client.course_detail(course).await?;
    if detail.is_expired() {
        bail!(
            "课程「{}」已过期（remaining={:?}），拒绝刷课",
            detail.course.label(),
            detail.remaining_secs
        );
    }

    let total_sections = detail.section_count().max(1);
    if !progress(UlProgress::new(
        UlProgressStage::Directory,
        1,
        1,
        detail.course.label(),
        format!(
            "{} 章 / {} 节",
            detail.chapters.len(),
            detail.section_count()
        ),
    )) {
        return Ok(UlPlan {
            course: detail.course,
            sections: Vec::new(),
            remaining_secs: detail.remaining_secs,
            cancelled: true,
        });
    }

    let max_sections = opts.max_sections.unwrap_or(usize::MAX);
    let mut plans = Vec::new();
    let mut scanned = 0usize;
    let mut actionable = 0usize;
    let mut cancelled = false;

    'chapters: for chapter in &detail.chapters {
        for section in &chapter.sections {
            if actionable >= max_sections {
                break 'chapters;
            }
            scanned += 1;
            let label = section_label(chapter, section);
            if !progress(UlProgress::new(
                UlProgressStage::Plan,
                scanned - 1,
                total_sections,
                label.clone(),
                "读取学习记录",
            )) {
                cancelled = true;
                break 'chapters;
            }

            let plan = plan_section(client, chapter, section, opts, &label).await?;
            if plan.is_actionable() {
                actionable += 1;
            }
            plans.push(plan);

            if !progress(UlProgress::new(
                UlProgressStage::Plan,
                scanned,
                total_sections,
                label,
                plans
                    .last()
                    .map(|plan| plan.action.label())
                    .unwrap_or("")
                    .to_string(),
            )) {
                cancelled = true;
                break 'chapters;
            }
        }
    }

    Ok(UlPlan {
        course: detail.course,
        sections: plans,
        remaining_secs: detail.remaining_secs,
        cancelled,
    })
}

fn section_label(chapter: &UlChapter, section: &UlSection) -> String {
    if chapter.name.trim().is_empty() {
        section.name.clone()
    } else {
        format!("{} / {}", chapter.name, section.name)
    }
}

async fn plan_section(
    client: &UlearningClient,
    chapter: &UlChapter,
    section: &UlSection,
    opts: &UlWatchOptions,
    label: &str,
) -> Result<UlSectionPlan> {
    let mut plan = UlSectionPlan {
        chapter_id: chapter.id,
        chapter_name: chapter.name.clone(),
        section_id: section.id,
        section_name: section.name.clone(),
        pages: Vec::new(),
        action: UlAction::SkipUnsupported,
        study_start_time: None,
        score: 100,
        note: String::new(),
    };
    if section.id <= 0 {
        plan.note = "节缺少 itemid".to_string();
        return Ok(plan);
    }

    let record = client
        .section_record(section.id)
        .await
        .with_context(|| format!("failed to read the record of {label}"))?;
    if record.completed() && !opts.include_completed {
        plan.action = UlAction::SkipDone;
        plan.note = "平台已完成".to_string();
        return Ok(plan);
    }

    let api_pages = client
        .section_pages(section.id)
        .await
        .with_context(|| format!("failed to read the pages of {label}"))?;
    let pages = if api_pages.is_empty() {
        section.pages.clone()
    } else {
        api_pages
    };
    if pages.is_empty() {
        plan.note = "节没有页面".to_string();
        return Ok(plan);
    }

    let mut page_plans = Vec::with_capacity(pages.len());
    for page in &pages {
        let content = match client.page_content(page.id).await {
            Ok(content) => content,
            Err(error) => {
                plan.note = format!("页面「{}」内容读取失败：{error}", page.name);
                return Ok(plan);
            }
        };
        if content.has_unsupported_element {
            plan.note = format!("页面「{}」包含暂不支持的元素", page.name);
            return Ok(plan);
        }
        let kind = page_kind(page, &content);
        let mut answers = Vec::new();
        if kind == UlPageKind::Practice {
            if content.questions.is_empty() {
                plan.note = format!("练习页「{}」没有题目", page.name);
                return Ok(plan);
            }
            for question in &content.questions {
                match client.question_answer(question.question_id, page.id).await {
                    Ok(answer) if !answer.is_empty() => answers.push(UlQuestionAnswer {
                        question_id: question.question_id,
                        score: question.score,
                        answer,
                    }),
                    Ok(_) => {
                        plan.note =
                            format!("题目 {} 未返回答案，暂不能完成该节", question.question_id);
                        return Ok(plan);
                    }
                    Err(error) => {
                        plan.note = format!("题目 {} 答案获取失败：{error}", question.question_id);
                        return Ok(plan);
                    }
                }
            }
        }
        let mut page_plan = match page_plan(page, &content, answers) {
            Ok(page_plan) => page_plan,
            Err(error) => {
                plan.note = error.to_string();
                return Ok(plan);
            }
        };
        if page_plan.page.content_type == 0 {
            page_plan.page.content_type = page.content_type;
        }
        page_plans.push(page_plan);
    }

    let has_practice = page_plans
        .iter()
        .any(|page| page.kind == UlPageKind::Practice);
    plan.pages = page_plans;
    plan.action = if has_practice {
        UlAction::CompletePractice
    } else {
        UlAction::Complete
    };
    plan.study_start_time = Some(client.initialize_study(section.id).await);
    plan.note = plan.action.label().to_string();
    Ok(plan)
}

fn random_delay(opts: &UlWatchOptions, rng: &mut impl Rng) -> Duration {
    let millis = if opts.delay_max_ms > opts.delay_min_ms {
        rng.gen_range(opts.delay_min_ms..=opts.delay_max_ms)
    } else {
        opts.delay_min_ms
    };
    Duration::from_millis(millis)
}

fn outcome_message(state: UlWatchState, section: &UlSectionPlan, detail: &str) -> UlWatchOutcome {
    UlWatchOutcome {
        label: section.label(),
        section_id: section.section_id,
        action: section.action,
        state,
        completion_status: None,
        message: detail.to_string(),
    }
}

/// Execute a plan.
///
/// Dry-run (the default) never sends a request. Real runs sleep a random delay
/// from the configured window before **every** `sync`, verify the section record
/// when enabled, and stop immediately when the platform answers `2`.
pub async fn run_watch(
    client: &UlearningClient,
    plan: &UlPlan,
    opts: &UlWatchOptions,
    progress: &(dyn Fn(UlProgress) -> bool + Send + Sync),
) -> Result<Vec<UlWatchOutcome>> {
    if plan.cancelled {
        return Ok(Vec::new());
    }
    let actionable = plan.actionable_count();
    let mut outcomes = Vec::with_capacity(plan.sections.len());
    // `StdRng` is Send; `ThreadRng` would make the future non-Send and break
    // Tauri commands, which hold this future across `.await`.
    let mut rng = StdRng::from_entropy();
    let mut submitted = 0usize;

    for section in &plan.sections {
        if !section.is_actionable() {
            outcomes.push(outcome_message(
                UlWatchState::Skip,
                section,
                &format!("{}：{}", section.action.label(), section.note),
            ));
            continue;
        }
        if opts.dry_run {
            outcomes.push(outcome_message(
                UlWatchState::DryRun,
                section,
                &format!(
                    "预演：将提交 itemid={}（{}），studyStartTime={}",
                    section.section_id,
                    section.summary(),
                    section.study_start_time.unwrap_or(0)
                ),
            ));
            if !progress(UlProgress::new(
                UlProgressStage::Submit,
                submitted,
                actionable,
                section.label(),
                "预演：未发送请求",
            )) {
                outcomes.push(outcome_message(
                    UlWatchState::Cancelled,
                    section,
                    "用户取消",
                ));
                break;
            }
            continue;
        }

        let label = section.label();
        if !progress(UlProgress::new(
            UlProgressStage::Submit,
            submitted,
            actionable,
            label.clone(),
            "准备提交",
        )) {
            outcomes.push(outcome_message(
                UlWatchState::Cancelled,
                section,
                "用户取消",
            ));
            break;
        }
        let delay = random_delay(opts, &mut rng);
        tokio::time::sleep(delay).await;

        let study_start_time = section.study_start_time.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or(0)
        });
        let payload = match build_record_payload(section, study_start_time) {
            Ok(payload) => payload,
            Err(error) => {
                outcomes.push(outcome_message(
                    UlWatchState::Failed,
                    section,
                    &format!("构造上报数据失败：{error}"),
                ));
                if opts.stop_on_error {
                    break;
                }
                submitted += 1;
                continue;
            }
        };

        match submit_record(client, &payload).await {
            Ok(UlSyncOutcome::Success) => {
                let mut completion_status = None;
                let mut state = UlWatchState::Ok;
                let mut message = "提交成功".to_string();
                if opts.verify {
                    tokio::time::sleep(Duration::from_millis(VERIFY_DELAY_MS)).await;
                    match client.section_record(section.section_id).await {
                        Ok(record) => {
                            completion_status = Some(record.completion_status);
                            if record.completed() {
                                message = "提交成功，回读 completion_status=1".to_string();
                            } else {
                                state = UlWatchState::Failed;
                                message = format!(
                                    "提交已发送，但回读 completion_status={}",
                                    record.completion_status
                                );
                            }
                        }
                        Err(error) => {
                            state = UlWatchState::Failed;
                            message = format!("提交已发送，但回读失败：{error}");
                        }
                    }
                }
                let mut outcome = outcome_message(state, section, &message);
                outcome.completion_status = completion_status;
                outcomes.push(outcome);
                if state == UlWatchState::Failed && opts.stop_on_error {
                    break;
                }
            }
            Ok(UlSyncOutcome::CheatDetected) => {
                outcomes.push(outcome_message(
                    UlWatchState::CircuitBroken,
                    section,
                    "服务端返回 2（判定刷分），已停止整批",
                ));
                break;
            }
            Ok(UlSyncOutcome::Other(code)) => {
                outcomes.push(outcome_message(
                    UlWatchState::Failed,
                    section,
                    &format!("服务端返回 {code}"),
                ));
                if opts.stop_on_error {
                    break;
                }
            }
            Err(error) => {
                let message = error.to_string();
                let session_lost =
                    message.contains("登录状态失效") || message.contains("AUTHORIZATION");
                outcomes.push(outcome_message(
                    if session_lost {
                        UlWatchState::CircuitBroken
                    } else {
                        UlWatchState::Failed
                    },
                    section,
                    &format!("提交失败：{error}"),
                ));
                if session_lost || opts.stop_on_error {
                    break;
                }
            }
        }
        submitted += 1;

        if !progress(UlProgress::new(
            UlProgressStage::Verify,
            submitted,
            actionable,
            label,
            "已处理",
        )) {
            outcomes.push(outcome_message(
                UlWatchState::Cancelled,
                section,
                "用户取消",
            ));
            break;
        }
    }
    Ok(outcomes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ulearning::models::{UlQuestion, UlVideo};

    fn page(content_type: i64) -> UlPage {
        UlPage {
            id: 10,
            relation_id: 11,
            name: "页".to_string(),
            content_type,
        }
    }

    #[test]
    fn classifies_and_builds_video_plan() {
        let content = UlPageContent {
            videos: vec![UlVideo {
                video_id: 1563126,
                duration_secs: 1326,
            }],
            content_type: 6,
            ..UlPageContent::default()
        };
        let plan = page_plan(&page(6), &content, Vec::new()).unwrap();
        assert_eq!(plan.kind, UlPageKind::Video);
        assert_eq!(plan.videos.len(), 1);
        assert_eq!(plan.score, 100);
        assert!(page_plan(&page(6), &UlPageContent::default(), Vec::new()).is_err());
    }

    #[test]
    fn classifies_and_builds_practice_plan() {
        let content = UlPageContent {
            content_type: 7,
            coursepage_id: Some(9002),
            questions: vec![UlQuestion {
                question_id: 1,
                score: 20,
                kind: 1,
                title: "题干".to_string(),
            }],
            ..UlPageContent::default()
        };
        let answers = vec![UlQuestionAnswer {
            question_id: 1,
            score: 20,
            answer: vec!["D".to_string()],
        }];
        let plan = page_plan(&page(7), &content, answers).unwrap();
        assert_eq!(plan.kind, UlPageKind::Practice);
        assert_eq!(plan.coursepage_id, Some(9002));
        assert_eq!(plan.questions.len(), 1);
        assert!(page_plan(&page(7), &content, Vec::new()).is_err());

        let mut missing_component = content;
        missing_component.coursepage_id = None;
        assert!(
            page_plan(
                &page(7),
                &missing_component,
                vec![UlQuestionAnswer {
                    question_id: 1,
                    score: 20,
                    answer: vec!["D".to_string()],
                }],
            )
            .is_err()
        );
    }

    #[test]
    fn classifies_document_pages() {
        let content = UlPageContent {
            content_type: 5,
            ..UlPageContent::default()
        };
        let plan = page_plan(&page(5), &content, Vec::new()).unwrap();
        assert_eq!(plan.kind, UlPageKind::Document);
        assert!(plan.videos.is_empty());
    }

    #[test]
    fn delay_stays_inside_the_configured_window() {
        let opts = UlWatchOptions::default();
        let mut rng = StdRng::seed_from_u64(7);
        for _ in 0..100 {
            let millis = random_delay(&opts, &mut rng).as_millis() as u64;
            assert!((3_000..=5_000).contains(&millis), "delay {millis}");
        }
    }
}
