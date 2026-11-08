import { onZhsProgress, zhsApi } from "../api";
import { errorText, esc, openModal, qs } from "../dom";
import type { ToastTone } from "../dom";
import { formatPercent } from "../format";
import { icon } from "../icons";
import type {
  ZhsCourse,
  ZhsJobProgress,
  ZhsMeet,
  ZhsMeetProgress,
  ZhsMeetWatchSummary,
} from "../core/zhs/types";

export interface ZhsMeetHandlers {
  busy: boolean;
  onBack(): void;
  onRefresh(): void;
  onLoadProgress(meet: ZhsMeet): void;
  onWatch(meet: ZhsMeet | null): void;
}

function replayable(meet: ZhsMeet): boolean {
  return meet.live_id !== 0;
}

function meetStatus(meet: ZhsMeet): string {
  if (!replayable(meet)) return "无回放";
  if (meet.status === 0) return "未开始";
  return "可回放";
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
          <div class="eyebrow">知到 · 见面课回放</div>
          <h1>${esc(course.name || `课程 ${course.course_id}`)}</h1>
          <p class="course-sub">共 ${meets.length} 场 · ${withReplay} 场有回放 · 已看分钟以服务端 <code>getWatchHistory</code> 为准</p>
        </div>
        <div class="head-actions">
          <button class="icon-button" data-action="back" title="返回视频树" aria-label="返回视频树">${icon("folder", 16)}</button>
          <button class="icon-button" data-action="refresh" title="刷新见面课列表" aria-label="刷新见面课列表">${icon("refresh", 16)}</button>
          <button class="btn btn-primary" data-action="watch-all" ${withReplay === 0 ? "disabled" : ""}>${icon("play", 15)} 秒刷全部回放考勤</button>
        </div>
      </header>

      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 回放考勤按随机 90–100% 覆盖率逐分钟上报，带随机间隔与风控熔断。默认仅试运行，确认真实执行前不会发送。
      </div>

      ${
        meets.length === 0
          ? `<div class="empty-panel compact"><div class="empty-icon">${icon("live", 24)}</div><h2>没有见面课</h2><p>该课程当前没有见面课，或接口没有返回场次。</p></div>`
          : `<div class="meet-list">${meets.map((meet) => renderMeetCard(meet, progress.get(meet.meet_course_id))).join("")}</div>`
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
    if (target.closest("[data-action='watch-all']")) {
      handlers.onWatch(null);
      return;
    }
    const progressButton = target.closest<HTMLElement>("[data-meet-progress]");
    if (progressButton) {
      const meet = meets.find((item) => String(item.meet_course_id) === progressButton.dataset.meetProgress);
      if (meet) handlers.onLoadProgress(meet);
      return;
    }
    const watchButton = target.closest<HTMLElement>("[data-meet-watch]");
    if (watchButton) {
      const meet = meets.find((item) => String(item.meet_course_id) === watchButton.dataset.meetWatch);
      if (meet) handlers.onWatch(meet);
    }
  };
}

function renderMeetCard(meet: ZhsMeet, progress: ZhsMeetProgress | undefined): string {
  const canReplay = replayable(meet);
  const percent = progress ? progress.percent : 0;
  return `
    <article class="meet-card">
      <div class="meet-main">
        <div class="meet-head">
          <span class="kind-pill kind-live">${icon("live", 13)} 见面课</span>
          <span class="badge ${canReplay ? "badge-good" : "badge-muted"}">${meetStatus(meet)}</span>
        </div>
        <h3>${esc(meet.name || `见面课 ${meet.live_id}`)}</h3>
        <p class="meet-meta">
          ${esc(meet.teacher || "主讲未知")}
          ${meet.start_time ? ` · ${esc(meet.start_time)}` : ""}
          · liveId ${esc(String(meet.live_id))}
        </p>
        <div class="meet-progress">
          <div class="meet-progress-row">
            <span>回放进度</span>
            <span class="meet-progress-value">${
              progress ? `${progress.watched_count} / ${progress.total_minutes} 分钟 · ${percent}%` : "未查询"
            }</span>
          </div>
          <div class="progress"><div class="progress-fill fill-good" style="width:${percent}%"></div></div>
        </div>
      </div>
      <div class="meet-actions">
        <button class="btn btn-sm btn-ghost" data-meet-progress="${esc(String(meet.meet_course_id))}">${icon("refresh", 13)} 查询进度</button>
        <button class="btn btn-sm" data-meet-watch="${esc(String(meet.meet_course_id))}" ${canReplay ? "" : "disabled"}>${icon("play", 13)} 秒刷本场</button>
      </div>
    </article>
  `;
}

export interface ZhsMeetWatchModalOptions {
  courseId: string;
  courseName: string;
  meet: ZhsMeet | null;
  onToast(message: string, tone?: ToastTone): void;
  onFinished(summary: ZhsMeetWatchSummary): void;
}

/** Replay attendance dialog: coverage/pacing settings, dry-run and risk gate. */
export function openZhsMeetWatchModal(options: ZhsMeetWatchModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="eyebrow">知到 · 见面课</div>
        <h2>秒刷回放考勤</h2>
        <p class="modal-sub">${esc(options.meet ? options.meet.name : options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      <p class="modal-lead">
        读取 <code>getWatchHistory</code> 的已看分钟，按随机覆盖率补齐缺口，再逐分钟调用
        <code>setWatchHistorySecret</code>；每 N 条检查一次 <code>exceptionActionDetail</code>，命中锁定即熔断。
      </p>
      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 见面对考勤属于高风险操作。真实执行前请确认你理解账号风控与成绩判定风险。
      </div>
      <div class="settings-grid">
        <label class="field">
          <span>最低覆盖率（%）</span>
          <input id="zhs-meet-min" type="number" min="1" max="100" step="1" value="90" />
        </label>
        <label class="field">
          <span>最高覆盖率（%）</span>
          <input id="zhs-meet-max" type="number" min="1" max="100" step="1" value="100" />
        </label>
        <label class="field">
          <span>最小间隔（毫秒）</span>
          <input id="zhs-meet-delay-min" type="number" min="0" step="100" value="2000" />
        </label>
        <label class="field">
          <span>最大间隔（毫秒）</span>
          <input id="zhs-meet-delay-max" type="number" min="0" step="100" value="6000" />
        </label>
        <label class="field">
          <span>每 N 条检查风控</span>
          <input id="zhs-meet-check" type="number" min="1" step="1" value="10" />
        </label>
        <label class="check switch-row">
          <input id="zhs-meet-breaker" type="checkbox" checked />
          <span>启用风控熔断</span>
        </label>
        <label class="check switch-row">
          <input id="zhs-meet-dry" type="checkbox" checked />
          <span>试运行，只计算覆盖计划</span>
        </label>
        <label class="check switch-row risk-confirm">
          <input id="zhs-meet-confirm" type="checkbox" />
          <span>我确认已了解风险，按随机 90–100% 覆盖率真实上报</span>
        </label>
      </div>

      <div class="watch-progress" id="zhs-meet-progress">
        <div class="watch-status-row">
          <span id="zhs-meet-status">准备就绪</span>
          <span id="zhs-meet-count" class="watch-count"></span>
        </div>
        <div class="progress"><div class="progress-fill" id="zhs-meet-fill" style="width:0%"></div></div>
        <div class="watch-log" id="zhs-meet-log"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="zhs-meet-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="zhs-meet-start">${icon("play", 15)} 开始</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#zhs-meet-status", content);
  const countText = qs<HTMLElement>("#zhs-meet-count", content);
  const fill = qs<HTMLElement>("#zhs-meet-fill", content);
  const log = qs<HTMLElement>("#zhs-meet-log", content);
  const startButton = qs<HTMLButtonElement>("#zhs-meet-start", content);
  const stopButton = qs<HTMLButtonElement>("#zhs-meet-stop", content);
  const minInput = qs<HTMLInputElement>("#zhs-meet-min", content);
  const maxInput = qs<HTMLInputElement>("#zhs-meet-max", content);
  const delayMinInput = qs<HTMLInputElement>("#zhs-meet-delay-min", content);
  const delayMaxInput = qs<HTMLInputElement>("#zhs-meet-delay-max", content);
  const checkInput = qs<HTMLInputElement>("#zhs-meet-check", content);
  const breakerInput = qs<HTMLInputElement>("#zhs-meet-breaker", content);
  const dryInput = qs<HTMLInputElement>("#zhs-meet-dry", content);
  const confirmInput = qs<HTMLInputElement>("#zhs-meet-confirm", content);

  dryInput.addEventListener("change", () => {
    confirmInput.disabled = dryInput.checked;
    if (dryInput.checked) confirmInput.checked = false;
  });
  confirmInput.disabled = dryInput.checked;

  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let totalMeets = 0;

  const close = openModal(content, {
    wide: true,
    onClose: () => {
      closed = true;
      unlisten?.();
      unlisten = null;
      if (running) void zhsApi.cancelJob().catch(() => undefined);
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
    startButton.hidden = busy;
    stopButton.hidden = !busy;
    for (const input of [minInput, maxInput, delayMinInput, delayMaxInput, checkInput, breakerInput, dryInput]) {
      input.disabled = busy;
    }
    confirmInput.disabled = busy || dryInput.checked;
  };

  const appendLog = (message: string, tone?: "ok" | "warn" | "error") => {
    const row = document.createElement("div");
    row.className = "watch-log-line";
    if (tone) row.classList.add(`is-${tone}`);
    row.textContent = message;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  };

  const handleProgress = (progress: ZhsJobProgress) => {
    if (closed) return;
    if (progress.kind === "zhs-crawl") {
      statusText.textContent = progress.label ? `正在加载：${progress.label}` : "正在加载…";
      return;
    }
    if (progress.kind === "zhs-plan") {
      totalMeets = progress.total;
      log.innerHTML = "";
      setProgress(0, progress.total);
      statusText.textContent = progress.total === 0
        ? "没有可回放的见面课"
        : progress.dryRun
          ? `试运行：将为 ${progress.total} 场回放生成覆盖计划`
          : `准备处理 ${progress.total} 场回放`;
      return;
    }
    if (progress.kind === "zhs-meet") {
      if (progress.status === "running") {
        statusText.textContent = `正在处理：${progress.label}`;
        setProgress(progress.index - 1, totalMeets);
        appendLog(`[${progress.index}/${totalMeets}] ${progress.label}：计算覆盖目标`);
      } else {
        const tone = progress.status === "failed" ? "error" : progress.status === "skip" ? "warn" : "ok";
        appendLog(`[${progress.index}/${totalMeets}] ${progress.label}：${progress.message ?? progress.status}`, tone);
        setProgress(progress.index, totalMeets);
      }
      return;
    }
    if (progress.kind === "zhs-minute") {
      const tone = progress.status === "failed" ? "error" : progress.status === "ok" ? "ok" : undefined;
      appendLog(`  · 第 ${progress.minute} 分钟：${progress.message}`, tone);
      return;
    }
    if (progress.kind === "zhs-circuit") {
      appendLog(`风控检查：${progress.message}`, "warn");
    }
  };

  const finish = (summary: ZhsMeetWatchSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    if (summary.cancelled) {
      statusText.textContent = "已取消";
      options.onToast("已取消回放考勤上报", "info");
    } else if (summary.dryRun) {
      statusText.textContent = `试运行完成：${summary.meets} 场回放计划已生成，未发送`;
      options.onToast("试运行完成，没有发送考勤上报", "success");
    } else if (summary.failed === 0) {
      statusText.textContent = `完成：${summary.meets} 场回放处理结束`;
      options.onToast("回放考勤上报完成", "success");
    } else {
      statusText.textContent = `完成：${summary.failed} 场失败，详见日志`;
      options.onToast(`${summary.failed} 场失败，详见日志`, "error");
    }
    if (summary.errors.length) {
      const block = document.createElement("div");
      block.className = "watch-error";
      block.textContent = summary.errors.join("\n");
      log.appendChild(block);
    }
    if (!summary.cancelled) setProgress(totalMeets, totalMeets);
    options.onFinished(summary);
  };

  startButton.addEventListener("click", async () => {
    if (running) return;
    if (!dryInput.checked && !confirmInput.checked) {
      options.onToast("真实执行前必须勾选风险确认", "error");
      return;
    }
    const coverageMin = Math.min(100, Math.max(1, Number(minInput.value) || 90));
    const coverageMax = Math.min(100, Math.max(1, Number(maxInput.value) || 100));
    if (coverageMin > coverageMax) {
      options.onToast("最低覆盖率不能高于最高覆盖率", "error");
      return;
    }
    const delayMin = Math.max(0, Number(delayMinInput.value) || 0);
    const delayMax = Math.max(delayMin, Number(delayMaxInput.value) || 0);
    running = true;
    log.innerHTML = "";
    setRunningUi(true);
    statusText.textContent = "正在加载见面课列表…";
    setProgress(0, 0);

    unlisten = await onZhsProgress(handleProgress);
    if (closed) {
      unlisten?.();
      unlisten = null;
      return;
    }
    try {
      const summary = await zhsApi.meetWatch({
        course: options.courseId,
        meet: options.meet ? options.meet.meet_course_id : null,
        dryRun: dryInput.checked,
        coverageMin,
        coverageMax,
        delayMinMs: delayMin,
        delayMaxMs: delayMax,
        circuitBreaker: breakerInput.checked,
        checkEvery: Math.max(1, Number(checkInput.value) || 10),
      });
      if (!closed) finish(summary);
    } catch (error) {
      if (closed) return;
      running = false;
      setRunningUi(false);
      const text = errorText(error);
      statusText.textContent = text.includes("已取消") ? "已取消" : "秒刷失败";
      log.innerHTML = `<div class="watch-error">${esc(text)}</div>`;
      options.onToast(text, "error");
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
    void zhsApi.cancelJob();
  });
}
