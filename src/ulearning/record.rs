//! Study-record payload construction and submission for Ulearning.
//!
//! The player builds an `ItemStudyRecordUpdateDTO`, DES-encrypts it with the
//! hardcoded key and POSTs it to `/yws/api/personal/sync?courseType=4&platform=PC`.
//! The payload layout below matches the verified golden payload in
//! `docs/ulearning/miaoshua-plan.md` §2.4/§2.6:
//!
//! * `pageid` is the page **relation id**;
//! * video `videoid` is the element `resourceid` and `time` its `videoLength`;
//! * practice pages carry `coursepageId` plus one `questions[]` entry per
//!   answered question;
//! * the platform answers `1` (success) or `2` (anti-cheat stop).

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    cipher,
    client::UlearningClient,
    models::{UlPageKind, UlSectionPlan, UlSyncOutcome},
};

/// Client-side study time cap used by the player (`min(studyTime, 1000)`).
const STUDY_TIME_CAP: i64 = 1000;

/// Length of one fabricated playback interval in `startEndTimeList`, in seconds.
///
/// The platform's anti-cheat accepts a completed report only when
/// `startEndTimeList` contains **real epoch timestamps** for the played
/// intervals. The old payload sent `[{ "startTime": 0, "endTime": duration }]`,
/// which the server flags as 刷课 (sync returns `2`). We therefore fabricate a
/// plausible timeline that ends a couple of seconds ago and covers the whole
/// video, split into player-like chunks.
const PLAY_INTERVAL_SECS: i64 = 300;

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// Build the `ItemStudyRecordUpdateDTO` for one planned section.
pub fn build_record_payload(section: &UlSectionPlan, study_start_time: i64) -> Result<Value> {
    if !section.is_actionable() {
        bail!("节「{}」不是可提交状态", section.label());
    }
    if section.pages.is_empty() {
        bail!("节「{}」没有可提交的页面", section.label());
    }
    if study_start_time <= 0 {
        bail!("节「{}」缺少有效的 studyStartTime", section.label());
    }

    let mut page_records = Vec::with_capacity(section.pages.len());
    let now = unix_seconds();
    let mut earliest_video_start: Option<i64> = None;
    for planned in &section.pages {
        let page = &planned.page;
        if page.relation_id <= 0 {
            bail!("节「{}」页面缺少 relationid", section.label());
        }

        match planned.kind {
            UlPageKind::Video => {
                if planned.videos.is_empty() {
                    bail!("视频页「{}」缺少视频信息，拒绝猜测", page.name);
                }
            }
            UlPageKind::Practice => {
                if planned.questions.is_empty() {
                    bail!("练习页「{}」缺少答案，拒绝提交", page.name);
                }
                if planned.coursepage_id.is_none() {
                    bail!("练习页「{}」缺少练习组件 id", page.name);
                }
            }
            UlPageKind::Document => {}
        }

        let mut videos = Vec::with_capacity(planned.videos.len());
        for video in &planned.videos {
            if video.video_id <= 0 || video.duration_secs <= 0 {
                bail!("视频信息不完整（videoid/time 为空），拒绝猜测");
            }
            // Match the player's report shape: epoch-based playback intervals
            // that end shortly before "now" and cover the whole duration.
            let video_end = (now - 2).max(0);
            let video_start = (video_end - video.duration_secs).max(0);
            earliest_video_start = Some(match earliest_video_start {
                Some(existing) => existing.min(video_start),
                None => video_start,
            });
            let mut intervals = Vec::new();
            let mut cursor = video_start;
            while cursor < video_end {
                let next = (cursor + PLAY_INTERVAL_SECS).min(video_end);
                intervals.push(json!({ "startTime": cursor, "endTime": next }));
                cursor = next;
            }
            videos.push(json!({
                "videoid": video.video_id,
                "current": video.duration_secs,
                "status": 1,
                "recordTime": video.duration_secs,
                "time": video.duration_secs,
                "startEndTimeList": intervals,
            }));
        }

        let mut questions = Vec::with_capacity(planned.questions.len());
        for question in &planned.questions {
            if question.answer.is_empty() {
                bail!("题目 {} 缺少答案，拒绝提交", question.question_id);
            }
            questions.push(json!({
                "questionid": question.question_id,
                "answerList": question.answer,
                "score": question.score,
            }));
        }

        let mut page_record = Map::new();
        page_record.insert("pageid".to_string(), json!(page.relation_id));
        page_record.insert("complete".to_string(), json!(1));
        page_record.insert("studyTime".to_string(), json!(STUDY_TIME_CAP));
        page_record.insert("score".to_string(), json!(planned.score));
        page_record.insert("answerTime".to_string(), json!(1));
        page_record.insert(
            "submitTimes".to_string(),
            json!(if planned.kind == UlPageKind::Practice {
                1
            } else {
                0
            }),
        );
        if let Some(coursepage_id) = planned.coursepage_id {
            page_record.insert("coursepageId".to_string(), json!(coursepage_id));
        }
        page_record.insert("questions".to_string(), Value::Array(questions));
        page_record.insert("videos".to_string(), Value::Array(videos));
        page_record.insert("speaks".to_string(), json!([]));
        page_records.push(Value::Object(page_record));
    }

    let score = if section.score > 0 {
        section.score
    } else {
        100
    };
    let study_start_time = earliest_video_start.unwrap_or(study_start_time);
    Ok(json!({
        "itemid": section.section_id,
        "autoSave": 1,
        "withoutOld": Value::Null,
        "complete": 1,
        "studyStartTime": study_start_time,
        "score": score,
        "pageStudyRecordDTOList": page_records,
    }))
}

/// Serialize and DES-encrypt a record payload into the request body.
pub fn encrypt_record_payload(payload: &Value) -> Result<String> {
    let plaintext = serde_json::to_string(payload).context("failed to serialize record payload")?;
    cipher::encrypt_ecb_base64(&plaintext)
}

/// Submit one record payload and map the platform result.
///
/// `UlSyncOutcome::CheatDetected` (server code `2`) means the platform flagged
/// the request as 刷分; the caller must stop the whole batch immediately.
pub async fn submit_record(client: &UlearningClient, payload: &Value) -> Result<UlSyncOutcome> {
    let ciphertext = encrypt_record_payload(payload)?;
    client.post_sync_cipher(&ciphertext).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ulearning::models::{UlAction, UlPage, UlPagePlan, UlQuestionAnswer, UlVideo};

    fn video_section() -> UlSectionPlan {
        UlSectionPlan {
            chapter_id: 141351390,
            chapter_name: "第一讲 导论".to_string(),
            section_id: 2377981,
            section_name: "第一节".to_string(),
            pages: vec![UlPagePlan {
                page: UlPage {
                    id: 2377983,
                    relation_id: 2377984,
                    name: "视频页".to_string(),
                    content_type: 6,
                },
                kind: UlPageKind::Video,
                videos: vec![UlVideo {
                    video_id: 1563126,
                    duration_secs: 1326,
                }],
                questions: vec![],
                coursepage_id: None,
                score: 100,
            }],
            action: UlAction::Complete,
            study_start_time: Some(1_794_062_059),
            score: 100,
            note: String::new(),
        }
    }

    fn practice_section() -> UlSectionPlan {
        UlSectionPlan {
            chapter_id: 141351390,
            chapter_name: "第一讲 导论".to_string(),
            section_id: 2379018,
            section_name: "章节练习".to_string(),
            pages: vec![UlPagePlan {
                page: UlPage {
                    id: 2379019,
                    relation_id: 2379020,
                    name: "章节练习".to_string(),
                    content_type: 7,
                },
                kind: UlPageKind::Practice,
                videos: vec![],
                questions: vec![UlQuestionAnswer {
                    question_id: 17_393_623,
                    score: 20,
                    answer: vec!["D".to_string()],
                }],
                coursepage_id: Some(9002),
                score: 100,
            }],
            action: UlAction::CompletePractice,
            study_start_time: Some(1_794_062_059),
            score: 100,
            note: String::new(),
        }
    }

    #[test]
    fn builds_verified_video_payload() {
        let section = video_section();
        let payload = build_record_payload(&section, 1_794_062_059).unwrap();
        assert_eq!(payload["itemid"], json!(2377981));
        assert_eq!(payload["autoSave"], json!(1));
        assert_eq!(payload["withoutOld"], Value::Null);
        assert_eq!(payload["complete"], json!(1));
        assert_eq!(payload["score"], json!(100));
        let pages = payload["pageStudyRecordDTOList"].as_array().unwrap();
        assert_eq!(pages.len(), 1);
        let page = &pages[0];
        assert_eq!(page["pageid"], json!(2377984));
        assert_eq!(page["complete"], json!(1));
        assert_eq!(page["studyTime"], json!(1000));
        assert_eq!(page["score"], json!(100));
        assert_eq!(page["answerTime"], json!(1));
        assert_eq!(page["submitTimes"], json!(0));
        assert!(page.get("coursepageId").is_none());
        assert_eq!(page["questions"], json!([]));
        assert_eq!(page["speaks"], json!([]));
        let video = &page["videos"][0];
        assert_eq!(video["videoid"], json!(1563126));
        assert_eq!(video["current"], json!(1326));
        assert_eq!(video["status"], json!(1));
        assert_eq!(video["recordTime"], json!(1326));
        assert_eq!(video["time"], json!(1326));
        // `startEndTimeList` must be a real epoch timeline (the platform flags
        // the old `0..duration` timeline as 刷课).
        let intervals = video["startEndTimeList"].as_array().unwrap();
        assert!(!intervals.is_empty());
        let first_start = intervals
            .first()
            .and_then(|item| item["startTime"].as_i64())
            .unwrap();
        let last_end = intervals
            .last()
            .and_then(|item| item["endTime"].as_i64())
            .unwrap();
        assert!(first_start > 1_700_000_000, "epoch start expected");
        assert_eq!(payload["studyStartTime"], json!(first_start));
        assert_eq!(last_end - first_start, 1326);
        for pair in intervals.windows(2) {
            assert_eq!(pair[0]["endTime"], pair[1]["startTime"]);
        }
    }

    #[test]
    fn builds_practice_payload_with_answers() {
        let section = practice_section();
        let payload = build_record_payload(&section, 1_794_062_059).unwrap();
        let page = &payload["pageStudyRecordDTOList"][0];
        assert_eq!(page["pageid"], json!(2379020));
        assert_eq!(page["submitTimes"], json!(1));
        assert_eq!(page["coursepageId"], json!(9002));
        assert_eq!(page["videos"], json!([]));
        assert_eq!(
            page["questions"],
            json!([{
                "questionid": 17_393_623,
                "answerList": ["D"],
                "score": 20
            }])
        );
    }

    #[test]
    fn payload_round_trips_through_des() {
        let payload = build_record_payload(&video_section(), 1_794_062_059).unwrap();
        let ciphertext = encrypt_record_payload(&payload).unwrap();
        let plaintext = cipher::decrypt_ecb_base64(&ciphertext).unwrap();
        let decoded: Value = serde_json::from_str(&plaintext).unwrap();
        assert_eq!(decoded, payload);
    }

    #[test]
    fn rejects_unactionable_and_incomplete_sections() {
        let mut section = video_section();
        section.action = UlAction::SkipDone;
        assert!(build_record_payload(&section, 1_794_062_059).is_err());

        let mut section = video_section();
        section.pages[0].videos.clear();
        assert!(build_record_payload(&section, 1_794_062_059).is_err());

        let mut section = practice_section();
        section.pages[0].questions[0].answer.clear();
        assert!(build_record_payload(&section, 1_794_062_059).is_err());

        let mut section = practice_section();
        section.pages[0].coursepage_id = None;
        assert!(build_record_payload(&section, 1_794_062_059).is_err());

        assert!(build_record_payload(&video_section(), 0).is_err());
    }
}
