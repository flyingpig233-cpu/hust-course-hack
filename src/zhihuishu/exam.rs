//! Zhihuishu homework / final-exam reading, answer-bank extraction and
//! answer planning.
//!
//! The exam APIs live on `studentexam-api.zhihuishu.com/studentExam/gateway/t/v1`
//! (main engine) and `taurusexam-api.zhihuishu.com/taurusExam/gateway/t/v1`
//! (final-exam engine). Both use the same static `secretStr` wrapper as the
//! video endpoints, encrypted with the **module 3** key fetched at runtime from
//! the `c/has` handshake. There is no outer timestamp parameter.
//!
//! Verified requests/responses (2026-11-09): `student/getStudentHomework`,
//! `student/getStudentFinalExam`, `student/lookHomework`,
//! `answer/getStuAnswerInfo`, `answer/checkAnswerSheetInfo`,
//! `answer/saveStudentAnswer`, `answer/submit`. `lookHomework` never returns
//! correct answers; answers can only be recovered from submitted papers (full
//! marks) or from the AI-analysis text the exam page shows after submission.
//!
//! Nothing here logs the `AUTHORIZATION` token, encrypted bodies or full URLs.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, bail};
use reqwest::header::{CONTENT_TYPE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::form_urlencoded;

use super::{EXAM_API_BASE, MODULE_EXAM, TAURUS_EXAM_API_BASE, ZHS_USER_AGENT, ZhsClient, crypto};

/// Exam page Referer expected by the exam APIs.
const EXAM_REFERER: &str = "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html";

/// Homework / unit-test list.
const HOMEWORK_PATH: &str = "student/getStudentHomework";
/// Final-exam list (taurus engine).
const FINAL_EXAM_PATH: &str = "student/getStudentFinalExam";
/// Exam paper (questions + options only, no answers).
const LOOK_HOMEWORK_PATH: &str = "student/lookHomework";
/// Enter a homework/unit-test attempt and return its paper (`openHomework`).
const OPEN_HOMEWORK_PATH: &str = "student/doHomework";
/// Enter an exam attempt (taurus engine) and return its paper.
///
/// The page's `openExam` helper calls **`student/doExam` on the taurus engine**
/// (`taurusexam-api…/taurusExam/gateway/t/v1/student/doExam`); the main engine
/// exposes the same path for non-taurus exams.
const OPEN_EXAM_PATH: &str = "student/doExam";
/// Submitted answers of one paper.
const ANSWER_INFO_PATH: &str = "answer/getStuAnswerInfo";
/// Per-question scores of one submitted paper.
const ANSWER_SHEET_PATH: &str = "answer/checkAnswerSheetInfo";
/// Save one answer.
const SAVE_ANSWER_PATH: &str = "answer/saveStudentAnswer";
/// Submit the paper.
const SUBMIT_PATH: &str = "answer/submit";
/// School info (fallback source for `schoolId`).
const LOGIN_SCHOOL_INFO_PATH: &str = "exam/getLoginSchoolInfo";

/// Shared answer bank shipped with the binary (empty by default; grown locally
/// by `zhs exam bank --from-submission`).
pub const DEFAULT_ANSWER_BANK_JSON: &str =
    include_str!("../../test-data/zhihuishu-answer-bank.json");

/// Default answer-bank path used by the CLI.
pub const DEFAULT_ANSWER_BANK_PATH: &str = "test-data/zhihuishu-answer-bank.json";

/// One homework / unit-test / meet-quiz entry.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ZhsHomework {
    /// `stuExamId` (the `id` of the list item).
    pub stu_exam_id: String,
    /// `examId` used by the paper/answer APIs.
    pub exam_id: String,
    /// Exam name.
    pub name: String,
    /// Platform state code.
    pub state: Option<i64>,
    /// Achieved score.
    pub achieve: Option<f64>,
    /// Number of attempts.
    pub achieve_count: Option<i64>,
    /// Remaining attempts (`backNum`).
    pub back_num: Option<i64>,
    /// Score, when the platform already graded the paper.
    pub score: Option<f64>,
    /// Number of questions.
    pub problem_num: Option<i64>,
    /// Total score of the paper.
    pub total_score: Option<f64>,
    /// `meetCourseType` (`1` = meet-course quiz).
    pub meet_course_type: Option<i64>,
    /// Chapter id, when the paper belongs to a chapter.
    pub chapter_id: Option<String>,
    /// `isCheckAnswer` flag.
    pub is_check_answer: Option<i64>,
    /// Parent course id.
    pub course_id: String,
    /// Parent recruit id.
    pub recruit_id: String,
    /// Teacher / exam author name.
    pub exam_user_name: Option<String>,
}

impl ZhsHomework {
    /// Stable label for CLI output.
    pub fn label(&self) -> String {
        format!("{}（examId={}）", self.name, self.exam_id)
    }
}

/// One final-exam entry (`student/getStudentFinalExam`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ZhsFinalExam {
    /// `stuExamId`.
    pub stu_exam_id: String,
    /// `examId`.
    pub exam_id: String,
    /// Exam name.
    pub name: String,
    /// Number of questions.
    pub problem_num: Option<i64>,
    /// Total score.
    pub total_score: Option<f64>,
    /// Time limit in minutes.
    pub limit_time: Option<i64>,
    /// Remaining attempts (`faStudentExamRemainCount`).
    pub remain_count: Option<i64>,
    /// Parent course id.
    pub course_id: String,
    /// Parent recruit id.
    pub recruit_id: String,
}

/// One option of an exam question.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsExamOption {
    /// Option id (`questionOptions[].id`).
    pub id: String,
    /// Option content; this is the only stable key across randomized attempts.
    pub content: String,
}

/// One exam question (no correct answer is provided by the API).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsExamQuestion {
    /// Question id (`questionDtos[].id`).
    pub id: String,
    /// Stem text.
    pub stem: String,
    /// Question type id.
    pub kind_id: i64,
    /// Question type name (e.g. 单选题).
    pub kind_name: String,
    /// Options in the current attempt's order.
    pub options: Vec<ZhsExamOption>,
    /// Full score of the question.
    pub score: i64,
    /// Optional `eid` field sent back in `saveStudentAnswer`.
    pub eid: Option<String>,
}

impl ZhsExamQuestion {
    /// Whether the question is a multiple-choice question (more than one answer).
    pub fn is_multiple(&self) -> bool {
        self.kind_id == 2 || self.kind_name.contains("多选")
    }

    /// Bank key: normalized stem with HTML tags removed.
    pub fn bank_key(&self) -> String {
        normalize_stem_text(&self.stem)
    }
}

/// One part (大题) of a paper.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsExamPart {
    /// Sort order (`startSort`).
    pub sort: i64,
    /// Question count reported by the platform.
    pub question_count: i64,
    /// Questions of this part.
    pub questions: Vec<ZhsExamQuestion>,
}

/// One exam paper (`student/lookHomework`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ZhsExamPaper {
    /// Exam name.
    pub exam_name: String,
    /// Course name.
    pub course_name: String,
    /// Paper total score.
    pub total_score: f64,
    /// Number of questions.
    pub problem_num: i64,
    /// Parts in platform order.
    pub parts: Vec<ZhsExamPart>,
}

impl ZhsExamPaper {
    /// All questions in paper order.
    pub fn questions(&self) -> impl Iterator<Item = &ZhsExamQuestion> {
        self.parts.iter().flat_map(|part| part.questions.iter())
    }

    /// Total number of questions.
    pub fn question_count(&self) -> usize {
        self.questions().count()
    }
}

/// One answer recovered from a submitted paper.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ZhsSubmittedAnswer {
    /// Question id.
    pub question_id: String,
    /// Selected option ids (comma-separated in the API).
    pub option_ids: Vec<String>,
    /// Score awarded for the question.
    pub score: f64,
}

/// Per-attempt context required by the paper / save / submit APIs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsExamContext {
    /// `recruitId` as a string (the APIs send numbers as strings).
    pub recruit_id: String,
    /// `courseId` (the internal course id, not the `ocId`).
    pub course_id: String,
    /// `stuExamId`.
    pub stu_exam_id: String,
    /// `examId`.
    pub exam_id: String,
    /// `schoolId`.
    pub school_id: String,
    /// `examType` sent by `saveStudentAnswer`.
    ///
    /// The browser reads it from `localStorage.setGoErweimaObj.examType` and
    /// sends an empty string when the exam did not go through the QR-code flow;
    /// it is kept as a string so callers can mirror that exactly.
    pub exam_type: String,
    /// `fromType` sent by `saveStudentAnswer` (the browser sends `3`).
    pub from_type: i64,
    /// `deviceId` sent by `saveStudentAnswer` (the browser sends a random
    /// `DEVICE_CODE` fingerprint; an empty string is accepted by the API for
    /// scripted saves).
    pub device_id: String,
}

impl ZhsExamContext {
    /// Build the context from a homework entry and the resolved school id.
    pub fn from_homework(homework: &ZhsHomework, school_id: impl Into<String>) -> Self {
        Self {
            recruit_id: homework.recruit_id.clone(),
            course_id: homework.course_id.clone(),
            stu_exam_id: homework.stu_exam_id.clone(),
            exam_id: homework.exam_id.clone(),
            school_id: school_id.into(),
            exam_type: String::new(),
            from_type: 3,
            device_id: String::new(),
        }
    }

    /// Payload shared by `lookHomework` / `getStuAnswerInfo` / `answer/submit`.
    fn paper_payload(&self) -> Value {
        json!({
            "recruitId": self.recruit_id,
            "studentExamId": self.stu_exam_id,
            "examId": self.exam_id,
            "schoolId": self.school_id,
            "courseId": self.course_id,
        })
    }

    /// Payload of `student/openExam` (note `studentExamId` spelling).
    fn open_exam_payload(&self) -> Value {
        json!({
            "recruitId": self.recruit_id,
            "examId": self.exam_id,
            "studentExamId": self.stu_exam_id,
            "schoolId": self.school_id,
            "courseId": self.course_id,
            "deviceId": self.device_id,
        })
    }
}

/// Where a planned answer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZhsAnswerSource {
    /// Recovered from a fully-correct submitted paper.
    Submitted,
    /// Parsed from the exam page's AI-analysis text.
    AiAnalysis,
    /// Resolved from the local answer bank without source tracking.
    Bank,
}

impl ZhsAnswerSource {
    /// Chinese label for CLI output.
    pub fn label(self) -> &'static str {
        match self {
            Self::Submitted => "已提交满分",
            Self::AiAnalysis => "AI解析",
            Self::Bank => "答案库",
        }
    }
}

/// One resolved question of an answer plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsQuestionPlan {
    /// The question being answered.
    pub question: ZhsExamQuestion,
    /// Option ids to select, in paper order.
    pub option_ids: Vec<String>,
    /// Option contents to select (stable across randomized attempts).
    pub option_contents: Vec<String>,
    /// Where the answer came from.
    pub source: ZhsAnswerSource,
}

/// Answer plan for one paper.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ZhsExamPlan {
    /// Attempt context.
    pub context: ZhsExamContext,
    /// Paper metadata.
    pub paper: ZhsExamPaper,
    /// Questions with a resolved answer.
    pub questions: Vec<ZhsQuestionPlan>,
    /// Question ids that have no trusted answer.
    pub unresolved: Vec<String>,
}

impl ZhsExamPlan {
    /// Whether every question has an answer (required before real submission).
    pub fn is_complete(&self) -> bool {
        self.unresolved.is_empty() && self.questions.len() == self.paper.question_count()
    }
}

/// One answer bank entry, keyed by normalized stem.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsBankEntry {
    /// Normalized stem (`crate::answers::normalize_stem`).
    pub key: String,
    /// Original stem.
    pub stem: String,
    /// `single` / `multiple` / `judge`.
    pub question_type: String,
    /// Correct option **contents** (never option ids: option order is randomized).
    pub answers: Vec<String>,
    /// `submitted` / `ai_analysis`.
    pub source: String,
    /// Last update time (Unix seconds).
    pub updated_at_unix: u64,
}

/// Persisted answer bank.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZhsAnswerBank {
    /// Schema version.
    pub version: u32,
    /// Platform marker.
    pub platform: String,
    /// Generation time (Unix seconds).
    pub generated_at_unix: u64,
    /// Description of the sources.
    pub source: String,
    /// Entries.
    pub entries: Vec<ZhsBankEntry>,
}

impl ZhsAnswerBank {
    /// Parse the bank embedded in the binary.
    pub fn builtin() -> Self {
        Self::from_json_str(DEFAULT_ANSWER_BANK_JSON)
            .expect("embedded Zhihuishu answer bank must be valid JSON")
    }

    /// Parse a bank from JSON text.
    pub fn from_json_str(text: &str) -> Result<Self> {
        serde_json::from_str(text).context("invalid Zhihuishu answer-bank JSON")
    }

    /// Load a bank file; a missing file falls back to the embedded bank.
    pub fn load_or_builtin(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if !path.exists() {
            return Ok(Self::builtin());
        }
        let text = fs::read_to_string(path)
            .with_context(|| format!("failed to read answer bank {}", path.display()))?;
        Self::from_json_str(&text)
    }

    /// Serialize the bank as pretty JSON and write it atomically enough for CLI use.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(self).context("failed to serialize answer bank")?;
        fs::write(path, text)
            .with_context(|| format!("failed to write answer bank {}", path.display()))
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the bank has no entry.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Find the entry of one question (normalized stem).
    pub fn entry_for(&self, question: &ZhsExamQuestion) -> Option<&ZhsBankEntry> {
        let key = question.bank_key();
        if key.is_empty() {
            return None;
        }
        self.entries.iter().find(|entry| entry.key == key)
    }

    /// Resolve a question's correct options against the current attempt's
    /// options, returning the option ids in the bank's content order.
    pub fn resolve(&self, question: &ZhsExamQuestion) -> Option<Vec<ZhsExamOption>> {
        let entry = self.entry_for(question)?;
        if entry.answers.is_empty() {
            return None;
        }
        let mut resolved = Vec::with_capacity(entry.answers.len());
        for answer in &entry.answers {
            let normalized = normalize_content(answer);
            let option = question
                .options
                .iter()
                .find(|option| normalize_content(&option.content) == normalized)?;
            if resolved
                .iter()
                .any(|item: &ZhsExamOption| item.id == option.id)
            {
                return None;
            }
            resolved.push(option.clone());
        }
        Some(resolved)
    }

    /// Record answers extracted from a submitted paper.
    ///
    /// Only questions with full marks are recorded; a partially-correct
    /// submission does not reveal which answer was wrong.
    pub fn record_submitted(
        &mut self,
        paper: &ZhsExamPaper,
        submitted: &[ZhsSubmittedAnswer],
        now_unix: u64,
    ) -> usize {
        let by_question: BTreeMap<&str, &ZhsSubmittedAnswer> = submitted
            .iter()
            .map(|answer| (answer.question_id.as_str(), answer))
            .collect();
        let mut recorded = 0;
        for question in paper.questions() {
            let Some(answer) = by_question.get(question.id.as_str()) else {
                continue;
            };
            if question.score <= 0 || answer.score + 0.001 < question.score as f64 {
                continue;
            }
            let mut contents = Vec::with_capacity(answer.option_ids.len());
            for option_id in &answer.option_ids {
                if let Some(option) = question.options.iter().find(|item| &item.id == option_id) {
                    contents.push(option.content.clone());
                }
            }
            if contents.len() != answer.option_ids.len() || contents.is_empty() {
                continue;
            }
            if self.upsert(question, contents, "submitted", now_unix) {
                recorded += 1;
            }
        }
        recorded
    }

    /// Record answers parsed from saved AI-analysis texts (`questionId -> text`).
    pub fn record_ai_analysis(
        &mut self,
        paper: &ZhsExamPaper,
        texts: &HashMap<String, String>,
        now_unix: u64,
    ) -> usize {
        let mut recorded = 0;
        for question in paper.questions() {
            let Some(text) = texts.get(&question.id) else {
                continue;
            };
            let Some(contents) = parse_ai_analysis(text, question) else {
                continue;
            };
            if self.upsert(question, contents, "ai_analysis", now_unix) {
                recorded += 1;
            }
        }
        recorded
    }

    /// Insert or update one entry. AI-analysis answers never overwrite an answer
    /// recovered from a fully-correct submitted paper.
    fn upsert(
        &mut self,
        question: &ZhsExamQuestion,
        answers: Vec<String>,
        source: &str,
        now_unix: u64,
    ) -> bool {
        let key = question.bank_key();
        if key.is_empty() || answers.is_empty() {
            return false;
        }
        if let Some(existing) = self.entries.iter_mut().find(|entry| entry.key == key) {
            if existing.source == "submitted" && source != "submitted" {
                return false;
            }
            existing.answers = answers;
            existing.source = source.to_string();
            existing.updated_at_unix = now_unix;
            existing.stem = question.stem.clone();
            existing.question_type = question_type_label(question).to_string();
            return true;
        }
        self.entries.push(ZhsBankEntry {
            key,
            stem: question.stem.clone(),
            question_type: question_type_label(question).to_string(),
            answers,
            source: source.to_string(),
            updated_at_unix: now_unix,
        });
        true
    }
}

/// Build an answer plan from a paper and the answer bank.
pub fn plan_exam(
    paper: &ZhsExamPaper,
    context: &ZhsExamContext,
    bank: &ZhsAnswerBank,
) -> ZhsExamPlan {
    let mut plan = ZhsExamPlan {
        context: context.clone(),
        paper: paper.clone(),
        questions: Vec::new(),
        unresolved: Vec::new(),
    };
    for question in paper.questions() {
        match bank.resolve(question) {
            Some(options) => {
                let source = bank
                    .entry_for(question)
                    .map(|entry| match entry.source.as_str() {
                        "submitted" => ZhsAnswerSource::Submitted,
                        "ai_analysis" => ZhsAnswerSource::AiAnalysis,
                        _ => ZhsAnswerSource::Bank,
                    })
                    .unwrap_or(ZhsAnswerSource::Bank);
                plan.questions.push(ZhsQuestionPlan {
                    question: question.clone(),
                    option_ids: options.iter().map(|option| option.id.clone()).collect(),
                    option_contents: options
                        .iter()
                        .map(|option| option.content.clone())
                        .collect(),
                    source,
                });
            }
            None => plan.unresolved.push(question.id.clone()),
        }
    }
    plan
}

/// Parse the AI-analysis panel text of one question into correct option contents.
///
/// The check page renders an AI-written analysis; it identifies the correct
/// option in prose (e.g. "正确答案是D", "故选 A、C", "B项错误…"). This parser
/// only accepts unambiguous markers and returns `None` for anything vague, so
/// a doubtful text is never treated as a correct answer.
pub fn parse_ai_analysis(text: &str, question: &ZhsExamQuestion) -> Option<Vec<String>> {
    if text.trim().is_empty() || question.options.is_empty() {
        return None;
    }

    let mut negative: HashSet<char> = HashSet::new();
    for letter in letters_with_context(text) {
        if has_negative_context(text, letter.1) {
            negative.insert(letter.0);
        }
    }

    let mut positive: Vec<char> = Vec::new();
    for (letter, index) in letters_with_context(text) {
        // "不正确"/"不符合" also contains the substring "正确"; skip any letter
        // whose context is explicitly negative before checking positives.
        if has_negative_context(text, index) {
            continue;
        }
        if has_positive_context(text, index) {
            push_unique(&mut positive, letter);
        }
    }
    if positive.is_empty() {
        positive = marker_letters(text);
    }
    positive.retain(|letter| !negative.contains(letter));

    if !positive.is_empty() {
        let mut contents = Vec::with_capacity(positive.len());
        for letter in positive {
            let index = (letter as u8 - b'A') as usize;
            let option = question.options.get(index)?;
            if option.content.trim().is_empty() {
                return None;
            }
            contents.push(option.content.clone());
        }
        if contents.len() == 1 && question.is_multiple() {
            // A multiple-choice question needs at least two options; a single
            // letter is usually the AI discussing a distractor.
            return None;
        }
        return Some(contents);
    }

    content_fallback(text, question)
}

fn push_unique(target: &mut Vec<char>, value: char) {
    if !target.contains(&value) {
        target.push(value);
    }
}

fn normalize_content(text: &str) -> String {
    strip_html_tags(text)
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_ascii_punctuation())
        .collect::<String>()
        .to_lowercase()
}

/// Bank/reference key: HTML tags removed, then the shared stem normalizer.
fn normalize_stem_text(text: &str) -> String {
    crate::answers::normalize_stem(&strip_html_tags(text))
}

/// Whether an error is the platform's anti-cheat / slider-verification prompt.
fn needs_human_verification(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<super::ZhsError>()
            .is_some_and(|error| {
                error.code == -12
                    || error.message.contains("滑块")
                    || error.message.contains("验证")
            })
    })
}

/// Strip HTML tags (`<p>`, `<br/>`, `<span style=…>`) from exam stems/options.
fn strip_html_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn question_type_label(question: &ZhsExamQuestion) -> &'static str {
    if question.is_multiple() {
        "multiple"
    } else if question.kind_id == 3 || question.kind_name.contains("判断") {
        "judge"
    } else {
        "single"
    }
}

/// Uppercase option letters paired with their byte index in `text`.
fn letters_with_context(text: &str) -> Vec<(char, usize)> {
    let mut out = Vec::new();
    for (index, ch) in text.char_indices() {
        if ch.is_ascii_uppercase() && ('A'..='H').contains(&ch) {
            out.push((ch, index));
        }
    }
    out
}

fn context_window(text: &str, index: usize) -> &str {
    let rest = &text[index..];
    let mut end = rest.len().min(12);
    // Stop at the end of the clause: a distractor mentioned in the next
    // sentence ("D。A项错误") must not turn D into a negative candidate.
    for (offset, ch) in rest.char_indices() {
        if offset >= 12 {
            break;
        }
        if matches!(ch, '。' | '；' | ';' | '！' | '!' | '\n' | '，' | ',') {
            end = offset;
            break;
        }
    }
    while end < rest.len() && !rest.is_char_boundary(end) {
        end += 1;
    }
    &rest[..end]
}

fn has_negative_context(text: &str, index: usize) -> bool {
    let window = context_window(text, index);
    ["错误", "不正确", "不符合", "排除", "错项"]
        .iter()
        .any(|marker| window.contains(marker))
}

fn has_positive_context(text: &str, index: usize) -> bool {
    let window = context_window(text, index);
    window.contains("正确") || window.contains("对")
}

/// Letters directly following a "the correct answer is …" marker.
fn marker_letters(text: &str) -> Vec<char> {
    const MARKERS: [&str; 8] = [
        "正确答案",
        "答案为",
        "答案是",
        "答案：",
        "故选",
        "应选",
        "正确选项",
        "综上",
    ];
    for marker in MARKERS {
        let Some(position) = text.find(marker) else {
            continue;
        };
        let tail = &text[position + marker.len()..];
        let mut letters = Vec::new();
        for ch in tail.chars().take(24) {
            if ch.is_ascii_uppercase() && ('A'..='H').contains(&ch) {
                push_unique(&mut letters, ch);
            } else if ch.is_ascii_digit()
                || matches!(ch, '。' | '；' | ';' | '\n' | '！' | '!' | '，' | ',')
            {
                break;
            }
        }
        if !letters.is_empty() {
            return letters;
        }
    }
    Vec::new()
}

/// Last resort: locate an option content in the text right after a positive marker.
///
/// The search starts **after** the marker itself so the words "正确答案" do not
/// match an option literally named 正确 (judgement questions).
fn content_fallback(text: &str, question: &ZhsExamQuestion) -> Option<Vec<String>> {
    const MARKERS: [&str; 7] = [
        "正确答案",
        "答案为",
        "答案是",
        "答案：",
        "故选",
        "应选",
        "综上",
    ];
    for marker in MARKERS {
        let Some(position) = text.find(marker) else {
            continue;
        };
        let tail = &text[position + marker.len()..];
        let all: Vec<&ZhsExamOption> = question
            .options
            .iter()
            .filter(|option| {
                let content = option.content.trim();
                !content.is_empty() && tail.contains(content)
            })
            .collect();
        // Drop option contents that are substrings of other matched contents.
        let matched: Vec<&ZhsExamOption> = all
            .iter()
            .copied()
            .filter(|option| {
                !all.iter().any(|other| {
                    other.content.trim() != option.content.trim()
                        && other.content.contains(option.content.trim())
                })
            })
            .collect();
        if matched.len() == 1 {
            return Some(vec![matched[0].content.clone()]);
        }
        if question.is_multiple() && !matched.is_empty() {
            return Some(
                matched
                    .iter()
                    .map(|option| option.content.clone())
                    .collect(),
            );
        }
    }
    None
}

/// Zhihuishu exam client: same session and module-key plumbing as [`ZhsClient`],
/// but a different API base and the module-3 `secretStr` wrapper.
#[derive(Clone)]
pub struct ZhsExamClient {
    zhs: ZhsClient,
    base: String,
    taurus_base: String,
    school: Arc<Mutex<Option<String>>>,
}

impl ZhsExamClient {
    /// Build an exam client from an existing Zhihuishu client (production bases).
    pub fn new(zhs: ZhsClient) -> Self {
        Self::with_bases(zhs, EXAM_API_BASE, TAURUS_EXAM_API_BASE)
    }

    /// Build an exam client with explicit engine bases (used by mock tests).
    pub fn with_bases(
        zhs: ZhsClient,
        base: impl Into<String>,
        taurus_base: impl Into<String>,
    ) -> Self {
        Self {
            zhs,
            base: base.into().trim_end_matches('/').to_string(),
            taurus_base: taurus_base.into().trim_end_matches('/').to_string(),
            school: Arc::new(Mutex::new(None)),
        }
    }

    /// Build from a Netscape cookies file.
    pub fn from_cookie_file(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self::new(ZhsClient::from_cookie_file(path)?))
    }

    /// Build from a raw `Cookie:` header.
    pub fn from_cookie_header(header: &str) -> Result<Self> {
        Ok(Self::new(ZhsClient::from_cookie_header(header)?))
    }

    /// Underlying Zhihuishu client (session access).
    pub fn inner(&self) -> &ZhsClient {
        &self.zhs
    }

    /// Main exam engine base in use.
    pub fn base(&self) -> &str {
        &self.base
    }

    /// Taurus engine base in use (final exams).
    pub fn taurus_base(&self) -> &str {
        &self.taurus_base
    }

    async fn post_at(&self, base: &str, path: &str, payload: &Value) -> Result<Value> {
        let key = self.zhs.module_key(MODULE_EXAM).await?;
        let secret = crypto::encrypt_secret_json(&key, payload)?;
        let body = form_urlencoded::Serializer::new(String::new())
            .append_pair("secretStr", &secret)
            .finish();
        let url = format!("{base}/{path}");
        let response = self
            .zhs
            .http()
            .post(&url)
            .header(
                CONTENT_TYPE,
                "application/x-www-form-urlencoded; charset=UTF-8",
            )
            .header(USER_AGENT, ZHS_USER_AGENT)
            .header(REFERER, EXAM_REFERER)
            .body(body)
            .send()
            .await
            .map_err(|error| error.without_url())
            .with_context(|| format!("request to {path} failed"))?;
        self.zhs.read_json_response(path, response).await
    }

    /// Resolve the school id from the session cookie or `getLoginSchoolInfo`.
    async fn school_id(&self) -> Result<String> {
        if let Some(cached) = self
            .school
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
            return Ok(cached);
        }
        let school = if let Some(id) = self.zhs.school_id() {
            id.to_string()
        } else {
            let value = self
                .post_at(&self.base, LOGIN_SCHOOL_INFO_PATH, &json!({}))
                .await?;
            value
                .pointer("/rt/schoolId")
                .and_then(value_text)
                .context("无法从知到获取 schoolId，请确认登录态有效")?
        };
        let mut cache = self
            .school
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *cache = Some(school.clone());
        Ok(school)
    }

    /// Build the per-attempt context of one homework entry.
    pub async fn context_for(&self, homework: &ZhsHomework) -> Result<ZhsExamContext> {
        let school_id = self.school_id().await?;
        Ok(ZhsExamContext::from_homework(homework, school_id))
    }

    /// List unsubmitted (`flag=1`) or submitted (`flag=2`) homework / unit tests.
    pub async fn list_homework(
        &self,
        recruit_id: u64,
        course_id: u64,
        submitted: bool,
    ) -> Result<Vec<ZhsHomework>> {
        let flag = if submitted { 2 } else { 1 };
        let mut all = Vec::new();
        for page in 0..=20u64 {
            let payload = json!({
                "recruitId": recruit_id.to_string(),
                "courseId": course_id,
                "flag": flag,
                "pageSize": 100,
                "pageNum": page,
            });
            let value = self
                .post_at(&self.base, HOMEWORK_PATH, &payload)
                .await
                .context("读取知到作业列表失败")?;
            let rt = reply_rt(&value);
            let items = rt
                .get("studentHomeworkList")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let fetched = items.len();
            all.extend(
                items
                    .iter()
                    .filter_map(|item| parse_homework(item, recruit_id, course_id)),
            );
            let next = rt.get("next").and_then(value_i64).unwrap_or(-1);
            if fetched < 100 || next < 0 || page == 20 {
                break;
            }
        }
        Ok(all)
    }

    /// List final exams (`student/getStudentFinalExam`, taurus engine with a
    /// fallback to the main engine).
    pub async fn list_final_exams(
        &self,
        recruit_id: u64,
        course_id: u64,
    ) -> Result<Vec<ZhsFinalExam>> {
        let payload = json!({
            "courseId": course_id,
            "recruitId": recruit_id.to_string(),
            "flag": 1,
        });
        let value = match self
            .post_at(&self.taurus_base, FINAL_EXAM_PATH, &payload)
            .await
        {
            Ok(value) => value,
            Err(taurus_error) => {
                log::debug!(
                    "taurus final-exam endpoint failed ({taurus_error:#}); trying main engine"
                );
                self.post_at(&self.base, FINAL_EXAM_PATH, &payload)
                    .await
                    .context("读取知到期末列表失败")?
            }
        };
        let rt = reply_rt(&value);
        let items = rt.as_array().cloned().unwrap_or_else(|| {
            rt.get("examList")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        });
        Ok(items
            .iter()
            .filter_map(|item| parse_final_exam(item, recruit_id, course_id))
            .collect())
    }

    /// Fetch the paper through the read-only check-page endpoint
    /// (`student/lookHomework`). This works for already-submitted papers;
    /// unstarted attempts must use [`Self::paper_for_answering`].
    pub async fn paper(&self, homework: &ZhsHomework) -> Result<ZhsExamPaper> {
        let context = self.context_for(homework).await?;
        let value = self
            .post_at(&self.base, LOOK_HOMEWORK_PATH, &context.paper_payload())
            .await
            .with_context(|| format!("读取试卷 {} 失败", homework.label()))?;
        parse_paper(&value)
    }

    /// Fetch a paper for answering.
    ///
    /// Tries the read-only `lookHomework` first and falls back to
    /// `student/openExam`, which **starts the attempt and its timer**. Callers
    /// must make that side effect explicit to the user.
    pub async fn paper_for_answering(&self, homework: &ZhsHomework) -> Result<ZhsExamPaper> {
        match self.paper(homework).await {
            Ok(paper) => Ok(paper),
            Err(look_error) => {
                log::debug!("lookHomework failed ({look_error:#}); trying openHomework/openExam");
                match self.open_homework(homework).await {
                    Ok(paper) => Ok(paper),
                    Err(homework_error) => {
                        if needs_human_verification(&homework_error) {
                            return Err(homework_error).context(
                                "平台要求滑块/人工验证：请在图形界面完成验证后重试；本次未提交任何答案",
                            );
                        }
                        log::debug!("openHomework failed ({homework_error:#}); trying openExam");
                        self.open_exam(homework).await
                    }
                }
            }
        }
    }

    /// Enter a homework/unit-test attempt and return its paper
    /// (`student/doHomework`, main engine).
    ///
    /// Measured payload: `{recruitId, examId, studentExamId, schoolId, courseId}`
    /// (no `deviceId`), response `rt.examBase.workExamParts`.
    pub async fn open_homework(&self, homework: &ZhsHomework) -> Result<ZhsExamPaper> {
        let context = self.context_for(homework).await?;
        let value = self
            .post_at(&self.base, OPEN_HOMEWORK_PATH, &context.paper_payload())
            .await
            .with_context(|| format!("进入作业 {} 失败", homework.label()))?;
        parse_paper(&value)
    }

    /// Enter an exam attempt and return its paper (`student/doExam`).
    ///
    /// Measured request: `{recruitId, examId, studentExamId, schoolId, courseId,
    /// deviceId}`; response `rt.examBase.workExamParts` like `lookHomework`.
    /// The page calls it through the taurus engine first; non-taurus exams use
    /// the main engine, so a failure on taurus retries the main base.
    pub async fn open_exam(&self, homework: &ZhsHomework) -> Result<ZhsExamPaper> {
        let context = self.context_for(homework).await?;
        let payload = context.open_exam_payload();
        let value = match self
            .post_at(&self.taurus_base, OPEN_EXAM_PATH, &payload)
            .await
        {
            Ok(value) => value,
            Err(taurus_error) => {
                log::debug!("taurus doExam failed ({taurus_error:#}); trying the main engine");
                self.post_at(&self.base, OPEN_EXAM_PATH, &payload)
                    .await
                    .with_context(|| format!("进入试卷 {} 失败", homework.label()))?
            }
        };
        parse_paper(&value)
    }

    /// Fetch the submitted answers (selected option ids + per-question score).
    ///
    /// `getStuAnswerInfo` requires the paper's `questionIds` list; the scores
    /// come from `checkAnswerSheetInfo` (same payload).
    pub async fn submitted_answers(
        &self,
        homework: &ZhsHomework,
        paper: &ZhsExamPaper,
    ) -> Result<Vec<ZhsSubmittedAnswer>> {
        let context = self.context_for(homework).await?;
        let mut payload = context.paper_payload();
        let question_ids = paper
            .questions()
            .map(|question| question.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        payload["questionIds"] = json!(question_ids);
        let answers = self
            .post_at(&self.base, ANSWER_INFO_PATH, &payload)
            .await
            .context("读取已作答答案失败")?;
        let scores = self
            .post_at(&self.base, ANSWER_SHEET_PATH, &payload)
            .await
            .context("读取判分结果失败")?;
        Ok(parse_submitted_answers(&answers, &scores))
    }

    /// Save one answer (`answer/saveStudentAnswer`). `option_ids` may hold one
    /// id (single/judge) or several ids (multiple).
    pub async fn save_answer(
        &self,
        homework: &ZhsHomework,
        question: &ZhsExamQuestion,
        option_ids: &[String],
    ) -> Result<bool> {
        if option_ids.is_empty() {
            bail!("题目 {} 没有可保存的选项", question.id);
        }
        let context = self.context_for(homework).await?;
        let answer = option_ids.join(",");
        let record = json!({
            "examId": context.exam_id,
            "recruitId": context.recruit_id,
            "stuExamId": context.stu_exam_id,
            "eid": question.eid.clone().unwrap_or_else(|| question.id.clone()),
            "schoolId": context.school_id,
            "deviceId": context.device_id,
            "examType": context.exam_type,
            "fromType": context.from_type,
            "answer": answer,
            "dataIds": "",
            "questionType": question.kind_id,
        });
        let stu_exam_answer =
            serde_json::to_string(&vec![record]).context("failed to serialize exam answer")?;
        let payload = json!({
            "stuExamAnswer": stu_exam_answer,
            "recruitId": context.recruit_id,
        });
        let value = self
            .post_at(&self.base, SAVE_ANSWER_PATH, &payload)
            .await
            .context("保存答案失败")?;
        let statu = value
            .pointer("/rt/statu")
            .and_then(value_text)
            .unwrap_or_default();
        Ok(statu == "1")
    }

    /// Submit the paper (`answer/submit`).
    pub async fn submit(&self, homework: &ZhsHomework) -> Result<ZhsSubmitResult> {
        let context = self.context_for(homework).await?;
        let value = self
            .post_at(&self.base, SUBMIT_PATH, &context.paper_payload())
            .await
            .with_context(|| format!("提交试卷 {} 失败", homework.label()))?;
        let rt = reply_rt(&value);
        let result = ZhsSubmitResult {
            message: rt
                .get("msg")
                .and_then(value_text)
                .unwrap_or_else(|| "提交成功".to_string()),
            score: rt.get("score").and_then(value_f64),
            statu: rt.get("statu").and_then(value_text).unwrap_or_default(),
        };
        if result.statu != "0" {
            bail!("提交未成功：{}（statu={}）", result.message, result.statu);
        }
        Ok(result)
    }
}

/// Result of `answer/submit`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ZhsSubmitResult {
    /// Platform message.
    pub message: String,
    /// Score reported by the platform, when present.
    pub score: Option<f64>,
    /// Platform status (`"0"` = success).
    pub statu: String,
}

// -------------------------------------------------------------------------
// Parsing helpers (pure; fixture-tested)
// -------------------------------------------------------------------------

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn value_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_str()
            .and_then(|text| text.trim().parse::<i64>().ok())
    })
}

fn value_f64(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|text| text.trim().parse::<f64>().ok())
    })
}

fn get_text(item: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(value_text)
        .filter(|text| !text.is_empty())
}

fn get_i64(item: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(value_i64)
}

fn get_f64(item: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(value_f64)
}

fn get_array<'a>(item: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find_map(Value::as_array)
}

/// The `rt` envelope of an exam response.
fn reply_rt(value: &Value) -> &Value {
    value.get("rt").unwrap_or(&Value::Null)
}

fn parse_homework(item: &Value, recruit_id: u64, course_id: u64) -> Option<ZhsHomework> {
    let stu_exam_id = get_text(item, &["id", "stuExamId"])?;
    let exam_id = get_text(item, &["examId"])?;
    Some(ZhsHomework {
        stu_exam_id,
        exam_id,
        name: get_text(item, &["examName", "name"]).unwrap_or_default(),
        state: get_i64(item, &["state"]),
        achieve: get_f64(item, &["achieve"]),
        achieve_count: get_i64(item, &["achieveCount"]),
        back_num: get_i64(item, &["backNum"]),
        score: get_f64(item, &["score"]),
        problem_num: get_i64(item, &["problemNum"]),
        total_score: get_f64(item, &["totalScore"]),
        meet_course_type: get_i64(item, &["meetCourseType"]),
        chapter_id: get_text(item, &["chapterId"]),
        is_check_answer: get_i64(item, &["isCheckAnswer"]),
        course_id: course_id.to_string(),
        recruit_id: recruit_id.to_string(),
        exam_user_name: get_text(item, &["examUserName"]),
    })
}

fn parse_final_exam(item: &Value, recruit_id: u64, course_id: u64) -> Option<ZhsFinalExam> {
    let stu_exam_id = get_text(item, &["id", "stuExamId"])?;
    let exam_id = get_text(item, &["examId"])?;
    Some(ZhsFinalExam {
        stu_exam_id,
        exam_id,
        name: get_text(item, &["examName", "name"]).unwrap_or_default(),
        problem_num: get_i64(item, &["problemNum"]),
        total_score: get_f64(item, &["totalScore"]),
        limit_time: get_i64(item, &["limitTime"]),
        remain_count: get_i64(item, &["faStudentExamRemainCount"]),
        course_id: course_id.to_string(),
        recruit_id: recruit_id.to_string(),
    })
}

fn parse_paper(value: &Value) -> Result<ZhsExamPaper> {
    let exam_base = value
        .pointer("/rt/examBase")
        .context("lookHomework response is missing rt.examBase")?;
    let total_score = get_f64(exam_base, &["totalScore"]).unwrap_or_default();
    let problem_num = get_i64(exam_base, &["problemNum"]).unwrap_or_default();
    let parts = get_array(exam_base, &["workExamParts"])
        .map(|parts| {
            parts
                .iter()
                .enumerate()
                .map(|(index, part)| {
                    let questions = get_array(part, &["questionDtos"])
                        .map(|questions| questions.iter().filter_map(parse_question).collect())
                        .unwrap_or_default();
                    ZhsExamPart {
                        sort: get_i64(part, &["startSort"]).unwrap_or(index as i64 + 1),
                        question_count: get_i64(part, &["questionCount"]).unwrap_or_default(),
                        questions,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ZhsExamPaper {
        exam_name: get_text(exam_base, &["name", "examName"]).unwrap_or_default(),
        course_name: get_text(exam_base, &["courseName"]).unwrap_or_default(),
        total_score,
        problem_num,
        parts,
    })
}

fn parse_question(item: &Value) -> Option<ZhsExamQuestion> {
    let id = get_text(item, &["id"])?;
    let kind_id = get_i64(item, &["questionType.id"]).or_else(|| {
        item.get("questionType")
            .and_then(|kind| get_i64(kind, &["id"]))
    })?;
    let kind_name = item
        .get("questionType")
        .and_then(|kind| get_text(kind, &["name"]))
        .unwrap_or_default();
    let options = get_array(item, &["questionOptions"])
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    Some(ZhsExamOption {
                        id: get_text(option, &["id"])?,
                        content: strip_html_tags(
                            &get_text(option, &["content"]).unwrap_or_default(),
                        ),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ZhsExamQuestion {
        id,
        stem: strip_html_tags(&get_text(item, &["name", "title"]).unwrap_or_default()),
        kind_id,
        kind_name,
        options,
        score: get_f64(item, &["questionScore"])
            .map(|score| score.round() as i64)
            .unwrap_or_default(),
        eid: get_text(item, &["eid"]),
    })
}

fn parse_submitted_answers(answers: &Value, scores: &Value) -> Vec<ZhsSubmittedAnswer> {
    let answers = reply_rt(answers);
    let scores = reply_rt(scores);
    let Some(map) = answers.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(map.len());
    for (question_id, item) in map {
        let option_ids = item
            .get("answer")
            .and_then(value_text)
            .map(|answer| {
                answer
                    .split(',')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if option_ids.is_empty() {
            continue;
        }
        let score = scores
            .get(question_id)
            .and_then(|item| get_f64(item, &["score"]))
            .or_else(|| get_f64(item, &["score"]))
            .unwrap_or_default();
        out.push(ZhsSubmittedAnswer {
            question_id: question_id.clone(),
            option_ids,
            score,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(id: &str, content: &str) -> ZhsExamOption {
        ZhsExamOption {
            id: id.to_string(),
            content: content.to_string(),
        }
    }

    fn question(
        kind_id: i64,
        kind_name: &str,
        stem: &str,
        options: Vec<ZhsExamOption>,
    ) -> ZhsExamQuestion {
        ZhsExamQuestion {
            id: "1001".to_string(),
            stem: stem.to_string(),
            kind_id,
            kind_name: kind_name.to_string(),
            options,
            score: 10,
            eid: None,
        }
    }

    fn single_question() -> ZhsExamQuestion {
        let mut question = question(
            1,
            "单选题",
            "公元13世纪上半叶征服基辅罗斯的游牧帝国是（ ）。",
            vec![
                option("519312795", "阿拉伯帝国"),
                option("519312798", "奥斯曼土耳其帝国"),
                option("519312790", "突厥帝国"),
                option("519312793", "蒙古帝国"),
            ],
        );
        question.id = "1001".to_string();
        question
    }

    fn multiple_question() -> ZhsExamQuestion {
        let mut question = question(
            2,
            "多选题",
            "以下属于国家主权范畴的有（ ）。",
            vec![
                option("1", "独立权"),
                option("2", "平等权"),
                option("3", "内政不受干涉"),
            ],
        );
        question.id = "1002".to_string();
        question
    }

    fn paper_fixture() -> ZhsExamPaper {
        ZhsExamPaper {
            exam_name: "第一章单元测试".to_string(),
            course_name: "军事理论-综合版".to_string(),
            total_score: 100.0,
            problem_num: 2,
            parts: vec![ZhsExamPart {
                sort: 1,
                question_count: 2,
                questions: vec![single_question(), multiple_question()],
            }],
        }
    }

    #[test]
    fn parses_measured_paper_shape() {
        // Sanitized fixture mirroring the live lookHomework response.
        let value = json!({
            "currentTime": 1_794_219_638_650u64,
            "msg": "请求成功",
            "status": "200",
            "rt": {
                "id": null,
                "score": "100",
                "examBase": {
                    "id": "exam-A",
                    "name": "测试单元测试",
                    "courseName": "测试课程",
                    "problemNum": 2,
                    "totalScore": "100",
                    "chapterId": 1000116293,
                    "workExamParts": [{
                        "id": null,
                        "startSort": 1,
                        "questionCount": 2,
                        "questionDtos": [{
                            "id": 1110187736,
                            "name": "测试题干一（ ）。",
                            "questionType": {"id": 1, "name": "单选题"},
                            "questionOptions": [
                                {"id": 11, "content": "选项甲"},
                                {"id": 12, "content": "选项乙"}
                            ],
                            "questionScore": "50",
                            "eid": null
                        }, {
                            "id": 1110187798,
                            "name": "测试题干二（ ）。",
                            "questionType": {"id": 2, "name": "多选题"},
                            "questionOptions": [
                                {"id": 21, "content": "选项A"},
                                {"id": 22, "content": "选项B"},
                                {"id": 23, "content": "选项C"}
                            ],
                            "questionScore": "50"
                        }]
                    }]
                }
            }
        });
        let paper = parse_paper(&value).unwrap();
        assert_eq!(paper.exam_name, "测试单元测试");
        assert_eq!(paper.total_score, 100.0);
        assert_eq!(paper.question_count(), 2);
        let questions: Vec<_> = paper.questions().collect();
        assert_eq!(questions[0].id, "1110187736");
        assert_eq!(questions[0].stem, "测试题干一（ ）。");
        assert_eq!(questions[0].kind_id, 1);
        assert_eq!(questions[0].kind_name, "单选题");
        assert_eq!(questions[0].options.len(), 2);
        assert_eq!(questions[0].options[1].content, "选项乙");
        assert_eq!(questions[0].score, 50);
        assert!(questions[1].is_multiple());
    }

    #[test]
    fn parses_homework_and_final_lists() {
        let homework = json!({
            "id": "stu-A", "examId": "exam-A", "examName": "第二章单元测试",
            "state": 1, "score": null, "achieveCount": 0, "backNum": 3,
            "totalScore": "100", "problemNum": 10, "meetCourseType": 0,
            "chapterId": 1000116294, "isCheckAnswer": 0, "examUserName": "孙华"
        });
        let parsed = parse_homework(&homework, 463_667, 1_000_011_214).unwrap();
        assert_eq!(parsed.stu_exam_id, "stu-A");
        assert_eq!(parsed.exam_id, "exam-A");
        assert_eq!(parsed.name, "第二章单元测试");
        assert_eq!(parsed.back_num, Some(3));
        assert_eq!(parsed.total_score, Some(100.0));
        assert_eq!(parsed.chapter_id.as_deref(), Some("1000116294"));
        assert_eq!(parsed.recruit_id, "463667");

        let final_exam = json!({
            "id": "stu-F", "examId": "exam-F", "examName": "教程考试",
            "problemNum": 68, "totalScore": "100", "limitTime": 90,
            "faStudentExamRemainCount": 1
        });
        let parsed = parse_final_exam(&final_exam, 463_667, 1_000_011_214).unwrap();
        assert_eq!(parsed.name, "教程考试");
        assert_eq!(parsed.problem_num, Some(68));
        assert_eq!(parsed.limit_time, Some(90));
        assert_eq!(parsed.remain_count, Some(1));
    }

    #[test]
    fn parses_submitted_answers_and_scores() {
        let answers = json!({
            "currentTime": 1, "status": "200",
            "rt": {
                "1001": {"score": "10", "isCurrent": "1", "questionId": "1001", "answer": "111,112", "stuExamId": "stu-A"},
                "1002": {"score": "0", "isCurrent": "1", "questionId": "1002", "answer": "113", "stuExamId": "stu-A"}
            }
        });
        let scores = json!({
            "currentTime": 1, "status": "200",
            "rt": {
                "1001": {"score": "10", "isCurrent": "1", "totalScore": ""},
                "1002": {"score": "0", "isCurrent": "1", "totalScore": ""}
            }
        });
        let parsed = parse_submitted_answers(&answers, &scores);
        assert_eq!(parsed.len(), 2);
        let first = parsed
            .iter()
            .find(|item| item.question_id == "1001")
            .unwrap();
        assert_eq!(first.option_ids, vec!["111", "112"]);
        assert_eq!(first.score, 10.0);
    }

    #[test]
    fn bank_resolves_reordered_options_by_content() {
        let mut bank = ZhsAnswerBank::builtin();
        bank.entries.push(ZhsBankEntry {
            key: single_question().bank_key(),
            stem: single_question().stem,
            question_type: "single".to_string(),
            answers: vec!["蒙古帝国".to_string()],
            source: "submitted".to_string(),
            updated_at_unix: 1,
        });
        // Same question, options in a different order (randomized attempt).
        let mut reordered = single_question();
        reordered.options = vec![
            option("9001", "蒙古帝国"),
            option("9002", "突厥帝国"),
            option("9003", "阿拉伯帝国"),
        ];
        let resolved = bank.resolve(&reordered).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].id, "9001");
        assert_eq!(resolved[0].content, "蒙古帝国");

        // A question that is absent from the bank stays unresolved.
        let unknown = question(1, "单选题", "全新的题干（ ）。", vec![option("1", "甲")]);
        assert!(bank.resolve(&unknown).is_none());
    }

    #[test]
    fn bank_records_only_full_score_submissions() {
        let paper = paper_fixture();
        let submitted = vec![
            ZhsSubmittedAnswer {
                question_id: "1001".to_string(),
                option_ids: vec!["519312793".to_string()],
                score: 10.0,
            },
            ZhsSubmittedAnswer {
                question_id: "1002".to_string(),
                option_ids: vec!["1".to_string()],
                score: 0.0,
            },
        ];
        let mut bank = ZhsAnswerBank::builtin();
        let recorded = bank.record_submitted(&paper, &submitted, 1);
        assert_eq!(recorded, 1);
        let entry = bank
            .entries
            .iter()
            .find(|entry| entry.key == single_question().bank_key())
            .unwrap();
        assert_eq!(entry.answers, vec!["蒙古帝国"]);
        assert_eq!(entry.source, "submitted");
        assert!(
            bank.entries
                .iter()
                .all(|entry| entry.key != multiple_question().bank_key())
        );
    }

    #[test]
    fn ai_analysis_parses_unambiguous_answers() {
        let single = single_question();
        let options = &single.options;
        assert_eq!(
            parse_ai_analysis("解析：……因此正确答案是D。A项错误，B项错误。", &single),
            Some(vec![options[3].content.clone()])
        );
        assert_eq!(
            parse_ai_analysis("正确答案：D", &single),
            Some(vec![options[3].content.clone()])
        );
        assert_eq!(
            parse_ai_analysis("无法确定，可能选A也可能选B", &single),
            None
        );
        assert_eq!(parse_ai_analysis("正确答案是波斯帝国", &single), None);

        let mut multiple = multiple_question();
        multiple.options = vec![
            option("1", "独立权"),
            option("2", "平等权"),
            option("3", "内政不受干涉"),
        ];
        assert_eq!(
            parse_ai_analysis("故选A、C，B项错误。", &multiple),
            Some(vec!["独立权".to_string(), "内政不受干涉".to_string()])
        );
    }

    #[test]
    fn bank_records_realistic_ai_analysis_texts() {
        let paper = paper_fixture();
        let mut texts = HashMap::new();
        texts.insert(
            "1001".to_string(),
            "解析：A项错误，B项排除，C项不符合题意。D项符合材料，因此正确答案是D。".to_string(),
        );
        texts.insert(
            "1002".to_string(),
            "正确答案：A、C。B项不正确，排除B。".to_string(),
        );
        let mut bank = ZhsAnswerBank::builtin();
        let recorded = bank.record_ai_analysis(&paper, &texts, 1);
        assert_eq!(recorded, 2, "entries = {:?}", bank.entries);
        let single = bank
            .entries
            .iter()
            .find(|e| e.stem == single_question().stem)
            .unwrap();
        assert_eq!(single.answers, vec!["蒙古帝国"]);
        assert_eq!(single.source, "ai_analysis");
        let multiple = bank
            .entries
            .iter()
            .find(|e| e.stem == multiple_question().stem)
            .unwrap();
        assert_eq!(multiple.answers, vec!["独立权", "内政不受干涉"]);
    }

    #[test]
    fn bank_skips_ambiguous_and_negative_only_ai_texts() {
        let paper = paper_fixture();
        let mut texts = HashMap::new();
        texts.insert(
            "1001".to_string(),
            "A项错误，B项排除，C项不符合，D项也不正确，无法确定。".to_string(),
        );
        texts.insert(
            "1002".to_string(),
            "可能选A，也可能选B，需要结合更多材料。".to_string(),
        );
        let mut bank = ZhsAnswerBank::builtin();
        let recorded = bank.record_ai_analysis(&paper, &texts, 1);
        assert_eq!(recorded, 0);
        assert!(
            bank.entries.is_empty(),
            "ambiguous text must not become an answer"
        );
    }

    #[test]
    fn ai_analysis_handles_judgement_content_fallback() {
        let judge = question(
            3,
            "判断题",
            "测试判断题干（ ）。",
            vec![option("1", "正确"), option("2", "错误")],
        );
        assert_eq!(
            parse_ai_analysis("正确答案是：错误", &judge),
            Some(vec!["错误".to_string()])
        );
        assert_eq!(
            parse_ai_analysis("正确答案是：正确", &judge),
            Some(vec!["正确".to_string()])
        );
        assert_eq!(parse_ai_analysis("无法判断题干对错", &judge), None);
        // A/B refer to the current option order: B (= 错误) is correct here.
        assert_eq!(
            parse_ai_analysis("A项错误，B项正确", &judge),
            Some(vec!["错误".to_string()])
        );
    }

    #[test]
    fn bank_key_strips_html_tags() {
        let mut question = single_question();
        question.stem = "<p>测试<b>题干</b>（ ）。</p>".to_string();
        let key = question.bank_key();
        assert!(!key.contains('<'), "key = {key}");
        assert!(!key.contains('p') || key.contains("测试"), "key = {key}");
        assert_eq!(normalize_content("<p>选项<br/>甲</p>"), "选项甲");
    }

    #[test]
    fn plan_reports_unresolved_questions() {
        let paper = paper_fixture();
        let context = ZhsExamContext {
            recruit_id: "463667".to_string(),
            course_id: "1000011214".to_string(),
            stu_exam_id: "stu-A".to_string(),
            exam_id: "exam-A".to_string(),
            school_id: "360".to_string(),
            exam_type: String::new(),
            from_type: 3,
            device_id: String::new(),
        };
        let mut bank = ZhsAnswerBank::builtin();
        bank.entries.push(ZhsBankEntry {
            key: single_question().bank_key(),
            stem: single_question().stem,
            question_type: "single".to_string(),
            answers: vec!["蒙古帝国".to_string()],
            source: "submitted".to_string(),
            updated_at_unix: 1,
        });
        let plan = plan_exam(&paper, &context, &bank);
        assert_eq!(plan.questions.len(), 1);
        assert_eq!(plan.unresolved, vec!["1002".to_string()]);
        assert!(!plan.is_complete());
        assert_eq!(plan.questions[0].source, ZhsAnswerSource::Submitted);

        bank.entries.push(ZhsBankEntry {
            key: multiple_question().bank_key(),
            stem: multiple_question().stem,
            question_type: "multiple".to_string(),
            answers: vec!["独立权".to_string(), "平等权".to_string()],
            source: "ai_analysis".to_string(),
            updated_at_unix: 2,
        });
        let plan = plan_exam(&paper, &context, &bank);
        assert!(plan.is_complete());
        assert_eq!(plan.questions[1].source, ZhsAnswerSource::AiAnalysis);
    }

    #[test]
    fn answer_bank_round_trips_through_json() {
        let mut bank = ZhsAnswerBank::builtin();
        bank.entries.push(ZhsBankEntry {
            key: "testkey".to_string(),
            stem: "测试题干".to_string(),
            question_type: "single".to_string(),
            answers: vec!["答案".to_string()],
            source: "submitted".to_string(),
            updated_at_unix: 1,
        });
        let text = serde_json::to_string_pretty(&bank).unwrap();
        let parsed = ZhsAnswerBank::from_json_str(&text).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed.entries[0].answers, vec!["答案"]);
    }

    #[test]
    fn exam_module_and_paths_match_the_measured_protocol() {
        assert_eq!(MODULE_EXAM, 3);
        assert!(EXAM_API_BASE.contains("studentexam-api"));
        assert!(EXAM_API_BASE.contains("/studentExam/gateway/t/v1"));
        assert!(TAURUS_EXAM_API_BASE.contains("taurusexam-api"));
    }
}
