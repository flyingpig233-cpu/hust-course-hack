import { api, onJobProgress } from "../api";
import { errorText, esc, openModal, qs } from "../dom";
import { icon } from "../icons";
import type { JobProgress, WatchSummary } from "../types";
import type { ToastTone } from "../dom";

export interface WatchModalOptions {
  courseId: string;
  courseName: string;
  jobId?: string | null;
  onToast(message: string, tone?: ToastTone): void;
  onPassed(jobIds: string[]): void;
}

const STATUS_TEXT: Record<string, string> = {
  running: "上报中",
  passed: "已通过",
  failed: "未通过",
  error: "出错",
  dry_run: "已生成",
};

const STATUS_TONE: Record<string, string> = {
  running: "is-running",
  passed: "is-good",
  failed: "is-bad",
  error: "is-bad",
  dry_run: "is-muted",
};

export function openWatchModal(options: WatchModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <h2>完成视频</h2>
        <p class="modal-sub">${esc(options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      ${options.jobId ? `<div class="inline-notice">当前视频</div>` : ""}
      <p>确认上报视频？此操作将向平台提交记录。</p>

      <div class="watch-progress" id="watch-progress" hidden>
        <div class="watch-status-row">
          <span id="watch-status">就绪</span>
          <span id="watch-count" class="watch-count"></span>
        </div>
        <div class="progress"><div class="progress-fill" id="watch-fill" style="width:0%"></div></div>
        <div class="watch-log" id="watch-log"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="watch-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="watch-start">${icon("play", 15)} 确认执行</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#watch-status", content);
  const countText = qs<HTMLElement>("#watch-count", content);
  const fill = qs<HTMLElement>("#watch-fill", content);
  const log = qs<HTMLElement>("#watch-log", content);
  const startButton = qs<HTMLButtonElement>("#watch-start", content);
  const stopButton = qs<HTMLButtonElement>("#watch-stop", content);


  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let passedJobs: string[] = [];
  let totalVideos = 0;
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

  const rowTemplate = (progress: Extract<JobProgress, { kind: "watch" }>) => {
    const wrapper = document.createElement("div");
    wrapper.className = "watch-row";
    wrapper.dataset.index = String(progress.index);
    wrapper.innerHTML = `
      <span class="watch-index">${progress.index}</span>
      <div class="watch-row-main">
        <div class="watch-row-label" title="${esc(progress.label)}">${esc(progress.label)}</div>
        <div class="watch-row-detail"></div>
      </div>
      <span class="status-chip">${icon("clock", 12)} 等待</span>
    `;
    return wrapper;
  };

  const applyWatch = (progress: Extract<JobProgress, { kind: "watch" }>) => {
    let row = rows.get(progress.index);
    if (!row) {
      row = rowTemplate(progress);
      rows.set(progress.index, row);
      log.appendChild(row);
    }
    const chip = row.querySelector<HTMLElement>(".status-chip");
    if (chip) {
      chip.className = `status-chip ${STATUS_TONE[progress.status] ?? ""}`;
      chip.innerHTML = `${progress.status === "running" ? icon("clock", 12) : icon("check", 12)} ${
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
          summary.textContent = "查看详情";
          const pre = document.createElement("pre");
          pre.textContent = progress.message;
          toggler.append(summary, pre);
          detail.appendChild(toggler);
        } else {
          const pre = document.createElement("pre");
          pre.textContent = progress.message;
          detail.appendChild(pre);
        }
      } else if (progress.status === "passed") {
        detail.textContent = "已完成";
      } else if (progress.status === "running") {
        detail.textContent = "处理中…";
      }
    }
    row.classList.toggle("is-passed", progress.status === "passed");
    if (progress.status === "passed") passedJobs.push(progress.jobId);
    setProgress(progress.status === "running" ? progress.index - 1 : progress.index, totalVideos);
    if (progress.status === "running") {
      setStatus(`正在处理：${progress.label}`);
    }
  };

  const handleProgress = (progress: JobProgress) => {
    if (closed) return;
    if (progress.kind === "crawl") {
      setStatus("加载中…");
      setProgress(progress.done, progress.total);
      return;
    }
    if (progress.kind === "watchPlan") {
      totalVideos = progress.total;
      rows.clear();
      log.innerHTML = "";
      setProgress(0, progress.total);
      setStatus(
        progress.total === 0
          ? "没有需要处理的视频"
          : progress.dryRun
            ? `试运行 · ${progress.total} 个视频`
            : `准备上报 ${progress.total} 个视频`,
      );
      return;
    }
    if (progress.kind === "watch") applyWatch(progress);
  };

  const finish = (summary: WatchSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    startButton.disabled = true;
    stopButton.hidden = true;

    if (summary.cancelled) {
      setStatus("已取消");
      options.onToast("已取消视频上报", "info");
    } else {
      setStatus(
        `完成：${summary.passed} 个通过 · ${summary.failed} 个未通过`,
      );
      if (summary.failed === 0 && summary.passed > 0) {
        options.onToast(`已完成 ${summary.passed} 个视频`, "success");
      } else if (summary.failed > 0) {
        options.onToast(
          `${summary.passed} 个通过，${summary.failed} 个失败`,
          "error",
        );
      } else {
        options.onToast("没有可上报的视频", "info");
      }
    }
    options.onPassed([...new Set(passedJobs)]);
    passedJobs = [];
    if (!summary.cancelled) setProgress(totalVideos, totalVideos);
  };

  startButton.addEventListener("click", async () => {
    if (running) return;
    running = true;
    passedJobs = [];
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
      const summary = await api.watchCourse({
        course: options.courseId,
        job: options.jobId ?? null,
        includeCompleted: Boolean(options.jobId),
        stepSecs: 0,
        delayMs: 0,
        maxVideos: null,
        dryRun: false,
      });
      if (!closed) finish(summary);
    } catch (error) {
      if (closed) return;
      running = false;
      setRunningUi(false);
      const message = errorText(error);
      if (message.includes("已取消")) {
        setStatus("已取消");
        options.onToast("已取消视频上报", "info");
      } else {
        setStatus("上报失败");
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
