//! Structured answer bank for chapter quizzes.
//!
//! The bank in `test-data/answer-bank.json` is keyed by platform question id,
//! with a normalized-stem index as a fallback for questions that were crawled
//! under a different id (for example after the platform rebuilt a work).
//!
//! Loading the bank and looking up an answer stays independent of HTTP and
//! Tauri so the one-click submission path can be tested from a fixture.

use crate::models::{Question, QuestionOption};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, sync::OnceLock};
use unicode_normalization::UnicodeNormalization;

/// Answer bank shipped with the desktop app.
///
/// The GUI has no file picker for a bank: the captured data in `test-data` is
/// embedded so one-click quiz submission works in dev and in the installer.
pub const DEFAULT_ANSWER_BANK_JSON: &str = include_str!("../test-data/answer-bank.json");

/// One question record from `question_index`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BankAnswer {
    pub question_id: String,
    #[serde(default)]
    pub course_id: Option<String>,
    #[serde(default)]
    pub knowledge_id: Option<String>,
    #[serde(default)]
    pub work_id: Option<String>,
    #[serde(default)]
    pub work_name: Option<String>,
    #[serde(default)]
    pub chapter_path: Vec<String>,
    #[serde(default)]
    pub question_type: String,
    #[serde(default)]
    pub stem: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    /// Canonical answer submitted to the platform.
    #[serde(default)]
    pub answer: String,
    /// Option labels for choice questions and option-based true/false.
    #[serde(default)]
    pub answer_labels: Vec<String>,
    /// One entry per blank for fill-in-the-blank questions.
    #[serde(default)]
    pub answer_blanks: Vec<String>,
    /// Human-readable answer text.
    #[serde(default)]
    pub answer_text: String,
    #[serde(default)]
    pub accepted_answers: Vec<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// The parsed `answer-bank.json`.
///
/// Unknown top-level fields (`stats`, `review`, `courses`, ...) are ignored;
/// only the two lookup indexes are needed at runtime.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AnswerBank {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub question_index: HashMap<String, BankAnswer>,
    #[serde(default)]
    pub stem_index: HashMap<String, Vec<String>>,
}

impl AnswerBank {
    /// The embedded `DEFAULT_ANSWER_BANK_JSON`, parsed once per process.
    pub fn builtin() -> Result<&'static Self> {
        static BANK: OnceLock<AnswerBank> = OnceLock::new();
        if let Some(bank) = BANK.get() {
            return Ok(bank);
        }
        let bank = Self::from_json(DEFAULT_ANSWER_BANK_JSON)
            .context("built-in answer bank is not valid JSON")?;
        Ok(BANK.get_or_init(|| bank))
    }

    /// Load a bank from disk.
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read answer bank {}", path.display()))?;
        Self::from_json(&text)
            .with_context(|| format!("failed to parse answer bank {}", path.display()))
    }

    pub fn from_json(text: &str) -> Result<Self> {
        let bank: Self = serde_json::from_str(text).context("answer bank is not valid JSON")?;
        if bank.question_index.is_empty() {
            bail!("answer bank has an empty question_index");
        }
        Ok(bank)
    }

    pub fn len(&self) -> usize {
        self.question_index.len()
    }

    pub fn is_empty(&self) -> bool {
        self.question_index.is_empty()
    }

    pub fn by_id(&self, question_id: &str) -> Option<&BankAnswer> {
        self.question_index.get(question_id)
    }

    /// Look up an answer by question id, then by normalized stem.
    pub fn lookup(&self, question: &Question) -> Option<&BankAnswer> {
        if let Some(answer) = self.by_id(&question.id) {
            return Some(answer);
        }
        self.lookup_by_stem(&question.stem, None, None)
    }

    /// Look up an answer, preferring the bank entry from the same course/work.
    ///
    /// Question ids are globally unique in the current capture, so the id hit
    /// wins outright. The course/work filter only disambiguates duplicate
    /// stems when the id is unknown.
    pub fn lookup_for(
        &self,
        question: &Question,
        course_id: &str,
        work_id: &str,
    ) -> Option<&BankAnswer> {
        if let Some(answer) = self.by_id(&question.id) {
            return Some(answer);
        }
        self.lookup_by_stem(&question.stem, Some(course_id), Some(work_id))
    }

    fn lookup_by_stem(
        &self,
        stem: &str,
        course_id: Option<&str>,
        work_id: Option<&str>,
    ) -> Option<&BankAnswer> {
        let mut keys = vec![normalize_stem(stem)];
        // Parsed stems usually have the type label stripped already, while the
        // bank index keeps whatever the raw page had. Try the stripped form and
        // each possible label as a prefix.
        let bare = normalize_stem_without_label(stem);
        if !bare.is_empty() && !keys.contains(&bare) {
            keys.push(bare.clone());
            for label in STEM_TYPE_LABELS {
                keys.push(format!("{label}{bare}"));
            }
        }
        keys.retain(|key| !key.is_empty());

        for key in keys {
            let Some(ids) = self.stem_index.get(&key) else {
                continue;
            };
            let candidates = ids.iter().filter_map(|id| self.question_index.get(id));
            if course_id.is_none() && work_id.is_none() {
                return candidates.into_iter().next();
            }

            let mut fallback = None;
            for candidate in candidates {
                let course_matches =
                    course_id.is_none_or(|id| candidate.course_id.as_deref() == Some(id));
                let work_matches =
                    work_id.is_none_or(|id| candidate.work_id.as_deref() == Some(id));
                if course_matches && work_matches {
                    return Some(candidate);
                }
                if fallback.is_none() {
                    fallback = Some(candidate);
                }
            }
            if fallback.is_some() {
                return fallback;
            }
        }
        None
    }
}

const STEM_TYPE_LABELS: &[&str] = &[
    "判断题",
    "单选题",
    "多选题",
    "填空题",
    "简答题",
    "名词解释",
    "论述题",
    "排序题",
];

/// Normalize a question stem the same way `stem_index` was generated.
///
/// Steps: NFKC, lowercase, drop a leading `label:` prefix, then keep only
/// letters and digits. Punctuation and whitespace are removed, which makes the
/// key stable across the platform's cosmetic HTML changes.
///
/// Note that the index keeps bracketed labels such as `[单选题]` or
/// `(多选题)`; those become `单选题` / `多选题` in the key. Lookup also tries
/// the label-stripped form, so either representation matches.
pub fn normalize_stem(raw: &str) -> String {
    let normalized: String = raw.nfkc().collect();
    let mut text = normalized.trim().to_lowercase();

    for label in STEM_TYPE_LABELS {
        if let Some(rest) = text.strip_prefix(label) {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix([':', '：']) {
                text = rest.to_string();
                break;
            }
        }
    }

    text.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Normalize after removing a leading type label, with or without a colon.
fn normalize_stem_without_label(raw: &str) -> String {
    let normalized: String = raw.nfkc().collect();
    let mut text = normalized.trim().to_lowercase();

    for label in STEM_TYPE_LABELS {
        let wrapped: [String; 2] = [format!("【{label}】"), format!("[{label}]")];
        let mut stripped = None;
        for marker in &wrapped {
            if let Some(rest) = text.strip_prefix(marker) {
                stripped = Some(
                    rest.trim_start_matches([':', '：', ' ', '\t', '\n'])
                        .to_string(),
                );
                break;
            }
        }
        if let Some(rest) = stripped {
            text = rest;
            break;
        }
        if let Some(rest) = text.strip_prefix(label) {
            text = rest
                .trim_start_matches([':', '：', ' ', '\t', '\n'])
                .to_string();
            break;
        }
    }

    text.chars().filter(|c| c.is_alphanumeric()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bank() -> AnswerBank {
        AnswerBank::from_json(include_str!("../test-data/answer-bank.json"))
            .expect("test-data answer bank must parse")
    }

    fn question(id: &str, stem: &str) -> Question {
        Question {
            id: id.to_string(),
            question_type: Some("单选题".to_string()),
            stem: stem.to_string(),
            options: Vec::new(),
            my_answer: None,
            correct_answer: None,
            score: None,
        }
    }

    #[test]
    fn loads_the_full_test_bank() {
        let bank = bank();
        assert_eq!(bank.len(), 541);
        assert_eq!(bank.by_id("676210").unwrap().answer, "B");
        assert_eq!(bank.by_id("681357").unwrap().answer_blanks.len(), 3);
        assert_eq!(AnswerBank::builtin().unwrap().len(), 541);
    }

    #[test]
    fn every_stem_normalizes_to_an_indexed_key() {
        let bank = bank();
        let mut missing = Vec::new();
        for answer in bank.question_index.values() {
            let key = normalize_stem(&answer.stem);
            if !bank.stem_index.contains_key(&key) {
                missing.push((answer.question_id.clone(), key));
            }
        }
        assert!(
            missing.is_empty(),
            "stems that do not match stem_index: {missing:?}"
        );
    }

    #[test]
    fn looks_up_by_id_then_by_stem() {
        let bank = bank();
        let by_id = question("676210", "Anything");
        assert_eq!(bank.lookup(&by_id).unwrap().question_id, "676210");

        let stem = "To spell the past form of the following words when used as verbs, to which one should we first add –K- then -ED?";
        let by_stem = question("unknown-id", stem);
        assert_eq!(bank.lookup(&by_stem).unwrap().question_id, "676210");
    }

    #[test]
    fn prefers_the_same_work_for_duplicate_stems() {
        let bank = bank();
        let stem = "选择合适的情态动词完成句子:Graphical passwords only be used with handheld devices. ( )";
        let q = question("unknown-id", stem);
        let answer = bank
            .lookup_for(&q, "17310000026064", "c665426d4b4e4bec8ea4b11b368dd7d6")
            .expect("duplicate stem should resolve");
        assert!(matches!(answer.question_id.as_str(), "676584" | "676586"));
        assert_eq!(answer.course_id.as_deref(), Some("17310000026064"));
    }

    #[test]
    fn normalize_keeps_unicode_letters_and_drops_punctuation() {
        assert_eq!(
            normalize_stem("【单选题】 1 【判断题】The paper ____ the water problem.(错)"),
            "单选题1判断题thepaperthewaterproblem错"
        );
        assert_eq!(
            normalize_stem_without_label(
                "【单选题】 1 【判断题】The paper ____ the water problem.(错)"
            ),
            "1判断题thepaperthewaterproblem错"
        );
        assert_eq!(
            normalize_stem("What is the meaning of “schedule”?"),
            "whatisthemeaningofschedule"
        );
    }
}
