//! Video progress reporting.
//!
//! The platform's player reports playback through
//! `GET /mooc-ans/multimedia/log/a/{cpi}/{dtoken}`. The request carries a
//! signature computed as
//!
//! ```text
//! md5("[clazzId][userid][jobid][objectId][playingTime*1000][salt][duration*1000][clipTime]")
//! ```
//!
//! with the fixed H5 salt `d_yHJ!$pdA~5`. The values below were verified
//! against a real HAR: the two captured signatures reproduce byte for byte.
//! The server accepted a jump straight to the end of the video, so the fast
//! path mirrors the player's `ended` event instead of sleeping through the
//! real duration.

use crate::{
    client::SmartCourseClient,
    models::{Chapter, CourseDetail, TaskKind, TaskPoint},
    parse,
};
use anyhow::{Context, Result, bail};
use percent_encoding::percent_decode_str;
use serde::Deserialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub const PLAYER_REFERER: &str =
    "https://smartcourse.hust.edu.cn/ananas/modules/video/index.html?v=2026-0710-1025";

const ENC_SALT: &str = "d_yHJ!$pdA~5";

/// One video that can be reported as watched.
#[derive(Debug, Clone)]
pub struct WatchTarget {
    pub course_id: String,
    pub clazz_id: String,
    pub cpi: String,
    pub knowledge_id: String,
    pub knowledge_title: String,
    pub card_index: usize,
    pub name: String,
    pub job_id: String,
    pub object_id: String,
    pub duration_secs: u64,
    pub played_secs: u64,
    pub clip_time: String,
    pub other_info: String,
    pub att_duration_enc: Option<String>,
    pub rt: String,
    pub video_face_capture_enc: Option<String>,
    pub user_id: String,
    pub dtoken: String,
    /// `mArg.defaults.reportUrl`, usually `/mooc-ans/multimedia/log/a/{cpi}`.
    pub report_base: Option<String>,
}

impl WatchTarget {
    pub fn label(&self) -> String {
        format!(
            "{} / {} / card {} / {} ({}s)",
            self.knowledge_title, self.name, self.card_index, self.job_id, self.duration_secs
        )
    }

    /// Build the signed report URL for one heartbeat.
    pub fn report_url(&self, base: &Url, playing_secs: u64, is_drag: u8) -> Result<String> {
        let report_path = self
            .report_base
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("/mooc-ans/multimedia/log/a");
        let mut url = if report_path.starts_with("http://") || report_path.starts_with("https://") {
            Url::parse(report_path).context("invalid reportUrl from mArg.defaults")?
        } else {
            base.join(report_path)
                .context("invalid reportUrl from mArg.defaults")?
        };

        let mut segments: Vec<String> = url
            .path_segments()
            .map(|parts| {
                parts
                    .filter(|part| !part.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if segments.last().map(String::as_str) != Some(self.cpi.as_str()) {
            segments.push(self.cpi.clone());
        }
        segments.push(self.dtoken.clone());
        url.set_path(&format!("/{}", segments.join("/")));

        let enc = video_enc(
            &self.clazz_id,
            &self.user_id,
            &self.job_id,
            &self.object_id,
            playing_secs,
            self.duration_secs,
            &self.clip_time,
        );
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or(0);

        // `otherInfo` is a signed fragment. Some cards append
        // `&courseId=...` to it and percent-encode the whole value
        // (`%26courseId%3D...`, occasionally encoded twice). Decode until
        // stable, then keep only the signed part; the explicit courseId
        // parameter below carries the course id.
        let mut decoded = self.other_info.clone();
        for _ in 0..3 {
            let next = percent_decode_str(&decoded)
                .decode_utf8_lossy()
                .into_owned();
            if next == decoded {
                break;
            }
            decoded = next;
        }
        let other_info = decoded.split('&').next().unwrap_or(decoded.as_str());

        // Build the query manually. `query_pairs_mut` would percent-encode the
        // `&`/`=` inside signed fragments and change what the server validates.
        // The attachment's `videoFaceCaptureEnc` is not the player's report
        // token; the verified player requests send an empty value.
        let query = format!(
            "clazzId={}&playingTime={}&duration={}&clipTime={}&objectId={}&otherInfo={}&courseId={}&jobid={}&userid={}&isdrag={}&view=pc&enc={}&rt={}&videoFaceCaptureEnc=&dtype=Video&_t={}&attDuration={}&attDurationEnc={}&courseEngineInfo=false",
            self.clazz_id,
            playing_secs,
            self.duration_secs,
            self.clip_time,
            self.object_id,
            other_info,
            self.course_id,
            self.job_id,
            self.user_id,
            is_drag,
            enc,
            self.rt,
            timestamp,
            self.duration_secs,
            self.att_duration_enc.as_deref().unwrap_or(""),
        );
        url.set_query(Some(&query));

        Ok(url.to_string())
    }
}

/// Response from the progress endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct ReportReply {
    #[serde(rename = "isPassed", default)]
    pub is_passed: bool,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub msg: Option<String>,
}

/// Options for a watch run.
#[derive(Debug, Clone, Default)]
pub struct WatchOptions {
    /// Include task points the platform already marks as completed.
    pub include_completed: bool,
    /// Only process this job id.
    pub job: Option<String>,
    pub max_videos: Option<usize>,
    /// 0 jumps straight to the end after the start heartbeat. A positive value
    /// sends intermediate heartbeats every N seconds for slower pacing.
    pub step_secs: u64,
    /// Delay between heartbeats.
    pub delay_ms: u64,
}

#[derive(Debug, Default)]
pub struct WatchSummary {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

/// Compute the report signature used by the H5 player.
pub fn video_enc(
    clazz_id: &str,
    user_id: &str,
    job_id: &str,
    object_id: &str,
    playing_secs: u64,
    duration_secs: u64,
    clip_time: &str,
) -> String {
    let source = format!(
        "[{clazz_id}][{user_id}][{job_id}][{object_id}][{}][{ENC_SALT}][{}][{clip_time}]",
        playing_secs * 1000,
        duration_secs * 1000,
    );
    format!("{:x}", md5::compute(source))
}

/// Collect every video task point that needs a report.
pub fn collect_targets(
    client: &SmartCourseClient,
    detail: &CourseDetail,
    options: &WatchOptions,
) -> Result<Vec<WatchTarget>> {
    let cookie_user = client
        .cookie_value("_uid")
        .filter(|value| !value.is_empty());
    let mut targets = Vec::new();
    collect_from_chapters(
        &detail.chapters,
        detail,
        cookie_user.as_deref(),
        options,
        &mut targets,
    )?;

    if let Some(max) = options.max_videos {
        targets.truncate(max);
    }
    Ok(targets)
}

fn collect_from_chapters(
    chapters: &[Chapter],
    detail: &CourseDetail,
    cookie_user: Option<&str>,
    options: &WatchOptions,
    out: &mut Vec<WatchTarget>,
) -> Result<()> {
    for chapter in chapters {
        for card in &chapter.cards {
            let env = card.playback.as_ref();
            for point in &card.task_points {
                if point.kind != TaskKind::Video {
                    continue;
                }
                if !options.include_completed && point.completed == Some(true) {
                    continue;
                }
                let Some(job_id) = point.job_id.clone() else {
                    continue;
                };
                if let Some(filter) = &options.job
                    && &job_id != filter
                {
                    continue;
                }
                let Some(object_id) = point.object_id.clone() else {
                    continue;
                };
                let Some(duration_secs) = point.duration_secs.filter(|value| *value > 0) else {
                    continue;
                };
                let Some(dtoken) = point.video.as_ref().and_then(|video| video.dtoken.clone())
                else {
                    log::warn!(
                        "video `{}` has no dtoken; the status request may have failed",
                        point.name
                    );
                    continue;
                };
                let Some(other_info) = point.other_info.clone() else {
                    bail!(
                        "video `{}` is missing otherInfo; refresh the course data",
                        point.name
                    );
                };
                let user_id = env
                    .and_then(|value| value.user_id.clone())
                    .or_else(|| cookie_user.map(str::to_string))
                    .context(
                        "cards page did not expose mArg.defaults.userid; re-login and retry",
                    )?;
                let clazz_id = env
                    .and_then(|value| value.clazz_id.clone())
                    .unwrap_or_else(|| detail.course.class_id.clone());
                let course_id = env
                    .and_then(|value| value.course_id.clone())
                    .unwrap_or_else(|| detail.course.course_id.clone());

                if point.att_duration_enc.is_none() {
                    log::warn!(
                        "video `{}` has no attDurationEnc; the platform may reject the report",
                        point.name
                    );
                }

                out.push(WatchTarget {
                    course_id,
                    clazz_id,
                    cpi: detail.course.cpi.clone(),
                    knowledge_id: chapter.id.clone(),
                    knowledge_title: chapter.title.clone(),
                    card_index: card.index,
                    name: point.name.clone(),
                    job_id,
                    object_id,
                    duration_secs,
                    played_secs: point.played_ms.unwrap_or(0) / 1000,
                    clip_time: clip_time(point, duration_secs),
                    other_info,
                    att_duration_enc: point.att_duration_enc.clone(),
                    rt: point.rt.clone().unwrap_or_else(|| "1".to_string()),
                    video_face_capture_enc: point.video_face_capture_enc.clone(),
                    user_id,
                    dtoken,
                    report_base: env.and_then(|value| value.report_url.clone()),
                });
            }
        }
        collect_from_chapters(&chapter.children, detail, cookie_user, options, out)?;
    }
    Ok(())
}

fn clip_time(point: &TaskPoint, duration_secs: u64) -> String {
    let start = point
        .raw
        .get("startTime")
        .and_then(parse::as_u64)
        .unwrap_or(0);
    let end = point
        .raw
        .get("endTime")
        .and_then(parse::as_u64)
        .unwrap_or(duration_secs);
    format!("{start}_{end}")
}

/// Send the heartbeat sequence for one video.
///
/// The captured player sent: start (`isdrag=4`), play (`isdrag=3`), ended
/// (`isdrag=4`), then pause (`isdrag=2`). We mirror that order; the server's
/// `isPassed` in the response is what decides success.
pub async fn watch_target(
    client: &SmartCourseClient,
    target: &WatchTarget,
    options: &WatchOptions,
) -> Result<bool> {
    let end = target.duration_secs.max(1);
    let start = target.played_secs.min(end);

    let mut reply = client.report_video_progress(target, start, 4).await?;
    if reply.is_passed {
        return Ok(true);
    }

    reply = client.report_video_progress(target, start, 3).await?;
    if reply.is_passed {
        return Ok(true);
    }

    if options.step_secs == 0 {
        pause(options).await;
        reply = client.report_video_progress(target, end, 4).await?;
        if reply.is_passed {
            return Ok(true);
        }
        pause(options).await;
        reply = client.report_video_progress(target, end, 2).await?;
        return Ok(reply.is_passed);
    }

    let mut position = start;
    while position < end {
        position = (position + options.step_secs).min(end);
        reply = client.report_video_progress(target, position, 4).await?;
        if reply.is_passed {
            return Ok(true);
        }
        pause(options).await;
    }

    reply = client.report_video_progress(target, end, 2).await?;
    Ok(reply.is_passed)
}

async fn pause(options: &WatchOptions) {
    if options.delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(options.delay_ms)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_target() -> WatchTarget {
        WatchTarget {
            course_id: "1000".to_string(),
            clazz_id: "2000".to_string(),
            cpi: "3000".to_string(),
            knowledge_id: "4000".to_string(),
            knowledge_title: "Unit 1".to_string(),
            card_index: 1,
            name: "lesson.mp4".to_string(),
            job_id: "5000".to_string(),
            object_id: "abc123".to_string(),
            duration_secs: 647,
            played_secs: 0,
            clip_time: "0_647".to_string(),
            other_info: "nodeId_4000-cpi_3000".to_string(),
            att_duration_enc: Some("att-enc".to_string()),
            rt: "1".to_string(),
            video_face_capture_enc: None,
            user_id: "6000".to_string(),
            dtoken: "test-dtoken".to_string(),
            report_base: Some("/mooc-ans/multimedia/log/a/3000".to_string()),
        }
    }

    #[test]
    fn enc_matches_reference_vector() {
        // The formula itself was verified byte-for-byte against a live HAR;
        // this synthetic vector keeps captured ids out of the repository.
        assert_eq!(
            video_enc("2000", "6000", "5000", "abc123", 646, 647, "0_647"),
            "a6c82cfd9f0c28fe4849c6021c39229c"
        );
        assert_eq!(
            video_enc("2000", "6000", "5000", "abc123", 0, 647, "0_647"),
            "47c831658ca901455427bf3b630975f9"
        );
    }

    #[test]
    fn builds_report_url() {
        let target = sample_target();
        let base = Url::parse("https://smartcourse.hust.edu.cn/").unwrap();
        let url = target.report_url(&base, 646, 4).unwrap();
        assert!(url.starts_with(
            "https://smartcourse.hust.edu.cn/mooc-ans/multimedia/log/a/3000/test-dtoken?"
        ));
        assert!(url.contains("clazzId=2000"));
        assert!(url.contains("playingTime=646"));
        assert!(url.contains("duration=647"));
        assert!(url.contains("clipTime=0_647"));
        assert!(url.contains("objectId=abc123"));
        assert!(url.contains("jobid=5000"));
        assert!(url.contains("userid=6000"));
        assert!(url.contains("isdrag=4"));
        assert!(url.contains("enc=a6c82cfd9f0c28fe4849c6021c39229c"));
        assert!(url.contains("attDuration=647"));
        assert!(url.contains("attDurationEnc=att-enc"));
        assert!(url.contains("videoFaceCaptureEnc=&dtype=Video"));
        assert!(url.contains("dtype=Video"));
    }

    #[test]
    fn ignores_attachment_face_capture_token() {
        let mut target = sample_target();
        target.video_face_capture_enc = Some("attachment-token".to_string());
        let base = Url::parse("https://smartcourse.hust.edu.cn/").unwrap();
        let url = target.report_url(&base, 0, 4).unwrap();
        assert!(url.contains("videoFaceCaptureEnc=&dtype=Video"));
        assert!(!url.contains("attachment-token"));
    }

    #[test]
    fn strips_appended_query_from_other_info() {
        let mut target = sample_target();
        target.other_info = "nodeId_4000-cpi_3000&courseId=1000".to_string();
        let base = Url::parse("https://smartcourse.hust.edu.cn/").unwrap();
        let url = target.report_url(&base, 357, 4).unwrap();
        assert!(url.contains("otherInfo=nodeId_4000-cpi_3000&courseId=1000&jobid="));
        assert_eq!(url.matches("courseId=").count(), 1);
        assert!(!url.contains("%26"));
    }

    #[test]
    fn decodes_encoded_other_info_before_building_query() {
        let mut target = sample_target();
        target.other_info = "nodeId_4000-cpi_3000-enc_abc%26courseId%3D1000".to_string();
        let base = Url::parse("https://smartcourse.hust.edu.cn/").unwrap();
        let url = target.report_url(&base, 0, 4).unwrap();
        assert!(url.contains("otherInfo=nodeId_4000-cpi_3000-enc_abc&courseId=1000&jobid="));
        assert!(!url.contains("%26"));
        assert!(!url.contains("%3D"));
    }

    #[test]
    fn decodes_double_encoded_other_info_before_building_query() {
        let mut target = sample_target();
        target.other_info = "nodeId_4000-cpi_3000-enc_abc%2526courseId%253D1000".to_string();
        let base = Url::parse("https://smartcourse.hust.edu.cn/").unwrap();
        let url = target.report_url(&base, 0, 4).unwrap();
        assert!(url.contains("otherInfo=nodeId_4000-cpi_3000-enc_abc&courseId=1000&jobid="));
        assert!(!url.contains("%25"));
        assert!(!url.contains("%26"));
    }

    #[test]
    fn report_url_appends_cpi_when_report_base_omits_it() {
        let mut target = sample_target();
        target.report_base = Some("/mooc-ans/multimedia/log/a".to_string());
        let base = Url::parse("https://smartcourse.hust.edu.cn/").unwrap();
        let url = target.report_url(&base, 0, 3).unwrap();
        assert!(url.contains("/mooc-ans/multimedia/log/a/3000/test-dtoken"));
    }
}
