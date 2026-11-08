//! Pure parsers for the Ulearning student API responses.
//!
//! The response shapes below were recovered from the public player bundle
//! (`ua.ulearning.cn/learnCourse/js/model/{Course,Chapter,Section,Page,PageElement}.js`)
//! and cross-checked against `docs/ulearning/web-analysis.md`:
//!
//! * directory: `chapters[]` with `nodeid` / `nodetitle` / `id` / `items[]`,
//!   sections with `itemid` / `title` / `coursepages[]`, pages with
//!   `id` / `relationid` / `title` / `contentType`;
//! * section pages: `{itemid, wholepageDTOList[]}` (also tolerates a bare array);
//! * page content: `coursepageDTOList[]` with `type` / `resourceid` /
//!   `videoLength` / `questionDTOList[]`;
//! * section record: `completion_status` / `version` / `studyTime`.
//!
//! The parsers accept the field aliases observed in different builds; unknown
//! elements make the section "unsupported" instead of being guessed.

use anyhow::{Context, Result};
use serde_json::Value;

use super::models::{
    UlChapter, UlCourse, UlPage, UlPageContent, UlQuestion, UlSection, UlSectionRecord, UlUser,
    UlVideo,
};

/// First present key holding an id (number or numeric string).
fn as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().map(|n| n as i64))
            .or_else(|| number.as_f64().map(|f| f as i64)),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn get_i64(item: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(as_i64)
}

fn get_str(item: &Value, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(|value| match value {
            Value::String(text) => Some(text.trim().to_string()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn get_array<'a>(item: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(Value::as_array)
}

/// Unwrap an optional `{"data": ...}` envelope.
fn payload(value: &Value) -> &Value {
    match value.get("data") {
        Some(inner) if inner.is_object() || inner.is_array() => inner,
        _ => value,
    }
}

/// Parse one page list item; returns `None` when the item has no page id.
fn parse_page(item: &Value) -> Option<UlPage> {
    let id = get_i64(item, &["id", "pageid", "pageId"])?;
    if id <= 0 {
        return None;
    }
    let relation_id = get_i64(item, &["relationid", "relationId", "relation_id"]).unwrap_or(id);
    let content_type = {
        let raw = get_i64(item, &["contentType", "contenttype", "content_type"]);
        match raw {
            Some(kind) if (5..=7).contains(&kind) => kind,
            _ => 5,
        }
    };
    Some(UlPage {
        id,
        relation_id,
        name: get_str(item, &["title", "name", "pageName"]),
        content_type,
    })
}

/// Parse the shared-course list (`GET /courseListStu`).
///
/// The exact list endpoint was not captured, so the parser accepts the common
/// envelopes and keeps only entries with an internal `textbookId`.
pub fn parse_course_list(value: &Value) -> Vec<UlCourse> {
    let mut items: &[Value] = &[];
    if let Some(array) = value.as_array() {
        items = array;
    } else {
        let data = payload(value);
        if let Some(array) = data.as_array() {
            items = array;
        } else if let Some(array) = get_array(data, &["courses", "courseList", "list", "rows"]) {
            items = array;
        } else if let Some(array) = get_array(
            value,
            &["courses", "courseList", "list", "rows", "courseListStu"],
        ) {
            items = array;
        }
    }

    items
        .iter()
        .filter_map(|item| {
            let oc_id = get_i64(item, &["ocId", "oc_id", "ocID"]);
            let mut textbook_id =
                get_i64(item, &["textbookId", "textbook_id", "bookId"]).unwrap_or_default();
            let mut oc_id = oc_id;
            // Older list payloads reuse `courseId`: with an explicit `ocId` it is
            // the internal id, otherwise it is the external course id.
            if textbook_id == 0
                && let Some(course_id) = get_i64(item, &["courseId", "courseid"])
            {
                if oc_id.is_some() {
                    textbook_id = course_id;
                } else {
                    oc_id = Some(course_id);
                }
            }
            if textbook_id == 0 {
                // Last resort: a bare `id` is the internal textbook id.
                textbook_id = get_i64(item, &["id"])?;
            }
            Some(UlCourse {
                oc_id,
                textbook_id,
                class_id: get_i64(item, &["classId", "classid", "class_id"]),
                name: get_str(item, &["courseName", "name", "title", "textbookName"]),
                author: Some(get_str(item, &["author", "teacherName", "teacher"]))
                    .filter(|text| !text.is_empty()),
                remaining_secs: get_i64(item, &["remaining", "remainingTime", "time"]),
            })
        })
        .collect()
}

/// Parse `GET /course/{id}/basicinformation` into `(name, author)`.
pub fn parse_basic_information(value: &Value) -> (Option<String>, Option<String>) {
    let root = value
        .get("course")
        .filter(|inner| inner.is_object())
        .unwrap_or(value);
    let name = get_str(root, &["name", "courseName"]);
    let author = get_str(root, &["author", "teacherName", "createUserName"]);
    (
        (!name.is_empty()).then_some(name),
        (!author.is_empty()).then_some(author),
    )
}

/// Parse `GET /course/{id}/remaining`; negative means expired.
pub fn parse_remaining(value: &Value) -> Option<i64> {
    if let Some(number) = as_i64(value) {
        return Some(number);
    }
    let root = payload(value);
    get_i64(root, &["time", "remaining", "remainingTime", "seconds"])
}

/// Parse the class name from `GET /classes/{id}?classId=`.
pub fn parse_class_name(value: &Value) -> Option<String> {
    let root = payload(value);
    let name = if let Some(items) = root.as_array() {
        items
            .iter()
            .map(|item| get_str(item, &["name", "className", "classname"]))
            .find(|text| !text.is_empty())
            .unwrap_or_default()
    } else {
        get_str(root, &["name", "className", "classname"])
    };
    (!name.is_empty()).then_some(name)
}

/// Parse the chapter tree from `GET /course/stu/{textbookId}/directory`.
pub fn parse_directory(value: &Value) -> Result<Vec<UlChapter>> {
    let root = payload(value);
    let chapters: &Vec<Value> = root
        .get("chapters")
        .and_then(Value::as_array)
        .or_else(|| root.as_array())
        .or_else(|| get_array(root, &["chapterList", "items"]))
        .context("directory response is missing chapters")?;

    let mut out = Vec::with_capacity(chapters.len());
    for chapter in chapters {
        let id = get_i64(chapter, &["nodeid", "id", "chapterId"]).unwrap_or_default();
        let id_for_class = get_i64(chapter, &["id"]);
        let sections = get_array(chapter, &["items", "sections", "sectionList", "children"])
            .map(|items| parse_sections(items))
            .unwrap_or_default();
        out.push(UlChapter {
            id,
            id_for_class,
            name: get_str(chapter, &["nodetitle", "title", "name", "chapterName"]),
            hide: get_i64(chapter, &["hide", "isHide"]),
            sections,
        });
    }
    Ok(out)
}

fn parse_sections(items: &[Value]) -> Vec<UlSection> {
    items
        .iter()
        .map(|section| UlSection {
            id: get_i64(section, &["itemid", "id", "sectionId"]).unwrap_or_default(),
            name: get_str(section, &["title", "name", "sectionName"]),
            id_for_class: get_i64(section, &["id", "idForClass", "chapterIdForClass"]),
            hide: get_i64(section, &["hide", "ishidepreview", "isHide"]),
            pages: get_array(section, &["coursepages", "pages", "pageList"])
                .map(|pages| pages.iter().filter_map(parse_page).collect())
                .unwrap_or_default(),
        })
        .collect()
}

/// Parse `GET /wholepage/item/stu/{sectionId}` into the section page list.
///
/// The endpoint returns `{itemid, wholepageDTOList:[...]}` on the current build;
/// a bare array (older build) is also accepted.
pub fn parse_section_pages(value: &Value) -> Result<Vec<UlPage>> {
    let root = payload(value);
    let pages: &Vec<Value> = root
        .as_array()
        .or_else(|| get_array(root, &["wholepageDTOList", "pageList", "pages", "list"]))
        .or_else(|| {
            root.get("wholepageItemDTOList")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| get_array(item, &["wholepageDTOList", "pageList", "pages"]))
        })
        .context("section page response is missing wholepageDTOList")?;
    Ok(pages.iter().filter_map(parse_page).collect())
}

/// Element types this module knows how to complete safely.
///
/// 1 title, 2 text, 3 image, 4 video, 6 practice, 8 html, 10 document,
/// 11 big page, 12 composite page. Everything else (audio/discussion/flash/
/// role-play/oral/knowledge-point) makes the section unsupported.
const SUPPORTED_ELEMENTS: [i64; 9] = [1, 2, 3, 4, 6, 8, 10, 11, 12];

/// Parse `GET /wholepage/stu/{pageId}` into a typed page content.
pub fn parse_page_content(value: &Value) -> Result<UlPageContent> {
    let root = payload(value);
    let mut content = UlPageContent {
        page_id: get_i64(root, &["id", "pageid", "pageId"]),
        relation_id: get_i64(root, &["relationid", "relationId", "relation_id"]),
        content_type: get_i64(root, &["contentType", "contenttype", "content_type"])
            .filter(|kind| (5..=7).contains(kind))
            .unwrap_or_default(),
        ..UlPageContent::default()
    };

    let elements: Vec<&Value> =
        match get_array(root, &["coursepageDTOList", "elements", "elementList"]) {
            Some(items) => items.iter().collect(),
            None => {
                // Some builds return the element object directly for a single element.
                if root.get("type").is_some() {
                    vec![root]
                } else {
                    Vec::new()
                }
            }
        };

    for element in elements {
        let element_type = get_i64(element, &["type", "elementType", "elementtype"]).unwrap_or(0);
        let element_id = get_i64(element, &["coursepageDTOid", "id", "elementId"]);
        match element_type {
            4 => {
                let resource_id = get_i64(
                    element,
                    &[
                        "resourceid",
                        "resourceId",
                        "videoId",
                        "videoid",
                        "resource_id",
                    ],
                );
                let duration = get_i64(
                    element,
                    &[
                        "videoLength",
                        "videoDuration",
                        "duration",
                        "resourceDuration",
                        "timeLength",
                        "seconds",
                    ],
                )
                .or_else(|| {
                    get_array(element, &["resourceDTOList", "resources"]).and_then(|resources| {
                        resources.iter().find_map(|resource| {
                            get_i64(
                                resource,
                                &["duration", "videoLength", "length", "timeLength"],
                            )
                        })
                    })
                })
                .unwrap_or_default();
                if let Some(video_id) = resource_id.filter(|id| *id > 0) {
                    content.videos.push(UlVideo {
                        video_id,
                        duration_secs: duration,
                    });
                }
            }
            6 => {
                if element_id.is_some() {
                    content.coursepage_id = element_id;
                }
                if let Some(questions) =
                    get_array(element, &["questionDTOList", "questions", "questionList"])
                {
                    content.questions.extend(parse_questions(questions));
                }
            }
            _ => {}
        }
        if !SUPPORTED_ELEMENTS.contains(&element_type) {
            content.has_unsupported_element = true;
        }
    }

    // Some payloads expose the questions at page level instead of element level.
    if content.questions.is_empty()
        && let Some(questions) = get_array(root, &["questionDTOList", "questions", "questionList"])
    {
        content.questions.extend(parse_questions(questions));
    }
    Ok(content)
}

fn parse_questions(items: &[Value]) -> Vec<UlQuestion> {
    items
        .iter()
        .filter_map(|question| {
            let question_id = get_i64(question, &["questionid", "questionId", "id"])?;
            Some(UlQuestion {
                question_id,
                score: get_i64(question, &["score", "questionScore", "fullScore"]).unwrap_or(0),
                kind: get_i64(question, &["type", "questionType"]).unwrap_or(0),
                title: get_str(question, &["title", "name", "stem", "content"]),
            })
        })
        .collect()
}

/// Parse `GET /studyrecord/item/{sectionId}?courseType=4`.
pub fn parse_section_record(value: &Value) -> UlSectionRecord {
    if value.is_null() || value.as_array().is_some_and(Vec::is_empty) {
        return UlSectionRecord::default();
    }
    let root = payload(value);
    UlSectionRecord {
        completion_status: get_i64(
            root,
            &[
                "completion_status",
                "completionStatus",
                "complete",
                "status",
            ],
        )
        .unwrap_or(0),
        version: get_i64(root, &["version"]),
        study_time: get_i64(root, &["studyTime", "study_time", "sectionStudyTime"]),
    }
}

/// Parse `GET /studyrecord/initialize/{sectionId}` (a Unix timestamp).
pub fn parse_initialize(value: &Value) -> Option<i64> {
    if let Some(number) = as_i64(value) {
        return Some(number);
    }
    let root = payload(value);
    get_i64(
        root,
        &["studyStartTime", "study_start_time", "startTime", "time"],
    )
}

/// Parse `GET /questionAnswer/{questionId}?parentId={pageId}` into answer letters.
pub fn parse_question_answer(value: &Value) -> Vec<String> {
    let root = payload(value);
    if let Some(items) = get_array(
        root,
        &[
            "correctAnswerList",
            "correct_answer_list",
            "answerList",
            "correctAnswer",
        ],
    ) {
        return items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.trim().to_string()),
                Value::Number(number) => Some(number.to_string()),
                Value::Bool(flag) => Some(flag.to_string()),
                _ => None,
            })
            .filter(|text| !text.is_empty())
            .collect();
    }
    // Judge questions use `correctreply` ("true"/"false"); single choices may
    // also be returned as a plain letter.
    let reply = get_str(root, &["correctreply", "correctReply"]);
    if reply.is_empty() {
        return Vec::new();
    }
    if reply.starts_with('[')
        && let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&reply)
    {
        return items
            .iter()
            .filter_map(Value::as_str)
            .map(|text| text.trim().to_string())
            .collect();
    }
    let lower = reply.to_ascii_lowercase();
    if lower == "true" || lower == "false" {
        vec![lower]
    } else {
        vec![reply]
    }
}

/// Parse `GET /user`.
pub fn parse_user(value: &Value) -> UlUser {
    let root = payload(value);
    UlUser {
        user_id: get_i64(root, &["userid", "userId", "id"]).unwrap_or_default(),
        name: get_str(root, &["name", "username", "userName"]),
        org_id: get_i64(root, &["orgid", "orgId", "org_id"]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_directory_tree() {
        let value = json!({
            "chapters": [{
                "nodeid": 141351390,
                "nodetitle": "第一讲 导论",
                "id": 141351391,
                "hide": 0,
                "items": [{
                    "itemid": 2377981,
                    "title": "习近平新时代中国特色社会主义思想的产生背景",
                    "id": 2377982,
                    "hide": 0,
                    "coursepages": [{
                        "id": 2377983,
                        "relationid": 2377984,
                        "title": "第一节视频",
                        "contentType": 6
                    }, {
                        "id": 2377985,
                        "relationid": 2377986,
                        "title": "章节练习",
                        "contentType": 7
                    }]
                }]
            }]
        });
        let chapters = parse_directory(&value).unwrap();
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].id, 141351390);
        assert_eq!(chapters[0].id_for_class, Some(141351391));
        assert_eq!(chapters[0].name, "第一讲 导论");
        assert_eq!(chapters[0].sections.len(), 1);
        let section = &chapters[0].sections[0];
        assert_eq!(section.id, 2377981);
        assert_eq!(section.name, "习近平新时代中国特色社会主义思想的产生背景");
        assert_eq!(section.pages.len(), 2);
        assert_eq!(section.pages[0].id, 2377983);
        assert_eq!(section.pages[0].relation_id, 2377984);
        assert!(section.pages[0].is_video());
        assert!(section.pages[1].is_practice());
    }

    #[test]
    fn parses_directory_error_when_empty() {
        assert!(parse_directory(&json!({})).is_err());
        assert!(parse_directory(&json!([])).is_ok());
    }

    #[test]
    fn parses_section_pages_object_and_array() {
        let object = json!({
            "itemid": 2377981,
            "wholepageDTOList": [{
                "id": 2377983,
                "relationid": 2377984,
                "title": "视频页",
                "contentType": 6
            }]
        });
        let pages = parse_section_pages(&object).unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].relation_id, 2377984);

        let array = json!([{
            "id": 1,
            "relationid": 2,
            "title": "页",
            "contentType": 5
        }]);
        assert_eq!(parse_section_pages(&array).unwrap().len(), 1);
        assert!(parse_section_pages(&json!({})).is_err());
    }

    #[test]
    fn parses_video_page_content() {
        let value = json!({
            "id": 2377983,
            "relationid": 2377984,
            "contentType": 6,
            "coursepageDTOList": [{
                "coursepageDTOid": 9001,
                "type": 4,
                "resourceid": 1563126,
                "videoLength": 1326
            }]
        });
        let content = parse_page_content(&value).unwrap();
        assert_eq!(content.content_type, 6);
        assert_eq!(content.page_id, Some(2377983));
        assert_eq!(content.relation_id, Some(2377984));
        assert_eq!(content.videos.len(), 1);
        assert_eq!(content.videos[0].video_id, 1563126);
        assert_eq!(content.videos[0].duration_secs, 1326);
        assert!(!content.has_unsupported_element);
        assert!(!content.has_practice());
    }

    #[test]
    fn parses_practice_page_content() {
        let value = json!({
            "contentType": 7,
            "coursepageDTOList": [{
                "coursepageDTOid": 9002,
                "type": 6,
                "questionDTOList": [{
                    "questionid": 17393623,
                    "score": 20,
                    "type": 1,
                    "title": "题干一",
                    "choiceitemModels": [
                        {"choiceitemid": 1, "title": "A"},
                        {"choiceitemid": 2, "title": "B"}
                    ]
                }, {
                    "questionid": 17393624,
                    "score": 20,
                    "type": 1,
                    "title": "题干二"
                }]
            }]
        });
        let content = parse_page_content(&value).unwrap();
        assert_eq!(content.content_type, 7);
        assert!(content.has_practice());
        assert_eq!(content.coursepage_id, Some(9002));
        assert_eq!(content.questions.len(), 2);
        assert_eq!(content.questions[0].question_id, 17393623);
        assert_eq!(content.questions[0].score, 20);
        assert_eq!(content.questions[0].kind, 1);
        assert_eq!(content.questions[1].title, "题干二");
        assert!(!content.has_unsupported_element);
    }

    #[test]
    fn flags_unsupported_elements() {
        let value = json!({
            "coursepageDTOList": [{
                "type": 16,
                "id": 1
            }]
        });
        assert!(parse_page_content(&value).unwrap().has_unsupported_element);
        assert!(
            !parse_page_content(&json!({}))
                .unwrap()
                .has_unsupported_element
        );
    }

    #[test]
    fn parses_document_page_without_elements() {
        let content = parse_page_content(&json!({"contentType": 5})).unwrap();
        assert_eq!(content.content_type, 5);
        assert!(content.videos.is_empty());
        assert!(!content.has_unsupported_element);
    }

    #[test]
    fn parses_section_record_and_initialize() {
        let record = parse_section_record(&json!({
            "completion_status": 1,
            "version": 12,
            "studyTime": 1008
        }));
        assert!(record.completed());
        assert_eq!(record.version, Some(12));
        assert_eq!(record.study_time, Some(1008));

        assert!(!parse_section_record(&json!([])).completed());
        assert_eq!(parse_initialize(&json!(1794062059)), Some(1794062059));
        assert_eq!(parse_initialize(&json!({"studyStartTime": 42})), Some(42));
    }

    #[test]
    fn parses_question_answers() {
        assert_eq!(
            parse_question_answer(&json!({"questionid": 1, "correctAnswerList": ["D"]})),
            vec!["D".to_string()]
        );
        assert_eq!(
            parse_question_answer(&json!({"correctreply": "true"})),
            vec!["true".to_string()]
        );
        assert_eq!(
            parse_question_answer(&json!({"correctreply": "[\"A\",\"C\"]"})),
            vec!["A".to_string(), "C".to_string()]
        );
        assert!(parse_question_answer(&json!({})).is_empty());
    }

    #[test]
    fn parses_course_metadata() {
        assert_eq!(
            parse_basic_information(&json!({"course": {"name": "概论", "author": "王老师"}})),
            (Some("概论".to_string()), Some("王老师".to_string()))
        );
        assert_eq!(parse_remaining(&json!(3600)), Some(3600));
        assert_eq!(parse_remaining(&json!({"time": -1})), Some(-1));
        assert_eq!(
            parse_class_name(&json!([{"name": "2026秋1班"}])),
            Some("2026秋1班".to_string())
        );
    }

    #[test]
    fn parses_course_list_shapes() {
        let value = json!({
            "data": [{
                "textbookId": 47353,
                "ocId": 165508,
                "classId": 1019700,
                "courseName": "习近平新时代中国特色社会主义思想概论",
                "author": "王老师"
            }]
        });
        let courses = parse_course_list(&value);
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].textbook_id, 47353);
        assert_eq!(courses[0].oc_id, Some(165508));
        assert_eq!(courses[0].class_id, Some(1019700));
        assert_eq!(courses[0].name, "习近平新时代中国特色社会主义思想概论");
        // Entries without an internal textbook id are dropped.
        assert!(parse_course_list(&json!([{"courseId": 165508}])).is_empty());
    }
}
