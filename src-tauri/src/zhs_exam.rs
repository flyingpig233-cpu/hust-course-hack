//! Zhihuishu homework / exam GUI commands.
//!
//! This module only orchestrates: the protocol lives in
//! `hust_course_hack::zhihuishu::exam`. Rules enforced here:
//!
//! * every real submission needs an explicit `dry_run=false` call from a UI that
//!   already asked for confirmation; dry-run never sends a submit;
//! * final exams (期末 / 教程考试, one attempt) are never planned or submitted —
//!   they are only listed;
//! * an incomplete answer plan is never submitted (no low-score attempt);
//! * the AI-analysis harvest happens in an isolated WebView2 window whose
//!   session cookies are injected from the Rust cookie jar (never over IPC).
//!
//! Cookie values and the harvested analysis text never cross the IPC boundary in
//! the other direction either: the UI only sees counts and question stems.

use crate::{events::JobProgress, login::LOGIN_LABEL, state::AppState};
use anyhow::{Context, Result};
use hust_course_hack::{
    cookie::CookieRecord,
    zhihuishu::{
        ZhsAnswerBank, ZhsBankEntry, ZhsCourse, ZhsExamClient, ZhsExamOption, ZhsExamPaper,
        ZhsExamPlan, ZhsExamQuestion, ZhsFinalExam, ZhsHomework, ZhsSubmittedAnswer, plan_exam,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    webview::PageLoadEvent,
};
use url::Url;

/// Label of the isolated exam webview window.
pub const EXAM_WINDOW_LABEL: &str = "zhs-exam";
/// Temporary WebView2 data-directory prefix (removed on window destroy).
const EXAM_DIR_PREFIX: &str = "hust-course-hack-zhexam-";
/// Exam check page (`/checkHomework/<recruit>/<stuExamId>/<examId>/<courseId>/<schoolId>`).
const EXAM_CHECK_BASE: &str =
    "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/checkHomework";
/// Exam attempt page (slider captcha is completed manually in the window).
const EXAM_ATTEMPT_BASE: &str =
    "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework";
/// School id measured on the live account (HUST).
const EXAM_SCHOOL_ID: &str = "360";
/// Answer bank file under the app data directory.
const BANK_FILE: &str = "zhihuishu-answer-bank.json";
/// Injected harvest script (check page: AI解析 collection).
const HARVEST_SCRIPT: &str = include_str!("zhs_exam_harvest.js");
/// Injected attempt script (dohomework page: manual slider, then auto answer).
const ATTEMPT_SCRIPT: &str = include_str!("zhs_exam_attempt.js");
/// Injected redo script (exam list page: 已提交 tab → 申请重做 → confirm).
const REDO_SCRIPT: &str = include_str!("zhs_exam_redo.js");
/// Loading/error/diagnostic bootstrap injected into the exam window before any
/// navigation. It guarantees the window is never blank white and bridges JS
/// errors to the file log.
const DIAGNOSTIC_SCRIPT: &str = r##"
(function () {
  if (window.__ZHS_DIAG_READY__) return;
  window.__ZHS_DIAG_READY__ = true;
  window.__ZHS_LOG_LINES__ = window.__ZHS_LOG_LINES__ || [];

  function root() { return document.documentElement || document.body; }

  window.__ZHS_PUSH_LOG__ = function (line) {
    window.__ZHS_LOG_LINES__.push(String(line));
    while (window.__ZHS_LOG_LINES__.length > 40) window.__ZHS_LOG_LINES__.shift();
  };

  window.__ZHS_HIDE_LOADING__ = function () {
    var el = document.getElementById('__zhs_loading_panel');
    if (el) el.remove();
  };

  window.__ZHS_SHOW_LOGIN_PROMPT__ = function (text) {
    var host = root();
    if (!host) return;
    var old = document.getElementById('__zhs_login_prompt');
    if (old) old.remove();
    var banner = document.createElement('div');
    banner.id = '__zhs_login_prompt';
    banner.setAttribute(
      'style',
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#1d4ed8;color:#fff;font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.25)',
    );
    banner.textContent = String(text || '需要在本窗口登录一次知到，登录后会自动继续');
    host.appendChild(banner);
  };

  window.__ZHS_HIDE_LOGIN_PROMPT__ = function () {
    var el = document.getElementById('__zhs_login_prompt');
    if (el) el.remove();
  };

  window.__ZHS_SHOW_ERROR__ = function (title, detail) {
    var host = root();
    if (!host) return;
    window.__ZHS_HIDE_LOADING__();
    var old = document.getElementById('__zhs_error_panel');
    if (old) old.remove();
    var text = String(title || '') + '\n' + String(detail || '');
    var panel = document.createElement('div');
    panel.id = '__zhs_error_panel';
    panel.setAttribute('style', 'position:fixed;inset:0;z-index:2147483645;background:#0f172a;color:#e5e7eb;font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif;padding:44px;box-sizing:border-box;overflow:auto');
    panel.innerHTML =
      '<h2 style="margin:0 0 14px;color:#fca5a5">考试页加载失败</h2>' +
      '<div id="__zhs_err_detail" style="white-space:pre-wrap;margin-bottom:18px;font-size:13px;opacity:.92"></div>' +
      '<div style="display:flex;gap:10px">' +
      '<button id="__zhs_err_reload" style="all:unset;cursor:pointer;padding:8px 18px;border-radius:8px;background:#2563eb;color:#fff">重新加载</button>' +
      '<button id="__zhs_err_copy" style="all:unset;cursor:pointer;padding:8px 18px;border-radius:8px;background:#374151;color:#fff">复制诊断</button>' +
      '</div>' +
      '<p style="opacity:.65;margin-top:20px;font-size:12.5px">诊断日志：%APPDATA%\\hust-course-hack\\logs\\zhs-exam.log</p>';
    host.appendChild(panel);
    document.getElementById('__zhs_err_detail').textContent = text;
    document.getElementById('__zhs_err_reload').onclick = function () { location.reload(); };
    document.getElementById('__zhs_err_copy').onclick = function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
          return;
        }
      } catch (e) { /* fall through */ }
      var area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      area.remove();
    };
  };

  function showLoading() {
    var host = root();
    if (!host || document.getElementById('__zhs_error_panel') || document.getElementById('__zhs_loading_panel')) return;
    var panel = document.createElement('div');
    panel.id = '__zhs_loading_panel';
    panel.setAttribute('style', 'position:fixed;inset:0;z-index:2147483644;background:#f8fafc;color:#0f172a;font:15px/1.8 "Microsoft YaHei",system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px;box-sizing:border-box');
    panel.innerHTML =
      '<div style="width:34px;height:34px;border:3px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:__zhs_spin 1s linear infinite;margin-bottom:14px"></div>' +
      '<div style="font-weight:700;font-size:16px">正在加载考试页…</div>' +
      '<div style="opacity:.7;margin-top:6px;font-size:13px">正在注入登录会话并打开知到页面，请稍候。</div>' +
      '<div style="opacity:.5;margin-top:16px;font-size:12px">如长时间停留，请查看 %APPDATA%\\hust-course-hack\\logs\\zhs-exam.log</div>';
    var style = document.createElement('style');
    style.textContent = '@keyframes __zhs_spin{to{transform:rotate(360deg)}}';
    host.appendChild(style);
    host.appendChild(panel);
  }

  function report(kind, message) {
    var text = String(kind) + ': ' + String(message == null ? '' : message).slice(0, 500);
    window.__ZHS_PUSH_LOG__(text);
    try {
      var internals = window.__TAURI_INTERNALS__;
      var ctx = window.__ZHS_EXAM_CTX__ || {};
      if (internals && typeof internals.invoke === 'function') {
        internals.invoke('zhs_exam_js_error', {
          windowLabel: ctx.windowLabel || '',
          message: text,
        });
      }
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('error', function (event) {
    report('js-error', (event && event.message) || '');
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    report('js-rejection', reason && (reason.message || reason));
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showLoading);
  } else {
    setTimeout(showLoading, 0);
  }
})();
"##;
/// How long the exam window waits for the first real page load before showing
/// the timeout error panel.
const EXAM_PAGE_LOAD_TIMEOUT: Duration = Duration::from_secs(25);

// ---- DTOs ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsHomeworkDto {
    pub stu_exam_id: String,
    pub exam_id: String,
    pub name: String,
    pub state: Option<i64>,
    pub achieve: Option<f64>,
    pub achieve_count: Option<i64>,
    pub back_num: Option<i64>,
    pub score: Option<f64>,
    pub problem_num: Option<i64>,
    pub total_score: Option<f64>,
    /// `1` = meet-course quiz.
    pub meet_course_type: Option<i64>,
    pub chapter_id: Option<String>,
    pub is_check_answer: Option<i64>,
    pub exam_user_name: Option<String>,
}

impl From<ZhsHomework> for ZhsHomeworkDto {
    fn from(item: ZhsHomework) -> Self {
        Self {
            stu_exam_id: item.stu_exam_id,
            exam_id: item.exam_id,
            name: item.name,
            state: item.state,
            achieve: item.achieve,
            achieve_count: item.achieve_count,
            back_num: item.back_num,
            score: item.score,
            problem_num: item.problem_num,
            total_score: item.total_score,
            meet_course_type: item.meet_course_type,
            chapter_id: item.chapter_id,
            is_check_answer: item.is_check_answer,
            exam_user_name: item.exam_user_name,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsFinalExamDto {
    pub stu_exam_id: String,
    pub exam_id: String,
    pub name: String,
    pub problem_num: Option<i64>,
    pub total_score: Option<f64>,
    pub limit_time: Option<i64>,
    pub remain_count: Option<i64>,
    /// Always `true`; finals are list-only in the GUI.
    pub final_exam: bool,
}

impl From<ZhsFinalExam> for ZhsFinalExamDto {
    fn from(item: ZhsFinalExam) -> Self {
        Self {
            stu_exam_id: item.stu_exam_id,
            exam_id: item.exam_id,
            name: item.name,
            problem_num: item.problem_num,
            total_score: item.total_score,
            limit_time: item.limit_time,
            remain_count: item.remain_count,
            final_exam: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsExamListDto {
    pub submitted: bool,
    pub homework: Vec<ZhsHomeworkDto>,
    pub finals: Vec<ZhsFinalExamDto>,
    /// Populated when the final-exam list endpoint failed (the homework list is
    /// still returned).
    pub finals_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsExamOptionDto {
    pub id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsExamQuestionDto {
    pub id: String,
    pub stem: String,
    pub kind_id: i64,
    pub kind_name: String,
    pub score: i64,
    pub multiple: bool,
    pub options: Vec<ZhsExamOptionDto>,
}

fn question_dto(question: &ZhsExamQuestion) -> ZhsExamQuestionDto {
    ZhsExamQuestionDto {
        id: question.id.clone(),
        stem: question.stem.clone(),
        kind_id: question.kind_id,
        kind_name: question.kind_name.clone(),
        score: question.score,
        multiple: question.is_multiple(),
        options: question
            .options
            .iter()
            .map(|option| ZhsExamOptionDto {
                id: option.id.clone(),
                content: option.content.clone(),
            })
            .collect(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsExamPaperDto {
    pub exam_name: String,
    pub course_name: String,
    pub total_score: f64,
    pub problem_num: i64,
    pub question_count: usize,
    pub questions: Vec<ZhsExamQuestionDto>,
}

impl From<ZhsExamPaper> for ZhsExamPaperDto {
    fn from(paper: ZhsExamPaper) -> Self {
        let question_count = paper.question_count();
        let questions = paper.questions().map(question_dto).collect();
        Self {
            exam_name: paper.exam_name,
            course_name: paper.course_name,
            total_score: paper.total_score,
            problem_num: paper.problem_num,
            question_count,
            questions,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsPlanQuestionDto {
    pub question: ZhsExamQuestionDto,
    pub option_ids: Vec<String>,
    pub option_contents: Vec<String>,
    /// `submitted` / `ai_analysis` / `bank`.
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsUnresolvedDto {
    pub question_id: String,
    pub stem: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsExamPlanDto {
    pub exam_id: String,
    pub exam_name: String,
    pub total_score: f64,
    pub question_count: usize,
    pub resolved: usize,
    pub unresolved: Vec<ZhsUnresolvedDto>,
    pub complete: bool,
    pub questions: Vec<ZhsPlanQuestionDto>,
}

fn plan_dto(plan: &ZhsExamPlan) -> ZhsExamPlanDto {
    let unresolved_by_id: HashMap<&str, &ZhsExamQuestion> = plan
        .paper
        .questions()
        .filter(|question| plan.unresolved.iter().any(|id| id == &question.id))
        .map(|question| (question.id.as_str(), question))
        .collect();
    ZhsExamPlanDto {
        exam_id: plan.context.exam_id.clone(),
        exam_name: plan.paper.exam_name.clone(),
        total_score: plan.paper.total_score,
        question_count: plan.paper.question_count(),
        resolved: plan.questions.len(),
        unresolved: plan
            .unresolved
            .iter()
            .map(|id| ZhsUnresolvedDto {
                question_id: id.clone(),
                stem: unresolved_by_id
                    .get(id.as_str())
                    .map(|question| question.stem.clone())
                    .unwrap_or_default(),
            })
            .collect(),
        complete: plan.is_complete(),
        questions: plan
            .questions
            .iter()
            .map(|item| ZhsPlanQuestionDto {
                question: question_dto(&item.question),
                option_ids: item.option_ids.clone(),
                option_contents: item.option_contents.clone(),
                source: match item.source {
                    hust_course_hack::zhihuishu::ZhsAnswerSource::Submitted => "submitted",
                    hust_course_hack::zhihuishu::ZhsAnswerSource::AiAnalysis => "ai_analysis",
                    hust_course_hack::zhihuishu::ZhsAnswerSource::Bank => "bank",
                }
                .to_string(),
            })
            .collect(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsQuestionResultDto {
    pub question_id: String,
    pub stem: String,
    pub score: f64,
    pub full_score: f64,
    pub correct: bool,
    pub selected_contents: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsAnswerResultDto {
    pub dry_run: bool,
    pub plan: ZhsExamPlanDto,
    pub submitted: bool,
    pub score: Option<f64>,
    pub total_score: f64,
    pub correct_count: usize,
    pub question_count: usize,
    pub per_question: Vec<ZhsQuestionResultDto>,
    pub message: String,
    pub recorded_to_bank: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsBankInfoDto {
    pub total: usize,
    pub submitted_entries: usize,
    pub ai_entries: usize,
    /// Newest `updated_at_unix` across entries, when any.
    pub updated_at_unix: Option<u64>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsRecordAiResultDto {
    pub recorded: usize,
    pub skipped: usize,
    /// Question ids whose panel text was missing/unmappable (for the harvest
    /// overlay and manual follow-up).
    pub skipped_question_ids: Vec<String>,
    pub bank_total: usize,
    pub path: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ZhsAiEntryDto {
    /// Question id, when the page exposes it.
    pub question_id: Option<String>,
    /// Paper order fallback (0-based).
    pub index: Option<usize>,
    /// AI-analysis panel text.
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsExamAiEvent {
    pub recorded: usize,
    pub skipped: usize,
    pub bank_total: usize,
}

// ---- Commands --------------------------------------------------------------

/// Homework / unit-test list (unsubmitted or submitted) plus final exams.
#[tauri::command]
pub async fn zhs_exam_list(
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    submitted: bool,
) -> Result<ZhsExamListDto, String> {
    let client = exam_client(&state)?;
    let homework = client
        .list_homework(recruit_id, course_id, submitted)
        .await
        .map_err(|error| format!("读取知到作业/测验列表失败：{error:#}"))?;
    let (finals, finals_error) = if submitted {
        (Vec::new(), None)
    } else {
        match client.list_final_exams(recruit_id, course_id).await {
            Ok(finals) => (finals, None),
            Err(error) => {
                log::warn!("zhihuishu final-exam list failed: {error:#}");
                (Vec::new(), Some(format!("{error:#}")))
            }
        }
    };
    Ok(ZhsExamListDto {
        submitted,
        homework: homework.into_iter().map(ZhsHomeworkDto::from).collect(),
        finals: finals.into_iter().map(ZhsFinalExamDto::from).collect(),
        finals_error,
    })
}

/// Read-only paper preview. Unstarted attempts are refused on purpose: entering
/// them (`openExam`) starts the attempt timer, which the UI must warn about
/// before the user chooses 「重做并提交」.
#[tauri::command]
pub async fn zhs_exam_paper(
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    exam_id: String,
    submitted: bool,
) -> Result<ZhsExamPaperDto, String> {
    let client = exam_client(&state)?;
    let homework = find_homework(&client, recruit_id, course_id, &exam_id).await?;
    let paper = client.paper(&homework).await.map_err(|error| {
        if submitted {
            format!("读取已提交试卷失败：{error:#}")
        } else {
            format!(
                "未开始的试卷无法只读预览（进入考试会开始计时，已阻止）。请使用「重做并提交」并在确认提示后继续：{error:#}"
            )
        }
    })?;
    Ok(paper.into())
}

/// Answer plan for one submitted / already-started paper.
///
/// For an unstarted paper this can call `openExam` (starts the timer); the UI
/// shows a warning before calling it.
#[tauri::command]
pub async fn zhs_exam_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    exam_id: String,
) -> Result<ZhsExamPlanDto, String> {
    let client = exam_client(&state)?;
    ensure_not_final(&client, recruit_id, course_id, &exam_id).await?;
    let homework = find_homework(&client, recruit_id, course_id, &exam_id).await?;
    let paper = client
        .paper_for_answering(&homework)
        .await
        .map_err(|error| format!("读取试卷失败：{error:#}"))?;
    let context = client
        .context_for(&homework)
        .await
        .map_err(|error| format!("构建答题上下文失败：{error:#}"))?;
    let bank = load_bank(&app)?;
    Ok(plan_dto(&plan_exam(&paper, &context, &bank)))
}

/// Dry-run the answer plan, or submit it for real.
///
/// Real submission requires `dry_run=false` (the UI must have asked the user for
/// explicit confirmation), a complete plan and a non-final exam. Answers are
/// saved one by one with 1-3 s random pacing, then the paper is submitted and
/// re-read to report the score.
#[tauri::command]
pub async fn zhs_exam_answer(
    app: AppHandle,
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    exam_id: String,
    dry_run: bool,
) -> Result<ZhsAnswerResultDto, String> {
    if dry_run {
        let plan =
            zhs_exam_plan(app.clone(), state, recruit_id, course_id, exam_id.clone()).await?;
        return Ok(ZhsAnswerResultDto {
            dry_run: true,
            question_count: plan.question_count,
            total_score: plan.total_score,
            plan,
            submitted: false,
            score: None,
            correct_count: 0,
            per_question: Vec::new(),
            message: "试运行：只生成答题计划，没有进入考试、保存或提交。".to_string(),
            recorded_to_bank: 0,
        });
    }

    let _job = state.begin_job()?;
    let client = exam_client(&state)?;
    ensure_not_final(&client, recruit_id, course_id, &exam_id).await?;
    let homework = find_homework(&client, recruit_id, course_id, &exam_id).await?;

    // Starting an unsolved paper through the API now raises the platform's
    // slider captcha (code -12) and never reaches save/submit. The GUI drives
    // that attempt in an isolated webview instead.
    let already_submitted = homework.state == Some(1) || homework.achieve.is_some();
    if !already_submitted {
        return Err(
            "平台对未开始试卷的 API 作答会弹出滑块验证（code -12），纯 API 无法通过。请使用「网页作答」入口：窗口内手动完成滑块后会自动读取计划、作答并提交；本次未保存/提交任何答案。"
                .to_string(),
        );
    }

    // This may start the attempt timer when the paper was never opened.
    let paper = client
        .paper_for_answering(&homework)
        .await
        .map_err(|error| format!("进入试卷失败：{error:#}"))?;
    let context = client
        .context_for(&homework)
        .await
        .map_err(|error| format!("构建答题上下文失败：{error:#}"))?;
    let bank = load_bank(&app)?;
    let plan = plan_exam(&paper, &context, &bank);
    if !plan.is_complete() {
        let unresolved = plan.unresolved.len();
        return Err(format!(
            "答题计划不完整：{unresolved} 道题没有可信答案（共 {} 题）。为避免低分提交已停止，未保存任何答案；请先采集/导入 AI解析 或已提交试卷的答案。",
            plan.paper.question_count()
        ));
    }

    let total = plan.questions.len();
    emit_exam_progress(
        &app,
        "saving",
        0,
        total,
        "准备保存答案",
        "逐题保存中（每题间隔 1-3 秒）",
    );
    for (offset, item) in plan.questions.iter().enumerate() {
        if state.is_cancelled() {
            return Err("已取消：未提交试卷（本次已进入考试，可能已消耗一次尝试机会）".to_string());
        }
        if offset > 0 {
            pace(1000 + jitter(2000)).await;
        }
        let saved = client
            .save_answer(&homework, &item.question, &item.option_ids)
            .await
            .map_err(|error| {
                format!("保存第 {} 题失败：{error:#}（已停止，未提交）", offset + 1)
            })?;
        if !saved {
            return Err(format!(
                "第 {} 题被平台拒绝（statu != 1），已停止且未提交",
                offset + 1
            ));
        }
        emit_exam_progress(
            &app,
            "saving",
            offset + 1,
            total,
            &exam_question_label(&item.question, offset),
            "已保存",
        );
    }

    if state.is_cancelled() {
        return Err("已取消：未提交试卷（本次已进入考试，可能已消耗一次尝试机会）".to_string());
    }

    emit_exam_progress(&app, "submitting", total, total, "提交试卷", "正在提交…");
    let submit = client
        .submit(&homework)
        .await
        .map_err(|error| format!("提交试卷失败：{error:#}"))?;

    emit_exam_progress(
        &app,
        "verifying",
        total,
        total,
        "复核成绩",
        "正在读取提交后的分数…",
    );

    // Re-read the submitted paper to report the real score.
    let paper_after = match client.paper(&homework).await {
        Ok(paper) => paper,
        Err(error) => {
            log::warn!("reading the submitted paper failed: {error:#}");
            paper.clone()
        }
    };
    let submitted_answers = client
        .submitted_answers(&homework, &paper_after)
        .await
        .unwrap_or_default();
    let mut bank = load_bank(&app)?;
    let recorded_to_bank = bank.record_submitted(&paper_after, &submitted_answers, now_unix());
    if recorded_to_bank > 0 {
        save_bank(&app, &bank)?;
    }

    let by_question: HashMap<&str, &hust_course_hack::zhihuishu::ZhsSubmittedAnswer> =
        submitted_answers
            .iter()
            .map(|answer| (answer.question_id.as_str(), answer))
            .collect();
    let mut per_question = Vec::with_capacity(paper_after.question_count());
    let mut correct_count = 0usize;
    let mut summed_score = 0.0f64;
    for question in paper_after.questions() {
        let answer = by_question.get(question.id.as_str());
        let score = answer.map(|item| item.score).unwrap_or(0.0);
        let correct = question.score > 0 && score + 0.001 >= question.score as f64;
        if correct {
            correct_count += 1;
        }
        summed_score += score;
        let selected_contents = answer
            .map(|item| {
                item.option_ids
                    .iter()
                    .filter_map(|id| {
                        question
                            .options
                            .iter()
                            .find(|option| &option.id == id)
                            .map(|option| option.content.clone())
                    })
                    .collect()
            })
            .unwrap_or_default();
        per_question.push(ZhsQuestionResultDto {
            question_id: question.id.clone(),
            stem: question.stem.clone(),
            score,
            full_score: question.score as f64,
            correct,
            selected_contents,
        });
    }

    Ok(ZhsAnswerResultDto {
        dry_run: false,
        question_count: paper_after.question_count(),
        total_score: paper_after.total_score,
        plan: plan_dto(&plan),
        submitted: true,
        score: submit.score.or(Some(summed_score)),
        correct_count,
        per_question,
        message: submit.message,
        recorded_to_bank,
    })
}

/// Answer-bank statistics kept in the app data directory.
#[tauri::command]
pub fn zhs_exam_bank_info(app: AppHandle) -> Result<ZhsBankInfoDto, String> {
    let path = bank_path(&app)?;
    let bank = load_bank(&app)?;
    let submitted_entries = bank
        .entries
        .iter()
        .filter(|entry| entry.source == "submitted")
        .count();
    let ai_entries = bank
        .entries
        .iter()
        .filter(|entry| entry.source == "ai_analysis")
        .count();
    let updated_at_unix = bank.entries.iter().map(|entry| entry.updated_at_unix).max();
    Ok(ZhsBankInfoDto {
        total: bank.len(),
        submitted_entries,
        ai_entries,
        updated_at_unix,
        path: path.display().to_string(),
    })
}

/// Persist AI-analysis texts harvested by the exam window (or pasted by hand).
///
/// Maintainer-only: the normal GUI never exposes this command (the harvest /
/// manual-import UI is hidden behind the `#dev` URL hash). Kept registered so
/// the maintainer can populate `test-data/zhihuishu-answer-bank.json`.
#[tauri::command]
pub async fn zhs_exam_record_ai(
    app: AppHandle,
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    exam_id: String,
    entries: Vec<ZhsAiEntryDto>,
) -> Result<ZhsRecordAiResultDto, String> {
    if entries.is_empty() {
        return Err("没有可写入的 AI解析 文本".to_string());
    }
    let client = exam_client(&state)?;
    let homework = find_homework(&client, recruit_id, course_id, &exam_id).await?;
    let paper = client
        .paper(&homework)
        .await
        .map_err(|error| format!("读取试卷失败（AI解析采集仅支持已提交试卷）：{error:#}"))?;

    let ordered: Vec<&ZhsExamQuestion> = paper.questions().collect();
    let mut texts: HashMap<String, String> = HashMap::new();
    let mut skipped = 0usize;
    let mut skipped_question_ids: Vec<String> = Vec::new();
    for entry in &entries {
        let question = entry
            .question_id
            .as_deref()
            .and_then(|id| ordered.iter().find(|question| question.id == id).copied())
            .or_else(|| entry.index.and_then(|index| ordered.get(index).copied()));
        let Some(question) = question else {
            skipped += 1;
            if let Some(id) = &entry.question_id {
                skipped_question_ids.push(id.clone());
            }
            continue;
        };
        if entry.text.trim().is_empty() {
            skipped += 1;
            skipped_question_ids.push(question.id.clone());
            continue;
        }
        texts.insert(question.id.clone(), entry.text.clone());
    }
    if texts.is_empty() {
        return Err(
            "所有 AI解析 文本都无法对应到试卷题目（请确认试卷与解析页是同一场）".to_string(),
        );
    }

    let path = bank_path(&app)?;
    let mut bank = load_bank(&app)?;
    let recorded = bank.record_ai_analysis(&paper, &texts, now_unix());
    save_bank(&app, &bank)?;
    let result = ZhsRecordAiResultDto {
        recorded,
        skipped: skipped + (entries.len().saturating_sub(skipped) - texts.len()),
        skipped_question_ids,
        bank_total: bank.len(),
        path: path.display().to_string(),
    };
    let _ = app.emit(
        "zhs-exam-ai",
        ZhsExamAiEvent {
            recorded: result.recorded,
            skipped: result.skipped,
            bank_total: result.bank_total,
        },
    );
    Ok(result)
}

/// Open the isolated WebView2 window that harvests AI-analysis texts from the
/// platform's "check submitted homework" page.
///
/// Maintainer-only (hidden behind the `#dev` URL hash in the GUI): normal users
/// only see list → 看试卷 → 网页作答/网页重做. The session cookies are injected
/// into the window's own WebView2 profile before navigating to the exam page;
/// they never cross the IPC boundary.
#[tauri::command]
pub async fn zhs_exam_open_check_window(
    app: AppHandle,
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    exam_id: String,
) -> Result<(), String> {
    let client = exam_client(&state)?;
    ensure_exam_sso_ready(&state)?;
    let homework = find_homework(&client, recruit_id, course_id, &exam_id).await?;
    open_check_window(&app, recruit_id, course_id, &homework)
}

/// JS console bridge for the exam window: appends errors to the window log.
#[tauri::command]
pub async fn zhs_exam_js_error(
    app: AppHandle,
    window_label: String,
    message: String,
) -> Result<(), String> {
    let message: String = message.chars().take(600).collect();
    exam_log(&app, format!("js {window_label}: {message}"));
    log::warn!("zhihuishu exam window js error ({window_label}): {message}");
    Ok(())
}
// ---- Homework / exam summary and redo --------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsExamSummaryDto {
    /// Homework + unit-test / meet-quiz papers for this course.
    pub homework_total: usize,
    pub homework_submitted: usize,
    /// Average score of the submitted papers that already have a score.
    pub average_score: Option<f64>,
    pub final_exam_count: usize,
    /// Finals whose remaining attempts dropped to zero (platform has no direct
    /// submitted flag; `faStudentExamRemainCount == 0` is the closest signal).
    pub final_exam_submitted: usize,
}

/// Stat-strip summary for the course page and the exam modal header.
#[tauri::command]
pub async fn zhs_exam_summary(
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
) -> Result<ZhsExamSummaryDto, String> {
    let client = exam_client(&state)?;
    let pending = client
        .list_homework(recruit_id, course_id, false)
        .await
        .map_err(|error| format!("读取作业列表失败：{error:#}"))?;
    let submitted = client
        .list_homework(recruit_id, course_id, true)
        .await
        .map_err(|error| format!("读取已提交作业失败：{error:#}"))?;
    let finals = client
        .list_final_exams(recruit_id, course_id)
        .await
        .unwrap_or_default();
    let scores: Vec<f64> = submitted
        .iter()
        .filter_map(|homework| homework.score.or(homework.achieve))
        .collect();
    let average_score = if scores.is_empty() {
        None
    } else {
        let sum: f64 = scores.iter().sum();
        Some((sum / scores.len() as f64 * 10.0).round() / 10.0)
    };
    let final_exam_submitted = finals
        .iter()
        .filter(|final_exam| final_exam.remain_count == Some(0))
        .count();
    Ok(ZhsExamSummaryDto {
        homework_total: pending.len() + submitted.len(),
        homework_submitted: submitted.len(),
        average_score,
        final_exam_count: finals.len(),
        final_exam_submitted,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsRedoResultDto {
    pub started: bool,
    pub message: String,
}

/// Result event for the webview-driven redo flow.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsRedoEventDto {
    pub exam_id: String,
    pub ok: bool,
    pub reason: String,
}

/// Request a redo through the exam-list webview.
///
/// The platform's `student/applyRedo` API is a dead end (it returns `rt:0`
/// without moving the attempt); the working browser flow is the list page
/// click sequence. This opens the exam list with the course
/// `recruitAndCourseId` secret and the injected [`REDO_SCRIPT`] switches to
/// 已提交, clicks 申请重做 and confirms the dialog. The script reports back
/// through [`zhs_exam_redo_result`], which emits `zhs-exam-redo`; on success the
/// window is destroyed and the UI refreshes + opens the attempt window.
///
/// Finals are never redone (single attempt, list-only).
#[tauri::command]
pub async fn zhs_exam_redo(
    app: AppHandle,
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    exam_name_or_id: String,
) -> Result<ZhsRedoResultDto, String> {
    let client = exam_client(&state)?;
    ensure_exam_sso_ready(&state)?;
    let homework = find_homework_ref(&client, recruit_id, course_id, &exam_name_or_id).await?;
    ensure_not_final(&client, recruit_id, course_id, &homework.exam_id).await?;
    if homework.state != Some(1) && homework.achieve.is_none() {
        return Err("该作业尚未提交，无需申请重做；直接点「网页作答」即可。".to_string());
    }
    if homework.back_num == Some(0) {
        return Err("平台显示剩余重做次数为 0，无法申请重做。".to_string());
    }
    let secret = state
        .zhs_course(&course_id.to_string())
        .map(|course| course.secret_or_derive())
        .unwrap_or_else(|| {
            ZhsCourse {
                recruit_id,
                course_id,
                ..Default::default()
            }
            .course_secret()
        });
    let url = exam_list_url(&secret)?;
    let context_json = serde_json::json!({
        "mode": "redo",
        "windowLabel": EXAM_WINDOW_LABEL,
        "recruitId": recruit_id,
        "courseId": course_id,
        "examId": homework.exam_id,
        "stuExamId": homework.stu_exam_id,
        "targetName": homework.name,
    });
    let script = format!(
        "window.__ZHS_EXAM_CTX__ = {};\n{}\n{}",
        context_json, DIAGNOSTIC_SCRIPT, REDO_SCRIPT
    );
    exam_log(
        &app,
        format!(
            "redo requested via webview: {} (examId={}, backNum={:?})",
            homework.name, homework.exam_id, homework.back_num
        ),
    );
    open_exam_window(&app, url, "知到 · 申请重做", script)?;
    Ok(ZhsRedoResultDto {
        started: true,
        message: "已打开考试列表窗口，正在自动申请重做…".to_string(),
    })
}

/// Result reported by the injected redo script (also closes the window on
/// success so the UI can refresh and open the attempt window).
#[tauri::command]
pub async fn zhs_exam_redo_result(
    app: AppHandle,
    exam_id: String,
    ok: bool,
    reason: String,
) -> Result<(), String> {
    let reason_log: String = reason.chars().take(300).collect();
    exam_log(
        &app,
        format!("redo result: examId={exam_id} ok={ok} reason={reason_log}"),
    );
    let _ = app.emit(
        "zhs-exam-redo",
        ZhsRedoEventDto {
            exam_id,
            ok,
            reason,
        },
    );
    if ok && let Some(window) = app.get_webview_window(EXAM_WINDOW_LABEL) {
        let _ = window.destroy();
    }
    Ok(())
}
/// Stub hook for the 网易易盾 click-character captcha solver.
///
/// The attempt script detects the captcha, calls this command and falls back to
/// asking the user to complete it manually in the window; it never clicks random
/// coordinates. A real solver can be wired here later (the PNG bytes are already
/// part of the contract).
#[tauri::command]
pub async fn zhs_exam_solve_captcha(
    app: AppHandle,
    window_label: String,
    png_base64: String,
) -> Result<(), String> {
    exam_log(
        &app,
        format!(
            "captcha solve requested: window={window_label} png_bytes={}",
            png_base64.len()
        ),
    );
    Err(
        "未接入网易易盾点击验证码求解器；请在窗口内手动完成一次验证，通过后会自动继续。"
            .to_string(),
    )
}
// ---- Webview-driven attempt ------------------------------------------------

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ZhsWebviewOptionDto {
    pub id: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ZhsWebviewQuestionDto {
    pub question_id: String,
    pub stem: String,
    pub kind_id: i64,
    pub kind_name: String,
    pub score: i64,
    pub options: Vec<ZhsWebviewOptionDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsWebviewUnresolvedDto {
    pub question_id: String,
    pub stem: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsWebviewPlanDto {
    pub total: usize,
    pub resolved: usize,
    pub complete: bool,
    /// `questionId -> correct option contents` (ids are unstable across attempts).
    pub answers: HashMap<String, Vec<String>>,
    pub unresolved: Vec<ZhsWebviewUnresolvedDto>,
}

/// One question whose submitted answer did not earn full marks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsWrongQuestionDto {
    pub question_id: String,
    pub stem: String,
    pub score: f64,
    pub full_score: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZhsWebviewResultDto {
    pub submitted: bool,
    pub score: Option<f64>,
    pub total_score: f64,
    pub correct_count: usize,
    pub question_count: usize,
    pub recorded_to_bank: usize,
    /// Questions that did not earn full marks (shown to the user; the app never
    /// auto-retries because attempts are limited).
    pub wrong_questions: Vec<ZhsWrongQuestionDto>,
    pub message: String,
}

/// Open the `dohomework` page for a webview-driven attempt.
///
/// The platform blocks the bare API attempt with a slider captcha; the user
/// completes it once in the window, then the injected script reads the paper,
/// asks [`zhs_exam_webview_plan`] for the bank plan, clicks the answers and
/// submits after an explicit 「开始自动作答」 click.
#[tauri::command]
pub async fn zhs_exam_open_attempt_window(
    app: AppHandle,
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    exam_id: String,
) -> Result<(), String> {
    let client = exam_client(&state)?;
    ensure_exam_sso_ready(&state)?;
    ensure_not_final(&client, recruit_id, course_id, &exam_id).await?;
    let homework = find_homework(&client, recruit_id, course_id, &exam_id).await?;
    open_attempt_window(&app, recruit_id, course_id, &homework)
}

/// Plan the questions scraped from the attempt page against the local bank.
#[tauri::command]
pub async fn zhs_exam_webview_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    exam_id: String,
    questions: Vec<ZhsWebviewQuestionDto>,
) -> Result<ZhsWebviewPlanDto, String> {
    if questions.is_empty() {
        return Err("网页中还没有读到题目".to_string());
    }
    let client = exam_client(&state)?;
    let bank = load_bank(&app)?;
    let paper = match find_homework(&client, recruit_id, course_id, &exam_id).await {
        Ok(homework) => client.paper(&homework).await.ok(),
        Err(_) => None,
    };
    let authoritative: Vec<&ZhsExamQuestion> = paper
        .as_ref()
        .map(|paper| paper.questions().collect())
        .unwrap_or_default();

    let mut answers: HashMap<String, Vec<String>> = HashMap::new();
    let mut unresolved = Vec::new();
    for dom in &questions {
        let dom_question = ZhsExamQuestion {
            id: dom.question_id.clone(),
            stem: dom.stem.clone(),
            kind_id: if dom.kind_id != 0 {
                dom.kind_id
            } else {
                kind_id_from_name(&dom.kind_name)
            },
            kind_name: dom.kind_name.clone(),
            options: dom
                .options
                .iter()
                .enumerate()
                .map(|(index, option)| ZhsExamOption {
                    id: option.id.clone().unwrap_or_else(|| format!("dom-{index}")),
                    content: option.content.clone(),
                })
                .collect(),
            score: dom.score,
            eid: None,
        };
        let candidate = authoritative
            .iter()
            .copied()
            .find(|question| question.id == dom.question_id)
            .or_else(|| {
                authoritative
                    .iter()
                    .copied()
                    .find(|question| normalized(&question.stem) == normalized(&dom.stem))
            });
        let resolved = candidate
            .and_then(|question| bank.resolve(question))
            .or_else(|| bank.resolve(&dom_question))
            .or_else(|| fuzzy_resolve(&bank, &dom_question));
        match resolved {
            Some(options) if !options.is_empty() => {
                answers.insert(
                    dom.question_id.clone(),
                    options
                        .iter()
                        .map(|option| option.content.clone())
                        .collect(),
                );
            }
            _ => unresolved.push(ZhsWebviewUnresolvedDto {
                question_id: dom.question_id.clone(),
                stem: dom.stem.clone(),
            }),
        }
    }
    let total = questions.len();
    Ok(ZhsWebviewPlanDto {
        total,
        resolved: answers.len(),
        complete: unresolved.is_empty() && total > 0,
        answers,
        unresolved,
    })
}

/// After the webview submits, re-read the submitted paper, persist full-score
/// answers into the bank and report the score/correctness.
#[tauri::command]
pub async fn zhs_exam_webview_submitted(
    app: AppHandle,
    state: State<'_, AppState>,
    recruit_id: u64,
    course_id: u64,
    exam_id: String,
    score: Option<f64>,
) -> Result<ZhsWebviewResultDto, String> {
    let client = exam_client(&state)?;
    let mut homework = None;
    for attempt in 0..4 {
        if attempt > 0 {
            pace(1500).await;
        }
        if let Ok(found) = find_homework(&client, recruit_id, course_id, &exam_id).await
            && (found.state == Some(1) || found.achieve.is_some())
        {
            homework = Some(found);
            break;
        }
    }
    let Some(homework) = homework else {
        return Ok(ZhsWebviewResultDto {
            submitted: true,
            score,
            total_score: 0.0,
            correct_count: 0,
            question_count: 0,
            recorded_to_bank: 0,
            wrong_questions: Vec::new(),
            message: "已提交；平台列表尚未刷新，稍后可在「已提交」中查看成绩".to_string(),
        });
    };
    let paper = client
        .paper(&homework)
        .await
        .map_err(|error| format!("读取提交后的试卷失败：{error:#}"))?;
    let submitted = client
        .submitted_answers(&homework, &paper)
        .await
        .unwrap_or_default();
    let mut bank = load_bank(&app)?;
    let recorded_to_bank = bank.record_submitted(&paper, &submitted, now_unix());
    if recorded_to_bank > 0 {
        save_bank(&app, &bank)?;
    }
    let by_id: HashMap<&str, &ZhsSubmittedAnswer> = submitted
        .iter()
        .map(|answer| (answer.question_id.as_str(), answer))
        .collect();
    let mut correct_count = 0usize;
    let mut summed = 0.0f64;
    let mut wrong_questions = Vec::new();
    for question in paper.questions() {
        let item_score = by_id
            .get(question.id.as_str())
            .map(|answer| answer.score)
            .unwrap_or(0.0);
        summed += item_score;
        if question.score > 0 && item_score + 0.001 >= question.score as f64 {
            correct_count += 1;
        } else {
            wrong_questions.push(ZhsWrongQuestionDto {
                question_id: question.id.clone(),
                stem: question.stem.clone(),
                score: item_score,
                full_score: question.score,
            });
        }
    }
    // `homework.score` comes from the platform after grading and is authoritative
    // when present; the per-question sum is the fallback/check-sheet total.
    let authoritative_score = homework.score.or(Some(summed));
    let wrong_count = wrong_questions.len();
    let message = if wrong_count == 0 {
        "已提交：全部题目满分，已写入答案库".to_string()
    } else {
        format!("已提交：{wrong_count} 题未得满分（尝试次数有限，不会自动重试）")
    };
    let result = ZhsWebviewResultDto {
        submitted: true,
        score: score.or(authoritative_score),
        total_score: paper.total_score,
        correct_count,
        question_count: paper.question_count(),
        recorded_to_bank,
        wrong_questions,
        message,
    };
    let _ = app.emit("zhs-exam-result", &result);
    Ok(result)
}
// ---- Helpers ---------------------------------------------------------------

/// Exam/redo windows are only opened after the login flow completed the exam
/// engine SSO; otherwise the window would stall on the passport redirect.
fn ensure_exam_sso_ready(state: &AppState) -> Result<(), String> {
    if state.zhs_exam_sso_ready() {
        return Ok(());
    }
    Err(
        "考试引擎会话尚未就绪（登录时未完成考试 SSO）。请回主界面重新登录知到一次，登录窗口会自动完成考试引擎验证后再打开考试窗口。"
            .to_string(),
    )
}

fn exam_client(state: &AppState) -> Result<ZhsExamClient, String> {
    let zhs = state
        .zhs_client()
        .ok_or_else(|| "尚未连接知到账号，请先在连接页登录知到".to_string())?;
    Ok(ZhsExamClient::new(zhs))
}

async fn find_homework(
    client: &ZhsExamClient,
    recruit_id: u64,
    course_id: u64,
    exam_id: &str,
) -> Result<ZhsHomework, String> {
    for submitted in [false, true] {
        let list = client
            .list_homework(recruit_id, course_id, submitted)
            .await
            .map_err(|error| format!("读取知到作业列表失败：{error:#}"))?;
        if let Some(homework) = list.into_iter().find(|item| item.exam_id == exam_id) {
            return Ok(homework);
        }
    }
    Err(format!("未找到考试 {exam_id}，请先刷新作业/测验列表"))
}

fn kind_id_from_name(name: &str) -> i64 {
    if name.contains("多选") {
        2
    } else if name.contains("判断") {
        3
    } else {
        1
    }
}

/// Normalize a stem/content for fuzzy matching: drop whitespace and common
/// punctuation, lowercase ASCII. The core keeps its own stricter normalizer for
/// bank keys; this one only bridges DOM text to bank entries.
fn normalized(text: &str) -> String {
    text.chars()
        .filter(|ch| {
            !ch.is_whitespace()
                && !matches!(
                    ch,
                    '，' | '。'
                        | '；'
                        | '：'
                        | '、'
                        | '（'
                        | '）'
                        | '('
                        | ')'
                        | '"'
                        | '\''
                        | '“'
                        | '”'
                        | '‘'
                        | '’'
                        | '？'
                        | '！'
                        | '?'
                        | '!'
                        | ','
                        | '.'
                        | ';'
                        | ':'
                        | '/'
                        | '\\'
                )
        })
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

/// Resolve one bank entry's answer contents against the DOM question's options.
fn resolve_entry(entry: &ZhsBankEntry, question: &ZhsExamQuestion) -> Option<Vec<ZhsExamOption>> {
    if entry.answers.is_empty() {
        return None;
    }
    let mut resolved: Vec<ZhsExamOption> = Vec::new();
    for answer in &entry.answers {
        let target = normalized(answer);
        if target.is_empty() {
            return None;
        }
        let option = question.options.iter().find(|option| {
            let content = normalized(&option.content);
            !content.is_empty()
                && (content == target || content.contains(&target) || target.contains(&content))
        })?;
        if resolved.iter().any(|item| item.id == option.id) {
            return None;
        }
        resolved.push(option.clone());
    }
    Some(resolved)
}

/// Last resort when neither the question id nor the exact stem matches: compare
/// a normalized DOM stem with every bank entry and accept a long containment.
fn fuzzy_resolve(bank: &ZhsAnswerBank, question: &ZhsExamQuestion) -> Option<Vec<ZhsExamOption>> {
    let stem = normalized(&question.stem);
    if stem.is_empty() {
        return None;
    }
    let mut best: Option<(&ZhsBankEntry, usize)> = None;
    for entry in &bank.entries {
        let entry_stem = normalized(&entry.stem);
        if entry_stem.is_empty() {
            continue;
        }
        let score = if entry_stem == stem {
            usize::MAX
        } else if stem.contains(&entry_stem) || entry_stem.contains(&stem) {
            entry_stem.chars().count().min(stem.chars().count())
        } else {
            continue;
        };
        if best.is_none_or(|(_, best_score)| score > best_score) {
            best = Some((entry, score));
        }
    }
    let (entry, score) = best?;
    if score == usize::MAX || score >= 8 {
        resolve_entry(entry, question)
    } else {
        None
    }
}

/// Like [`find_homework`] but accepts the exam name as well (the redo UI passes
/// `name` because it is what the list webview shows).
async fn find_homework_ref(
    client: &ZhsExamClient,
    recruit_id: u64,
    course_id: u64,
    reference: &str,
) -> Result<ZhsHomework, String> {
    for submitted in [false, true] {
        let list = client
            .list_homework(recruit_id, course_id, submitted)
            .await
            .map_err(|error| format!("读取知到作业列表失败：{error:#}"))?;
        if let Some(homework) = list
            .iter()
            .find(|item| item.exam_id == reference || item.name == reference)
        {
            return Ok(homework.clone());
        }
    }
    // Truncated/renamed titles: accept a containment match as the last resort.
    for submitted in [false, true] {
        let list = client
            .list_homework(recruit_id, course_id, submitted)
            .await
            .map_err(|error| format!("读取知到作业列表失败：{error:#}"))?;
        if let Some(homework) = list.into_iter().find(|item| {
            !reference.trim().is_empty()
                && (item.name.contains(reference) || reference.contains(item.name.as_str()))
        }) {
            return Ok(homework);
        }
    }
    Err(format!(
        "未找到作业「{reference}」，请先在作业/考试弹窗点「刷新」后再试"
    ))
}

/// Exam list URL used by the webview redo flow.
fn exam_list_url(secret: &str) -> Result<Url, String> {
    let encoded = base64_encode(secret);
    let raw = format!(
        "https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId={encoded}"
    );
    Url::parse(&raw).map_err(|error| format!("申请重做页地址无效：{error}"))
}

/// Minimal base64 encoder (the exam list expects the secret base64-encoded, and
/// the GUI crate intentionally has no extra codec dependency).
pub(crate) fn base64_encode(input: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let value = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Reject the one-attempt final exam (list-only in the GUI).
async fn ensure_not_final(
    client: &ZhsExamClient,
    recruit_id: u64,
    course_id: u64,
    exam_id: &str,
) -> Result<(), String> {
    let finals = client
        .list_final_exams(recruit_id, course_id)
        .await
        .unwrap_or_default();
    if finals
        .iter()
        .any(|final_exam| final_exam.exam_id == exam_id)
    {
        return Err(
            "期末/教程考试只有 1 次机会，GUI 仅支持查看，不生成答题计划、不自动提交".to_string(),
        );
    }
    Ok(())
}

fn bank_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(BANK_FILE))
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

fn load_bank(app: &AppHandle) -> Result<ZhsAnswerBank, String> {
    let path = bank_path(app)?;
    let first_use = !path.exists();
    let mut bank = ZhsAnswerBank::load_or_builtin(&path)
        .map_err(|error| format!("读取答案库失败：{error:#}"))?;
    // Seed the app-data bank from the compile-time bank on first use and merge
    // entries added by later app updates, so end users never need a harvest step.
    let builtin = ZhsAnswerBank::builtin();
    let mut merged_any = false;
    for entry in builtin.entries {
        if !bank
            .entries
            .iter()
            .any(|existing| existing.key == entry.key)
        {
            bank.entries.push(entry);
            merged_any = true;
        }
    }
    if first_use || merged_any {
        bank.save(&path)
            .map_err(|error| format!("写入答案库失败：{error:#}"))?;
    }
    Ok(bank)
}

fn save_bank(app: &AppHandle, bank: &ZhsAnswerBank) -> Result<(), String> {
    let path = bank_path(app)?;
    bank.save(&path)
        .map_err(|error| format!("保存答案库失败：{error:#}"))
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn emit_exam_progress(
    app: &AppHandle,
    stage: &str,
    done: usize,
    total: usize,
    label: &str,
    message: &str,
) {
    let _ = app.emit(
        "job-progress",
        JobProgress::ZhsExamProgress {
            stage: stage.to_string(),
            done,
            total,
            label: label.to_string(),
            message: message.to_string(),
        },
    );
}

/// Short label of one exam question for progress events (stem is not secret).
fn exam_question_label(question: &ZhsExamQuestion, offset: usize) -> String {
    let stem = question.stem.trim();
    let stem: String = stem.chars().take(36).collect();
    if stem.is_empty() {
        format!("第 {} 题", offset + 1)
    } else {
        format!("第 {} 题：{stem}", offset + 1)
    }
}

fn jitter(max_ms: u64) -> u64 {
    if max_ms == 0 {
        return 0;
    }
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as u64)
        .unwrap_or(0);
    seed % (max_ms + 1)
}

async fn pace(ms: u64) {
    if ms == 0 {
        return;
    }
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(ms));
    })
    .await;
}

// ---- Exam WebView2 window --------------------------------------------------

fn open_check_window(
    app: &AppHandle,
    recruit_id: u64,
    course_id: u64,
    homework: &ZhsHomework,
) -> Result<(), String> {
    let url = exam_check_url(recruit_id, course_id, homework);
    let context_json = serde_json::json!({
        "mode": "harvest",
        "windowLabel": EXAM_WINDOW_LABEL,
        "recruitId": recruit_id,
        "courseId": course_id,
        "examId": homework.exam_id,
        "stuExamId": homework.stu_exam_id,
        "name": homework.name,
    });
    let script = format!(
        "window.__ZHS_EXAM_CTX__ = {};\n{}\n{}",
        context_json, DIAGNOSTIC_SCRIPT, HARVEST_SCRIPT
    );
    open_exam_window(app, url, "知到 · 作业/考试 AI解析采集", script)
}

fn open_attempt_window(
    app: &AppHandle,
    recruit_id: u64,
    course_id: u64,
    homework: &ZhsHomework,
) -> Result<(), String> {
    let url = exam_attempt_url(recruit_id, course_id, homework);
    let context_json = serde_json::json!({
        "mode": "attempt",
        "windowLabel": EXAM_WINDOW_LABEL,
        "recruitId": recruit_id,
        "courseId": course_id,
        "examId": homework.exam_id,
        "stuExamId": homework.stu_exam_id,
        "name": homework.name,
    });
    let script = format!(
        "window.__ZHS_EXAM_CTX__ = {};\n{}\n{}",
        context_json, DIAGNOSTIC_SCRIPT, ATTEMPT_SCRIPT
    );
    open_exam_window(app, url, "知到 · 网页作答（滑块验证后自动作答）", script)
}

/// Open the shared isolated WebView2 window (cookies injected from the Rust
/// jar, temporary profile cleaned on destroy).
/// File log for the exam window only. Never receives cookie values.
pub(crate) fn exam_log(app: &AppHandle, message: impl AsRef<str>) {
    static LOCK: Mutex<()> = Mutex::new(());
    let Some(path) = exam_log_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line: String = message
        .as_ref()
        .chars()
        .map(|ch| if ch == '\n' || ch == '\r' { ' ' } else { ch })
        .take(600)
        .collect();
    let stamp = now_unix();
    if let Ok(_guard) = LOCK.lock()
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
    {
        let _ = writeln!(file, "[{stamp}] {line}");
    }
}

fn exam_log_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return Some(
            PathBuf::from(appdata)
                .join("hust-course-hack")
                .join("logs")
                .join("zhs-exam.log"),
        );
    }
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("logs").join("zhs-exam.log"))
}

/// Render the visible error panel inside the exam window (never leave it white).
fn show_exam_error(window: &tauri::WebviewWindow, title: &str, detail: &str) {
    let Ok(title) = serde_json::to_string(title) else {
        return;
    };
    let Ok(detail) = serde_json::to_string(detail) else {
        return;
    };
    let script = format!(
        "if (window.__ZHS_SHOW_ERROR__) {{ window.__ZHS_SHOW_ERROR__({title}, {detail}); }}"
    );
    if let Err(error) = window.eval(script) {
        log::warn!("zhihuishu exam window: cannot render the error panel: {error}");
    }
}

/// Render the non-blocking "please log in in this window" banner.
fn show_exam_login_prompt(window: &tauri::WebviewWindow, text: &str) {
    let Ok(text) = serde_json::to_string(text) else {
        return;
    };
    let script = format!(
        "if (window.__ZHS_SHOW_LOGIN_PROMPT__) {{ window.__ZHS_SHOW_LOGIN_PROMPT__({text}); }}"
    );
    let _ = window.eval(script);
}

async fn exam_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(ms));
    })
    .await;
}

/// Open the shared isolated WebView2 window: about:blank first, cookies injected
/// into its own profile, then the exam page. Any failure is rendered in the
/// window (plus `%APPDATA%\hust-course-hack\logs\zhs-exam.log`).
fn open_exam_window(
    app: &AppHandle,
    exam_url: Url,
    title: &str,
    script: String,
) -> Result<(), String> {
    let open_started = Instant::now();
    exam_log(app, format!("open request (+0ms): {title} -> {exam_url}"));

    // The fixed label must not be reused while its WebView2 is still alive:
    // destroy the stale window and wait until Tauri really dropped it.
    if let Some(existing) = app.get_webview_window(EXAM_WINDOW_LABEL) {
        exam_log(app, "destroying stale exam window before recreating");
        let _ = existing.destroy();
        for _ in 0..40 {
            if app.get_webview_window(EXAM_WINDOW_LABEL).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if app.get_webview_window(EXAM_WINDOW_LABEL).is_some() {
            exam_log(
                app,
                "stale exam window still registered after destroy; recreating anyway",
            );
        }
    }

    // Reuse the login window's WebView2 profile when available: the CAS/SSO
    // state lives in the profile and cannot be reproduced by injecting cookies
    // into a fresh one. Wait for the login window to release the profile first.
    let mut shared_profile = app.state::<AppState>().zhs_webview_dir();
    if shared_profile.is_some() && app.get_webview_window(LOGIN_LABEL).is_some() {
        exam_log(
            app,
            "exam window: waiting for the login window to release the shared profile",
        );
        for _ in 0..60 {
            if app.get_webview_window(LOGIN_LABEL).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let using_shared = shared_profile.is_some() && app.get_webview_window(LOGIN_LABEL).is_none();
    let data_dir = if using_shared {
        let dir = shared_profile.take().expect("shared profile checked");
        exam_log(
            app,
            format!(
                "exam window: shared login profile={} (cookie injection skipped)",
                dir.display()
            ),
        );
        dir
    } else {
        exam_log(app, "exam window: temp profile + cookie injection");
        exam_data_dir()
    };
    let blank = Url::parse("about:blank").map_err(|error| format!("无效的空白页地址：{error}"))?;
    let injected = Arc::new(AtomicUsize::new(0));
    let loaded = Arc::new(AtomicBool::new(false));
    let app_nav = app.clone();
    let app_load = app.clone();
    let app_merge = app.clone();
    let loaded_for_load = Arc::clone(&loaded);
    let count_for_load = Arc::clone(&injected);
    let expected_host = exam_url.host_str().unwrap_or_default().to_ascii_lowercase();
    let open_started_load = open_started;
    let open_started_nav = open_started;
    let recovering = Arc::new(AtomicBool::new(false));
    let recovery_rounds = Arc::new(AtomicUsize::new(0));
    let recovering_load = Arc::clone(&recovering);
    let rounds_load = Arc::clone(&recovery_rounds);
    let target_url_load = exam_url.clone();
    let using_shared_load = using_shared;
    let initial_script = format!("{DIAGNOSTIC_SCRIPT}\n{script}");
    exam_log(
        app,
        format!(
            "initialization scripts prepared: diagnostic + {} automation bytes",
            script.len()
        ),
    );

    let builder = WebviewWindowBuilder::new(app, EXAM_WINDOW_LABEL, WebviewUrl::External(blank))
        .title(title)
        .inner_size(1180.0, 900.0)
        .min_inner_size(900.0, 640.0)
        .data_directory(data_dir.clone())
        .initialization_script(initial_script)
        .on_navigation(move |url| {
            exam_log(&app_nav, format!("navigation: {url}"));
            true
        })
        .on_page_load(move |window, payload| {
            let url = payload.url().clone();
            let event = payload.event();
            exam_log(
                &app_load,
                format!(
                    "page-load {event:?} (+{}ms): {url}",
                    open_started_load.elapsed().as_millis()
                ),
            );
            if event != PageLoadEvent::Finished || url.scheme() == "about" {
                return;
            }
            // The page did load, so the timeout watcher must stand down.
            loaded_for_load.store(true, Ordering::SeqCst);

            let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
            let path = url.path().to_ascii_lowercase();
            let login_page = host.contains("login")
                || host.starts_with("passport.")
                || host.starts_with("pass.")
                || path.contains("login")
                || path.contains("passport");
            if login_page {
                exam_log(&app_load, format!("login redirect detected: {url}"));
                if recovering_load.load(Ordering::SeqCst) {
                    exam_log(&app_load, "still waiting for the one-time manual login");
                    return;
                }
                let rounds = rounds_load.fetch_add(1, Ordering::SeqCst) + 1;
                if rounds > 3 {
                    exam_log(
                        &app_load,
                        format!("login recovery exceeded 3 rounds (last {url})"),
                    );
                    show_exam_error(
                        &window,
                        "需要重新登录知到",
                        &format!(
                            "自动恢复登录已尝试 {rounds} 次仍未获得考试引擎会话。\n最后地址：{url}\n\n请关闭本窗口，回主界面重新登录知到后再试；日志：%APPDATA%\\hust-course-hack\\logs\\zhs-exam.log"
                        ),
                    );
                    return;
                }
                recovering_load.store(true, Ordering::SeqCst);
                exam_log(
                    &app_load,
                    format!("starting in-window login recovery (round {rounds})"),
                );
                let _ = window.eval(
                    "if (window.__ZHS_HIDE_LOADING__) window.__ZHS_HIDE_LOADING__();",
                );
                show_exam_login_prompt(
                    &window,
                    "需要在本窗口登录一次知到，登录后会自动继续（无需关闭窗口）",
                );
                let keep_login_page = host.starts_with("login.")
                    || host.starts_with("passport.")
                    || host.starts_with("pass.");
                if !keep_login_page
                    && let Ok(portal) =
                        Url::parse("https://onlineweb.zhihuishu.com/onlinestuh5")
                {
                    exam_log(&app_load, "login recovery: opening the normal portal");
                    let _ = window.navigate(portal);
                }
                return;
            }

            if recovering_load.load(Ordering::SeqCst) && host == expected_host {
                // The platform redirected straight back to the target after the
                // manual login: merge the new host cookies and continue.
                recovering_load.store(false, Ordering::SeqCst);
                let _ = window.eval(
                    "if (window.__ZHS_HIDE_LOGIN_PROMPT__) window.__ZHS_HIDE_LOGIN_PROMPT__();",
                );
                exam_log(
                    &app_load,
                    format!("login recovery finished on target host: {url}"),
                );
            } else if recovering_load.load(Ordering::SeqCst) {
                // Logged-in portal page: merge cookies, then resume the target.
                exam_log(
                    &app_load,
                    format!("login recovery page reached: {url}; resuming the intended target"),
                );
                let app_c = app_merge.clone();
                let target = target_url_load.clone();
                let recovering_c = Arc::clone(&recovering_load);
                tauri::async_runtime::spawn(async move {
                    let app_for_read = app_c.clone();
                    let records = tauri::async_runtime::spawn_blocking(move || {
                        app_for_read
                            .get_webview_window(EXAM_WINDOW_LABEL)
                            .and_then(|window| read_exam_window_cookies(&window).ok())
                    })
                    .await
                    .ok()
                    .flatten();
                    if let Some(records) = records
                        && !records.is_empty()
                    {
                        app_c.state::<AppState>().merge_zhs_cookies(records);
                    }
                    recovering_c.store(false, Ordering::SeqCst);
                    if let Some(window) = app_c.get_webview_window(EXAM_WINDOW_LABEL) {
                        let _ = window.eval(
                            "if (window.__ZHS_HIDE_LOGIN_PROMPT__) window.__ZHS_HIDE_LOGIN_PROMPT__();",
                        );
                        exam_log(
                            &app_c,
                            format!("login recovery: navigating back to {target}"),
                        );
                        let _ = window.navigate(target);
                    }
                });
                return;
            }

            if host != expected_host {
                exam_log(
                    &app_load,
                    format!("unexpected page host: {url} (expected {expected_host})"),
                );
                show_exam_error(
                    &window,
                    if host.ends_with("zhihuishu.com") {
                        "会话未注入/已过期，请重新登录知到"
                    } else {
                        "考试页加载失败"
                    },
                    &format!(
                        "页面跳转到了非预期地址：{url}\n期望主机：{expected_host}\n\n可关闭本窗口后重新登录知到，或点「重新加载」重试。"
                    ),
                );
                return;
            }

            // Expose the cookie/profile mode to the overlay scripts.
            let count = count_for_load.load(Ordering::SeqCst);
            let _ = window.eval(format!("window.__ZHS_INJECTED_COUNT__ = {count};"));
            if using_shared_load {
                let _ = window.eval("window.__ZHS_PROFILE_SHARED__ = true;");
            }

            // Merge cookies set by the exam host back into the main session, so a
            // manual login performed inside this window also fixes the API client.
            let app_for_cookies = app_merge.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    if let Some(window) = app_for_cookies.get_webview_window(EXAM_WINDOW_LABEL)
                        && let Ok(records) = read_exam_window_cookies(&window)
                        && !records.is_empty()
                    {
                        app_for_cookies
                            .state::<AppState>()
                            .merge_zhs_cookies(records);
                        log::info!("zhihuishu exam window: merged host cookies into the session");
                    }
                })
                .await;
            });
        });

    let window = builder.build().map_err(|error| {
        if !using_shared {
            cleanup_exam_dir(data_dir.clone());
        }
        exam_log(
            app,
            if using_shared {
                format!("window build failed with the shared profile: {error}")
            } else {
                format!("window build failed: {error}")
            },
        );
        format!("打开考试窗口失败：{error}")
    })?;

    let app_destroy = app.clone();
    let data_dir_for_destroy = data_dir.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if using_shared {
                exam_log(&app_destroy, "window destroyed (shared login profile kept)");
            } else {
                exam_log(&app_destroy, "window destroyed (temporary profile cleaned)");
                cleanup_exam_dir(data_dir_for_destroy.clone());
            }
        }
    });
    let _ = window.set_focus();

    // Inject the session cookies into the window's own profile BEFORE the first
    // navigation, then navigate, then enforce a page-load timeout.
    let app_inject = app.clone();
    let injected_count = Arc::clone(&injected);
    let loaded_for_watch = Arc::clone(&loaded);
    let nav_url = exam_url.clone();
    tauri::async_runtime::spawn(async move {
        exam_sleep(180).await;
        if using_shared {
            exam_log(
                &app_inject,
                "cookie injection skipped: shared login profile already carries the exam SSO",
            );
        } else {
            let cookies = app_inject.state::<AppState>().zhs_cookies();
            let cookie_names = cookies
                .iter()
                .map(|cookie| cookie.name.as_str())
                .collect::<Vec<_>>()
                .join(",");
            exam_log(
                &app_inject,
                format!(
                    "cookie injection start: {} records (names: {cookie_names})",
                    cookies.len()
                ),
            );
            let Some(window) = app_inject.get_webview_window(EXAM_WINDOW_LABEL) else {
                exam_log(&app_inject, "window disappeared before cookie injection");
                return;
            };
            // WebView2 may not expose its core immediately after window creation;
            // retry a few times before navigating anyway (the error panel shows if
            // the session really is missing).
            let mut injected_ok = false;
            for attempt in 0..4 {
                if attempt > 0 {
                    exam_sleep(250).await;
                }
                let app_for_closure = app_inject.clone();
                let holder = Arc::clone(&injected_count);
                let cookies_for_closure = cookies.clone();
                let result = window.with_webview(move |webview| {
                    match inject_webview2_cookies(&webview, &cookies_for_closure) {
                        Ok(count) => {
                            holder.store(count, Ordering::SeqCst);
                            exam_log(
                                &app_for_closure,
                                format!("cookie injection ok: {count} cookies"),
                            );
                        }
                        Err(error) => {
                            exam_log(
                                &app_for_closure,
                                format!("cookie injection attempt {attempt} failed: {error:#}"),
                            );
                        }
                    }
                });
                if let Err(error) = result {
                    exam_log(&app_inject, format!("with_webview failed: {error}"));
                }
                if injected_count.load(Ordering::SeqCst) > 0 {
                    injected_ok = true;
                    break;
                }
            }
            if !injected_ok {
                exam_log(
                    &app_inject,
                    "cookie injection did not succeed; navigating anyway (login redirect will show the error panel)",
                );
            }
        }
        match window.navigate(nav_url.clone()) {
            Ok(()) => exam_log(
                &app_inject,
                format!(
                    "navigation requested (+{}ms): {nav_url}",
                    open_started_nav.elapsed().as_millis()
                ),
            ),
            Err(error) => {
                exam_log(&app_inject, format!("navigate failed: {error}"));
                show_exam_error(
                    &window,
                    "考试页加载失败",
                    &format!("无法打开考试页：{nav_url}\n\n错误：{error}"),
                );
            }
        }

        exam_sleep(EXAM_PAGE_LOAD_TIMEOUT.as_millis() as u64).await;
        if loaded_for_watch.load(Ordering::SeqCst) {
            return;
        }
        exam_log(&app_inject, format!("page-load timeout for {nav_url}"));
        show_exam_error(
            &window,
            "考试页加载超时",
            &format!(
                "{:?} 内没有收到考试页加载完成事件。\n\n目标地址：{nav_url}\n\n可能原因：网络问题、登录会话未注入、或页面被重定向。\n可点「重新加载」，或关闭窗口后重新登录知到。",
                EXAM_PAGE_LOAD_TIMEOUT
            ),
        );
    });

    Ok(())
}
/// Build the check-page URL for one homework entry.
fn exam_check_url(recruit_id: u64, course_id: u64, homework: &ZhsHomework) -> Url {
    let url_str = format!(
        "{EXAM_CHECK_BASE}/{recruit_id}/{stu_exam_id}/{exam_id}/{course_id}/{school}",
        stu_exam_id = homework.stu_exam_id,
        exam_id = homework.exam_id,
        school = EXAM_SCHOOL_ID,
    );
    Url::parse(&url_str).expect("the exam check URL is built from safe components")
}

/// Build the attempt-page URL for one homework entry.
fn exam_attempt_url(recruit_id: u64, course_id: u64, homework: &ZhsHomework) -> Url {
    let url_str = format!(
        "{EXAM_ATTEMPT_BASE}/{recruit_id}/{stu_exam_id}/{exam_id}/{course_id}/{school}/0",
        stu_exam_id = homework.stu_exam_id,
        exam_id = homework.exam_id,
        school = EXAM_SCHOOL_ID,
    );
    Url::parse(&url_str).expect("the exam attempt URL is built from safe components")
}

fn exam_data_dir() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("{EXAM_DIR_PREFIX}{}-{stamp}", std::process::id()))
}

fn cleanup_exam_dir(path: PathBuf) {
    std::thread::spawn(move || {
        for _ in 0..20 {
            if std::fs::remove_dir_all(&path).is_ok() || !path.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    });
}

/// Cookie URLs read from an exam window after every page load.
fn exam_window_cookie_urls(window: &tauri::WebviewWindow) -> Vec<Url> {
    let mut urls = Vec::new();
    if let Ok(current) = window.url() {
        urls.push(current);
    }
    for raw in [
        "https://onlineexamh5new.zhihuishu.com/",
        "https://studentexam-api.zhihuishu.com/",
        "https://taurusexam-api.zhihuishu.com/",
    ] {
        if let Ok(url) = Url::parse(raw) {
            urls.push(url);
        }
    }
    urls
}

/// Read the exam window cookies (blocking worker; `cookies_for_url` deadlocks on
/// the main thread on Windows).
fn read_exam_window_cookies(window: &tauri::WebviewWindow) -> anyhow::Result<Vec<CookieRecord>> {
    let urls = exam_window_cookie_urls(window);
    let mut records = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for url in urls {
        for cookie in window
            .cookies_for_url(url)
            .map_err(|error| anyhow::anyhow!("{error}"))?
        {
            let name = cookie.name().to_string();
            let value = cookie.value().to_string();
            if !seen.insert((name.clone(), value.clone())) {
                continue;
            }
            records.push(CookieRecord {
                domain: cookie.domain().unwrap_or_default().to_string(),
                include_subdomains: cookie
                    .domain()
                    .is_some_and(|domain| domain.starts_with('.')),
                path: cookie.path().unwrap_or("/").to_string(),
                secure: cookie.secure().unwrap_or(false),
                expires: cookie
                    .expires_datetime()
                    .map(|time| time.unix_timestamp())
                    .unwrap_or(0),
                name,
                value,
            });
        }
    }
    Ok(records)
}

/// Inject the captured Zhihuishu cookies into the window's WebView2 profile.
#[cfg(windows)]
fn inject_webview2_cookies(
    webview: &tauri::webview::PlatformWebview,
    cookies: &[CookieRecord],
) -> Result<usize> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use windows::core::{HSTRING, Interface};

    let controller = webview.controller();
    let core = unsafe { controller.CoreWebView2() }.context("WebView2 core is not ready")?;
    // `ICoreWebView2CookieManager` hangs off `ICoreWebView2_2` (WebView2 1.0.864+).
    let core: ICoreWebView2_2 = core
        .cast()
        .context("WebView2 ICoreWebView2_2 unsupported")?;
    let manager = unsafe { core.CookieManager() }.context("WebView2 cookie manager unavailable")?;

    for cookie in cookies {
        let domain = cookie_domain(cookie);
        let name = HSTRING::from(cookie.name.as_str());
        let value = HSTRING::from(cookie.value.as_str());
        let domain = HSTRING::from(domain.as_str());
        let path = HSTRING::from(if cookie.path.is_empty() {
            "/"
        } else {
            cookie.path.as_str()
        });
        let item = unsafe { manager.CreateCookie(&name, &value, &domain, &path) }
            .context("CreateCookie failed")?;
        unsafe {
            let _ = item.SetIsHttpOnly(true);
            let _ = item.SetIsSecure(cookie.secure);
        }
        if cookie.expires > 0 {
            unsafe {
                let _ = item.SetExpires(cookie.expires as f64);
            }
        }
        unsafe { manager.AddOrUpdateCookie(&item) }.context("AddOrUpdateCookie failed")?;
    }
    Ok(cookies.len())
}

#[cfg(not(windows))]
fn inject_webview2_cookies(
    _webview: &tauri::webview::PlatformWebview,
    _cookies: &[CookieRecord],
) -> Result<usize> {
    Err(anyhow::anyhow!(
        "cookie injection is only implemented on Windows"
    ))
}

fn cookie_domain(cookie: &CookieRecord) -> String {
    let domain = cookie.domain.trim();
    if domain.is_empty() {
        ".zhihuishu.com".to_string()
    } else if cookie.include_subdomains && !domain.starts_with('.') {
        format!(".{domain}")
    } else {
        domain.to_string()
    }
}
