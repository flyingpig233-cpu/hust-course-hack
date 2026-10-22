import { api, onJobProgress } from "../api";
import type { ToastTone } from "../dom";
import { errorText, esc, openModal, qs } from "../dom";
import { icon } from "../icons";
import type { JobProgress, QuizSummary } from "../types";

export interface QuizModalOptions {
  courseId: string;
  courseName: string;
  /** Only process this work id or job id. */
  workId?: string | null;
  bankQuestions?: number | null;
  onToast(message: string, tone?: ToastTone): void;
  onSubmitted(workIds: string[]): void;
}

const STATUS_TEXT: Record<string, string> = {
  running: "提交中",
  submitted: "已提交",
  failed: "失败",
  skipped: "已跳过",
  dry_run: "计划",
};

const STATUS_TONE: Record<string, string> = {
  running: "is-running",
  submitted: "is-good",
  failed: "is-bad",
  skipped: "is-muted",
  dry_run: "is-muted",
};

function statusIcon(status: string): string {
  if (status === "submitted") return icon("check", 12);
  if (status === "failed") return icon("alert", 12);
  if (status === "skipped") return icon("stop", 12);
  return icon("clock", 12);
}

export function openQuizModal(options: QuizModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal quiz-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="eyebrow">章节测验</div>
        <h2>一键完成题目</h2>
        <p class="modal-sub">${esc(options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      <p class="modal-lead">
        使用内置题库匹配每道题，已批改的作业自动跳过；题目没抓全或题库缺少答案的作业
        不会提交，也不会只提交一部分。每次提交前都会重新打开作答页获取页面令牌。
      </p>
      ${
        options.workId
          ? `<div class="inline-notice">${icon("link", 14)} 仅处理作业 <code>${esc(
              options.workId,
            )}</code></div>`
          : ""
      }
      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 关闭“试运行”后，这会向平台提交真实答案；请先确认题库覆盖情况。
      </div>
      <div class="quiz-bank-line">
        内置题库 <strong>${options.bankQuestions ?? "…"}</strong> 题 · 未批改作业会先匹配再提交
      </div>
      <div class="settings-grid quiz-settings">
        ${
          options.workId
            ? ""
            : `<label class="field">
                <span>最多处理作业数</span>
                <input id="quiz-max" type="number" min="1" step="1" placeholder="不限" />
                <em>第一次建议先试运行，或只处理 1 个</em>
              </label>`
        }
        <label class="check switch-row">
          <input id="quiz-dry" type="checkbox" checked />
          <span>试运行，只生成计划</span>
        </label>
        <label class="check switch-row">
          <input id="quiz-confirm" type="checkbox" />
          <span>我确认提交未批改作业</span>
        </label>
      </div>

      <div class="watch-progress" id="quiz-progress">
        <div class="watch-status-row">
          <span id="quiz-status">准备就绪</span>
          <span id="quiz-count" class="watch-count"></span>
        </div>
        <div class="progress"><div class="progress-fill" id="quiz-fill" style="width:0%"></div></div>
        <div class="watch-log" id="quiz-log"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="quiz-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="quiz-start">${icon("work", 15)} 生成计划</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#quiz-status", content);
  const countText = qs<HTMLElement>("#quiz-count", content);
  const fill = qs<HTMLElement>("#quiz-fill", content);
  const log = qs<HTMLElement>("#quiz-log", content);
  const startButton = qs<HTMLButtonElement>("#quiz-start", content);
  const stopButton = qs<HTMLButtonElement>("#quiz-stop", content);
  const dryRun = qs<HTMLInputElement>("#quiz-dry", content);
  const confirm = qs<HTMLInputElement>("#quiz-confirm", content);
  const maxInput = content.querySelector<HTMLInputElement>("#quiz-max");

  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let totalWorks = 0;
  let submittedIds: string[] = [];
  const rows = new Map<number, HTMLElement>();

  const close = openModal(content, {
    wide: true,
    onClose: () => {
      closed = true;
      unlisten?.();
      unlisten = null;
      if (running) void api.cancelJob().catch(() => undefined);
    },
  });

  content.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-close]")) close();
  });

  const setStatus = (text: string) => {
    statusText.textContent = text;
  };

  const setProgress = (done: number, total: number) => {
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    fill.style.width = `${percent}%`;
    countText.textContent = total > 0 ? `${done} / ${total}` : "";
  };

  const setRunningUi = (busy: boolean) => {
    startButton.hidden = busy;
    startButton.disabled = busy || (!dryRun.checked && !confirm.checked);
    stopButton.hidden = !busy;
    stopButton.disabled = false;
    stopButton.innerHTML = `${icon("stop", 14)} 停止`;
    for (const input of [dryRun, confirm, ...(maxInput ? [maxInput] : [])]) {
      input.disabled = busy;
    }
  };

  const syncStart = () => {
    if (running) return;
    confirm.disabled = dryRun.checked;
    if (dryRun.checked) confirm.checked = false;
    startButton.disabled = !dryRun.checked && !confirm.checked;
    startButton.title = startButton.disabled
      ? "请先勾选确认提交，或改用试运行"
      : "";
    startButton.innerHTML = dryRun.checked
      ? `${icon("work", 15)} 生成计划`
      : `${icon("work", 15)} 开始提交`;
  };

  dryRun.addEventListener("change", syncStart);
  confirm.addEventListener("change", syncStart);
  syncStart();

  const rowTemplate = (progress: Extract<JobProgress, { kind: "quiz" }>) => {
    const wrapper = document.createElement("div");
    wrapper.className = "watch-row";
    wrapper.dataset.index = String(progress.index);
    wrapper.innerHTML = `
      <span class="watch-index">${progress.index}</span>
      <div class="watch-row-main">
        <div class="watch-row-label" title="${esc(
          `${progress.chapter} / ${progress.workName}`,
        )}">${esc(progress.chapter)} / ${esc(progress.workName)}</div>
        <div class="watch-row-detail">${progress.questionCount} 道题</div>
      </div>
      <span class="status-chip">${icon("clock", 12)} 等待</span>
    `;
    return wrapper;
  };

  const applyQuiz = (progress: Extract<JobProgress, { kind: "quiz" }>) => {
    let row = rows.get(progress.index);
    if (!row) {
      row = rowTemplate(progress);
      rows.set(progress.index, row);
      log.appendChild(row);
    }
    const chip = row.querySelector<HTMLElement>(".status-chip");
    if (chip) {
      chip.className = `status-chip ${STATUS_TONE[progress.status] ?? ""}`;
      chip.innerHTML = `${statusIcon(progress.status)} ${
        STATUS_TEXT[progress.status] ?? progress.status
      }`;
    }
    const detail = row.querySelector<HTMLElement>(".watch-row-detail");
    if (detail) {
      detail.textContent = progress.message
        ? progress.message
        : progress.status === "running"
          ? "正在打开作答页并提交…"
          : `${progress.questionCount} 道题`;
    }
    row.classList.toggle("is-passed", progress.status === "submitted");
    if (progress.status === "submitted") submittedIds.push(progress.workId);
    setProgress(
      progress.status === "running" ? progress.index - 1 : progress.index,
      totalWorks,
    );
    if (progress.status === "running") {
      setStatus(`正在提交：${progress.workName}`);
    }
  };

  const handleProgress = (progress: JobProgress) => {
    if (closed) return;
    if (progress.kind === "crawl") {
      setStatus("正在刷新课程与测验题目…");
      setProgress(progress.done, progress.total);
      return;
    }
    if (progress.kind === "quizPlan") {
      totalWorks = progress.total;
      rows.clear();
      submittedIds = [];
      log.innerHTML = "";
      setProgress(0, progress.total);
      if (progress.total === 0) {
        setStatus(
          progress.skippedGraded > 0
            ? `没有需要提交的作业（已跳过 ${progress.skippedGraded} 个已批改作业）`
            : "这门课程没有可提交的测验作业",
        );
      } else if (progress.dryRun) {
        setStatus(
          `试运行：${progress.total} 个作业，其中 ${progress.incomplete} 个题库不完整`,
        );
      } else {
        setStatus(
          `准备提交 ${progress.total} 个作业${
            progress.incomplete > 0
              ? `，将跳过 ${progress.incomplete} 个不完整作业`
              : ""
          }`,
        );
      }
      return;
    }
    if (progress.kind === "quiz") {
      applyQuiz(progress);
    }
  };

  const finish = (summary: QuizSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    stopButton.hidden = true;

    if (summary.cancelled) {
      setStatus("已取消");
      options.onToast("已取消题目提交", "info");
    } else if (summary.dryRun) {
      setStatus(
        `试运行完成：${summary.total - summary.skipped} 个作业可提交，${summary.skipped} 个跳过`,
      );
      options.onToast("试运行完成，没有发送任何提交请求", "success");
    } else if (summary.failed > 0) {
      setStatus(
        `完成：${summary.submitted} 个已提交 · ${summary.failed} 个失败 · ${summary.skipped} 个跳过`,
      );
      options.onToast(
        `${summary.submitted} 个提交成功，${summary.failed} 个失败，详见日志`,
        "error",
      );
    } else if (summary.submitted > 0) {
      setStatus(
        `完成：${summary.submitted} 个已提交${
          summary.skipped > 0 ? ` · ${summary.skipped} 个跳过` : ""
        }`,
      );
      options.onToast(`已提交 ${summary.submitted} 个作业`, "success");
    } else if (summary.total === 0) {
      setStatus(
        summary.skippedGraded > 0
          ? `没有需要提交的作业（已跳过 ${summary.skippedGraded} 个已批改作业）`
          : "这门课程没有可提交的测验作业",
      );
      options.onToast("没有需要提交的作业", "info");
    } else {
      setStatus(`没有提交任何作业，${summary.skipped} 个作业被跳过`);
      options.onToast("所有作业都不完整，详见日志", "info");
    }

    const problems = [...summary.planErrors, ...summary.errors];
    if (problems.length > 0) {
      const block = document.createElement("div");
      block.className = "watch-error";
      block.textContent = problems.join("\n");
      log.appendChild(block);
    }
    options.onSubmitted([...new Set(submittedIds)]);
    submittedIds = [];
    if (!summary.cancelled) setProgress(totalWorks, totalWorks);
  };

  startButton.addEventListener("click", async () => {
    if (running) return;
    running = true;
    submittedIds = [];
    rows.clear();
    log.innerHTML = "";
    setRunningUi(true);
    setStatus("正在刷新课程与测验题目…");
    setProgress(0, 0);

    unlisten = await onJobProgress(handleProgress);
    if (closed) {
      unlisten?.();
      unlisten = null;
      return;
    }
    try {
      const summary = await api.completeQuizzes({
        course: options.courseId,
        work: options.workId ?? null,
        dryRun: dryRun.checked,
        maxWorks: maxInput?.value
          ? Math.max(1, Number(maxInput.value) || 1)
          : null,
      });
      if (!closed) finish(summary);
    } catch (error) {
      if (closed) return;
      running = false;
      setRunningUi(false);
      const message = errorText(error);
      if (message.includes("已取消")) {
        setStatus("已取消");
        options.onToast("已取消题目提交", "info");
      } else {
        setStatus("提交失败");
        log.innerHTML = `<div class="watch-error">${esc(message)}</div>`;
        options.onToast(message, "error");
      }
    } finally {
      unlisten?.();
      unlisten = null;
      running = false;
    }
  });

  stopButton.addEventListener("click", () => {
    if (!running) return;
    stopButton.disabled = true;
    stopButton.textContent = "正在停止…";
    void api.cancelJob();
  });
}
