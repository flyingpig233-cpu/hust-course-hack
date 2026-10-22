//! HTML/JSON parsers for the SmartCourse pages.
//!
//! The platform is a Chaoxing deployment, so several pages are server-rendered
//! HTML with inline JavaScript. These parsers deliberately depend only on the
//! stable class names and inline `mArg` payload we verified against the live
//! site, not on page layout details.

use crate::models::*;
use anyhow::{Context, Result, bail};
use scraper::{ElementRef, Html, Selector};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use url::Url;

fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("static CSS selector must be valid")
}

fn attr(el: &ElementRef<'_>, name: &str) -> Option<String> {
    el.value()
        .attr(name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn text(el: &ElementRef<'_>) -> String {
    clean_text(&el.text().collect::<String>())
}

fn text_of_first(el: &ElementRef<'_>, css: &str) -> Option<String> {
    el.select(&selector(css)).next().map(|node| text(&node))
}

fn attr_of_first(el: &ElementRef<'_>, css: &str, name: &str) -> Option<String> {
    el.select(&selector(css))
        .next()
        .and_then(|node| attr(&node, name))
}

fn has_class(el: &ElementRef<'_>, class: &str) -> bool {
    el.value().classes().any(|c| c == class)
}

fn clean_text(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn hidden_value(doc: &Html, id: &str) -> Option<String> {
    doc.select(&selector(&format!("#{id}")))
        .next()
        .and_then(|el| attr(&el, "value"))
}

pub(crate) fn as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|v| u64::try_from(v).ok()))
        .or_else(|| value.as_str().and_then(|v| v.trim().parse().ok()))
}

fn value_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|v| v.to_string()))
        .or_else(|| value.as_i64().map(|v| v.to_string()))
}

// ---------------------------------------------------------------------------
// Course list
// ---------------------------------------------------------------------------

/// Parse `getStudyCourse` HTML into course summaries.
pub fn parse_course_list(html: &str, base: &Url) -> Result<Vec<CourseSummary>> {
    let doc = Html::parse_document(html);
    let items = selector("li.w_couritem");
    let mut courses = Vec::new();

    for item in doc.select(&items) {
        let Some(course_id) = attr(&item, "cid").or_else(|| attr(&item, "courseid")) else {
            continue;
        };
        let name = attr(&item, "cname")
            .or_else(|| attr_of_first(&item, "h3 a", "title"))
            .or_else(|| text_of_first(&item, "h3"))
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }

        let href =
            attr_of_first(&item, "a[href*='opencoursenewfy']", "href").unwrap_or_else(|| {
                format!(
                    "/fyportal-smartcourse/courselist/opencoursenewfy?role=3&courseId={course_id}"
                )
            });
        let detail_url = base
            .join(&href)
            .with_context(|| format!("invalid course URL `{href}`"))?
            .to_string();

        courses.push(CourseSummary {
            course_id,
            class_id: attr(&item, "classid").unwrap_or_default(),
            cpi: attr(&item, "personId")
                .or_else(|| attr(&item, "personid"))
                .unwrap_or_default(),
            name,
            cover_url: attr_of_first(&item, "img", "src"),
            source: attr(&item, "source"),
            kc_enc: attr(&item, "kcenc"),
            ck_enc: attr(&item, "ckenc"),
            clazz_enc: attr(&item, "clazzenc"),
            detail_url,
        });
    }

    if courses.is_empty() && looks_logged_out(html) {
        bail!(
            "the course list came back empty and the page looks like a login page; cookies may have expired"
        );
    }

    Ok(courses)
}

fn looks_logged_out(html: &str) -> bool {
    html.contains("passport")
        || html.contains("用户登录")
        || html.contains("请先登录")
        || html.contains("login")
}

// ---------------------------------------------------------------------------
// Course home page
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CoursePageInfo {
    pub title: String,
    pub enc: Option<String>,
    pub old_enc: Option<String>,
    pub openc: Option<String>,
    /// Ids echoed by the course page, used as a fallback if the list page
    /// omitted an attribute.
    pub course_id: Option<String>,
    pub class_id: Option<String>,
    pub cpi: Option<String>,
}

/// Parse the page reached after the `opencoursenewfy` redirect.
pub fn parse_course_page(html: &str) -> Result<CoursePageInfo> {
    let doc = Html::parse_document(html);
    let title = doc
        .select(&selector("title"))
        .next()
        .map(|el| text(&el))
        .unwrap_or_default();
    Ok(CoursePageInfo {
        title,
        enc: hidden_value(&doc, "enc"),
        old_enc: hidden_value(&doc, "oldenc"),
        openc: hidden_value(&doc, "openc"),
        course_id: hidden_value(&doc, "courseid"),
        class_id: hidden_value(&doc, "clazzid"),
        cpi: hidden_value(&doc, "cpi"),
    })
}

// ---------------------------------------------------------------------------
// Chapter tree
// ---------------------------------------------------------------------------

/// Parse `studentstudycourselist` HTML into the chapter tree.
pub fn parse_chapter_tree(html: &str) -> Result<Vec<Chapter>> {
    let doc = Html::parse_document(html);
    let root = doc
        .select(&selector("ul"))
        .find(|ul| {
            ul.select(&selector("div.posCatalog_select"))
                .next()
                .is_some()
        })
        .or_else(|| doc.select(&selector("ul")).next())
        .context("chapter tree has no <ul>")?;

    let mut chapters = Vec::new();
    for li in root
        .children()
        .filter_map(ElementRef::wrap)
        .filter(|c| c.value().name() == "li")
    {
        if let Some(chapter) = parse_tree_node(li, 1) {
            chapters.push(chapter);
        }
    }
    Ok(chapters)
}

fn parse_tree_node(li: ElementRef<'_>, level: u32) -> Option<Chapter> {
    let div = li
        .children()
        .filter_map(ElementRef::wrap)
        .find(|c| c.value().name() == "div" && has_class(c, "posCatalog_select"))?;

    let raw_id = div.value().attr("id")?.trim();
    let is_leaf = raw_id.starts_with("cur");
    let id = raw_id.strip_prefix("cur").unwrap_or(raw_id).to_string();
    if id.is_empty() {
        return None;
    }

    let title_el = div
        .select(&selector("span.posCatalog_name, span.posCatalog_title"))
        .next();
    let title = title_el
        .and_then(|el| attr(&el, "title"))
        .or_else(|| title_el.map(|el| text(&el)))
        .unwrap_or_default();

    let number = div
        .select(&selector("em.posCatalog_sbar"))
        .next()
        .map(|el| text(&el))
        .filter(|n| !n.is_empty());

    let completed = if div
        .select(&selector("span.icon_Completed"))
        .next()
        .is_some()
    {
        Some(true)
    } else if div
        .select(&selector("span.icon_Uncompleted"))
        .next()
        .is_some()
    {
        Some(false)
    } else {
        None
    };

    let children = li
        .children()
        .filter_map(ElementRef::wrap)
        .find(|c| has_class(c, "posCatalog_level"))
        .and_then(|level_div| level_div.select(&selector("ul")).next())
        .map(|ul| {
            ul.children()
                .filter_map(ElementRef::wrap)
                .filter(|c| c.value().name() == "li")
                .filter_map(|child| parse_tree_node(child, level + 1))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(Chapter {
        id,
        title,
        number,
        level,
        is_leaf,
        completed,
        children,
        cards: Vec::new(),
    })
}

/// All leaf knowledge points in document order.
pub fn leaf_ids(chapters: &[Chapter]) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(nodes: &[Chapter], out: &mut Vec<String>) {
        for node in nodes {
            if node.is_leaf {
                out.push(node.id.clone());
            }
            walk(&node.children, out);
        }
    }
    walk(chapters, &mut out);
    out
}

/// Attach fetched cards to the matching leaves.
pub fn attach_cards(chapters: &mut [Chapter], cards: &HashMap<String, Vec<Card>>) {
    for node in chapters {
        if node.is_leaf
            && let Some(found) = cards.get(&node.id)
        {
            node.cards = found.clone();
        }
        attach_cards(&mut node.children, cards);
    }
}

// ---------------------------------------------------------------------------
// Cards and task points
// ---------------------------------------------------------------------------

/// Parse the card tabs and card count from `studentstudyAjax` HTML.
pub fn parse_card_list(html: &str) -> Result<Vec<Card>> {
    let doc = Html::parse_document(html);
    let mut cards = Vec::new();

    for (index, li) in doc
        .select(&selector("#prev_tab ul.prev_ul li, ul.prev_ul li"))
        .enumerate()
    {
        cards.push(Card {
            index: index + 1,
            card_id: attr(&li, "cardid"),
            title: attr(&li, "title").unwrap_or_else(|| format!("card {}", index + 1)),
            task_points: Vec::new(),
            playback: None,
        });
    }

    if cards.is_empty() {
        let count = hidden_value(&doc, "cardcount")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1)
            .max(1);
        for index in 1..=count {
            cards.push(Card {
                index,
                card_id: None,
                title: format!("card {index}"),
                task_points: Vec::new(),
                playback: None,
            });
        }
    }

    Ok(cards)
}

/// Extract the inline `mArg = {...};` JSON object from a `knowledge/cards` page.
pub fn extract_marg(html: &str) -> Result<Value> {
    let marker = "mArg = ";
    let mut start = None;

    for (index, _) in html.match_indices(marker) {
        let rest = &html[index + marker.len()..];
        let trimmed = rest.trim_start();
        if trimmed.starts_with('{') {
            let offset = rest.len() - trimmed.len();
            start = Some(index + marker.len() + offset);
        }
    }

    let start = start.context("mArg assignment not found in cards page")?;
    let mut deserializer = serde_json::Deserializer::from_str(&html[start..]);
    Value::deserialize(&mut deserializer).context("mArg is not valid JSON")
}

#[derive(Debug, Clone)]
pub struct CardContent {
    pub task_points: Vec<TaskPoint>,
    pub defaults: Value,
    pub course_name: Option<String>,
    pub knowledge_name: Option<String>,
}

/// Parse the `attachments` array from an `mArg` payload.
pub fn parse_card_content(marg: &Value) -> CardContent {
    let attachments = marg
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    CardContent {
        task_points: attachments.iter().map(parse_task_point).collect(),
        defaults: marg.get("defaults").cloned().unwrap_or(Value::Null),
        course_name: marg
            .get("coursename")
            .and_then(Value::as_str)
            .map(str::to_string),
        knowledge_name: marg
            .get("knowledgename")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// Parse the playback fields the report endpoint needs from `mArg.defaults`.
pub fn parse_playback_env(defaults: &Value) -> Option<PlaybackEnv> {
    if !defaults.is_object() {
        return None;
    }

    let field = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| defaults.get(*key).and_then(value_string))
            .filter(|value| !value.is_empty())
    };

    Some(PlaybackEnv {
        user_id: field(&["userid", "userId"]),
        clazz_id: field(&["clazzId", "clazzid", "clazzID"]),
        course_id: field(&["courseid", "courseId"]),
        fid: field(&["fid"]),
        report_url: field(&["reportUrl", "reporturl"]),
        report_interval_secs: defaults
            .get("reportTimeInterval")
            .or_else(|| defaults.get("reportTimeinterval"))
            .and_then(as_u64),
        ktoken: field(&["ktoken"]),
    })
}

fn parse_task_point(attachment: &Value) -> TaskPoint {
    let property = attachment.get("property").unwrap_or(&Value::Null);
    let source_type = attachment
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let kind = match source_type.as_str() {
        "video" => TaskKind::Video,
        "document" => TaskKind::Document,
        "workid" | "work" => TaskKind::Work,
        "audio" | "insertaudio" => TaskKind::Audio,
        "insertlive" | "live" => TaskKind::Live,
        _ => TaskKind::Other,
    };

    let name = property
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| property.get("title").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();

    TaskPoint {
        kind,
        source_type,
        name,
        job_id: attachment
            .get("jobid")
            .and_then(Value::as_str)
            .or_else(|| property.get("jobid").and_then(Value::as_str))
            .map(str::to_string),
        object_id: attachment
            .get("objectId")
            .and_then(Value::as_str)
            .or_else(|| property.get("objectid").and_then(Value::as_str))
            .map(str::to_string),
        mid: attachment
            .get("mid")
            .and_then(Value::as_str)
            .or_else(|| property.get("mid").and_then(Value::as_str))
            .map(str::to_string),
        size_bytes: property.get("size").and_then(as_u64),
        content_ext: property
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string),
        completed: attachment.get("isPassed").and_then(Value::as_bool),
        played_ms: attachment.get("playTime").and_then(as_u64),
        duration_secs: attachment.get("attDuration").and_then(as_u64),
        work_id: property
            .get("workid")
            .and_then(Value::as_str)
            .map(str::to_string),
        work_type: property
            .get("worktype")
            .and_then(Value::as_str)
            .map(str::to_string),
        work_status: None,
        enc: attachment
            .get("enc")
            .and_then(Value::as_str)
            .map(str::to_string),
        other_info: attachment
            .get("otherInfo")
            .and_then(value_string)
            .or_else(|| property.get("otherInfo").and_then(value_string)),
        att_duration_enc: attachment
            .get("attDurationEnc")
            .and_then(value_string)
            .or_else(|| property.get("attDurationEnc").and_then(value_string)),
        rt: attachment
            .get("rt")
            .and_then(value_string)
            .or_else(|| property.get("rt").and_then(value_string)),
        video_face_capture_enc: attachment
            .get("videoFaceCaptureEnc")
            .and_then(value_string)
            .or_else(|| property.get("videoFaceCaptureEnc").and_then(value_string)),
        video: None,
        questions: Vec::new(),
        raw: attachment.clone(),
    }
}

// ---------------------------------------------------------------------------
// Video status
// ---------------------------------------------------------------------------

pub fn parse_video_info(json: &Value) -> VideoInfo {
    VideoInfo {
        duration_secs: json.get("duration").and_then(as_u64),
        size_bytes: json.get("length").and_then(as_u64),
        filename: json
            .get("filename")
            .and_then(Value::as_str)
            .map(str::to_string),
        dtoken: json
            .get("dtoken")
            .and_then(Value::as_str)
            .map(str::to_string),
        screenshot: json
            .get("screenshot")
            .and_then(Value::as_str)
            .map(str::to_string),
        thumbnails: json
            .get("thumbnails")
            .and_then(Value::as_str)
            .map(str::to_string),
        download_url: json
            .get("download")
            .and_then(Value::as_str)
            .map(str::to_string),
        stream_url: json.get("http").and_then(Value::as_str).map(str::to_string),
        hd_stream_url: json
            .get("httphd")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: json
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

// ---------------------------------------------------------------------------
// Work / exercise pages
// ---------------------------------------------------------------------------

/// Parse questions from a chapter quiz page.
///
/// Works for both the answering page and the "already graded" page; the latter
/// additionally exposes `correct_answer`.
pub fn parse_questions(html: &str) -> Vec<Question> {
    let doc = Html::parse_document(html);
    let mut questions: Vec<Question> = doc
        .select(&selector("div.TiMu"))
        .filter_map(|node| parse_question_node(&node))
        .collect();

    if questions.is_empty() {
        questions = doc
            .select(&selector("div.questionLi"))
            .filter_map(|node| parse_question_node(&node))
            .collect();
    }

    // A handful of work types render the same question twice (for example a
    // print-friendly block); keep the first occurrence of each id.
    let mut seen = std::collections::HashSet::new();
    questions.retain(|q| q.id.is_empty() || seen.insert(q.id.clone()));
    questions
}

/// Resolve the platform question id.
///
/// Some work pages put the id on the `TiMu` element itself, others wrap each
/// question in `<div class="singleQuesId" id="question123">`, and newer pages
/// only expose it on the option elements (`qid`). The `data` attribute on
/// `TiMu` is sometimes the question type instead of the id, so it is only used
/// when it looks like a real platform id.
fn question_id(node: &ElementRef<'_>) -> Option<String> {
    fn strip_question_prefix(id: &str) -> Option<String> {
        let id = id.trim();
        let id = id.strip_prefix("question").unwrap_or(id);
        (!id.is_empty()).then(|| id.to_string())
    }

    if let Some(id) = attr(node, "id").and_then(|id| strip_question_prefix(&id)) {
        return Some(id);
    }

    if let Some(id) = node
        .ancestors()
        .filter_map(ElementRef::wrap)
        .filter_map(|el| attr(&el, "id"))
        .find_map(|id| {
            id.trim()
                .starts_with("question")
                .then(|| strip_question_prefix(&id))
                .flatten()
        })
    {
        return Some(id);
    }

    if let Some(id) = node
        .select(&selector("[qid]"))
        .next()
        .and_then(|el| attr(&el, "qid"))
    {
        return Some(id);
    }

    attr(node, "data").filter(|id| id.len() >= 5 && id.bytes().all(|b| b.is_ascii_digit()))
}

fn parse_question_node(node: &ElementRef<'_>) -> Option<Question> {
    let id = question_id(node).unwrap_or_default();

    let type_label = node
        .select(&selector(".newZy_TItle"))
        .next()
        .map(|el| text(&el))
        .filter(|label| !label.is_empty());

    let question_type = type_label
        .as_deref()
        .map(strip_brackets)
        .filter(|label| !label.is_empty());

    let raw_stem = node
        .select(&selector(".qtContent"))
        .next()
        .map(|el| text(&el))
        .or_else(|| {
            node.select(&selector(".Zy_TItle"))
                .next()
                .map(|el| text(&el))
        })
        .unwrap_or_default();

    let stem = normalize_stem(&raw_stem, type_label.as_deref());
    if stem.is_empty() {
        return None;
    }

    let options = node
        .select(&selector("ul.Zy_ulTop li"))
        .map(|li| {
            let label = li
                .select(&selector(".num_option, .num_option_dx, i"))
                .next()
                .map(|el| text(&el))
                .unwrap_or_default()
                .trim_end_matches(['、', '.', '．', ' '])
                .to_string();
            let option_text = li
                .select(&selector("a"))
                .next()
                .map(|el| text(&el))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| {
                    let whole = text(&li);
                    whole
                        .strip_prefix(&label)
                        .map(|rest| rest.trim_start_matches(['、', '.', '．', ' ']).to_string())
                        .unwrap_or(whole)
                });
            QuestionOption {
                label,
                text: option_text,
            }
        })
        .collect::<Vec<_>>();

    let my_answer = question_answer(node, ".myAnswer .answerCon", ".myAllAnswerBx .myAnswer");
    let correct_answer = question_answer(
        node,
        ".correctAnswer .answerCon",
        ".correctAnswerBx .correctAnswer",
    );
    let score = text_of_first(node, ".newAnswerScore .scoreNum");

    Some(Question {
        id,
        question_type,
        stem,
        options,
        my_answer,
        correct_answer,
        score,
    })
}

/// Read an answer, falling back to the fill-in-the-blank blocks.
///
/// Multiple-choice answers use `answerCon`; fill-in answers are rendered as
/// `第一空： value` inside `.myAllAnswerBx` / `.correctAnswerBx`.
fn question_answer(node: &ElementRef<'_>, answer_con: &str, blocks: &str) -> Option<String> {
    if let Some(answer) = text_of_first(node, answer_con).filter(|value| !value.is_empty()) {
        return Some(answer);
    }

    let mut answers = Vec::new();
    for block in node.select(&selector(blocks)) {
        let value = text(&block);
        if value.is_empty() || value == "我的答案：" || value == "正确答案：" {
            continue;
        }
        let value = strip_blank_labels(&value);
        if !value.is_empty() {
            answers.push(value);
        }
    }

    (!answers.is_empty()).then(|| answers.join("；"))
}

/// Turn `第一空： accelerated` (or several blanks in one block) into the
/// answer text alone.
fn strip_blank_labels(raw: &str) -> String {
    let mut parts = Vec::new();
    // Some pages use an ASCII colon between the blank label and its answer.
    let normalized = raw.replace("空:", "空：");
    for chunk in normalized.split("空：").skip(1) {
        let mut chunk = chunk.trim();
        if let Some(position) = chunk.rfind('第') {
            let tail = &chunk[position + '第'.len_utf8()..];
            if !tail.is_empty()
                && tail
                    .chars()
                    .all(|c| c.is_ascii_digit() || "一二三四五六七八九十".contains(c))
            {
                chunk = chunk[..position].trim();
            }
        }
        if !chunk.is_empty() {
            parts.push(chunk.to_string());
        }
    }

    if parts.is_empty() {
        raw.to_string()
    } else {
        parts.join("；")
    }
}

fn strip_brackets(raw: &str) -> String {
    raw.trim()
        .trim_start_matches(['【', '['])
        .trim_end_matches(['】', ']'])
        .trim()
        .to_string()
}

/// Remove the platform's question number and `【单选题】`-style prefix.
///
/// Some work pages put the number inside `.qtContent`, so the text can look
/// like `1 【单选题】...`; others put the type label first and the number in a
/// sibling element.
fn normalize_stem(raw: &str, type_label: Option<&str>) -> String {
    let mut stem = clean_text(raw);

    if let Some(label) = type_label {
        let label = strip_brackets(label);
        if label.is_empty() {
            return stem;
        }
        let marker = format!("【{label}】");
        if let Some(position) = stem.find(&marker)
            && position <= 12
        {
            stem = stem[position + marker.len()..].trim().to_string();
            return stem;
        }
        if let Some(rest) = stem.strip_prefix(label.as_str()) {
            stem = rest.trim().to_string();
        }
    }

    stem
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_course_cards() {
        let html = r#"
        <ul>
          <li class="w_couritem" cid="17310000026063" classid="17310000023403"
              personId="17310000196268" cname="大学英语词汇解析(一)" source="1">
            <img src="http://example.test/cover.jpg">
            <a href="/fyportal-smartcourse/courselist/opencoursenewfy?courseId=17310000026063">进入学习</a>
          </li>
        </ul>"#;
        let base = Url::parse("https://smartcourse.hust.edu.cn/").unwrap();
        let courses = parse_course_list(html, &base).unwrap();
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].course_id, "17310000026063");
        assert_eq!(courses[0].cpi, "17310000196268");
        assert_eq!(courses[0].name, "大学英语词汇解析(一)");
        assert_eq!(
            courses[0].detail_url,
            "https://smartcourse.hust.edu.cn/fyportal-smartcourse/courselist/opencoursenewfy?courseId=17310000026063"
        );
    }

    #[test]
    fn parses_nested_chapter_tree() {
        let html = r#"
        <ul>
          <li>
            <div class="posCatalog_select firstLayer" id="100">
              <span class="posCatalog_title" title="Unit 1"><em class="posCatalog_sbar">1</em> Unit 1</span>
            </div>
            <div class="posCatalog_level"><ul>
              <li>
                <div class="posCatalog_select" id="cur101">
                  <span class="posCatalog_name" title="1.1 Intro"><em class="posCatalog_sbar">1.1</em> Intro</span>
                  <span class="icon_Completed prevTips">已完成</span>
                </div>
              </li>
              <li>
                <div class="posCatalog_select" id="cur102">
                  <span class="posCatalog_name" title="1.2 Next"><em class="posCatalog_sbar">1.2</em> Next</span>
                </div>
              </li>
            </ul></div>
          </li>
        </ul>"#;
        let tree = parse_chapter_tree(html).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].id, "100");
        assert!(!tree[0].is_leaf);
        assert_eq!(tree[0].children.len(), 2);
        assert_eq!(tree[0].children[0].id, "101");
        assert_eq!(tree[0].children[0].completed, Some(true));
        assert_eq!(leaf_ids(&tree), vec!["101", "102"]);
    }

    #[test]
    fn extracts_last_marg_object() {
        let html = r#"
        <script>
          mArg = "";
          mArg = {"attachments":[{"type":"video","property":{"name":"a.mp4"}}]};
        </script>"#;
        let marg = extract_marg(html).unwrap();
        assert_eq!(marg["attachments"][0]["type"], "video");
    }

    #[test]
    fn parses_task_point_metadata() {
        let marg: Value = serde_json::from_str(
            r#"{"attachments":[{"type":"video","jobid":"j1","objectId":"o1",
                "isPassed":true,"playTime":820000,"attDuration":821,"enc":"e1",
                "property":{"name":"lesson.mp4","size":244039903,"type":".mp4",
                            "objectid":"o1","jobid":"j1","mid":"m1"}}]}"#,
        )
        .unwrap();
        let content = parse_card_content(&marg);
        let point = &content.task_points[0];
        assert_eq!(point.kind, TaskKind::Video);
        assert_eq!(point.object_id.as_deref(), Some("o1"));
        assert_eq!(point.size_bytes, Some(244039903));
        assert_eq!(point.played_ms, Some(820000));
        assert_eq!(point.duration_secs, Some(821));
        assert_eq!(point.completed, Some(true));
    }

    #[test]
    fn parses_playback_defaults_and_signature_fields() {
        let marg: Value = serde_json::from_str(
            r#"{
                "defaults": {
                    "userid": 6000,
                    "clazzId": "2000",
                    "courseid": "1000",
                    "fid": "1731",
                    "reportUrl": "/mooc-ans/multimedia/log/a/3000",
                    "reportTimeInterval": 60,
                    "ktoken": "kt"
                },
                "attachments": [{
                    "type": "video",
                    "jobid": "j1",
                    "objectId": "o1",
                    "otherInfo": "nodeId_1-cpi_2",
                    "attDurationEnc": "enc1",
                    "rt": 1,
                    "videoFaceCaptureEnc": "",
                    "property": {"name": "lesson.mp4"}
                }]
            }"#,
        )
        .unwrap();

        let content = parse_card_content(&marg);
        let env = parse_playback_env(&content.defaults).expect("defaults should parse");
        assert_eq!(env.user_id.as_deref(), Some("6000"));
        assert_eq!(env.clazz_id.as_deref(), Some("2000"));
        assert_eq!(env.course_id.as_deref(), Some("1000"));
        assert_eq!(env.fid.as_deref(), Some("1731"));
        assert_eq!(
            env.report_url.as_deref(),
            Some("/mooc-ans/multimedia/log/a/3000")
        );
        assert_eq!(env.report_interval_secs, Some(60));
        assert_eq!(env.ktoken.as_deref(), Some("kt"));

        let point = &content.task_points[0];
        assert_eq!(point.other_info.as_deref(), Some("nodeId_1-cpi_2"));
        assert_eq!(point.att_duration_enc.as_deref(), Some("enc1"));
        assert_eq!(point.rt.as_deref(), Some("1"));
        assert_eq!(point.video_face_capture_enc.as_deref(), Some(""));
    }

    #[test]
    fn parses_video_dtoken() {
        let info = parse_video_info(&serde_json::json!({
            "dtoken": "test-dtoken",
            "duration": 647
        }));
        assert_eq!(info.dtoken.as_deref(), Some("test-dtoken"));
    }

    #[test]
    fn strips_number_and_type_prefix_from_stem() {
        assert_eq!(
            normalize_stem(
                "1 【单选题】总体国家安全观是在哪个基础上形成的?",
                Some("【单选题】")
            ),
            "总体国家安全观是在哪个基础上形成的?"
        );
        assert_eq!(
            normalize_stem("【判断题】The statement is true.", Some("【判断题】")),
            "The statement is true."
        );
        assert_eq!(
            normalize_stem("2026 年发生了什么?", Some("【单选题】")),
            "2026 年发生了什么?"
        );
    }

    #[test]
    fn parses_question_options_and_answers() {
        let html = r#"
        <div class="TiMu" data="676236" id="question676236">
          <div class="Zy_TItle">
            <i>1</i>
            <div class="qtContent"><span class="newZy_TItle">【单选题】</span>Which ch sounds different?</div>
          </div>
          <ul class="Zy_ulTop">
            <li><i class="fl">A、</i><a>interchange</a></li>
            <li><i class="fl">B、</i><a>scheme</a></li>
          </ul>
          <div class="myAnswer"><div class="answerCon">A</div></div>
          <div class="correctAnswer"><div class="answerCon">A</div></div>
          <div class="newAnswerScore"><span class="scoreNum">2.5</span></div>
        </div>"#;
        let questions = parse_questions(html);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].id, "676236");
        assert_eq!(questions[0].question_type.as_deref(), Some("单选题"));
        assert_eq!(questions[0].stem, "Which ch sounds different?");
        assert_eq!(questions[0].options[0].label, "A");
        assert_eq!(questions[0].options[0].text, "interchange");
        assert_eq!(questions[0].my_answer.as_deref(), Some("A"));
        assert_eq!(questions[0].correct_answer.as_deref(), Some("A"));
    }

    #[test]
    fn parses_fill_in_answers_from_answer_blocks() {
        let html = r#"
        <div class="TiMu" data="676265" id="question676265">
          <div class="Zy_TItle"><div class="qtContent">
            <span class="newZy_TItle">【填空题】</span>Tropical deforestation ____ markedly.
          </div></div>
          <div class="newAnswerBx">
            <div class="myAllAnswerBx">
              <div class="myAnswer marTop16">第一空：&nbsp;<p>accelerated<br></p></div>
            </div>
            <div class="correctAnswerBx">
              <div class="correctAnswer"><span class="answerFont fl">正确答案：</span></div>
              <div class="correctAnswer marTop16">第一空：&nbsp;accelerated</div>
            </div>
          </div>
          <div class="newAnswerScore"><span class="scoreNum">2.5</span>分</div>
        </div>"#;
        let questions = parse_questions(html);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].my_answer.as_deref(), Some("accelerated"));
        assert_eq!(questions[0].correct_answer.as_deref(), Some("accelerated"));
        assert_eq!(questions[0].score.as_deref(), Some("2.5"));
    }

    #[test]
    fn splits_multiple_fill_in_blanks_with_chinese_labels() {
        let html = r#"
        <div class="TiMu" data="681357" id="question681357">
          <div class="Zy_TItle"><div class="qtContent">
            <span class="newZy_TItle">【填空题】</span>以____为根本、以____为基础。
          </div></div>
          <div class="newAnswerBx">
            <div class="myAllAnswerBx">
              <div class="myAnswer marTop16">第一空： 政治安全 第二空： 经济安全</div>
            </div>
            <div class="correctAnswerBx">
              <div class="correctAnswer marTop16">第一空： 政治安全 第二空： 经济安全</div>
            </div>
          </div>
        </div>"#;
        let questions = parse_questions(html);
        assert_eq!(questions.len(), 1);
        assert_eq!(
            questions[0].my_answer.as_deref(),
            Some("政治安全；经济安全")
        );
        assert_eq!(
            questions[0].correct_answer.as_deref(),
            Some("政治安全；经济安全")
        );
    }

    #[test]
    fn strips_ascii_colon_blank_labels() {
        let html = r#"
        <div class="TiMu" data="681254" id="question681254">
          <div class="Zy_TItle"><div class="qtContent">
            <span class="newZy_TItle">【填空题】</span>包括____和____环境。
          </div></div>
          <div class="newAnswerBx">
            <div class="correctAnswerBx">
              <div class="correctAnswer marTop16">第一空:生物第二空:非生物</div>
            </div>
          </div>
        </div>"#;
        let questions = parse_questions(html);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].correct_answer.as_deref(), Some("生物；非生物"));
    }

    #[test]
    fn keeps_questions_whose_timu_data_is_only_the_type() {
        let html = r#"
        <div class="singleQuesId" id="question676549" data="676549">
          <div class="TiMu newTiMu" data="3">
            <div class="Zy_TItle"><i>1</i><div class="fontLabel">
              <span class="newZy_TItle">【判断题】</span>The paper ____ the water problem.(错)
            </div></div>
            <ul class="Zy_ulTop">
              <li qid="676549"><label><span class="num_option">A</span></label><a>对</a></li>
              <li qid="676549"><label><span class="num_option">B</span></label><a>错</a></li>
            </ul>
          </div>
        </div>
        <div class="singleQuesId" id="question676550" data="676550">
          <div class="TiMu newTiMu" data="3">
            <div class="Zy_TItle"><i>2</i><div class="fontLabel">
              <span class="newZy_TItle">【判断题】</span>The police ____ uncovered no evidence.(对)
            </div></div>
            <ul class="Zy_ulTop">
              <li qid="676550"><label><span class="num_option">A</span></label><a>对</a></li>
              <li qid="676550"><label><span class="num_option">B</span></label><a>错</a></li>
            </ul>
          </div>
        </div>"#;
        let questions = parse_questions(html);
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].id, "676549");
        assert_eq!(questions[1].id, "676550");
        assert_eq!(questions[0].question_type.as_deref(), Some("判断题"));
        assert!(questions[0].stem.contains("The paper"));
        assert_eq!(questions[0].options[0].label, "A");
        assert_eq!(questions[0].options[0].text, "对");
        assert_eq!(questions[0].options[1].label, "B");
        assert_eq!(questions[0].options[1].text, "错");
    }

    #[test]
    fn parses_multi_select_option_labels() {
        let html = r#"
        <div class="TiMu" data="1" id="question681204">
          <div class="Zy_TItle"><div class="fontLabel">
            <span class="newZy_TItle">【多选题】</span>政治安全最核心的是( )和( )。
          </div></div>
          <ul class="Zy_ulTop">
            <li qid="681204"><label><span class="num_option_dx">A</span></label><a>政权安全</a></li>
            <li qid="681204"><label><span class="num_option_dx">B</span></label><a>制度安全</a></li>
          </ul>
        </div>"#;
        let questions = parse_questions(html);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].options[0].label, "A");
        assert_eq!(questions[0].options[0].text, "政权安全");
        assert_eq!(questions[0].options[1].label, "B");
    }

    #[test]
    fn falls_back_to_option_qid_for_question_id() {
        let html = r#"
        <div class="TiMu newTiMu" data="3">
          <div class="Zy_TItle"><i>1</i><div class="fontLabel">
            <span class="newZy_TItle">【判断题】</span>Only qid here.
          </div></div>
          <ul class="Zy_ulTop">
            <li qid="676551"><span class="num_option">A</span><a>对</a></li>
          </ul>
        </div>"#;
        let questions = parse_questions(html);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].id, "676551");
    }
}
