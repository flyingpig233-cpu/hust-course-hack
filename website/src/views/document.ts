import { api, onJobProgress } from "../api";
import type { ToastTone } from "../dom";
import { errorText, esc, openModal, qs } from "../dom";
import { icon } from "../icons";
import type { DocumentSummary, JobProgress } from "../types";

export interface DocumentModalOptions {
  courseId: string;
  courseName: string;
  /** Only process this document job id (used by a single task-row button). */
  jobId?: string | null;
  onToast(message: string, tone?: ToastTone): void;
  onCompleted(jobIds: string[]): void;
}

const STATUS_TEXT: Record<string, string> = {
  running: "读取中",
  passed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  error: "出错",
  dry_run: "已计划",
};

const STATUS_TONE: Record<string, string> = {
  running: "is-running",
  passed: "is-good",
  failed: "is-bad",
  skipped: "is-muted",
  error: "is-bad",
  dry_run: "is-muted",
};

function statusIcon(status: string): string {
  if (status === "passed") return icon("check", 12);
  if (status === "failed" || status === "error") return icon("alert", 12);
  if (status === "skipped") return icon("stop", 12);
  return icon("clock", 12);
}

export function openDocumentModal(options: DocumentModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal document-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="eyebrow">文档任务</div>
        <h2>完成文档任务点</h2>
        <p class="modal-sub">${esc(options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      <p class="modal-lead">
        按 Chaoxing 官方客户端协议，先读取卡片的
        <code>window.AttachmentSetting</code> 取得每个附件的
        <code>jtoken</code>，再调用 <code>/mooc-ans/job/document</code> 标记文档已读。
        只有服务端返回 <code>status: true</code> 才算完成。
      </p>
      ${
        options.jobId
          ? `<div class="inline-notice">${icon("link", 14)} 仅处理任务点 <code>${esc(
              options.jobId,
            )}</code></div>`
          : ""
      }
      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 取消“试运行”后，这会向平台发送真实的
        <code>wxcard</code> 与 <code>job/document</code> 请求。
      </div>
      <div class="settings-grid">
        ${
          options.jobId
            ? ""
            : `<label class="field">
                <span>最多处理文档数</span>
                <input id="document-max" type="number" min="1" step="1" placeholder="不限" />
                <em>用于先跑一个小批量</em>
              </label>`
        }
        <label class="check switch-row">
          <input id="document-include-completed" type="checkbox" />
          <span>包含已完成的文档</span>
        </label>
        <label class="check switch-row">
          <input id="document-dry" type="checkbox" checked />
          <span>试运行，只列出目标</span>
        </label>
      </div>

      <div class="watch-progress" id="document-progress">
        <div class="watch-status-row">
          <span id="document-status">准备就绪</span>
          <span id="document-count" class="watch-count"></span>
        </div>
        <div class="progress"><div class="progress-fill" id="document-fill" style="width:0%"></div></div>
        <div class="watch-log" id="document-log"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="document-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="document-start">${icon("document", 15)} 生成计划</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#document-status", content);
  const countText = qs<HTMLElement>("#document-count", content);
  const fill = qs<HTMLElement>("#document-fill", content);
  const log = qs<HTMLElement>("#document-log", content);
  const startButton = qs<HTMLButtonElement>("#document-start", content);
  const stopButton = qs<HTMLButtonElement>("#document-stop", content);
  const maxInput = content.querySelector<HTMLInputElement>("#document-max");
  const includeCompleted = qs<HTMLInputElement>(
    "#document-include-completed",
    content,
  );
  const dryRun = qs<HTMLInputElement>("#document-dry", content);

  // Re-completing a specific document must not be filtered out by the
  // backend's "skip completed" rule.
  if (options.jobId) includeCompleted.checked = true;

  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let passedIds: string[] = [];
  let totalDocuments = 0;
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
    startButton.disabled = busy;
    stopButton.hidden = !busy;
    stopButton.disabled = false;
    stopButton.innerHTML = `${icon("stop", 14)} 停止`;
    for (const input of [dryRun, includeCompleted, ...(maxInput ? [maxInput] : [])]) {
      input.disabled = busy;
    }
  };

  const syncStart = () => {
    if (running) return;
    startButton.innerHTML = dryRun.checked
      ? `${icon("document", 15)} 生成计划`
      : `${icon("document", 15)} 开始完成`;
  };
  dryRun.addEventListener("change", syncStart);
  syncStart();

  const rowTemplate = (progress: Extract<JobProgress, { kind: "document" }>) => {
    const wrapper = document.createElement("div");
    wrapper.className = "watch-row";
    wrapper.dataset.index = String(progress.index);
    wrapper.innerHTML = `
      <span class="watch-index">${progress.index}</span>
      <div class="watch-row-main">
        <div class="watch-row-label" title="${esc(progress.label)}">${esc(
          progress.label,
        )}</div>
        <div class="watch-row-detail">任务点 ${esc(progress.jobId)}</div>
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
      detail.innerHTML = "";
      if (progress.message) {
        if (progress.status === "dry_run") {
          const toggler = document.createElement("details");
          toggler.className = "watch-urls";
          const summary = document.createElement("summary");
          summary.textContent = "查看计划请求";
          const pre = document.createElement("pre");
          pre.textContent = progress.message;
          toggler.append(summary, pre);
          detail.appendChild(toggler);
        } else {
          const pre = document.createElement("pre");
          pre.textContent = progress.message;
          detail.appendChild(pre);
        }
      } else if (progress.status === "running") {
        detail.textContent = "正在读取卡片附件并上报…";
      } else if (progress.status === "passed") {
        detail.textContent = "服务端返回 status=true";
      }
    }
    row.classList.toggle("is-passed", progress.status === "passed");
    if (progress.status === "passed") passedIds.push(progress.jobId);
    setProgress(
      progress.status === "running" ? progress.index - 1 : progress.index,
      totalDocuments,
    );
    if (progress.status === "running") {
      setStatus(`正在完成：${progress.label}`);
    }
  };

  const handleProgress = (progress: JobProgress) => {
    if (closed) return;
    if (progress.kind === "crawl") {
      setStatus("正在刷新课程与文档任务点…");
      setProgress(progress.done, progress.total);
      return;
    }
    if (progress.kind === "documentPlan") {
      totalDocuments = progress.total;
      rows.clear();
      passedIds = [];
      log.innerHTML = "";
      setProgress(0, progress.total);
      if (progress.total === 0) {
        setStatus(
          progress.skipped > 0
            ? `没有可处理的文档（${progress.skipped} 个目标缺少 card id 或 job id，详见日志）`
            : "这门课程没有需要完成的文档任务点",
        );
      } else if (progress.dryRun) {
        setStatus(
          `试运行：${progress.total} 个文档目标${
            progress.skipped > 0 ? `，${progress.skipped} 个目标缺少 card id 或 job id` : ""
          }`,
        );
      } else {
        setStatus(
          `准备完成 ${progress.total} 个文档${
            progress.skipped > 0 ? `，跳过 ${progress.skipped} 个无法定位附件的目标` : ""
          }`,
        );
      }
      return;
    }
    if (progress.kind === "document") applyDocument(progress);
  };

  const finish = (summary: DocumentSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    stopButton.hidden = true;

    if (summary.cancelled) {
      setStatus("已取消");
      options.onToast("已取消文档任务", "info");
    } else if (summary.dryRun) {
      setStatus(
        `试运行完成：${summary.total} 个文档目标已列出，未发送 wxcard / job/document 请求`,
      );
      options.onToast("试运行完成，没有发送文档完成请求", "success");
    } else if (summary.failed > 0) {
      setStatus(
        `完成：${summary.passed} 个已标记完成 · ${summary.failed} 个失败 · ${summary.skipped} 个跳过`,
      );
      options.onToast(
        `${summary.passed} 个文档完成，${summary.failed} 个失败，详见日志`,
        "error",
      );
    } else if (summary.passed > 0) {
      setStatus(
        `完成：${summary.passed} 个文档已标记完成${
          summary.skipped > 0 ? ` · ${summary.skipped} 个跳过` : ""
        }`,
      );
      options.onToast(`已完成 ${summary.passed} 个文档`, "success");
    } else if (summary.total === 0) {
      setStatus("没有需要完成的文档任务点");
      options.onToast("没有需要完成的文档", "info");
    } else {
      setStatus(`没有文档完成，${summary.skipped} 个目标被跳过`);
      options.onToast("所有目标都缺少 jtoken，详见日志", "info");
    }

    if (summary.errors.length > 0) {
      const block = document.createElement("div");
      block.className = "watch-error";
      block.textContent = summary.errors.join("\n");
      log.appendChild(block);
    }
    options.onCompleted([...new Set(passedIds)]);
    passedIds = [];
    if (!summary.cancelled) setProgress(totalDocuments, totalDocuments);
  };

  startButton.addEventListener("click", async () => {
    if (running) return;
    running = true;
    passedIds = [];
    rows.clear();
    log.innerHTML = "";
    setRunningUi(true);
    setStatus("正在刷新课程与文档任务点…");
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
        includeCompleted: includeCompleted.checked,
        dryRun: dryRun.checked,
        maxDocuments: maxInput?.value
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
        options.onToast("已取消文档任务", "info");
      } else {
        setStatus("文档任务失败");
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
