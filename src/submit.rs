//! Quiz submission: answer encoding, form construction and course planning.
//!
//! Verified against a live `doHomeWorkNew` answering page (2026-10-22):
//!
//! - `form#form1`'s action already contains the per-session `token`, encrypted
//!   `totalQuestionNum`, `workid`, `originJobId`, `testmooc2`, ...; the final
//!   POST reuses it and only appends `ua`, `formType`, `saveStatus`, `pos` and
//!   `version`.
//! - `$("#form1").serialize()` carries the hidden base fields plus one
//!   `answer{id}` / `answertype{id}` pair per question.
//! - True/false answers are `true` / `false`; multiple-choice labels are
//!   sorted; `answerwqbid` has a trailing comma.
//! - Fill-in questions use `tiankongsize{id}` and named
//!   `answerEditor{id}{n}` textareas; the mobile handler uses
//!   `answer{id}{n}`, so both shapes are sent.
//!
//! The final POST was verified live on 2026-10-22 against a 6-question
//! true/false work: the server returned `success=true`, and a fresh course
//! crawl then reported the work as graded. Fill/multiple-choice encodings were
//! validated against their live page structures; submit a fill work once
//! before relying on them in bulk.
//!
//! Everything here is pure data transformation except the URL builder;
//! `SmartCourseClient` adds the HTTP hop.

use crate::{
    answers::AnswerBank,
    models::{
        Card, Chapter, CourseDetail, CourseSummary, Question, QuestionOption, TaskKind, TaskPoint,
    },
};
use anyhow::{Context, Result, bail};
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    time::{SystemTime, UNIX_EPOCH},
};
use url::Url;

/// Fallback submit path used only when `form#form1` has no action.
///
/// Real answering pages expose a fully populated action that is preferred by
/// [`submission_url`]; this path keeps synthetic fixtures and unknown layouts
/// working.
pub const SUBMIT_PATH: &str = "mooc-ans/work/addStudentWorkNewWeb";

/// Referer used when a [`WorkTarget`] does not carry the cards-page URL.
pub const DEFAULT_WORK_REFERER: &str =
    "https://smartcourse.hust.edu.cn/mooc-ans/mycourse/studentstudy";

const BASE_FIELDS: &[&str] = &[
    "pyFlag",
    "courseId",
    "classId",
    "api",
    "workAnswerId",
    "totalQuestionNum",
    "fullScore",
    "knowledgeid",
    "oldSchoolId",
    "oldWorkId",
    "jobid",
    "workRelationId",
    "enc_work",
    "userId",
    "workTimesEnc",
    "answerwqbid",
];

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

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// How the fetched work page should be treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkStatus {
    /// "查看已批改作业"; answers are read-only.
    Graded,
    /// The answering page.
    InProgress,
    Unknown,
}

impl WorkStatus {
    pub fn from_work_status(value: Option<&str>) -> Self {
        match value {
            Some("graded") => Self::Graded,
            Some("in_progress") => Self::InProgress,
            _ => Self::Unknown,
        }
    }

    pub fn as_work_status(self) -> Option<&'static str> {
        match self {
            Self::Graded => Some("graded"),
            Self::InProgress => Some("in_progress"),
            Self::Unknown => None,
        }
    }
}

/// Everything the platform needs to identify one quiz work.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTarget {
    pub course_id: String,
    pub class_id: String,
    pub cpi: String,
    pub knowledge_id: String,
    pub work_id: String,
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_type: Option<String>,
    /// Attachment signature, when the cards page exposed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enc: Option<String>,
    /// Session token from `mArg.defaults`; needed to open the work page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ktoken: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// Cards-page URL used as the referer when fetching the work page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referer: Option<String>,
}

impl WorkTarget {
    /// Build a target from a crawled leaf card and its `workid` task point.
    pub fn from_task(
        course: &CourseSummary,
        knowledge_id: &str,
        card: &Card,
        point: &TaskPoint,
    ) -> Result<Self> {
        if point.kind != TaskKind::Work {
            bail!("task point {} is not a work", point.name);
        }
        let work_id = point
            .work_id
            .clone()
            .with_context(|| format!("work task point {} has no workid", point.name))?;
        let job_id = point
            .job_id
            .clone()
            .with_context(|| format!("work {work_id} has no jobid"))?;
        let playback = card.playback.as_ref();

        Ok(Self {
            course_id: course.course_id.clone(),
            class_id: course.class_id.clone(),
            cpi: course.cpi.clone(),
            knowledge_id: knowledge_id.to_string(),
            work_id,
            job_id,
            work_type: point.work_type.clone(),
            enc: point.enc.clone(),
            ktoken: playback.and_then(|env| env.ktoken.clone()),
            user_id: playback.and_then(|env| env.user_id.clone()),
            referer: None,
        })
    }
}

/// A fetched answering/graded page.
#[derive(Debug, Clone)]
pub struct WorkPage {
    pub final_url: String,
    pub status: WorkStatus,
    pub questions: Vec<Question>,
    pub form: WorkForm,
}

/// Hidden fields and per-question type codes from the answering page.
#[derive(Debug, Clone, Default)]
pub struct WorkForm {
    /// `form#form1` action, usually `addStudentWorkNewWeb?...` with the
    /// per-session tokens already in the query string.
    pub action: Option<String>,
    pub method: Option<String>,
    /// All question ids rendered in the form, in document order.
    pub question_ids: Vec<String>,
    /// Named hidden inputs in document order; these are copied into the POST
    /// body. Id-only inputs are intentionally excluded because
    /// `$("#form1").serialize()` does not submit them.
    pub hidden: Vec<(String, String)>,
    /// Lookup by `name` and by `id`, including empty values.
    pub values: BTreeMap<String, String>,
    /// `answertype{questionId}` -> numeric question type.
    pub question_types: BTreeMap<String, u32>,
}

impl WorkForm {
    pub fn hidden_value(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    pub fn question_type(&self, question_id: &str) -> Option<u32> {
        self.question_types.get(question_id).copied()
    }
}

/// Parse the hidden form and question type codes from an answering page.
pub fn parse_work_form(html: &str) -> WorkForm {
    let doc = Html::parse_document(html);
    let mut form = WorkForm::default();

    if let Some(form_node) = doc.select(&selector("form#form1")).next().or_else(|| {
        doc.select(&selector("form")).find(|node| {
            node.select(&selector("input[name=workAnswerId]"))
                .next()
                .is_some()
        })
    }) {
        form.action = attr(&form_node, "action");
        form.method = attr(&form_node, "method").map(|method| method.to_ascii_lowercase());
    }

    let mut seen_questions = HashSet::new();
    for node in doc.select(&selector("div.singleQuesId, div.TiMu")) {
        let id = attr(&node, "id")
            .and_then(|id| id.strip_prefix("question").map(str::to_string))
            .or_else(|| {
                attr(&node, "data")
                    .filter(|data| data.len() >= 5 && data.chars().all(|c| c.is_ascii_digit()))
            });
        let Some(id) = id else {
            continue;
        };
        if !id.is_empty() && seen_questions.insert(id.clone()) {
            form.question_ids.push(id);
        }
    }

    for input in doc.select(&selector("input")) {
        let id = attr(&input, "id");
        let name = attr(&input, "name");
        let input_type = attr(&input, "type")
            .unwrap_or_default()
            .to_ascii_lowercase();

        for candidate in id.iter().chain(name.iter()) {
            if let Some(rest) = candidate.strip_prefix("answertype")
                && !rest.is_empty()
                && rest.chars().all(|c| c.is_ascii_digit())
                && let Some(value) = attr(&input, "value").and_then(|v| v.parse::<u32>().ok())
            {
                form.question_types.insert(rest.to_string(), value);
            }
        }

        let Some(key) = name.clone().or_else(|| id.clone()) else {
            continue;
        };
        if is_per_question_field(&key) {
            continue;
        }
        let value = attr(&input, "value").unwrap_or_default();
        let is_hidden = input_type == "hidden";
        let is_known = BASE_FIELDS.contains(&key.as_str());
        if !is_hidden && !is_known {
            continue;
        }

        // Only real form names are echoed back; an id-only input is useful for
        // lookups (and for the canonical fields below) but is not a body key.
        if let Some(name) = &name {
            form.hidden.push((name.clone(), value.clone()));
        }
        if let Some(id) = &id {
            remember_value(&mut form.values, id, &value);
        }
        if let Some(name) = &name {
            remember_value(&mut form.values, name, &value);
        }
    }

    form
}

fn remember_value(values: &mut BTreeMap<String, String>, key: &str, value: &str) {
    if !value.is_empty() || !values.contains_key(key) {
        values.insert(key.to_string(), value.to_string());
    }
}

/// Whether a form key belongs to a single question and must be regenerated.
fn is_per_question_field(key: &str) -> bool {
    if key == "answerwqbid" {
        return false;
    }
    for prefix in ["answer", "answertype", "tiankongsize"] {
        if let Some(rest) = key.strip_prefix(prefix)
            && !rest.is_empty()
            && rest.chars().all(|c| c.is_ascii_digit())
        {
            return true;
        }
    }
    false
}

/// A single answer, encoded independently of the page's numeric type code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionAnswer {
    pub question_id: String,
    /// Best-known numeric type (0 single, 1 multiple, 2 fill, 3 true/false,
    /// 4+ free text). The page's `answertype{id}` overrides this at submit.
    pub question_type: u32,
    /// Canonical answer string from the bank.
    pub answer: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub blanks: Vec<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub confidence: Option<String>,
}

impl QuestionAnswer {
    pub fn from_bank(question: &Question, answer: &crate::answers::BankAnswer) -> Result<Self> {
        let question_type = question
            .question_type
            .as_deref()
            .and_then(question_type_code)
            .or_else(|| question_type_code(&answer.question_type))
            .with_context(|| {
                format!(
                    "question {} has an unknown type {:?}",
                    question.id, question.question_type
                )
            })?;

        let mut labels = answer.answer_labels.clone();
        if labels.is_empty() && matches!(question_type, 0 | 1) {
            labels = labels_from_answer(&answer.answer);
        }
        labels = labels
            .into_iter()
            .map(|label| label.trim().to_ascii_uppercase())
            .filter(|label| !label.is_empty())
            .collect();

        let mut blanks = answer.answer_blanks.clone();
        if blanks.is_empty() && matches!(question_type, 2 | 14) {
            blanks = split_blanks(&answer.answer);
        }
        blanks = blanks
            .into_iter()
            .map(|blank| blank.trim().to_string())
            .filter(|blank| !blank.is_empty())
            .collect();

        let options = if question.options.is_empty() {
            answer.options.clone()
        } else {
            question.options.clone()
        };

        Ok(Self {
            question_id: question.id.clone(),
            question_type,
            answer: answer.answer.clone(),
            labels,
            blanks,
            text: if answer.answer_text.trim().is_empty() {
                answer.answer.clone()
            } else {
                answer.answer_text.clone()
            },
            options,
            source: answer.source.clone(),
            confidence: answer.confidence.clone(),
        })
    }

    /// Append `answertype{id}` and the answer field(s) for `type_code`.
    pub fn encode_fields(&self, type_code: u32, fields: &mut Vec<(String, String)>) -> Result<()> {
        fields.push((
            format!("answertype{}", self.question_id),
            type_code.to_string(),
        ));

        match type_code {
            0 => {
                let label = self.single_label()?;
                fields.push((format!("answer{}", self.question_id), label));
            }
            1 => {
                let labels = self.multi_labels();
                if labels.is_empty() {
                    bail!(
                        "question {} has no multiple-choice labels",
                        self.question_id
                    );
                }
                fields.push((format!("answer{}", self.question_id), labels.join("")));
            }
            2 | 14 => {
                if self.blanks.is_empty() {
                    bail!("question {} has no fill-in blanks", self.question_id);
                }
                fields.push((
                    format!("tiankongsize{}", self.question_id),
                    self.blanks.len().to_string(),
                ));
                for (index, blank) in self.blanks.iter().enumerate() {
                    // Mobile handlers read `answer{id}{n}`; the web answering
                    // page renders named `answerEditor{id}{n}` textareas and
                    // serializes those. Send both shapes so either handler can
                    // read the value.
                    fields.push((
                        format!("answer{}{}", self.question_id, index + 1),
                        blank.clone(),
                    ));
                    fields.push((
                        format!("answerEditor{}{}", self.question_id, index + 1),
                        blank.clone(),
                    ));
                }
            }
            3 => {
                let value = self.judge_value().with_context(|| {
                    format!("question {} has no true/false value", self.question_id)
                })?;
                fields.push((
                    format!("answer{}", self.question_id),
                    if value { "true" } else { "false" }.to_string(),
                ));
            }
            _ => {
                let text = self.free_text();
                if text.trim().is_empty() {
                    bail!(
                        "question {} has an empty free-text answer",
                        self.question_id
                    );
                }
                fields.push((format!("answer{}", self.question_id), text.clone()));
                // Free-text questions use an editor named
                // `answerEditor{id}` on the web page.
                if (4..=10).contains(&type_code) {
                    fields.push((format!("answerEditor{}", self.question_id), text));
                }
            }
        }
        Ok(())
    }

    fn single_label(&self) -> Result<String> {
        if let Some(label) = self.labels.first() {
            return Ok(label.clone());
        }
        let answer = self.answer.trim();
        if answer.len() == 1 && answer.chars().all(|c| c.is_ascii_alphabetic()) {
            return Ok(answer.to_ascii_uppercase());
        }
        bail!("question {} has no single-choice label", self.question_id)
    }

    fn multi_labels(&self) -> Vec<String> {
        let mut labels = if self.labels.is_empty() {
            labels_from_answer(&self.answer)
        } else {
            self.labels.clone()
        };
        labels.retain(|label| !label.is_empty());
        // The page's `sortMultiAnswer()` always sorts the selected labels
        // before writing `answer{id}`.
        labels.sort();
        labels.dedup();
        labels
    }

    fn judge_value(&self) -> Option<bool> {
        let mut candidates = Vec::new();
        if !self.text.trim().is_empty() {
            candidates.push(self.text.as_str());
        }
        candidates.extend(self.labels.iter().map(String::as_str));
        if !self.answer.trim().is_empty() {
            candidates.push(self.answer.as_str());
        }
        candidates.extend(self.blanks.iter().map(String::as_str));

        for candidate in &candidates {
            if let Some(value) = truth_value(candidate) {
                return Some(value);
            }
        }

        // The platform renders 对/错 as options A/B. Map through the option
        // text first so a page that swaps the labels still works.
        for candidate in &candidates {
            if let Some(option) = self
                .options
                .iter()
                .find(|option| option.label.eq_ignore_ascii_case(candidate))
                && let Some(value) = truth_value(&option.text)
            {
                return Some(value);
            }
        }

        let first = candidates
            .iter()
            .find_map(|candidate| candidate.trim().chars().next())?;
        match first.to_ascii_uppercase() {
            'A' => Some(true),
            'B' => Some(false),
            _ => None,
        }
    }

    fn free_text(&self) -> String {
        if self.text.trim().is_empty() {
            self.answer.trim().to_string()
        } else {
            self.text.trim().to_string()
        }
    }
}

fn labels_from_answer(answer: &str) -> Vec<String> {
    let mut labels: Vec<String> = answer
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase().to_string())
        .collect();
    labels.sort();
    labels.dedup();
    labels
}

fn split_blanks(answer: &str) -> Vec<String> {
    answer
        .split(['；', ';', '|'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn truth_value(raw: &str) -> Option<bool> {
    let value = raw
        .trim()
        .trim_matches(|c: char| c.is_whitespace() || "。.！!：:".contains(c))
        .to_lowercase();
    match value.as_str() {
        "true" | "t" | "yes" | "y" | "对" | "正确" | "√" | "是" => Some(true),
        "false" | "f" | "no" | "n" | "错" | "错误" | "×" | "x" | "否" => Some(false),
        _ => None,
    }
}

/// Map a Chinese type label (or a numeric string) to Chaoxing's type code.
pub fn question_type_code(label: &str) -> Option<u32> {
    let label = label
        .trim()
        .trim_matches(|c| matches!(c, '【' | '】' | '[' | ']'));
    if let Ok(code) = label.parse::<u32>() {
        return Some(code);
    }
    match label {
        "单选题" | "单选" | "单项选择" => Some(0),
        "多选题" | "多选" | "多项选择" => Some(1),
        "填空题" | "填空" => Some(2),
        "判断题" | "判断" => Some(3),
        "简答题" | "简答" | "问答" => Some(4),
        "名词解释" => Some(5),
        "论述题" => Some(6),
        "计算题" => Some(7),
        "其它" | "其他" => Some(8),
        "分录题" => Some(9),
        "资料题" => Some(10),
        "连线题" => Some(11),
        "排序题" => Some(13),
        "完型填空" | "完形填空" => Some(14),
        "阅读理解" => Some(15),
        "口语题" => Some(18),
        "听力题" => Some(19),
        "共用选项题" => Some(20),
        "测评题" => Some(21),
        _ => None,
    }
}

/// Build the form body for a submission.
pub fn build_submission_fields(
    target: &WorkTarget,
    page: &WorkPage,
    answers: &[QuestionAnswer],
) -> Result<Vec<(String, String)>> {
    if page.status == WorkStatus::Graded {
        bail!(
            "work {} ({}) is already graded; refusing to submit",
            target.work_id,
            target.job_id
        );
    }
    if page.questions.is_empty() {
        bail!("work page for {} has no questions", target.work_id);
    }
    if let Some(total) = page
        .form
        .hidden_value("totalQuestionNum")
        .and_then(|value| value.parse::<usize>().ok())
        && total != page.questions.len()
    {
        bail!(
            "parsed {} of {} questions in work {}; refusing a partial submission",
            page.questions.len(),
            total,
            target.work_id
        );
    }
    if !page.form.question_ids.is_empty() {
        let rendered: HashSet<&str> = page.form.question_ids.iter().map(String::as_str).collect();
        let parsed: HashSet<&str> = page.questions.iter().map(|q| q.id.as_str()).collect();
        if rendered != parsed {
            let unparsed: Vec<&str> = page
                .form
                .question_ids
                .iter()
                .map(String::as_str)
                .filter(|id| !parsed.contains(id))
                .collect();
            bail!(
                "parsed {} of {} questions in work {}; missing ids: {}; refusing a partial submission",
                page.questions.len(),
                page.form.question_ids.len(),
                target.work_id,
                unparsed.join(", ")
            );
        }
    }

    let mut by_id: HashMap<&str, &QuestionAnswer> = HashMap::with_capacity(answers.len());
    for answer in answers {
        if by_id.insert(answer.question_id.as_str(), answer).is_some() {
            bail!("duplicate answer for question {}", answer.question_id);
        }
    }

    let mut ordered = Vec::with_capacity(page.questions.len());
    let mut missing = Vec::new();
    for question in &page.questions {
        if question.id.is_empty() {
            bail!(
                "work page for {} has a question without an id",
                target.work_id
            );
        }
        match by_id.get(question.id.as_str()) {
            Some(answer) => ordered.push((*answer).clone()),
            None => missing.push(question.id.clone()),
        }
    }
    if !missing.is_empty() {
        bail!(
            "no answer for question(s) in work {}: {}",
            target.work_id,
            missing.join(", ")
        );
    }
    let unknown: Vec<&str> = answers
        .iter()
        .map(|answer| answer.question_id.as_str())
        .filter(|id| !page.questions.iter().any(|question| question.id == *id))
        .collect();
    if !unknown.is_empty() {
        bail!(
            "answers contain question id(s) not present in work {}: {}",
            target.work_id,
            unknown.join(", ")
        );
    }

    let form = &page.form;
    let work_answer_id = required_hidden(form, "workAnswerId", &target.work_id)?;
    let enc_work = required_hidden(form, "enc_work", &target.work_id)?;

    let mut fields: Vec<(String, String)> = Vec::with_capacity(20 + ordered.len() * 3);
    let mut seen: HashSet<String> = HashSet::with_capacity(20 + ordered.len() * 3);

    push_field(
        &mut fields,
        &mut seen,
        "pyFlag",
        form.hidden_value("pyFlag").unwrap_or(""),
    );
    push_field(&mut fields, &mut seen, "courseId", &target.course_id);
    push_field(&mut fields, &mut seen, "classId", &target.class_id);
    push_field(
        &mut fields,
        &mut seen,
        "api",
        form.hidden_value("api")
            .filter(|v| !v.is_empty())
            .unwrap_or("1"),
    );
    push_field(&mut fields, &mut seen, "workAnswerId", work_answer_id);
    let total_question_num = form
        .hidden_value("totalQuestionNum")
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| ordered.len().to_string());
    push_field(
        &mut fields,
        &mut seen,
        "totalQuestionNum",
        &total_question_num,
    );
    push_field(
        &mut fields,
        &mut seen,
        "fullScore",
        form.hidden_value("fullScore").unwrap_or(""),
    );
    push_field(&mut fields, &mut seen, "knowledgeid", &target.knowledge_id);
    push_field(
        &mut fields,
        &mut seen,
        "oldSchoolId",
        form.hidden_value("oldSchoolId").unwrap_or(""),
    );
    push_field(&mut fields, &mut seen, "oldWorkId", &target.work_id);
    push_field(&mut fields, &mut seen, "jobid", &target.job_id);
    push_field(
        &mut fields,
        &mut seen,
        "workRelationId",
        form.hidden_value("workRelationId").unwrap_or(""),
    );
    push_field(&mut fields, &mut seen, "enc_work", enc_work);
    push_field(
        &mut fields,
        &mut seen,
        "userId",
        target
            .user_id
            .as_deref()
            .or_else(|| form.hidden_value("userId"))
            .unwrap_or(""),
    );
    push_field(
        &mut fields,
        &mut seen,
        "workTimesEnc",
        form.hidden_value("workTimesEnc").unwrap_or(""),
    );

    // Preserve extra page-level hidden fields (score{id}, type{id}, new
    // platform tokens) without duplicating the fields above.
    for (key, value) in &form.hidden {
        if BASE_FIELDS.contains(&key.as_str()) || is_per_question_field(key) {
            continue;
        }
        push_field(&mut fields, &mut seen, key, value);
    }

    let ids: Vec<&str> = page
        .questions
        .iter()
        .map(|question| question.id.as_str())
        .collect();
    // The page's own JS sets `answerwqbid` with a trailing comma.
    let answer_ids = format!("{},", ids.join(","));
    push_field(&mut fields, &mut seen, "answerwqbid", &answer_ids);

    for (answer, question) in ordered.iter().zip(&page.questions) {
        let type_code = form
            .question_type(&question.id)
            .unwrap_or(answer.question_type);
        answer.encode_fields(type_code, &mut fields)?;
    }

    Ok(fields)
}

fn required_hidden<'a>(form: &'a WorkForm, key: &str, work_id: &str) -> Result<&'a str> {
    form.hidden_value(key)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("work page for {work_id} did not expose hidden field `{key}`"))
}

fn push_field(
    fields: &mut Vec<(String, String)>,
    seen: &mut HashSet<String>,
    key: &str,
    value: &str,
) {
    if seen.insert(key.to_string()) {
        fields.push((key.to_string(), value.to_string()));
    }
}

/// The exact POST a submission performs. Useful for `--dry-run` UIs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmissionRequest {
    pub url: String,
    pub referer: String,
    pub fields: Vec<(String, String)>,
}

/// Build the final submission URL.
///
/// The real answering page puts every per-session token (`token`,
/// `totalQuestionNum`, `workid`, `originJobId`, `testmooc2`, ...) in
/// `form#form1`'s action. Reuse that action verbatim; the browser's submit
/// helper only appends `ua`, `formType`, `saveStatus`, `pos` and `version`.
pub fn submission_url(
    base: &Url,
    target: &WorkTarget,
    page: &WorkPage,
    now_ms: u64,
) -> Result<String> {
    let mut url = if let Some(action) = page
        .form
        .action
        .as_deref()
        .filter(|action| !action.is_empty())
    {
        let page_url = Url::parse(&page.final_url)
            .with_context(|| format!("invalid work page URL {}", page.final_url))?;
        page_url
            .join(action)
            .with_context(|| format!("invalid form action `{action}`"))
    } else {
        // Fallback for a page that did not expose form#form1. This mirrors the
        // old hand-built URL and is only used by fixtures or unknown layouts.
        let work_answer_id = required_hidden(&page.form, "workAnswerId", &target.work_id)?;
        let enc_work = required_hidden(&page.form, "enc_work", &target.work_id)?;
        let relation = page.form.hidden_value("workRelationId").unwrap_or("");
        let mut url = base
            .join(SUBMIT_PATH)
            .with_context(|| format!("cannot build submit URL from {base}"))?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("keyboardDisplayRequiresUserAction", "1")
                .append_pair("_classId", &target.class_id)
                .append_pair("courseid", &target.course_id)
                .append_pair("token", enc_work)
                .append_pair("workAnswerId", work_answer_id)
                .append_pair("workid", relation)
                .append_pair("cpi", &target.cpi)
                .append_pair("jobid", &target.job_id)
                .append_pair("knowledgeid", &target.knowledge_id)
                .append_pair("ut", "s")
                .append_pair("t", &now_ms.to_string());
        }
        Ok(url)
    }?;

    append_final_query(&mut url, page.form.method.as_deref().unwrap_or("post"));
    Ok(url.to_string())
}

/// Append the query parameters added by the page's `version(url)` helper.
fn append_final_query(url: &mut Url, method: &str) {
    let version = url
        .query_pairs()
        .find(|(key, _)| key == "version")
        .and_then(|(_, value)| value.parse::<u32>().ok())
        .map(|version| version + 1)
        .unwrap_or(1);
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "version")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    pairs.push(("ua".to_string(), "pc".to_string()));
    pairs.push(("formType".to_string(), method.to_ascii_lowercase()));
    pairs.push(("saveStatus".to_string(), "1".to_string()));
    pairs.push(("pos".to_string(), String::new()));
    pairs.push(("version".to_string(), version.to_string()));

    url.set_query(None);
    let mut query = url.query_pairs_mut();
    for (key, value) in pairs {
        query.append_pair(&key, &value);
    }
}

pub fn prepare_submission(
    base: &Url,
    target: &WorkTarget,
    page: &WorkPage,
    answers: &[QuestionAnswer],
    now_ms: u64,
) -> Result<SubmissionRequest> {
    Ok(SubmissionRequest {
        url: submission_url(base, target, page, now_ms)?,
        referer: page.final_url.clone(),
        fields: build_submission_fields(target, page, answers)?,
    })
}

/// The server's answer to a submit request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitReply {
    pub success: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

/// Parse the JSON (or HTML/plain-text) body returned by the submit handler.
pub fn parse_submit_reply(body: &str) -> Result<SubmitReply> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        bail!("submit endpoint returned an empty body");
    }

    let lower = trimmed.to_lowercase();
    if lower.contains("passport")
        || trimmed.contains("请先登录")
        || trimmed.contains("用户登录")
        || lower.contains("not logged in")
    {
        bail!("login expired while submitting answers");
    }

    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        let success = value
            .get("status")
            .or_else(|| value.get("success"))
            .and_then(boolish)
            .or_else(|| {
                value
                    .get("msg")
                    .or_else(|| value.get("message"))
                    .and_then(Value::as_str)
                    .map(|msg| msg.contains("成功"))
            })
            .unwrap_or(false);
        let message = value
            .get("msg")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or(if success {
                "提交成功"
            } else {
                "提交失败"
            })
            .to_string();
        return Ok(SubmitReply {
            success,
            message,
            raw: Some(truncate(trimmed, 2000)),
        });
    }

    let success = trimmed.contains("提交成功") || lower.contains("success");
    Ok(SubmitReply {
        success,
        message: if success {
            "提交成功".to_string()
        } else {
            truncate(trimmed, 500)
        },
        raw: Some(truncate(trimmed, 2000)),
    })
}

fn boolish(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => value.as_i64().map(|number| number != 0),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut out: String = value.chars().take(max_chars).collect();
    if value.chars().count() > max_chars {
        out.push('…');
    }
    out
}

/// Answers resolved from the bank for one work.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QuestionPlan {
    #[serde(default)]
    pub answers: Vec<QuestionAnswer>,
    #[serde(default)]
    pub missing_question_ids: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

impl QuestionPlan {
    pub fn is_complete(&self) -> bool {
        self.missing_question_ids.is_empty() && self.errors.is_empty()
    }
}

/// Resolve every question in a work against the bank.
pub fn plan_questions(
    questions: &[Question],
    bank: &AnswerBank,
    course_id: &str,
    work_id: &str,
) -> QuestionPlan {
    let mut plan = QuestionPlan::default();
    for question in questions {
        let Some(answer) = bank.lookup_for(question, course_id, work_id) else {
            plan.missing_question_ids.push(question.id.clone());
            continue;
        };
        match QuestionAnswer::from_bank(question, answer) {
            Ok(answer) => plan.answers.push(answer),
            Err(error) => plan
                .errors
                .push(format!("question {}: {error:#}", question.id)),
        }
    }
    plan
}

/// One work that can be submitted from a course plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedWork {
    pub work_id: String,
    pub work_name: String,
    pub chapter_id: String,
    pub chapter_title: String,
    pub question_count: usize,
    pub target: WorkTarget,
    #[serde(default)]
    pub answers: Vec<QuestionAnswer>,
    #[serde(default)]
    pub missing_question_ids: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

impl PlannedWork {
    pub fn is_complete(&self) -> bool {
        !self.answers.is_empty()
            && self.answers.len() == self.question_count
            && self.missing_question_ids.is_empty()
            && self.errors.is_empty()
    }
}

/// A course-wide, unanswered-work plan.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CourseSubmissionPlan {
    pub course_id: String,
    pub course_name: String,
    #[serde(default)]
    pub works: Vec<PlannedWork>,
    #[serde(default)]
    pub skipped_graded: usize,
    #[serde(default)]
    pub errors: Vec<String>,
}

impl CourseSubmissionPlan {
    pub fn complete_works(&self) -> impl Iterator<Item = &PlannedWork> {
        self.works.iter().filter(|work| work.is_complete())
    }
}

/// Build a course plan from an already crawled [`CourseDetail`].
///
/// Graded works are skipped. Works whose questions were not fetched (or whose
/// answers are missing from the bank) stay in the plan with diagnostics so the
/// caller can show them instead of silently submitting a partial quiz.
pub fn plan_course(course: &CourseDetail, bank: &AnswerBank) -> CourseSubmissionPlan {
    let mut plan = CourseSubmissionPlan {
        course_id: course.course.course_id.clone(),
        course_name: course.title.clone(),
        ..CourseSubmissionPlan::default()
    };
    plan_chapters(&course.course, &course.chapters, bank, &mut plan);
    plan
}

fn plan_chapters(
    course: &CourseSummary,
    chapters: &[Chapter],
    bank: &AnswerBank,
    plan: &mut CourseSubmissionPlan,
) {
    for chapter in chapters {
        for card in &chapter.cards {
            for point in &card.task_points {
                if point.kind != TaskKind::Work {
                    continue;
                }
                if point.work_status.as_deref() == Some("graded") {
                    plan.skipped_graded += 1;
                    continue;
                }
                let target = match WorkTarget::from_task(course, &chapter.id, card, point) {
                    Ok(target) => target,
                    Err(error) => {
                        plan.errors.push(format!(
                            "chapter {} work {}: {error:#}",
                            chapter.id, point.name
                        ));
                        continue;
                    }
                };
                let resolved =
                    plan_questions(&point.questions, bank, &course.course_id, &target.work_id);
                let mut errors = resolved.errors;
                if point.questions.is_empty() {
                    errors.push("work has no fetched questions".to_string());
                }
                plan.works.push(PlannedWork {
                    work_id: target.work_id.clone(),
                    work_name: point.name.clone(),
                    chapter_id: chapter.id.clone(),
                    chapter_title: chapter.title.clone(),
                    question_count: point.questions.len(),
                    target,
                    answers: resolved.answers,
                    missing_question_ids: resolved.missing_question_ids,
                    errors,
                });
            }
        }
        plan_chapters(course, &chapter.children, bank, plan);
    }
}

/// Progress snapshot emitted by the batch submit loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitProgress {
    pub total_works: usize,
    pub done_works: usize,
    pub work_id: String,
    pub work_name: String,
    pub success: bool,
}

/// Result of one work in the batch submit loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkSubmitOutcome {
    pub work_id: String,
    pub work_name: String,
    pub question_count: usize,
    pub success: bool,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::answers::AnswerBank;
    use crate::models::{
        Card, Chapter, CourseDetail, CourseStats, CourseSummary, PlaybackEnv, QuestionOption,
    };
    use std::collections::HashSet;

    const WORK_HTML: &str = r#"
    <html><head><title>作业</title></head><body>
      <form id="form1" method="post"
            action="addStudentWorkNewWeb?_classId=17310000023403&courseid=17310000026063&token=enc-work&totalQuestionNum=enc-total&workid=7001&cpi=17310000196268&jobid=job-1&knowledgeid=582304&testmooc2=1&originJobId=job-1&wMicroNodeId=0">
        <input type="hidden" id="workAnswerId" name="workAnswerId" value="9001">
        <input type="hidden" id="answerId" name="answerId" value="9001">
        <input type="hidden" id="totalQuestionNum" name="totalQuestionNum" value="5">
        <input type="hidden" id="fullScore" name="fullScore" value="50">
        <input type="hidden" id="workRelationId" name="workRelationId" value="7001">
        <input type="hidden" id="enc_work" name="enc_work" value="enc-work">
        <input type="hidden" id="enc" name="enc" value="">
        <input type="hidden" id="pyFlag" name="pyFlag" value="">
        <input type="hidden" id="answerwqbid" name="answerwqbid" value="">
        <input type="hidden" id="workTimesEnc" name="workTimesEnc" value="">
        <input type="hidden" id="answertype101" value="0">
        <input type="hidden" id="answertype102" value="1">
        <input type="hidden" id="answertype103" value="2">
        <input type="hidden" id="answertype104" value="3">
        <input type="hidden" id="answertype105" value="4">
        <input type="hidden" name="score101" value="10">
      </form>
      <div class="singleQuesId" id="question101"></div>
      <div class="singleQuesId" id="question102"></div>
      <div class="singleQuesId" id="question103"></div>
      <div class="singleQuesId" id="question104"></div>
      <div class="singleQuesId" id="question105"></div>
    </body></html>"#;

    fn bank() -> AnswerBank {
        AnswerBank::from_json(include_str!("../test-data/answer-bank.json"))
            .expect("test-data answer bank must parse")
    }

    fn target() -> WorkTarget {
        WorkTarget {
            course_id: "17310000026063".to_string(),
            class_id: "17310000023403".to_string(),
            cpi: "17310000196268".to_string(),
            knowledge_id: "582304".to_string(),
            work_id: "work-1".to_string(),
            job_id: "job-1".to_string(),
            work_type: Some("workA".to_string()),
            enc: Some("enc-1".to_string()),
            ktoken: Some("kt-1".to_string()),
            user_id: Some("6000".to_string()),
            referer: None,
        }
    }

    fn single(id: &str) -> Question {
        Question {
            id: id.to_string(),
            question_type: Some("单选题".to_string()),
            stem: format!("question {id}"),
            options: vec![
                QuestionOption {
                    label: "A".to_string(),
                    text: "alpha".to_string(),
                },
                QuestionOption {
                    label: "B".to_string(),
                    text: "beta".to_string(),
                },
            ],
            my_answer: None,
            correct_answer: None,
            score: None,
        }
    }

    fn page(questions: Vec<Question>) -> WorkPage {
        WorkPage {
            final_url: "https://smartcourse.hust.edu.cn/mooc-ans/work/doHomeWorkNew?workId=work-1"
                .to_string(),
            status: WorkStatus::InProgress,
            questions,
            form: parse_work_form(WORK_HTML),
        }
    }

    fn answers() -> Vec<QuestionAnswer> {
        vec![
            QuestionAnswer {
                question_id: "101".to_string(),
                question_type: 0,
                answer: "B".to_string(),
                labels: vec!["B".to_string()],
                blanks: Vec::new(),
                text: "beta".to_string(),
                options: Vec::new(),
                source: None,
                confidence: None,
            },
            QuestionAnswer {
                question_id: "102".to_string(),
                question_type: 1,
                answer: "CA".to_string(),
                labels: vec!["C".to_string(), "A".to_string()],
                blanks: Vec::new(),
                text: String::new(),
                options: Vec::new(),
                source: None,
                confidence: None,
            },
            QuestionAnswer {
                question_id: "103".to_string(),
                question_type: 2,
                answer: "first；second".to_string(),
                labels: Vec::new(),
                blanks: vec!["first".to_string(), "second".to_string()],
                text: String::new(),
                options: Vec::new(),
                source: None,
                confidence: None,
            },
            QuestionAnswer {
                question_id: "104".to_string(),
                question_type: 3,
                answer: "对".to_string(),
                labels: Vec::new(),
                blanks: Vec::new(),
                text: "对".to_string(),
                options: Vec::new(),
                source: None,
                confidence: None,
            },
            QuestionAnswer {
                question_id: "105".to_string(),
                question_type: 4,
                answer: "Essay answer".to_string(),
                labels: Vec::new(),
                blanks: Vec::new(),
                text: "Essay answer".to_string(),
                options: Vec::new(),
                source: None,
                confidence: None,
            },
        ]
    }

    fn all_questions() -> Vec<Question> {
        let mut questions = vec![single("101"), single("102"), single("103"), single("104")];
        questions.push(Question {
            id: "105".to_string(),
            question_type: Some("简答题".to_string()),
            stem: "short".to_string(),
            options: Vec::new(),
            my_answer: None,
            correct_answer: None,
            score: None,
        });
        questions
    }

    fn field<'a>(fields: &'a [(String, String)], key: &str) -> Option<&'a str> {
        fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn parses_hidden_form_and_question_types() {
        let form = parse_work_form(WORK_HTML);
        assert_eq!(form.hidden_value("workAnswerId"), Some("9001"));
        assert_eq!(form.hidden_value("enc_work"), Some("enc-work"));
        assert_eq!(form.hidden_value("workTimesEnc"), Some(""));
        assert_eq!(form.question_type("101"), Some(0));
        assert_eq!(form.question_type("105"), Some(4));
        assert_eq!(form.question_ids, vec!["101", "102", "103", "104", "105"]);
        assert_eq!(form.method.as_deref(), Some("post"));
        assert!(
            form.action
                .as_deref()
                .unwrap()
                .starts_with("addStudentWorkNewWeb?")
        );
        assert!(!form.hidden.iter().any(|(key, _)| key == "answertype101"));
        assert!(form.hidden.iter().any(|(key, _)| key == "answerwqbid"));
    }

    #[test]
    fn builds_all_question_field_shapes() {
        let page = page(all_questions());
        let fields = build_submission_fields(&target(), &page, &answers()).unwrap();

        let mut seen = HashSet::new();
        for (key, _) in &fields {
            assert!(seen.insert(key.clone()), "duplicate form field {key}");
        }

        assert_eq!(field(&fields, "courseId"), Some("17310000026063"));
        assert_eq!(field(&fields, "classId"), Some("17310000023403"));
        assert_eq!(field(&fields, "workAnswerId"), Some("9001"));
        assert_eq!(field(&fields, "answerId"), Some("9001"));
        assert_eq!(field(&fields, "totalQuestionNum"), Some("5"));
        assert_eq!(field(&fields, "fullScore"), Some("50"));
        assert_eq!(field(&fields, "workRelationId"), Some("7001"));
        assert_eq!(field(&fields, "enc_work"), Some("enc-work"));
        assert_eq!(field(&fields, "enc"), Some(""));
        assert_eq!(field(&fields, "userId"), Some("6000"));
        assert_eq!(field(&fields, "knowledgeid"), Some("582304"));
        assert_eq!(field(&fields, "jobid"), Some("job-1"));
        assert_eq!(field(&fields, "answerwqbid"), Some("101,102,103,104,105,"));
        assert_eq!(field(&fields, "score101"), Some("10"));
        assert_eq!(field(&fields, "mooc"), None);
        assert_eq!(field(&fields, "isphone"), None);

        assert_eq!(field(&fields, "answertype101"), Some("0"));
        assert_eq!(field(&fields, "answer101"), Some("B"));
        assert_eq!(field(&fields, "answertype102"), Some("1"));
        assert_eq!(field(&fields, "answer102"), Some("AC"));
        assert_eq!(field(&fields, "answertype103"), Some("2"));
        assert_eq!(field(&fields, "tiankongsize103"), Some("2"));
        assert_eq!(field(&fields, "answer1031"), Some("first"));
        assert_eq!(field(&fields, "answer1032"), Some("second"));
        assert_eq!(field(&fields, "answerEditor1031"), Some("first"));
        assert_eq!(field(&fields, "answerEditor1032"), Some("second"));
        assert_eq!(field(&fields, "answertype104"), Some("3"));
        assert_eq!(field(&fields, "answer104"), Some("true"));
        assert_eq!(field(&fields, "answertype105"), Some("4"));
        assert_eq!(field(&fields, "answer105"), Some("Essay answer"));
        assert_eq!(field(&fields, "answerEditor105"), Some("Essay answer"));
    }

    #[test]
    fn page_type_overrides_the_planned_type() {
        let mut page = page(all_questions());
        page.form.question_types.insert("101".to_string(), 3);
        let mut answers = answers();
        answers[0].text = "错".to_string();
        let fields = build_submission_fields(&target(), &page, &answers).unwrap();
        assert_eq!(field(&fields, "answertype101"), Some("3"));
        assert_eq!(field(&fields, "answer101"), Some("false"));
    }

    #[test]
    fn refuses_graded_pages_and_missing_answers() {
        let mut work_page = page(all_questions());
        work_page.status = WorkStatus::Graded;
        let error = build_submission_fields(&target(), &work_page, &answers()).unwrap_err();
        assert!(error.to_string().contains("already graded"));

        let work_page = page(all_questions());
        let error = build_submission_fields(&target(), &work_page, &answers()[..2]).unwrap_err();
        assert!(error.to_string().contains("no answer for question(s)"));
    }

    #[test]
    fn builds_the_submit_url() {
        let page = page(all_questions());
        let url = submission_url(
            &Url::parse("https://smartcourse.hust.edu.cn/").unwrap(),
            &target(),
            &page,
            123456,
        )
        .unwrap();
        assert!(
            url.starts_with("https://smartcourse.hust.edu.cn/mooc-ans/work/addStudentWorkNewWeb?")
        );
        for pair in [
            "token=enc-work",
            "totalQuestionNum=enc-total",
            "workid=7001",
            "courseid=17310000026063",
            "jobid=job-1",
            "testmooc2=1",
            "originJobId=job-1",
            "wMicroNodeId=0",
            "ua=pc",
            "formType=post",
            "saveStatus=1",
            "pos=",
            "version=1",
        ] {
            assert!(url.contains(pair), "URL is missing {pair}: {url}");
        }
        assert!(!url.contains("ut=s"));
        assert!(!url.contains("t=123456"));
    }

    #[test]
    fn falls_back_to_a_built_url_without_form_action() {
        let mut work_page = page(all_questions());
        work_page.form.action = None;
        let url = submission_url(
            &Url::parse("https://smartcourse.hust.edu.cn/").unwrap(),
            &target(),
            &work_page,
            123456,
        )
        .unwrap();
        for pair in [
            "keyboardDisplayRequiresUserAction=1",
            "token=enc-work",
            "workAnswerId=9001",
            "workid=7001",
            "ut=s",
            "t=123456",
            "ua=pc",
            "formType=post",
        ] {
            assert!(url.contains(pair), "URL is missing {pair}: {url}");
        }
    }

    #[test]
    fn parses_submit_responses() {
        let ok = parse_submit_reply(r#"{"status":true,"msg":"提交成功"}"#).unwrap();
        assert!(ok.success);
        assert_eq!(ok.message, "提交成功");

        let rejected = parse_submit_reply(r#"{"status":false,"msg":"已交卷"}"#).unwrap();
        assert!(!rejected.success);
        assert_eq!(rejected.message, "已交卷");

        assert!(parse_submit_reply(r#"{"status":"true"}"#).unwrap().success);
        assert!(parse_submit_reply("提交成功").unwrap().success);
        assert!(
            parse_submit_reply("<html><title>passport login</title></html>")
                .unwrap_err()
                .to_string()
                .contains("login expired")
        );
        assert!(parse_submit_reply("   ").is_err());
    }

    #[test]
    fn encodes_real_bank_answers() {
        let bank = bank();
        let cases: [(&str, u32); 6] = [
            ("676210", 0),
            ("676250", 1),
            ("676256", 2),
            ("676440", 3),
            ("681357", 2),
            ("676380", 4),
        ];
        for (id, expected_type) in cases {
            let bank_answer = bank.by_id(id).unwrap();
            let question = Question {
                id: id.to_string(),
                question_type: Some(bank_answer.question_type.clone()),
                stem: bank_answer.stem.clone(),
                options: bank_answer.options.clone(),
                my_answer: None,
                correct_answer: None,
                score: None,
            };
            let answer = QuestionAnswer::from_bank(&question, bank_answer).unwrap();
            assert_eq!(answer.question_type, expected_type, "type for {id}");
            let mut fields = Vec::new();
            answer
                .encode_fields(answer.question_type, &mut fields)
                .unwrap();
        }

        let judge = bank.by_id("676440").unwrap();
        let question = Question {
            id: judge.question_id.clone(),
            question_type: Some(judge.question_type.clone()),
            stem: judge.stem.clone(),
            options: judge.options.clone(),
            my_answer: None,
            correct_answer: None,
            score: None,
        };
        let answer = QuestionAnswer::from_bank(&question, judge).unwrap();
        let mut fields = Vec::new();
        answer.encode_fields(3, &mut fields).unwrap();
        assert_eq!(field(&fields, "answer676440"), Some("true"));

        let fill = bank.by_id("681357").unwrap();
        let question = Question {
            id: fill.question_id.clone(),
            question_type: Some(fill.question_type.clone()),
            stem: fill.stem.clone(),
            options: fill.options.clone(),
            my_answer: None,
            correct_answer: None,
            score: None,
        };
        let answer = QuestionAnswer::from_bank(&question, fill).unwrap();
        let mut fields = Vec::new();
        answer.encode_fields(2, &mut fields).unwrap();
        assert_eq!(field(&fields, "tiankongsize681357"), Some("3"));
        assert_eq!(field(&fields, "answer6813571"), Some("人民安全"));
        assert_eq!(field(&fields, "answer6813573"), Some("经济安全"));
    }

    fn summary() -> CourseSummary {
        CourseSummary {
            course_id: "17310000026063".to_string(),
            class_id: "17310000023403".to_string(),
            cpi: "17310000196268".to_string(),
            name: "大学英语词汇解析(一)".to_string(),
            cover_url: None,
            source: None,
            kc_enc: None,
            ck_enc: None,
            clazz_enc: None,
            detail_url: "https://example.test/course".to_string(),
        }
    }

    fn work_point(work_id: &str, questions: Vec<Question>, status: &str) -> TaskPoint {
        TaskPoint {
            kind: TaskKind::Work,
            source_type: "workid".to_string(),
            name: format!("work {work_id}"),
            job_id: Some(format!("job-{work_id}")),
            object_id: None,
            mid: None,
            size_bytes: None,
            content_ext: None,
            completed: None,
            played_ms: None,
            duration_secs: None,
            work_id: Some(work_id.to_string()),
            work_type: Some("workA".to_string()),
            work_status: Some(status.to_string()),
            enc: Some(format!("enc-{work_id}")),
            other_info: None,
            att_duration_enc: None,
            rt: None,
            video_face_capture_enc: None,
            video: None,
            questions,
            raw: serde_json::Value::Null,
        }
    }

    #[test]
    fn plans_course_works_and_skips_graded() {
        let bank = bank();
        let card = Card {
            index: 1,
            card_id: Some("card-1".to_string()),
            title: "练习题".to_string(),
            task_points: vec![
                work_point("graded-work", vec![single("676210")], "graded"),
                work_point(
                    "in-progress-work",
                    vec![
                        single("676210"),
                        Question {
                            id: "676256".to_string(),
                            question_type: Some("填空题".to_string()),
                            stem: "fill".to_string(),
                            options: Vec::new(),
                            my_answer: None,
                            correct_answer: None,
                            score: None,
                        },
                    ],
                    "in_progress",
                ),
            ],
            playback: Some(PlaybackEnv {
                user_id: Some("6000".to_string()),
                clazz_id: Some("17310000023403".to_string()),
                course_id: Some("17310000026063".to_string()),
                fid: Some("1731".to_string()),
                report_url: None,
                report_interval_secs: None,
                ktoken: Some("kt-1".to_string()),
            }),
        };
        let course = CourseDetail {
            course: summary(),
            title: "大学英语词汇解析(一)".to_string(),
            enc: None,
            old_enc: None,
            openc: None,
            final_url: "https://example.test/course".to_string(),
            chapters: vec![Chapter {
                id: "582304".to_string(),
                title: "3.11 单元测试".to_string(),
                number: Some("3.11".to_string()),
                level: 2,
                is_leaf: true,
                completed: Some(false),
                children: Vec::new(),
                cards: vec![card],
            }],
            stats: CourseStats::default(),
        };

        let plan = plan_course(&course, &bank);
        assert_eq!(plan.skipped_graded, 1);
        assert_eq!(plan.works.len(), 1);
        let work = &plan.works[0];
        assert_eq!(work.work_id, "in-progress-work");
        assert_eq!(work.chapter_title, "3.11 单元测试");
        assert_eq!(work.question_count, 2);
        assert!(work.is_complete(), "{work:?}");
        assert_eq!(work.target.ktoken.as_deref(), Some("kt-1"));
        assert_eq!(work.target.user_id.as_deref(), Some("6000"));
        assert_eq!(work.answers[0].labels, vec!["B"]);
        assert_eq!(work.answers[1].blanks, vec!["frolicking"]);
    }

    #[test]
    fn every_test_data_question_has_an_encodable_answer() {
        #[derive(serde::Deserialize)]
        struct Dump {
            courses: Vec<Course>,
        }
        #[derive(serde::Deserialize)]
        struct Course {
            course_id: String,
            chapters: Vec<Chapter>,
        }

        let dump: Dump = serde_json::from_str(include_str!("../test-data/courses.json"))
            .expect("test-data courses.json must parse into the core models");
        let bank = bank();

        let mut works = 0usize;
        let mut questions = 0usize;
        for course in &dump.courses {
            fn walk(
                chapters: &[Chapter],
                course_id: &str,
                bank: &AnswerBank,
                works: &mut usize,
                questions: &mut usize,
            ) {
                for chapter in chapters {
                    for card in &chapter.cards {
                        for point in &card.task_points {
                            if point.kind != TaskKind::Work {
                                continue;
                            }
                            *works += 1;
                            *questions += point.questions.len();
                            let plan = plan_questions(
                                &point.questions,
                                bank,
                                course_id,
                                point.work_id.as_deref().unwrap_or_default(),
                            );
                            assert!(
                                plan.is_complete(),
                                "work {:?} is incomplete: {plan:?}",
                                point.work_id
                            );
                            assert_eq!(plan.answers.len(), point.questions.len());
                        }
                    }
                    walk(&chapter.children, course_id, bank, works, questions);
                }
            }
            walk(
                &course.chapters,
                &course.course_id,
                &bank,
                &mut works,
                &mut questions,
            );
        }

        assert_eq!(works, 117);
        assert_eq!(questions, 541);
    }
}
