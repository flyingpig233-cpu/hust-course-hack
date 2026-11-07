//! Document (PDF) task-point completion.
//!
//! The platform's H5 card page exposes one `jtoken` per attachment inside
//! `window.AttachmentSetting`, and `/mooc-ans/job/document` marks a document
//! 任务点 as read. This is the request the platform PDF viewer's `finishJob()`
//! sends; calling it directly lets the CLI, desktop GUI and the static website
//! finish documents without opening a webview.
//!
//! The contract is the one implemented by the official Chaoxing client 7.0.2
//! (ported in `flutter_chaoxing` 0.4.2 as `fetchDocumentJobs` /
//! `reportDocumentRead`). Live-verified on 2026-11-07 against the HUST
//! deployment: `/mooc-ans/phone/wxcard` returned the attachment `jtoken` and
//! all 49 document task points of 大学英语词汇解析(一) reported `status: true`.

use crate::models::{Chapter, CourseDetail, TaskKind, TaskPoint};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

/// One document task point that can be reported as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentTarget {
    pub course_id: String,
    pub class_id: String,
    pub cpi: String,
    /// Knowledge point id (`chapterId`).
    pub knowledge_id: String,
    pub knowledge_title: String,
    /// Card id; the `wxcard` endpoint needs it to return the attachment list.
    pub card_id: String,
    pub job_id: String,
    pub object_id: Option<String>,
    pub name: String,
}

impl DocumentTarget {
    /// Label used by CLI/GUI progress output.
    pub fn label(&self) -> String {
        if self.knowledge_title.is_empty() {
            self.name.clone()
        } else {
            format!("{} / {}", self.knowledge_title, self.name)
        }
    }
}

/// Result of one accepted document report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReport {
    pub job_id: String,
    pub name: String,
    /// Always `true` for a returned report; rejected reports are errors.
    pub accepted: bool,
    pub message: Option<String>,
}

/// Collect every document task point of a crawled course.
///
/// Documents whose `completed` flag is `Some(true)` are skipped unless
/// `include_completed` is set. The platform normally returns `null` for
/// document completion, so most documents are included.
pub fn collect_document_targets(
    detail: &CourseDetail,
    include_completed: bool,
) -> Vec<DocumentTarget> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    collect_from_chapters(
        &detail.chapters,
        detail,
        include_completed,
        &mut seen,
        &mut out,
    );
    out
}

fn collect_from_chapters(
    chapters: &[Chapter],
    detail: &CourseDetail,
    include_completed: bool,
    seen: &mut HashSet<(String, String)>,
    out: &mut Vec<DocumentTarget>,
) {
    for chapter in chapters {
        for card in &chapter.cards {
            for point in &card.task_points {
                if point.kind != TaskKind::Document {
                    continue;
                }
                if !include_completed && point.completed == Some(true) {
                    continue;
                }
                let Some(target) = target_from_point(detail, chapter, card.card_id.clone(), point)
                else {
                    continue;
                };
                // The same document can appear in more than one card payload.
                if !seen.insert((target.knowledge_id.clone(), target.job_id.clone())) {
                    continue;
                }
                out.push(target);
            }
        }
        collect_from_chapters(&chapter.children, detail, include_completed, seen, out);
    }
}

fn target_from_point(
    detail: &CourseDetail,
    chapter: &Chapter,
    card_id: Option<String>,
    point: &TaskPoint,
) -> Option<DocumentTarget> {
    let job_id = point.job_id.clone().filter(|id| !id.is_empty())?;
    let card_id = card_id.filter(|id| !id.is_empty())?;
    Some(DocumentTarget {
        course_id: detail.course.course_id.clone(),
        class_id: detail.course.class_id.clone(),
        cpi: detail.course.cpi.clone(),
        knowledge_id: chapter.id.clone(),
        knowledge_title: chapter.title.clone(),
        card_id,
        job_id,
        object_id: point.object_id.clone().filter(|id| !id.is_empty()),
        name: point.name.clone(),
    })
}

/// Extract the `window.AttachmentSetting = {...};` object from a `wxcard`
/// response. A response that is already a JSON object with `attachments` is
/// accepted as well.
pub fn parse_attachment_setting(html: &str) -> Option<Value> {
    let trimmed = html.trim_start();
    if trimmed.starts_with('{')
        && let Ok(value) = serde_json::from_str::<Value>(trimmed)
        && value.get("attachments").is_some()
    {
        return Some(value);
    }

    for marker in ["window.AttachmentSetting", "AttachmentSetting"] {
        for (index, _) in html.match_indices(marker) {
            let rest = &html[index + marker.len()..];
            let Some(eq) = rest.find('=') else {
                continue;
            };
            let after_eq = &rest[eq + 1..];
            let Some(brace) = after_eq.find('{') else {
                continue;
            };
            let json = &after_eq[brace..];
            let mut stream = serde_json::Deserializer::from_str(json).into_iter::<Value>();
            if let Some(Ok(value)) = stream.next()
                && value.get("attachments").is_some()
            {
                return Some(value);
            }
        }
    }
    None
}

/// Resolve the `jtoken` of one attachment. Matching is by `jobid` first, with
/// `property.objectid` as the fallback.
pub fn attachment_jtoken(setting: &Value, job_id: &str, object_id: Option<&str>) -> Option<String> {
    let attachments = setting.get("attachments")?.as_array()?;
    let mut fallback = None;
    for attachment in attachments {
        let attachment_job = value_text(attachment.get("jobid"));
        let attachment_object = value_text(
            attachment
                .get("property")
                .and_then(|property| property.get("objectid")),
        );
        let matches_job = attachment_job.as_deref() == Some(job_id);
        let matches_object =
            matches!(object_id, Some(id) if attachment_object.as_deref() == Some(id));
        if matches_job {
            if let Some(token) = value_text(attachment.get("jtoken")) {
                return Some(token);
            }
        } else if matches_object && fallback.is_none() {
            fallback = value_text(attachment.get("jtoken"));
        }
    }
    fallback
}

fn value_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Parse the JSON reply of `/mooc-ans/job/document`. Returns `Ok(())` only for
/// an explicit `status: true`; otherwise the platform message is surfaced.
pub fn parse_document_report(body: &str) -> Result<()> {
    let value: Value = serde_json::from_str(body.trim())
        .with_context(|| format!("document report returned non-JSON: {}", snippet(body)))?;
    let status = value.get("status");
    let accepted = status.and_then(Value::as_bool).unwrap_or(false)
        || status
            .and_then(Value::as_str)
            .is_some_and(|text| text == "true");
    if accepted {
        return Ok(());
    }
    let message = ["msg", "message", "errorMsg", "error"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or("status != true");
    bail!("platform rejected the document report: {message}");
}

fn snippet(body: &str) -> String {
    body.chars().take(160).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CourseDetail;

    const SETTING_HTML: &str = r#"
<html><script>
  window.AttachmentSetting = {"attachments":[
    {"type":"document","jobid":"1725539880620813","jtoken":"tok-1",
     "property":{"objectid":"obj-1","name":"a.pdf"}},
    {"type":"video","jobid":"v1","jtoken":"tok-v"},
    {"type":"document","jobid":42,"jtoken":"tok-2","property":{"objectid":"obj-2"}}
  ]};
</script></html>"#;

    #[test]
    fn parses_attachment_setting_from_script() {
        let setting = parse_attachment_setting(SETTING_HTML).expect("setting must parse");
        assert_eq!(setting["attachments"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn resolves_jtoken_by_job_id_and_object_id() {
        let setting = parse_attachment_setting(SETTING_HTML).unwrap();
        assert_eq!(
            attachment_jtoken(&setting, "1725539880620813", None).as_deref(),
            Some("tok-1")
        );
        assert_eq!(
            attachment_jtoken(&setting, "missing", Some("obj-2")).as_deref(),
            Some("tok-2")
        );
        assert_eq!(attachment_jtoken(&setting, "missing", None), None);
    }

    #[test]
    fn accepts_plain_json_wxcard_body() {
        let setting = parse_attachment_setting(r#"{"attachments":[{"jobid":"j1","jtoken":"t1"}]}"#)
            .expect("plain json must parse");
        assert_eq!(
            attachment_jtoken(&setting, "j1", None).as_deref(),
            Some("t1")
        );
    }

    #[test]
    fn judges_report_status() {
        parse_document_report(r#"{"status":true}"#).unwrap();
        parse_document_report(r#"{"status":"true"}"#).unwrap();
        let error = parse_document_report(r#"{"status":false,"msg":"no job"}"#).unwrap_err();
        assert!(error.to_string().contains("no job"));
        assert!(parse_document_report("<html>login</html>").is_err());
    }

    #[test]
    fn collects_documents_from_english_course_fixture() {
        #[derive(serde::Deserialize)]
        struct Dump {
            courses: Vec<Course>,
        }
        #[derive(serde::Deserialize)]
        struct Course {
            course_id: String,
            chapters: Vec<Chapter>,
        }

        let dump: Dump = serde_json::from_str(include_str!("../test-data/courses.json")).unwrap();
        let course = &dump.courses[0];
        let expected = count_document_points(&course.chapters);
        assert_eq!(expected, 49);
        let detail = CourseDetail {
            course: crate::models::CourseSummary {
                course_id: course.course_id.clone(),
                class_id: "17310000023403".to_string(),
                cpi: "17310000196268".to_string(),
                name: "大学英语词汇解析(一)".to_string(),
                cover_url: None,
                source: None,
                kc_enc: None,
                ck_enc: None,
                clazz_enc: None,
                detail_url: String::new(),
            },
            title: "大学英语词汇解析(一)".to_string(),
            enc: None,
            old_enc: None,
            openc: None,
            final_url: String::new(),
            chapters: course.chapters.clone(),
            stats: Default::default(),
        };
        let targets = collect_document_targets(&detail, false);
        assert_eq!(targets.len(), expected);
        assert!(targets.iter().all(|target| !target.job_id.is_empty()));
        assert!(targets.iter().all(|target| !target.card_id.is_empty()));
        assert!(targets.iter().all(|target| !target.knowledge_id.is_empty()));
        assert!(
            targets
                .iter()
                .filter(|target| target.name.ends_with(".pdf"))
                .count()
                == targets.len()
        );
    }

    fn count_document_points(chapters: &[Chapter]) -> usize {
        chapters
            .iter()
            .map(|chapter| {
                chapter
                    .cards
                    .iter()
                    .flat_map(|card| card.task_points.iter())
                    .filter(|point| point.kind == TaskKind::Document)
                    .count()
                    + count_document_points(&chapter.children)
            })
            .sum()
    }
}
