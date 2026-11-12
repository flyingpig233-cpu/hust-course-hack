//! Meet-course (见面课) replay attendance: list progress, pick a random
//! 90–100% coverage and report one minute at a time with rate limiting and a
//! circuit breaker.
//!
//! A replay minute is reported with a plain XOR `paramSecret` (no `secretStr`):
//! `[recruitId, liveId, userId, minute, "2", videoId]` joined with `;` and XORed
//! with `zhihuishu`. The watched-minute list comes back from `getWatchHistory`.
//! Anti-cheat checks run every `check_every` reports and abort the run when the
//! platform reports a lock or an abnormal record.

use std::{collections::HashSet, time::Duration};

use anyhow::{Result, bail};
use rand::{Rng, SeedableRng, rngs::StdRng};

use super::{
    XOR_KEY_MEET, ZhsClient, crypto,
    models::{ZhsMeet, ZhsMeetOutcome, ZhsMeetVideo, ZhsProgress, ZhsProgressStage, ZhsWatchState},
};

/// Attempts per minute after the first failure.
const MAX_RETRIES: usize = 2;

/// Base delay for the exponential retry backoff.
const RETRY_BASE_DELAY_MS: u64 = 300;

/// Consecutive failed reports that abort the run.
const MAX_CONSECUTIVE_FAILURES: usize = 3;

/// Meet replay watch options.
#[derive(Debug, Clone, PartialEq)]
pub struct ZhsMeetWatchOptions {
    /// Only compute and print the plan; never report a minute.
    pub dry_run: bool,
    /// Minimum coverage of the replay (fraction of total minutes).
    pub coverage_min: f64,
    /// Maximum coverage of the replay (fraction of total minutes).
    pub coverage_max: f64,
    /// Minimum delay between two reports, in milliseconds.
    pub delay_min_ms: u64,
    /// Maximum delay between two reports, in milliseconds.
    pub delay_max_ms: u64,
    /// Check the anti-cheat endpoint while reporting.
    pub circuit_breaker: bool,
    /// Number of reports between two anti-cheat checks.
    pub check_every: usize,
    /// Also report replay minutes for meetings that are already signed (签到).
    pub include_signed: bool,
}

impl Default for ZhsMeetWatchOptions {
    fn default() -> Self {
        Self {
            // Read-only by default: real attendance reporting must be requested
            // explicitly by the GUI user.
            dry_run: true,
            coverage_min: 0.90,
            coverage_max: 1.00,
            delay_min_ms: 2_000,
            delay_max_ms: 6_000,
            circuit_breaker: true,
            check_every: 10,
            include_signed: false,
        }
    }
}

impl ZhsMeetWatchOptions {
    /// Validate and normalize the coverage/delay/check windows.
    ///
    /// Invalid values are rejected instead of silently clamped, so the GUI can
    /// report a clear usage error.
    fn normalized(&self) -> Result<Self> {
        let mut opts = self.clone();
        if !(0.0..=1.0).contains(&opts.coverage_min) || !(0.0..=1.0).contains(&opts.coverage_max) {
            bail!("覆盖率必须在 0 到 1 之间（例如 0.90-1.00）");
        }
        if opts.coverage_min > opts.coverage_max {
            bail!("覆盖率下限不能大于上限");
        }
        if opts.delay_min_ms > opts.delay_max_ms {
            bail!("最小间隔不能大于最大间隔");
        }
        opts.coverage_min = opts.coverage_min.max(0.01);
        opts.coverage_max = opts.coverage_max.max(opts.coverage_min);
        if opts.check_every == 0 {
            bail!("风控检查间隔必须大于 0");
        }
        Ok(opts)
    }
}

/// Random target minute count for a replay, clamped to `1..=total`.
fn target_minutes(total_minutes: u32, opts: &ZhsMeetWatchOptions, rng: &mut impl Rng) -> u32 {
    if total_minutes == 0 {
        return 0;
    }
    let coverage = if opts.coverage_max > opts.coverage_min {
        rng.gen_range(opts.coverage_min..=opts.coverage_max)
    } else {
        opts.coverage_min
    };
    let target = (f64::from(total_minutes) * coverage).ceil() as u32;
    target.clamp(1, total_minutes)
}

/// Pick the minutes to report.
///
/// Watched minutes are excluded, then the first `target - watched` gap minutes
/// are selected in ascending order. A small random subset of them is dropped
/// (and refilled from the tail when possible) so the reported set never looks
/// like a perfectly contiguous prefix.
pub fn plan_meet_minutes(
    total_minutes: u32,
    watched: &[u32],
    target_minutes: u32,
    rng: &mut impl Rng,
) -> Vec<u32> {
    if total_minutes == 0 {
        return Vec::new();
    }
    let total = total_minutes;
    let target = target_minutes.min(total) as usize;
    let watched_set: HashSet<u32> = watched
        .iter()
        .copied()
        .filter(|minute| *minute >= 1 && *minute <= total)
        .collect();
    if watched_set.len() >= target {
        return Vec::new();
    }
    let need = target - watched_set.len();
    let candidates: Vec<u32> = (1..=total)
        .filter(|minute| !watched_set.contains(minute))
        .collect();
    if candidates.is_empty() {
        return Vec::new();
    }

    let (prefix, tail) = candidates.split_at(need.min(candidates.len()));
    let mut selected: Vec<u32> = prefix.to_vec();

    // Drop at most ~5% of the selection (and never more than half) to keep the
    // coverage random while staying inside the configured range.
    let max_drop = (need / 20).max(1).min(need / 2);
    if selected.len() > 1 && max_drop > 0 {
        let drop_count = rng.gen_range(0..=max_drop);
        for _ in 0..drop_count {
            if selected.len() <= 1 {
                break;
            }
            let index = rng.gen_range(0..selected.len());
            selected.remove(index);
        }
    }
    let selected_set: HashSet<u32> = selected.iter().copied().collect();
    for minute in tail {
        if selected.len() >= need {
            break;
        }
        if !selected_set.contains(minute) {
            selected.push(*minute);
        }
    }
    selected.sort_unstable();
    selected
}

/// Report one replay minute of the given replay video, retrying transient
/// failures with backoff.
async fn submit_with_retry(
    client: &ZhsClient,
    meet: &ZhsMeet,
    minute: u32,
    video_id: u64,
) -> Result<()> {
    let mut attempt = 0usize;
    loop {
        match client
            .meet_set_minute_for_video(meet, minute, video_id)
            .await
        {
            Ok(()) => return Ok(()),
            Err(error) if attempt < MAX_RETRIES => {
                let delay = RETRY_BASE_DELAY_MS.saturating_mul(1 << attempt);
                log::debug!(
                    "meet minute {minute} report failed (attempt {}), retrying in {delay} ms: {error:#}",
                    attempt + 1
                );
                tokio::time::sleep(Duration::from_millis(delay)).await;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Map a replay minute to the replay video it belongs to.
///
/// Videos are laid out consecutively, each occupying `ceil(duration / 60)`
/// minute slots; minutes beyond the known durations fall back to the last video.
/// When no duration is known the caller should not use this and must fall back
/// to the first video id (only single-video replays are exact in that case).
pub fn video_id_for_minute(videos: &[ZhsMeetVideo], minute: u32) -> Option<u64> {
    if videos.is_empty() {
        return None;
    }
    let mut start = 1u32;
    for video in videos {
        let slots = video.duration_secs.div_ceil(60).max(1) as u32;
        if minute < start.saturating_add(slots) {
            return Some(video.video_id);
        }
        start = start.saturating_add(slots);
    }
    videos.last().map(|video| video.video_id)
}

fn random_delay(opts: &ZhsMeetWatchOptions, rng: &mut impl Rng) -> Duration {
    let millis = if opts.delay_max_ms > opts.delay_min_ms {
        rng.gen_range(opts.delay_min_ms..=opts.delay_max_ms)
    } else {
        opts.delay_min_ms
    };
    Duration::from_millis(millis)
}

fn outcome(
    meet: &ZhsMeet,
    target: u32,
    watched_before: usize,
    state: ZhsWatchState,
    message: String,
) -> ZhsMeetOutcome {
    ZhsMeetOutcome {
        label: meet.label(),
        target_minutes: target,
        watched_before,
        submitted: 0,
        skipped: 0,
        failed: 0,
        watched_after: None,
        state,
        message,
    }
}

/// Execute one meet replay watch run.
///
/// The callback is invoked before every report and every anti-cheat check;
/// returning `false` cancels the run. A cancelled run still re-reads the watched
/// minutes so the caller can report the real coverage.
pub async fn run_meet_watch(
    client: &ZhsClient,
    meet: &ZhsMeet,
    opts: &ZhsMeetWatchOptions,
    progress: &(dyn Fn(ZhsProgress) -> bool + Send + Sync),
) -> Result<ZhsMeetOutcome> {
    let opts = opts.normalized()?;
    if meet.live_id == 0 {
        bail!("见面课「{}」缺少 liveId，无法上报回放考勤", meet.label());
    }
    let _user = client.current_user().await?;

    // 签到 is the authoritative completion signal: a signed meeting must not be
    // padded with replay minutes unless the caller explicitly asks for it.
    if !opts.include_signed {
        match client.meet_attendance(meet).await {
            Ok(attendance) if attendance.signed => {
                let mut done = outcome(
                    meet,
                    0,
                    0,
                    ZhsWatchState::Skip,
                    "已签到（签到已完成），跳过回放补刷".to_string(),
                );
                done.watched_after = Some(0);
                return Ok(done);
            }
            Ok(_) => {}
            Err(error) => log::warn!(
                "读取见面课「{}」考勤失败，继续按回放分钟处理：{error:#}",
                meet.label()
            ),
        }
    }

    // The minute report carries the replay `videoId`; load the video list
    // (id + duration) so multi-video replays map every minute to its own video.
    let mut effective_meet = meet.clone();
    let video_infos = match client.meet_video_infos(meet).await {
        Ok(infos) => infos,
        Err(error) => {
            log::warn!("could not resolve the replay video list: {error:#}");
            Vec::new()
        }
    };
    let durations_known = video_infos.iter().any(|video| video.duration_secs > 0);
    if effective_meet
        .video_id
        .filter(|video_id| *video_id > 0)
        .is_none()
    {
        effective_meet.video_id = video_infos.first().map(|video| video.video_id);
    }
    if !durations_known && video_infos.len() > 1 {
        // Without per-video lengths only the single-video case is exact; fall
        // back to the first `videoId` for every minute.
        log::warn!(
            "replay video durations unavailable for {}; using the first video id (only single-video replays are exact)",
            meet.label()
        );
    }
    let meet = &effective_meet;

    let total_secs = client.meet_duration_secs(meet).await?;
    let total_minutes = total_secs.div_ceil(60).max(1) as u32;
    let watched_before = client.meet_watch_history(meet).await?;
    let watched_count = watched_before.len();
    // `StdRng` is `Send`, unlike `ThreadRng` (`Rc`-based): the RNG is held
    // across `.await` points, and Tauri commands require the whole future to be
    // `Send`.
    let mut rng = StdRng::from_entropy();
    let target = target_minutes(total_minutes, &opts, &mut rng);

    if !progress(ZhsProgress::new(
        ZhsProgressStage::MeetList,
        0,
        1,
        meet.label(),
        format!("回放总时长 {total_minutes} 分钟，已看 {watched_count} 分钟，目标 {target} 分钟"),
    )) {
        let mut outcome = outcome(
            meet,
            target,
            watched_count,
            ZhsWatchState::Cancelled,
            "用户取消".to_string(),
        );
        outcome.watched_after = Some(watched_count);
        return Ok(outcome);
    }

    if watched_count >= target as usize {
        let mut outcome = outcome(
            meet,
            target,
            watched_count,
            ZhsWatchState::Skip,
            format!("已看 {watched_count} 分钟，已达到目标 {target} 分钟，跳过"),
        );
        outcome.watched_after = Some(watched_count);
        return Ok(outcome);
    }

    let minutes = plan_meet_minutes(total_minutes, &watched_before, target, &mut rng);
    if minutes.is_empty() {
        let mut outcome = outcome(
            meet,
            target,
            watched_count,
            ZhsWatchState::Skip,
            "没有需要补报的分钟".to_string(),
        );
        outcome.watched_after = Some(watched_count);
        return Ok(outcome);
    }

    if opts.dry_run {
        if progress(ZhsProgress::new(
            ZhsProgressStage::MeetMinutes,
            minutes.len(),
            minutes.len(),
            meet.label(),
            format!("预演：将上报 {} 分钟（目标 {target} 分钟）", minutes.len()),
        )) {
            let mut outcome = outcome(
                meet,
                target,
                watched_count,
                ZhsWatchState::DryRun,
                format!(
                    "预演：已看 {watched_count} 分钟，目标 {target} 分钟，将补报 {} 分钟（未发送请求）",
                    minutes.len()
                ),
            );
            outcome.watched_after = Some(watched_count);
            return Ok(outcome);
        }
        let mut outcome = outcome(
            meet,
            target,
            watched_count,
            ZhsWatchState::Cancelled,
            "用户取消".to_string(),
        );
        outcome.watched_after = Some(watched_count);
        return Ok(outcome);
    }

    let total_sends = minutes.len();
    let mut submitted = 0usize;
    let mut failed = 0usize;
    let mut consecutive_failures = 0usize;
    let mut cancelled = false;
    let mut circuit_broken = false;
    let mut circuit_message = String::new();
    let mut last_minute = 0u32;

    for (index, minute) in minutes.iter().enumerate() {
        let label = format!("第 {minute} 分钟");
        if !progress(ZhsProgress::new(
            ZhsProgressStage::MeetMinutes,
            index,
            total_sends,
            label.clone(),
            "准备上报",
        )) {
            cancelled = true;
            break;
        }
        // Rate limit every report, including the first one, to mimic human
        // viewing cadence from the very beginning of the run.
        let delay = random_delay(&opts, &mut rng);
        tokio::time::sleep(delay).await;
        let video_id = video_id_for_minute(&video_infos, *minute)
            .or(effective_meet.video_id)
            .unwrap_or(0);
        match submit_with_retry(client, meet, *minute, video_id).await {
            Ok(()) => {
                submitted += 1;
                consecutive_failures = 0;
            }
            Err(error) => {
                log::warn!("meet minute {minute} report failed: {error:#}");
                failed += 1;
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    circuit_broken = true;
                    circuit_message = "连续上报失败过多，已中止".to_string();
                    break;
                }
            }
        }
        last_minute = *minute;

        if opts.circuit_breaker && (index + 1) % opts.check_every == 0 {
            match client.meet_exception_status(meet).await {
                Ok(status) => {
                    if !progress(ZhsProgress::new(
                        ZhsProgressStage::CircuitCheck,
                        index + 1,
                        total_sends,
                        meet.label(),
                        status.message.clone(),
                    )) {
                        cancelled = true;
                        break;
                    }
                    if status.lock || status.abnormal {
                        circuit_broken = true;
                        circuit_message = format!("检测到风控异常，已中止：{}", status.message);
                        break;
                    }
                }
                Err(error) => log::warn!("meet exception check failed: {error:#}"),
            }
        }
    }

    let watched_after = client.meet_watch_history(meet).await.ok();
    let watched_after_count = watched_after.as_ref().map(Vec::len);
    let state = if cancelled {
        ZhsWatchState::Cancelled
    } else if circuit_broken {
        ZhsWatchState::CircuitBroken
    } else if failed > 0 {
        ZhsWatchState::Failed
    } else {
        ZhsWatchState::Ok
    };
    let mut message = if cancelled {
        "用户取消".to_string()
    } else if circuit_broken {
        circuit_message
    } else if failed > 0 {
        format!("部分分钟上报失败（成功 {submitted}，失败 {failed}）")
    } else {
        format!("已上报 {submitted} 分钟")
    };
    message.push_str(&format!(
        "；已看 {watched_count} → {}，目标 {target} 分钟",
        watched_after_count
            .map(|count| count.to_string())
            .unwrap_or_else(|| "未知".to_string())
    ));
    if last_minute > 0 && state != ZhsWatchState::Ok && cancelled {
        message.push_str(&format!("（最后尝试第 {last_minute} 分钟）"));
    }

    Ok(ZhsMeetOutcome {
        label: meet.label(),
        target_minutes: target,
        watched_before: watched_count,
        submitted,
        skipped: 0,
        failed,
        watched_after: watched_after_count,
        state,
        message,
    })
}

/// Build the XOR `paramSecret` of one replay minute (exposed for tests).
pub fn meet_param_secret(
    recruit_id: u64,
    live_id: u64,
    user_id: u64,
    minute: u32,
    video_id: u64,
) -> String {
    let fields: Vec<String> = vec![
        recruit_id.to_string(),
        live_id.to_string(),
        user_id.to_string(),
        minute.to_string(),
        "2".to_string(),
        video_id.to_string(),
    ];
    crypto::xor_encode(&fields, XOR_KEY_MEET)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use std::collections::HashSet;

    #[test]
    fn defaults_match_the_plan() {
        let opts = ZhsMeetWatchOptions::default();
        assert!(opts.dry_run, "core default must stay read-only");
        assert_eq!(opts.coverage_min, 0.90);
        assert_eq!(opts.coverage_max, 1.00);
        assert_eq!(opts.delay_min_ms, 2_000);
        assert_eq!(opts.delay_max_ms, 6_000);
        assert!(opts.circuit_breaker);
        assert_eq!(opts.check_every, 10);
    }

    #[test]
    fn rejects_invalid_options() {
        let opts = ZhsMeetWatchOptions {
            coverage_min: 1.5,
            ..ZhsMeetWatchOptions::default()
        };
        assert!(opts.normalized().is_err());

        let opts = ZhsMeetWatchOptions {
            coverage_min: 0.99,
            coverage_max: 0.90,
            ..ZhsMeetWatchOptions::default()
        };
        assert!(opts.normalized().is_err());

        let opts = ZhsMeetWatchOptions {
            delay_min_ms: 9_000,
            delay_max_ms: 1_000,
            ..ZhsMeetWatchOptions::default()
        };
        assert!(opts.normalized().is_err());

        let opts = ZhsMeetWatchOptions {
            check_every: 0,
            ..ZhsMeetWatchOptions::default()
        };
        assert!(opts.normalized().is_err());
    }

    #[test]
    fn target_stays_inside_the_coverage_window() {
        let opts = ZhsMeetWatchOptions::default();
        let mut rng = StdRng::seed_from_u64(7);
        for _ in 0..500 {
            let target = target_minutes(100, &opts, &mut rng);
            assert!((90..=100).contains(&target), "target {target}");
        }
        assert_eq!(target_minutes(0, &opts, &mut rng), 0);
        let mut rng = StdRng::seed_from_u64(7);
        assert_eq!(target_minutes(10, &opts, &mut rng), 10);
    }

    #[test]
    fn plan_excludes_watched_and_stays_sorted() {
        let mut rng = StdRng::seed_from_u64(42);
        let watched = [1u32, 2, 3, 7, 8];
        let minutes = plan_meet_minutes(100, &watched, 95, &mut rng);
        assert!(!minutes.is_empty());
        assert!(minutes.len() <= 95);
        assert!(minutes.len() >= 90, "planned {}", minutes.len());
        let unique: HashSet<u32> = minutes.iter().copied().collect();
        assert_eq!(unique.len(), minutes.len());
        assert!(minutes.windows(2).all(|pair| pair[0] < pair[1]));
        let watched_set: HashSet<u32> = watched.into_iter().collect();
        assert!(minutes.iter().all(|minute| !watched_set.contains(minute)));
        assert!(minutes.iter().all(|minute| (1..=100).contains(minute)));
    }

    #[test]
    fn plan_returns_empty_when_nothing_to_do() {
        let mut rng = StdRng::seed_from_u64(1);
        assert!(plan_meet_minutes(0, &[], 0, &mut rng).is_empty());
        assert!(plan_meet_minutes(10, &[1, 2, 3], 3, &mut rng).is_empty());
        let all: Vec<u32> = (1..=10).collect();
        assert!(plan_meet_minutes(10, &all, 10, &mut rng).is_empty());
    }

    #[test]
    fn plan_can_cover_a_complete_gap() {
        let mut rng = StdRng::seed_from_u64(3);
        let minutes = plan_meet_minutes(20, &[1, 2], 20, &mut rng);
        assert_eq!(minutes.len(), 18);
        assert!(minutes.contains(&20));
    }

    #[test]
    fn delays_stay_inside_the_configured_window() {
        let opts = ZhsMeetWatchOptions::default();
        let mut rng = StdRng::seed_from_u64(11);
        for _ in 0..200 {
            let delay = random_delay(&opts, &mut rng).as_millis() as u64;
            assert!((2_000..=6_000).contains(&delay), "delay {delay}");
        }
        let opts = ZhsMeetWatchOptions {
            delay_min_ms: 500,
            delay_max_ms: 500,
            ..ZhsMeetWatchOptions::default()
        };
        assert_eq!(random_delay(&opts, &mut rng).as_millis(), 500);
    }

    #[test]
    fn maps_replay_minutes_to_videos() {
        let videos = vec![
            ZhsMeetVideo {
                video_id: 11,
                duration_secs: 120,
            },
            ZhsMeetVideo {
                video_id: 22,
                duration_secs: 60,
            },
        ];
        assert_eq!(video_id_for_minute(&videos, 1), Some(11));
        assert_eq!(video_id_for_minute(&videos, 2), Some(11));
        assert_eq!(video_id_for_minute(&videos, 3), Some(22));
        // Minutes past the known durations fall back to the last video.
        assert_eq!(video_id_for_minute(&videos, 4), Some(22));
        assert_eq!(video_id_for_minute(&[], 1), None);
    }

    #[test]
    fn param_secret_matches_the_page_fields() {
        let secret = meet_param_secret(463667, 99_887_766, 12_345_678, 12, 70_000_001);
        assert_eq!(
            secret,
            "4e5e5a5e435e48514c42505e5f435f485947495c5c5e4251485947415a525f45594358454a59"
        );
        let decoded: Vec<String> = crypto::xor_decode(&secret, XOR_KEY_MEET)
            .unwrap()
            .split(';')
            .map(str::to_string)
            .collect();
        assert_eq!(
            decoded,
            vec![
                "463667".to_string(),
                "99887766".to_string(),
                "12345678".to_string(),
                "12".to_string(),
                "2".to_string(),
                "70000001".to_string(),
            ]
        );
    }
}
