import { api, onJobProgress } from "../api";
import type { ToastTone } from "../dom";
import { errorText, esc, openModal, qs } from "../dom";
import { icon } from "../icons";
import type { DocumentSummary, JobProgress } from "../types";

export interface DocumentModalOptions {
  courseId: string;
  courseName: string;
  /** Only complete this document task point. */
  jobId?: string | null;
  onToast(message: string, tone?: ToastTone): void;
  onCompleted(jobIds: string[]): void;
}

const STATUS_TEXT: Record<string, string> = {
  running: "上报中",
  completed: "已完成",
  failed: "失败",
  dry_run: "试运行",
};

const STATUS_TONE: Record<string, string> = {
  running: "is-running",
  completed: "is-good",
  failed: "is-bad",
  dry_run: "is-muted",
};

function statusIcon(status: string): string {
  if (status === "completed") return icon("check", 12);
  if (status === "failed") return icon("alert", 12);
  return icon("clock", 12);
}

export function openDocumentModal(options: DocumentModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal document-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <h2>完成文档</h2>
        <p class="modal-sub">${esc(options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      ${options.jobId ? `<div class="inline-notice">当前文档</div>` : ""}
      <p>确认完成文档？此操作将向平台提交记录。</p>

      <div class="watch-progress" id="document-progress" hidden>
        <div class="watch-status-row">
          <span id="document-status">就绪</span>
          <span id="document-count" class="watch-count"></span>
        </div>
        <div class="progress"><div class="progress-fill" id="document-fill" style="width:0%"></div></div>
        <div class="watch-log" id="document-log"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="document-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="document-start">${icon("document", 15)} 确认执行</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#document-status", content);
  const countText = qs<HTMLElement>("#document-count", content);
  const fill = qs<HTMLElement>("#document-fill", content);
  const log = qs<HTMLElement>("#document-log", content);
  const startButton = qs<HTMLButtonElement>("#document-start", content);
  const stopButton = qs<HTMLButtonElement>("#document-stop", content);


  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let totalDocuments = 0;
  let completedJobs: string[] = [];
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
    const percent =
      total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
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


  const rowTemplate = (progress: Extract<JobProgress, { kind: "document" }>) => {
    const wrapper = document.createElement("div");
    wrapper.className = "watch-row";
    wrapper.dataset.index = String(progress.index);
    wrapper.innerHTML = `
      <span class="watch-index">${progress.index}</span>
      <div class="watch-row-main">
        <div class="watch-row-label" title="${esc(
          `${progress.chapter} / ${progress.name}`,
        )}">${esc(progress.chapter)} / ${esc(progress.name)}</div>
        <div class="watch-row-detail"></div>
      </div>
      <span class="status-chip">${icon("clock", 12)} 等待</span>
    `;
    return wrapper;
  };

  const applyDocument = (
    progress: Extract<JobProgress, { kind: "document" }>,
  ) => {
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
          ? "处理中…"
          : progress.status === "completed"
            ? "已完成"
            : "";
    }
    row.classList.toggle("is-passed", progress.status === "completed");
    if (progress.status === "completed") completedJobs.push(progress.jobId);
    setProgress(
      progress.status === "running" ? progress.index - 1 : progress.index,
      totalDocuments,
    );
    if (progress.status === "running") {
      setStatus(`正在处理：${progress.name}`);
    }
  };

  const handleProgress = (progress: JobProgress) => {
    if (closed) return;
    if (progress.kind === "crawl") {
      setStatus("加载中…");
      setProgress(progress.done, progress.total);
      return;
    }
    if (progress.kind === "documentPlan") {
      totalDocuments = progress.total;
      rows.clear();
      completedJobs = [];
      log.innerHTML = "";
      setProgress(0, progress.total);
      setStatus(
        progress.total === 0
          ? "没有需要处理的文档"
          : progress.dryRun
            ? `试运行 · ${progress.total} 个文档`
            : `准备完成 ${progress.total} 个文档`,
      );
      return;
    }
    if (progress.kind === "document") applyDocument(progress);
  };

  const finish = (summary: DocumentSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    startButton.disabled = true;
    stopButton.hidden = true;

    if (summary.cancelled) {
      setStatus("已取消");
      options.onToast("已取消文档任务", "info");
    } else if (summary.dryRun) {
      setStatus(
        `试运行完成 · ${summary.total} 个文档`,
      );
      options.onToast("试运行完成", "success");
    } else if (summary.failed > 0) {
      setStatus(
        `完成：${summary.completed} 个已完成 · ${summary.failed} 个失败`,
      );
      options.onToast(
        `${summary.completed} 个文档完成，${summary.failed} 个失败`,
        "error",
      );
    } else if (summary.completed > 0) {
      setStatus(`已完成 ${summary.completed} 个文档`);
      options.onToast(`已完成 ${summary.completed} 个文档`, "success");
    } else if (summary.total === 0) {
      setStatus("没有需要处理的文档");
      options.onToast("没有需要处理的文档", "info");
    } else {
      setStatus("没有完成任何文档");
      options.onToast("没有完成任何文档", "info");
    }

    if (summary.errors.length > 0) {
      const block = document.createElement("div");
      block.className = "watch-error";
      block.textContent = summary.errors.join("\n");
      log.appendChild(block);
    }
    options.onCompleted([...new Set(completedJobs)]);
    completedJobs = [];
    if (!summary.cancelled) setProgress(totalDocuments, totalDocuments);
  };

  startButton.addEventListener("click", async () => {
    if (running) return;
    running = true;
    completedJobs = [];
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
      const summary = await api.completeDocuments({
        course: options.courseId,
        job: options.jobId ?? null,
        includeCompleted: Boolean(options.jobId),
        dryRun: false,
        maxDocuments: null,
      });
      if (!closed) finish(summary);
    } catch (error) {
      if (closed) return;
      running = false;
      setRunningUi(false);
      const message = errorText(error);
      if (message.includes("已取消")) {
        setStatus("已取消");
        options.onToast("已取消文档任务", "info");
      } else {
        setStatus("处理失败");
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
