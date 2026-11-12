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
        <h2>完成题目</h2>
        <p class="modal-sub">${esc(options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      ${options.workId ? `<div class="inline-notice">当前作业</div>` : ""}
      <p>确认提交题目？此操作将向平台提交记录。</p>

      <div class="watch-progress" id="quiz-progress" hidden>
        <div class="watch-status-row">
          <span id="quiz-status">就绪</span>
          <span id="quiz-count" class="watch-count"></span>
        </div>
        <div class="progress"><div class="progress-fill" id="quiz-fill" style="width:0%"></div></div>
        <div class="watch-log" id="quiz-log"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="quiz-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="quiz-start">${icon("work", 15)} 确认执行</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#quiz-status", content);
  const countText = qs<HTMLElement>("#quiz-count", content);
  const fill = qs<HTMLElement>("#quiz-fill", content);
  const log = qs<HTMLElement>("#quiz-log", content);
  const startButton = qs<HTMLButtonElement>("#quiz-start", content);
  const stopButton = qs<HTMLButtonElement>("#quiz-stop", content);

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
    if (busy) qs<HTMLElement>(".watch-progress", content).hidden = false;
    startButton.hidden = busy;
    startButton.disabled = busy;
    stopButton.hidden = !busy;
    stopButton.disabled = false;
    stopButton.innerHTML = `${icon("stop", 14)} 停止`;
  };


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
          ? "提交中…"
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
      setStatus("加载中…");
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
            ? `无需提交 · 跳过 ${progress.skippedGraded} 个已批改作业`
            : "暂无待提交作业",
        );
      } else if (progress.dryRun) {
        setStatus(
          `试运行 · ${progress.total} 个作业 · ${progress.incomplete} 个答案不全`,
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
      options.onToast("试运行完成", "success");
    } else if (summary.failed > 0) {
      setStatus(
        `完成：${summary.submitted} 个已提交 · ${summary.failed} 个失败 · ${summary.skipped} 个跳过`,
      );
      options.onToast(
        `${summary.submitted} 个提交成功，${summary.failed} 个失败`,
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
          ? `无需提交 · 跳过 ${summary.skippedGraded} 个已批改作业`
          : "暂无待提交作业",
      );
      options.onToast("没有需要提交的作业", "info");
    } else {
      setStatus(`未提交 · 跳过 ${summary.skipped} 个作业`);
      options.onToast("所有作业都不完整", "info");
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
    setStatus("加载中…");
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
        dryRun: false,
        maxWorks: null,
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
    stopButton.textContent = "停止中…";
    void api.cancelJob();
  });
}
