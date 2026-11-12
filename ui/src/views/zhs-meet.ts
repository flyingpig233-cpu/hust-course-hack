import { api, onJobProgress } from "../api";
import type { ToastTone } from "../dom";
import { copyText, errorText, esc, openModal, qs } from "../dom";
import { formatPercent } from "../format";
import { icon } from "../icons";
import type {
  JobProgress,
  ZhsCourse,
  ZhsMeet,
  ZhsMeetProgress,
  ZhsMeetWatchSummary,
} from "../types";
import { zhsCourseLabel } from "../zhs";

const STATUS_TEXT: Record<string, string> = {
  running: "处理中",
  ok: "已完成",
  skip: "已跳过",
  dry_run: "预演",
  failed: "失败",
  cancelled: "已取消",
  circuit_broken: "已熔断",
};

const STATUS_TONE: Record<string, string> = {
  running: "is-running",
  ok: "is-good",
  skip: "is-muted",
  dry_run: "is-muted",
  failed: "is-bad",
  cancelled: "is-muted",
  circuit_broken: "is-bad",
};

function replayable(meet: ZhsMeet): boolean {
  // Mirrors `ZhsMeet::has_replay`: a live id alone is not enough, the replay
  // page URL must also be present.
  return meet.liveId !== 0 && (meet.replayUrl ?? "").trim() !== "";
}

function meetStatus(meet: ZhsMeet): string {
  if (!replayable(meet)) return "无回放";
  if (meet.status === 0) return "未开始";
  return "可回放";
}

export interface ZhsMeetHandlers {
  busy: boolean;
  onBack(): void;
  onRefresh(): void;
  onLoadProgress(meet: ZhsMeet): void;
  onWatch(meet: ZhsMeet | null): void;
  onCheck(): void;
}

/** Meet-course list with per-entry replay progress and completion entry points. */
export function renderZhsMeet(
  main: HTMLElement,
  course: ZhsCourse,
  meets: ZhsMeet[],
  progress: Map<number, ZhsMeetProgress>,
  handlers: ZhsMeetHandlers,
): void {
  main.onchange = null;
  main.onclick = null;
  const withReplay = meets.filter(replayable).length;

  main.innerHTML = `
    <div class="course-view">
      <header class="course-head">
        <div class="course-head-copy">
          <h1>${esc(zhsCourseLabel(course))}</h1>
          <p class="course-sub">共 ${meets.length} 场 · ${withReplay} 场有回放</p>
        </div>
        <div class="head-actions">
          <button class="icon-button" data-action="back" title="返回视频" aria-label="返回视频">${icon("folder", 16)}</button>
          <button class="icon-button" data-action="refresh" title="刷新见面课列表" aria-label="刷新见面课列表">${icon("refresh", 16)}</button>
          <button class="icon-button" data-action="check" title="检查见面课风控状态" aria-label="检查见面课风控状态">${icon("shield", 16)}</button>
          <button class="btn btn-primary" data-action="watch-all" ${
            withReplay === 0 ? "disabled" : ""
          }>${icon("play", 15)} 完成回放</button>
        </div>
      </header>
      ${
        handlers.busy
          ? `<div class="crawl-banner"><div class="crawl-banner-row"><span class="spinner spinner-sm"></span><span class="crawl-progress-label">正在刷新见面课…</span></div></div>`
          : ""
      }

      ${
        meets.length === 0
          ? `<div class="empty-panel compact"><div class="empty-icon">${icon("live", 24)}</div><h2>没有见面课</h2></div>`
          : `<div class="meet-list">${meets
              .map((meet) => renderMeetCard(meet, progress.get(meet.meetCourseId)))
              .join("")}</div>`
      }
    </div>
  `;

  main.onclick = (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-action='back']")) {
      handlers.onBack();
      return;
    }
    if (target.closest("[data-action='refresh']")) {
      handlers.onRefresh();
      return;
    }
    if (target.closest("[data-action='check']")) {
      handlers.onCheck();
      return;
    }
    if (target.closest("[data-action='watch-all']")) {
      handlers.onWatch(null);
      return;
    }
    const progressButton = target.closest<HTMLElement>("[data-meet-progress]");
    if (progressButton) {
      const meet = meets.find(
        (item) =>
          String(item.meetCourseId) === progressButton.dataset.meetProgress,
      );
      if (meet) handlers.onLoadProgress(meet);
      return;
    }
    const watchButton = target.closest<HTMLElement>("[data-meet-watch]");
    if (watchButton) {
      const meet = meets.find(
        (item) => String(item.meetCourseId) === watchButton.dataset.meetWatch,
      );
      if (meet) handlers.onWatch(meet);
    }
  };
}

function renderMeetCard(
  meet: ZhsMeet,
  progress: ZhsMeetProgress | undefined,
): string {
  const canReplay = replayable(meet);
  const percent = progress ? progress.percent : 0;
  return `
    <article class="meet-card">
      <div class="meet-main">
        <div class="meet-head">
          <span class="kind-pill kind-live">${icon("live", 13)} 见面课</span>
          <span class="badge ${canReplay ? "badge-good" : "badge-muted"}">${meetStatus(meet)}</span>
        </div>
        <h3>${esc(meet.name || `见面课 ${meet.liveId}`)}</h3>
        <p class="meet-meta">
          ${esc(meet.teacher || "主讲未知")}
          ${meet.startTime ? ` · ${esc(meet.startTime)}` : ""}
        </p>
        <div class="meet-progress">
          <div class="meet-progress-row">
            <span>回放进度</span>
            <span class="meet-progress-value">${
              progress
                ? `${progress.watchedCount} / ${progress.totalMinutes} 分钟 · ${percent}%`
                : "未查询"
            }</span>
          </div>
          <div class="progress"><div class="progress-fill fill-good" style="width:${percent}%"></div></div>
        </div>
      </div>
      <div class="meet-actions">
        <button class="btn btn-sm btn-ghost" data-meet-progress="${esc(
          String(meet.meetCourseId),
        )}">${icon("refresh", 13)} 查询进度</button>
        <button class="btn btn-sm" data-meet-watch="${esc(
          String(meet.meetCourseId),
        )}" ${canReplay ? "" : "disabled"}>${icon("play", 13)} 完成回放</button>
      </div>
    </article>
  `;
}

export interface ZhsMeetWatchModalOptions {
  courseId: string;
  courseName: string;
  /** `null` processes every replayable meet of the course. */
  meet: ZhsMeet | null;
  meetCount: number;
  totalMinutes: number;
  onToast(message: string, tone?: ToastTone): void;
  onFinished(summary: ZhsMeetWatchSummary): void;
}

/** Replay attendance dialog: confirmation before submitting. */
export function openZhsMeetWatchModal(
  options: ZhsMeetWatchModalOptions,
): void {
  const content = document.createElement("div");
  content.className = "watch-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <h2>完成回放</h2>
        <p class="modal-sub">${
          options.meet
            ? esc(options.meet.name)
            : esc(options.courseName)
        }</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      <p>确认完成回放？此操作将向平台提交记录，可能影响账号或成绩。</p>

      <div class="watch-progress" id="zhs-meet-progress" hidden>
        <div class="watch-status-row">
          <span id="zhs-meet-status">就绪</span>
          <span id="zhs-meet-count" class="watch-count"></span>
        </div>
        <div class="progress"><div class="progress-fill" id="zhs-meet-fill" style="width:0%"></div></div>
        <div class="watch-log" id="zhs-meet-log"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="zhs-meet-copy" hidden>${icon("copy", 14)} 复制结果</button>
      <button class="btn btn-ghost" id="zhs-meet-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="zhs-meet-start">${icon("play", 15)} 确认执行</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#zhs-meet-status", content);
  const countText = qs<HTMLElement>("#zhs-meet-count", content);
  const fill = qs<HTMLElement>("#zhs-meet-fill", content);
  const log = qs<HTMLElement>("#zhs-meet-log", content);
  const startButton = qs<HTMLButtonElement>("#zhs-meet-start", content);
  const stopButton = qs<HTMLButtonElement>("#zhs-meet-stop", content);
  const copyButton = qs<HTMLButtonElement>("#zhs-meet-copy", content);

  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let totalMeets = 0;
  let resultLines: string[] = [];
  const rows = new Map<number, HTMLElement>();

  const close = openModal(content, {
    wide: true,
    onClose: () => {
      closed = true;
      unlisten?.();
      unlisten = null;
      if (running) void api.zhsCancelJob().catch(() => undefined);
    },
  });

  content.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-close]")) close();
  });

  const setProgress = (done: number, total: number) => {
    fill.style.width = `${formatPercent(done, total)}%`;
    countText.textContent = total > 0 ? `${done} / ${total}` : "";
  };

  const setRunningUi = (busy: boolean) => {
    if (busy) qs<HTMLElement>(".watch-progress", content).hidden = false;
    startButton.hidden = busy;
    stopButton.hidden = !busy;
  };

  const appendLog = (message: string, tone?: "ok" | "warn" | "error") => {
    const line = document.createElement("div");
    line.className = "watch-log-line";
    if (tone) line.classList.add(`is-${tone}`);
    line.textContent = message;
    log.appendChild(line);
    while (log.childElementCount > 200) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  };

  const addRow = (index: number, label: string): HTMLElement => {
    const row = document.createElement("div");
    row.className = "watch-row";
    row.dataset.index = String(index);
    row.innerHTML = `
      <span class="watch-index">${index}</span>
      <div class="watch-row-main">
        <div class="watch-row-label" title="${esc(label)}">${esc(label)}</div>
        <div class="watch-row-detail"></div>
      </div>
      <span class="status-chip">${icon("clock", 12)} 等待</span>
    `;
    rows.set(index, row);
    log.appendChild(row);
    return row;
  };

  const applyTarget = (
    index: number,
    label: string,
    status: string,
    message: string | null,
    targetMinutes: number | null,
    watchedBefore: number | null,
  ) => {
    const row = rows.get(index) ?? addRow(index, label);
    const chip = row.querySelector<HTMLElement>(".status-chip");
    if (chip) {
      chip.className = `status-chip ${STATUS_TONE[status] ?? ""}`;
      chip.innerHTML = `${status === "running" ? icon("clock", 12) : icon("check", 12)} ${
        STATUS_TEXT[status] ?? status
      }`;
    }
    const detail = row.querySelector<HTMLElement>(".watch-row-detail");
    if (detail) {
      const pieces: string[] = [];
      if (targetMinutes !== null) pieces.push(`目标 ${targetMinutes} 分钟`);
      if (watchedBefore !== null) pieces.push(`已看 ${watchedBefore} 分钟`);
      if (message) pieces.push(message);
      detail.textContent = pieces.join(" · ");
    }
    row.classList.toggle("is-passed", status === "ok");
    setProgress(status === "running" ? index - 1 : index, totalMeets);
    if (status === "running") statusText.textContent = `正在处理：${label}`;
  };

  const handleProgress = (progress: JobProgress) => {
    if (closed) return;
    if (progress.kind === "zhsPlan") {
      if (progress.job !== "zhs-meet-watch") return;
      totalMeets = progress.total;
      rows.clear();
      log.innerHTML = "";
      setProgress(0, progress.total);
      statusText.textContent =
        progress.total === 0
          ? "没有可回放的见面课"
          : progress.dryRun
            ? `试运行 · ${progress.total} 场回放`
            : `准备处理 ${progress.total} 场回放`;
      return;
    }
    if (progress.kind === "zhsTarget") {
      if (progress.job !== "zhs-meet-watch") return;
      applyTarget(
        progress.index,
        progress.label,
        progress.status,
        progress.message,
        progress.targetMinutes,
        progress.watchedBefore,
      );
      return;
    }
    if (progress.kind === "zhsStage") {
      if (progress.job !== "zhs-meet-watch") return;
      if (progress.stage === "circuit_check") {
        appendLog(`风控检查：${progress.message}`, "warn");
      } else if (progress.stage === "meet_minutes") {
        appendLog(`[${progress.done}/${progress.total}] ${progress.label}：${progress.message}`);
      } else if (progress.message) {
        appendLog(`${progress.label}：${progress.message}`);
      }
      if (progress.total > 0) {
        statusText.textContent = progress.label
          ? `正在处理：${progress.label}`
          : "正在处理…";
      }
    }
  };

  const copyResults = async () => {
    if (resultLines.length === 0) return;
    const copied = await copyText(resultLines.join("\n"));
    options.onToast(
      copied ? "结果已复制" : "复制失败",
      copied ? "success" : "error",
    );
  };
  copyButton.addEventListener("click", () => void copyResults());

  const finish = (summary: ZhsMeetWatchSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    stopButton.hidden = true;

    if (summary.cancelled) {
      statusText.textContent = "已取消";
      options.onToast("已取消回放考勤上报", "info");
    } else if (summary.dryRun) {
      statusText.textContent = `试运行完成 · ${summary.meets} 场回放`;
      options.onToast("试运行完成", "success");
    } else if (summary.failed === 0) {
      statusText.textContent = `已处理 ${summary.meets} 场回放`;
      options.onToast("回放考勤上报完成", "success");
    } else {
      statusText.textContent = `完成：${summary.failed} 场失败`;
      options.onToast(`${summary.failed} 场失败`, "error");
    }

    summary.outcomes.forEach((outcome, offset) => {
      const status = outcome.state === "circuit_broken" ? "failed" : outcome.state;
      if (!rows.has(offset + 1)) {
        applyTarget(
          offset + 1,
          outcome.label,
          status,
          outcome.message,
          outcome.targetMinutes,
          outcome.watchedBefore,
        );
      }
    });

    resultLines = summary.outcomes.map(
      (outcome) =>
        `${meetStateLabel(outcome.state)}  ${outcome.label}  目标 ${outcome.targetMinutes} 分钟 / 已看 ${outcome.watchedBefore} 分钟 · ${outcome.message}`,
    );
    if (summary.errors.length > 0) {
      resultLines.push("", ...summary.errors);
      const block = document.createElement("div");
      block.className = "watch-error";
      block.textContent = summary.errors.join("\n");
      log.appendChild(block);
    }
    copyButton.hidden = resultLines.length === 0;
    if (!summary.cancelled) setProgress(totalMeets, totalMeets);
    options.onFinished(summary);
  };

  startButton.addEventListener("click", async () => {
    if (running) return;
    running = true;
    rows.clear();
    log.innerHTML = "";
    resultLines = [];
    copyButton.hidden = true;
    setRunningUi(true);
    statusText.textContent = "正在加载见面课列表…";
    setProgress(0, 0);

    unlisten = await onJobProgress(handleProgress);
    if (closed) {
      unlisten?.();
      unlisten = null;
      return;
    }
    try {
      const summary = await api.zhsMeetWatch({
        course: options.courseId,
        meet: options.meet ? options.meet.meetCourseId : null,
        dryRun: false,
        coverageMin: 90,
        coverageMax: 100,
        delayMinMs: 2000,
        delayMaxMs: 6000,
        circuitBreaker: true,
        checkEvery: 10,
      });
      if (!closed) finish(summary);
    } catch (error) {
      if (closed) return;
      running = false;
      setRunningUi(false);
        const message = errorText(error);
      if (message.includes("已取消")) {
        statusText.textContent = "已取消";
        options.onToast("已取消回放考勤上报", "info");
      } else {
        statusText.textContent = "执行失败";
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
    void api.zhsCancelJob();
  });
}

function meetStateLabel(state: string): string {
  switch (state) {
    case "ok":
      return "[完成]";
    case "skip":
      return "[跳过]";
    case "dry_run":
      return "[预演]";
    case "failed":
      return "[失败]";
    case "cancelled":
      return "[取消]";
    case "circuit_broken":
      return "[熔断]";
    default:
      return `[${state}]`;
  }
}
