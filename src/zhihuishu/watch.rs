//! Shared-course video completion: plan, execute, verify and circuit-break.
//!
//! The completion protocol is a three-step dance per video:
//!
//! 1. `prelearningNote` returns a fresh `noteId`;
//! 2. `saveDatabaseIntervalTimeV2` receives the synthetic `ewssw` watch-point
//!    sequence, the XOR-encoded `sdsew` field list and `base64(noteId)` as
//!    `zwsds`;
//! 3. `queryStuyInfo` should report `watchState == 1` for the video.
//!
//! Each step is a normal API request; failures degrade to a per-video `Failed`
//! outcome and three consecutive failures, or any anti-cheat lock, aborts the
//! batch. The batch stops when the progress callback returns `false`.

use std::time::Duration;

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

use super::{
    XOR_KEY_VIDEO, ZhsClient, crypto,
    models::{
        ZhsCourse, ZhsCourseDetail, ZhsProgress, ZhsProgressStage, ZhsVideoTarget, ZhsWatchOptions,
        ZhsWatchOutcome, ZhsWatchState,
    },
};

/// Delay before the verification query so the server-side write is visible.
const VERIFY_DELAY_MS: u64 = 800;

/// Consecutive failures that abort the batch.
const MAX_CONSECUTIVE_FAILURES: usize = 3;

/// Flatten a course tree into an ordered plan of video targets.
///
/// Completed videos are kept in the plan (`completed = true`) so callers can
/// report them as skipped; [`ZhsVideoTarget::skip_reason`] decides what actually
/// runs. `max_videos` is applied to the flattened plan.
pub fn plan_videos(detail: &ZhsCourseDetail, opts: &ZhsWatchOptions) -> Vec<ZhsVideoTarget> {
    let course = &detail.course;
    let mut targets = Vec::new();
    for chapter in &detail.chapters {
        let chapter_id = chapter.chapter_id.unwrap_or(0);
        for lesson in &chapter.lessons {
            let videos = lesson.all_videos();
            for (index, video) in videos.iter().enumerate() {
                let mut label = format!("{} / {}", course.label(), chapter.name);
                if !lesson.name.is_empty() {
                    label.push_str(" / ");
                    label.push_str(&lesson.name);
                }
                if videos.len() > 1 {
                    if video.name.is_empty() {
                        label.push_str(&format!(" / 小节{}", index + 1));
                    } else {
                        label.push_str(" / ");
                        label.push_str(&video.name);
                    }
                }
                targets.push(ZhsVideoTarget {
                    recruit_id: course.recruit_id,
                    course_id: course.course_id,
                    chapter_id,
                    lesson_id: lesson.lesson_id,
                    lesson_video_id: video.lesson_video_id,
                    video_id: video.video_id,
                    video_sec: video.video_sec,
                    label,
                    completed: video.is_studied.unwrap_or(0) != 0,
                });
            }
        }
    }
    if let Some(max) = opts.max_videos.filter(|max| *max > 0) {
        targets.truncate(max);
    }
    targets
}

/// Build the `saveDatabaseIntervalTimeV2` payload for one target.
///
/// `uuid` is the short `CASLOGC` uuid; the site appends the literal `zhs`.
///
/// Field layout is the live-tested *send* format
/// `[recruitId, lessonId, lessonVideoId, videoId, chapterId, 0, total, total,
/// hms(total), uuid + "zhs"]`. The page's own capture uses `0` in place of the
/// second `total`; that variant is only used by `crypto_self_check` to verify
/// the raw XOR algorithm. Keep the two layouts separate — do not "unify" them.
pub fn build_video_payload(target: &ZhsVideoTarget, uuid: &str, note_id: u64) -> Result<Value> {
    let total = target.video_sec.to_string();
    let fields: Vec<String> = vec![
        target.recruit_id.to_string(),
        target.lesson_id.to_string(),
        target.lesson_video_id.to_string(),
        target.video_id.to_string(),
        target.chapter_id.to_string(),
        "0".to_string(),
        total.clone(),
        total,
        crypto::hms(target.video_sec),
        format!("{uuid}zhs"),
    ];
    let sdsew = crypto::xor_encode(&fields, XOR_KEY_VIDEO);
    let zwsds = STANDARD.encode(note_id.to_string());
    Ok(json!({
        "ewssw": crypto::watch_points(target.video_sec),
        "sdsew": sdsew,
        "zwsds": zwsds,
    }))
}

fn outcome(
    label: &str,
    state: ZhsWatchState,
    watch_state: Option<i64>,
    message: &str,
) -> ZhsWatchOutcome {
    ZhsWatchOutcome {
        label: label.to_string(),
        state,
        watch_state,
        message: message.to_string(),
    }
}

/// Execute a video plan.
///
/// Returns one outcome per processed target; a cancelled or circuit-broken run
/// stops early and reports the reason in the last outcome. The callback is
/// invoked for every stage transition and returning `false` cancels the run.
pub async fn run_video_watch(
    client: &ZhsClient,
    targets: &[ZhsVideoTarget],
    opts: &ZhsWatchOptions,
    progress: &(dyn Fn(ZhsProgress) -> bool + Send + Sync),
) -> Result<Vec<ZhsWatchOutcome>> {
    let total = targets.len();
    let mut outcomes = Vec::with_capacity(total);

    // A batch always belongs to one course.
    let course = ZhsCourse {
        recruit_id: targets.first().map(|t| t.recruit_id).unwrap_or(0),
        course_id: targets.first().map(|t| t.course_id).unwrap_or(0),
        ..ZhsCourse::default()
    };
    let needs_user = targets
        .iter()
        .any(|target| target.skip_reason(opts).is_none());
    let user = if needs_user {
        Some(client.current_user().await?)
    } else {
        None
    };

    let mut consecutive_failures = 0usize;
    for (index, target) in targets.iter().enumerate() {
        if let Some(reason) = target.skip_reason(opts) {
            outcomes.push(outcome(
                target.label.as_str(),
                ZhsWatchState::Skip,
                None,
                reason,
            ));
            if !progress(ZhsProgress::new(
                ZhsProgressStage::Videos,
                index + 1,
                total,
                target.label.clone(),
                reason,
            )) {
                outcomes.push(cancelled_outcome(target, total - index - 1));
                break;
            }
            continue;
        }

        if opts.dry_run {
            outcomes.push(outcome(
                target.label.as_str(),
                ZhsWatchState::DryRun,
                None,
                &format!(
                    "预演：将上报 {} 秒视频（{} 个观看点），未发送任何请求",
                    target.video_sec,
                    crypto::watch_points(target.video_sec).split(',').count()
                ),
            ));
            if !progress(ZhsProgress::new(
                ZhsProgressStage::Videos,
                index + 1,
                total,
                target.label.clone(),
                "预演：未发送任何请求",
            )) {
                outcomes.push(cancelled_outcome(target, total - index - 1));
                break;
            }
            continue;
        }

        let Some(user) = user.as_ref() else {
            outcomes.push(outcome(
                target.label.as_str(),
                ZhsWatchState::Failed,
                None,
                "登录状态缺失",
            ));
            continue;
        };

        if !progress(ZhsProgress::new(
            ZhsProgressStage::Videos,
            index,
            total,
            target.label.clone(),
            "获取学习记录",
        )) {
            outcomes.push(cancelled_outcome(target, total - index));
            break;
        }

        // Step 1: fresh noteId. Never cache it, it is page-bound.
        let note = match client.prelearning_note(&course, target).await {
            Ok(note) => note,
            Err(error) => {
                log::warn!("prelearningNote failed for {}: {error:#}", target.label);
                consecutive_failures += 1;
                outcomes.push(outcome(
                    target.label.as_str(),
                    ZhsWatchState::Failed,
                    None,
                    &format!("获取学习记录失败：{error}"),
                ));
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    mark_circuit_broken(&mut outcomes, "连续失败过多，已中止整批");
                    break;
                }
                continue;
            }
        };

        if note.completed() && !opts.include_completed {
            consecutive_failures = 0;
            outcomes.push(outcome(
                target.label.as_str(),
                ZhsWatchState::Skip,
                note.watch_state,
                "平台已标记完成，跳过",
            ));
            if !progress(ZhsProgress::new(
                ZhsProgressStage::Videos,
                index + 1,
                total,
                target.label.clone(),
                "平台已标记完成，跳过",
            )) {
                outcomes.push(cancelled_outcome(target, total - index - 1));
                break;
            }
            continue;
        }

        // Step 2: completion report.
        let payload = match build_video_payload(target, &user.uuid, note.note_id) {
            Ok(payload) => payload,
            Err(error) => {
                outcomes.push(outcome(
                    target.label.as_str(),
                    ZhsWatchState::Failed,
                    note.watch_state,
                    &format!("构造上报参数失败：{error}"),
                ));
                break;
            }
        };
        let saved = match client
            .save_interval(
                &course,
                payload["ewssw"].as_str().unwrap_or_default(),
                payload["sdsew"].as_str().unwrap_or_default(),
                payload["zwsds"].as_str().unwrap_or_default(),
            )
            .await
        {
            Ok(saved) => saved,
            Err(error) => {
                log::warn!(
                    "saveDatabaseIntervalTimeV2 failed for {}: {error:#}",
                    target.label
                );
                consecutive_failures += 1;
                outcomes.push(outcome(
                    target.label.as_str(),
                    ZhsWatchState::Failed,
                    note.watch_state,
                    &format!("上报失败：{error}"),
                ));
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    mark_circuit_broken(&mut outcomes, "连续失败过多，已中止整批");
                    break;
                }
                continue;
            }
        };
        if !saved {
            consecutive_failures += 1;
            outcomes.push(outcome(
                target.label.as_str(),
                ZhsWatchState::Failed,
                note.watch_state,
                "服务器未确认本次上报",
            ));
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                mark_circuit_broken(&mut outcomes, "连续失败过多，已中止整批");
                break;
            }
            continue;
        }

        // Step 3: verify.
        let mut watch_state = None;
        let mut state = ZhsWatchState::Ok;
        let mut message = "上报成功".to_string();
        if opts.verify {
            tokio::time::sleep(Duration::from_millis(VERIFY_DELAY_MS)).await;
            match client
                .query_stuy_info(
                    target.recruit_id,
                    &[target.lesson_id],
                    &[target.lesson_video_id],
                )
                .await
            {
                Ok(states) => {
                    let observed = states.get(&target.lesson_video_id);
                    watch_state = observed.and_then(|study| study.watch_state);
                    if observed.is_some_and(|study| study.completed()) {
                        message = "上报成功，复核 watchState=1".to_string();
                    } else {
                        state = ZhsWatchState::Failed;
                        consecutive_failures += 1;
                        message = format!(
                            "上报已提交，但复核 watchState={}（期望 1）",
                            watch_state
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "未知".to_string())
                        );
                    }
                }
                Err(error) => {
                    state = ZhsWatchState::Failed;
                    consecutive_failures += 1;
                    message = format!("上报已提交，但复核失败：{error}");
                }
            }
        } else {
            consecutive_failures = 0;
        }
        if state == ZhsWatchState::Ok {
            consecutive_failures = 0;
        }

        // Anti-cheat check after every report; a lock aborts the whole batch.
        match client.exception_status(&course).await {
            Ok(status) => {
                if !progress(ZhsProgress::new(
                    ZhsProgressStage::CircuitCheck,
                    index + 1,
                    total,
                    target.label.clone(),
                    status.message.clone(),
                )) {
                    outcomes.push(outcome(
                        target.label.as_str(),
                        ZhsWatchState::Cancelled,
                        watch_state,
                        "用户取消",
                    ));
                    break;
                }
                if status.lock || status.abnormal {
                    outcomes.push(outcome(
                        target.label.as_str(),
                        ZhsWatchState::CircuitBroken,
                        watch_state,
                        &format!("检测到风控异常，已中止整批：{}", status.message),
                    ));
                    break;
                }
            }
            Err(error) => {
                log::warn!("exceptionActionDetail check failed: {error:#}");
            }
        }

        outcomes.push(outcome(target.label.as_str(), state, watch_state, &message));
        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
            mark_circuit_broken(&mut outcomes, "连续失败过多，已中止整批");
            break;
        }
        if !progress(ZhsProgress::new(
            ZhsProgressStage::Verify,
            index + 1,
            total,
            target.label.clone(),
            message.clone(),
        )) {
            outcomes.push(cancelled_outcome(target, total - index - 1));
            break;
        }
    }
    Ok(outcomes)
}

/// Replace the last outcome's state when the batch is aborted by the breaker.
fn mark_circuit_broken(outcomes: &mut [ZhsWatchOutcome], message: &str) {
    match outcomes.last_mut() {
        Some(last) => {
            last.state = ZhsWatchState::CircuitBroken;
            last.message = format!("{}；{message}", last.message);
        }
        None => log::warn!("circuit breaker tripped before any outcome was recorded"),
    }
}

fn cancelled_outcome(target: &ZhsVideoTarget, remaining: usize) -> ZhsWatchOutcome {
    outcome(
        target.label.as_str(),
        ZhsWatchState::Cancelled,
        None,
        &format!("用户取消，剩余 {remaining} 节未执行"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zhihuishu::models::{ZhsChapter, ZhsCourse, ZhsLesson, ZhsVideo};

    fn detail() -> ZhsCourseDetail {
        ZhsCourseDetail {
            course: ZhsCourse {
                recruit_id: 463667,
                course_id: 1000011214,
                name: "军事理论".to_string(),
                ..ZhsCourse::default()
            },
            chapters: vec![ZhsChapter {
                chapter_id: Some(1000116293),
                name: "第一章".to_string(),
                lessons: vec![ZhsLesson {
                    lesson_id: 1000337356,
                    name: "第一节".to_string(),
                    videos: vec![
                        ZhsVideo {
                            video_id: 71192505,
                            lesson_video_id: 1000244477,
                            video_sec: 826,
                            is_studied: Some(1),
                            name: String::new(),
                        },
                        ZhsVideo {
                            video_id: 74150643,
                            lesson_video_id: 1000244476,
                            video_sec: 492,
                            is_studied: Some(0),
                            name: "小节二".to_string(),
                        },
                    ],
                    ..ZhsLesson::default()
                }],
                ..ZhsChapter::default()
            }],
        }
    }

    #[test]
    fn flattens_videos_and_marks_completion() {
        let detail = detail();
        let targets = plan_videos(&detail, &ZhsWatchOptions::default());
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].chapter_id, 1000116293);
        assert_eq!(targets[0].lesson_id, 1000337356);
        assert_eq!(targets[0].lesson_video_id, 1000244477);
        assert_eq!(targets[0].video_id, 71192505);
        assert_eq!(targets[0].video_sec, 826);
        assert!(targets[0].completed);
        assert!(targets[0].label.contains("军事理论 / 第一章 / 第一节"));
        assert!(targets[0].label.contains("小节1"));
        assert!(targets[1].label.contains("小节二"));
        assert!(!targets[1].completed);
    }

    #[test]
    fn respects_max_videos() {
        let detail = detail();
        let opts = ZhsWatchOptions {
            max_videos: Some(1),
            ..ZhsWatchOptions::default()
        };
        assert_eq!(plan_videos(&detail, &opts).len(), 1);
        let opts = ZhsWatchOptions {
            max_videos: Some(0),
            ..ZhsWatchOptions::default()
        };
        assert_eq!(plan_videos(&detail, &opts).len(), 2);
    }

    #[test]
    fn builds_the_verified_report_payload() {
        let target = ZhsVideoTarget {
            recruit_id: 463667,
            course_id: 1000011214,
            chapter_id: 1000116293,
            lesson_id: 1000337351,
            lesson_video_id: 1000244446,
            video_id: 70622143,
            video_sec: 468,
            label: "x".to_string(),
            completed: false,
        };
        let payload = build_video_payload(&target, "abcdefgh", 13_191_360_047).unwrap();
        assert_eq!(
            payload["sdsew"].as_str().unwrap(),
            "4e4c4342425d5f4b4a4044475953494f414f455a544a484440405e52414d40424658554e494b45445a544b4b46464d595f4a4144424c51504c424b444450544d40444c4f0b06191e151213021e1209"
        );
        assert_eq!(payload["zwsds"].as_str().unwrap(), "MTMxOTEzNjAwNDc=");
        assert!(
            payload["ewssw"]
                .as_str()
                .unwrap()
                .starts_with("0,1,2,2,2,3")
        );
    }

    #[test]
    fn skip_reason_respects_include_completed() {
        let target = ZhsVideoTarget {
            video_id: 1,
            lesson_video_id: 2,
            video_sec: 3,
            completed: true,
            ..ZhsVideoTarget::default()
        };
        assert!(target.skip_reason(&ZhsWatchOptions::default()).is_some());
        let opts = ZhsWatchOptions {
            include_completed: true,
            ..ZhsWatchOptions::default()
        };
        assert!(target.skip_reason(&opts).is_none());
        let incomplete = ZhsVideoTarget {
            video_id: 0,
            ..target
        };
        assert!(incomplete.skip_reason(&opts).is_some());
    }
}
