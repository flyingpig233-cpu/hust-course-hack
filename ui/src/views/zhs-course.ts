import { api, onJobProgress } from "../api";
import type { ToastTone } from "../dom";
import { copyText, errorText, esc, openModal, qs } from "../dom";
import { formatDuration, formatPercent } from "../format";
import { icon } from "../icons";
import type {
  JobProgress,
  SessionInfo,
  ZhsCourse,
  ZhsCourseDetail,
  ZhsWatchSummary,
} from "../types";
import {
  zhsCompletedVideos,
  zhsCourseLabel,
  zhsLessonVideos,
  zhsTotalVideos,
} from "../zhs";
import { courseHeadHtml, noticeHtml, statStripHtml } from "./course-shell";

const STATUS_TEXT: Record<string, string> = {
  running: "上报中",
  ok: "已确认",
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

export interface ZhsHomeHandlers {
  onSelect(courseId: string): void;
  onRefreshCourses(): void;
  onAddCourse(reference: string): void;
}

/** Course list for the Zhihuishu platform, plus the study-page URL fallback. */
export function renderZhsHome(
  main: HTMLElement,
  _session: SessionInfo,
  courses: ZhsCourse[],
  handlers: ZhsHomeHandlers,
): void {
  main.onchange = null;
  main.innerHTML = `
    <section class="home-view">
      <header class="home-head">
        <div>
          <div class="eyebrow">已连接 知到（智慧树）</div>
          <h1>我的课程</h1>
          <p class="home-sub">${courses.length} 门课程</p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-refresh>${icon("refresh", 15)} 刷新课程</button>
        </div>
      </header>

      <div class="zhs-add-course">
        <div class="zhs-add-copy">
          <strong>添加课程</strong>
          <p>粘贴课程学习页链接</p>
        </div>
        <div class="zhs-add-row">
          <input id="zhs-course-ref" type="text" spellcheck="false" autocomplete="off"
            placeholder="https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=..." />
          <button class="btn" data-add-course>${icon("link", 15)} 添加</button>
        </div>
      </div>

      ${
        courses.length
          ? `<div class="course-grid">${courses
              .map((course, index) => {
                const initial = [...course.name.trim()][0] ?? "课";
                const percent =
                  course.progress === null ? null : Math.round(course.progress);
                return `
                  <button class="course-card" data-course-id="${esc(
                    String(course.courseId),
                  )}" style="--delay:${index * 30}ms">
                    <div class="course-card-top">
                      <span class="course-avatar course-avatar-lg tone-${index % 5}">${esc(initial)}</span>
                    </div>
                    <h3>${esc(zhsCourseLabel(course))}</h3>
                    <p class="course-card-meta">${esc(course.teacher || "知到共享课")}${
                      percent === null ? "" : ` · 进度 ${percent}%`
                    }</p>
                    <span class="course-card-cta">查看课程 ${icon("chevron", 14)}</span>
                  </button>
                `;
              })
              .join("")}</div>`
          : `<div class="empty-panel">
              <div class="empty-icon">${icon("folder", 26)}</div>
              <h2>暂无共享课</h2>
              <p>刷新课程，或通过链接添加。</p>
              <button class="btn" data-refresh>${icon("refresh", 15)} 刷新课程列表</button>
            </div>`
      }

    </section>
  `;

  main.onclick = (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-refresh]")) {
      handlers.onRefreshCourses();
      return;
    }
    if (target.closest("[data-add-course]")) {
      const input = main.querySelector<HTMLInputElement>("#zhs-course-ref");
      const reference = input?.value.trim() ?? "";
      if (!reference) {
        return;
      }
      handlers.onAddCourse(reference);
      return;
    }
    const card = target.closest<HTMLElement>("[data-course-id]");
    if (card) handlers.onSelect(card.dataset.courseId ?? "");
  };
}

export function renderZhsLoading(
  main: HTMLElement,
  course: ZhsCourse,
  onCancel: () => void,
): void {
  main.onchange = null;
  main.innerHTML = `
    <div class="course-view">
      <header class="course-head">
        <div class="course-head-copy">
          <div class="eyebrow">知到 · recruit ${esc(String(course.recruitId))}</div>
          <h1>${esc(zhsCourseLabel(course))}</h1>
          <p class="course-sub">正在抓取视频树与完成状态。</p>
        </div>
      </header>
      <div class="crawl-card">
        <div class="crawl-orb">${icon("refresh", 28)}</div>
        <h2>正在抓取视频树</h2>
        <p>知到共享课的视频树一次返回章 / 节 / 小节，通常几秒内完成。</p>
        <div class="progress progress-lg">
          <div class="progress-fill zhs-loading-fill" style="width: 0%"></div>
        </div>
        <div class="crawl-meta">
          <span class="zhs-loading-label">正在请求 videoList…</span>
          <span class="zhs-loading-count"></span>
        </div>
        <button class="btn btn-ghost" data-cancel>${icon("stop", 14)} 取消</button>
      </div>
    </div>
  `;
  main.onclick = (event) => {
    if ((event.target as HTMLElement).closest("[data-cancel]")) onCancel();
  };
}

export function updateZhsLoading(
  main: HTMLElement,
  done: number,
  total: number,
  label: string,
): void {
  const fill = main.querySelector<HTMLElement>(".zhs-loading-fill");
  if (fill) fill.style.width = `${formatPercent(done, total)}%`;
  const text = main.querySelector<HTMLElement>(".zhs-loading-label");
  if (text && label) text.textContent = label;
  const count = main.querySelector<HTMLElement>(".zhs-loading-count");
  if (count && total > 0) count.textContent = `${done} / ${total}`;
}

export function renderZhsCourseError(
  main: HTMLElement,
  course: ZhsCourse,
  message: string,
  onRetry: () => void,
): void {
  main.onchange = null;
  main.innerHTML = `
    <div class="course-view">
      <header class="course-head">
        <div class="course-head-copy">
          <div class="eyebrow">知到 · recruit ${esc(String(course.recruitId))}</div>
          <h1>${esc(zhsCourseLabel(course))}</h1>
          <p class="course-sub">视频树抓取未完成</p>
        </div>
      </header>
      <div class="error-card">
        <div class="error-icon">${icon("alert", 24)}</div>
        <h2>抓取视频树失败</h2>
        <pre class="error-detail">${esc(message)}</pre>
        <p class="hint">如果提示登录失效，请在连接页重新登录知到。</p>
        <button class="btn btn-primary" data-retry>${icon("refresh", 15)} 重试</button>
      </div>
    </div>
  `;
  main.onclick = (event) => {
    if ((event.target as HTMLElement).closest("[data-retry]")) onRetry();
  };
}

export interface ZhsCourseHandlers {
  busy: boolean;
  onBack(): void;
  onRefresh(): void;
  onMeet(): void;
  onWatch(): void;
  onCheck(): void;
}

/** Shared-course video tree with the "秒刷本课视频" entry point. */
export function renderZhsCourse(
  main: HTMLElement,
  detail: ZhsCourseDetail,
  handlers: ZhsCourseHandlers,
): void {
  main.onchange = null;
  main.onclick = null;
  const course = detail.course;
  const videos = zhsTotalVideos(detail);
  const completed = zhsCompletedVideos(detail);
  const percent = formatPercent(completed, videos);
  const lessons = detail.chapters.reduce(
    (total, chapter) => total + chapter.lessons.length,
    0,
  );

  main.innerHTML = `
    <div class="course-view">
      ${courseHeadHtml({
        eyebrow: "知到 · 我的课程",
        title: zhsCourseLabel(course),
        subtitle: `${course.teacher || "知到共享课"} · ${detail.chapters.length} 章 ${lessons} 节`,
        actions: `
          <button class="icon-button" data-action="back" title="返回课程列表" aria-label="返回课程列表">${icon("folder", 16)}</button>
          <button class="icon-button" data-action="refresh" title="重新抓取" aria-label="重新抓取">${icon("refresh", 16)}</button>
          <button class="icon-button" data-action="check" title="检查风控状态" aria-label="检查风控状态">${icon("shield", 16)}</button>
          <button class="btn btn-ghost" data-action="meet">${icon("live", 15)} 见面课</button>
          <button class="btn btn-primary" data-action="watch">${icon("play", 15)} 秒刷本课视频</button>
        `,
      })}

      ${
        handlers.busy
          ? `<div class="crawl-banner"><div class="crawl-banner-row"><span class="spinner spinner-sm"></span><span class="crawl-progress-label">正在抓取视频树…</span></div></div>`
          : ""
      }

      ${noticeHtml(
        "alert",
        "操作可能影响账号或课程成绩。默认试运行，正式执行前需确认风险。",
      )}

      ${statStripHtml([
        {
          label: "视频完成度",
          value: `${completed} / ${videos}`,
          foot: `${percent}% 的小节视频已被平台标记完成`,
          wide: true,
          progress: percent,
        },
        { label: "章节", value: String(detail.chapters.length), foot: `${lessons} 节课` },
        { label: "视频", value: String(videos), foot: "按小节统计" },
        { label: "已完成", value: String(completed), foot: "watchState=1" },
      ])}

      ${
        videos === 0
          ? `<div class="empty-panel compact"><div class="empty-icon">${icon("video", 24)}</div><h2>没有可用的视频小节</h2><p>平台可能返回了空视频树，或该课程属于暂不支持的课程类型。</p></div>`
          : `<div class="tree">${detail.chapters
              .map((chapter, chapterIndex) => renderChapter(chapter, chapterIndex))
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
    if (target.closest("[data-action='meet']")) {
      handlers.onMeet();
      return;
    }
    if (target.closest("[data-action='watch']")) handlers.onWatch();
  };
}

function renderChapter(
  chapter: ZhsCourseDetail["chapters"][number],
  index: number,
): string {
  const videos = chapter.lessons.reduce(
    (total, lesson) => total + zhsLessonVideos(lesson).length,
    0,
  );
  return `
    <details class="tree-node"${index === 0 ? " open" : ""}>
      <summary class="tree-summary">
        <span class="tree-kind">${icon("folder", 16)}</span>
        <span class="tree-title">${esc(chapter.name)}</span>
        <span class="tree-count">${chapter.lessons.length} 节 · ${videos} 个视频</span>
        <span class="tree-chevron">${icon("chevron", 14)}</span>
      </summary>
      <div class="tree-body">
        ${chapter.lessons
          .map(
            (lesson) => `
          <div class="zhs-lesson">
            <div class="zhs-lesson-head">
              <span class="tree-title">${esc(lesson.name)}</span>
              <span class="tree-count">${zhsLessonVideos(lesson).length} 个小节</span>
            </div>
            <div class="task-rows">
              ${
                zhsLessonVideos(lesson).length
                  ? zhsLessonVideos(lesson)
                      .map(
                        (video, videoIndex) => `
                      <div class="task-row kind-video${
                        (video.isStudied ?? 0) !== 0 ? " is-done" : ""
                      }">
                        <span class="task-kind">${icon("video", 17)}</span>
                        <div class="task-copy">
                          <div class="task-name">${esc(
                            video.name || `${lesson.name} · 小节 ${videoIndex + 1}`,
                          )}</div>
                          <div class="task-meta">${esc(
                            formatDuration(video.videoSec),
                          )} · videoId ${esc(String(video.videoId))} · lessonVideoId ${esc(
                            String(video.lessonVideoId),
                          )}</div>
                        </div>
                        <div class="task-actions">
                          ${
                            (video.isStudied ?? 0) !== 0
                              ? `<span class="badge badge-good">${icon("check", 12)} 已完成</span>`
                              : `<span class="badge badge-muted">未完成</span>`
                          }
                        </div>
                      </div>
                    `,
                      )
                      .join("")
                  : `<div class="empty-inline">该节没有视频小节</div>`
              }
            </div>
          </div>
        `,
          )
          .join("")}
      </div>
    </details>
  `;
}

export interface ZhsWatchModalOptions {
  courseId: string;
  courseName: string;
  videoTotal: number;
  videoCompleted: number;
  onToast(message: string, tone?: ToastTone): void;
  onFinished(summary: ZhsWatchSummary): void;
}

/** Video completion dialog: dry-run by default, risk confirmation for real runs. */
export function openZhsWatchModal(options: ZhsWatchModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="eyebrow">知到 · 视频课</div>
        <h2>秒刷本课视频</h2>
        <p class="modal-sub">${esc(options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      <p class="modal-lead">
        对每个待处理的小节先取 <code>prelearningNote</code>（noteId），再提交
        <code>saveDatabaseIntervalTimeV2</code>，并可用 <code>queryStuyInfo</code> 复核
        <code>watchState=1</code>。试运行只在本地生成 <code>sdsew</code>/<code>ewssw</code>，不会发送。
      </p>
      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 秒刷视频属于最高风险形态。真实执行前请确认你理解账号风控与成绩判定风险。
      </div>
      <div class="settings-grid">
        <label class="field">
          <span>最多处理视频数</span>
          <input id="zhs-watch-max" type="number" min="1" step="1" placeholder="不限" />
          <em>先跑一个小批量</em>
        </label>
        <label class="check switch-row">
          <input id="zhs-watch-include" type="checkbox" />
          <span>重新上报已完成的视频</span>
        </label>
        <label class="check switch-row">
          <input id="zhs-watch-verify" type="checkbox" checked />
          <span>每节上报后复核 watchState</span>
        </label>
        <label class="check switch-row">
          <input id="zhs-watch-dry" type="checkbox" checked />
          <span>试运行，只生成上报字段</span>
        </label>
        <label class="check switch-row risk-confirm">
          <input id="zhs-watch-confirm" type="checkbox" />
          <span>我确认已了解风险，按平台协议真实上报视频进度</span>
        </label>
      </div>
      <div class="risk-summary" id="zhs-watch-summary"></div>

      <div class="watch-progress" id="zhs-watch-progress">
        <div class="watch-status-row">
          <span id="zhs-watch-status">准备就绪</span>
          <span id="zhs-watch-count" class="watch-count"></span>
        </div>
        <div class="progress"><div class="progress-fill" id="zhs-watch-fill" style="width:0%"></div></div>
        <div class="watch-log" id="zhs-watch-log"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="zhs-watch-copy" hidden>${icon("copy", 14)} 复制结果</button>
      <button class="btn btn-ghost" id="zhs-watch-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="zhs-watch-start">${icon("play", 15)} 开始</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#zhs-watch-status", content);
  const countText = qs<HTMLElement>("#zhs-watch-count", content);
  const fill = qs<HTMLElement>("#zhs-watch-fill", content);
  const log = qs<HTMLElement>("#zhs-watch-log", content);
  const summaryText = qs<HTMLElement>("#zhs-watch-summary", content);
  const startButton = qs<HTMLButtonElement>("#zhs-watch-start", content);
  const stopButton = qs<HTMLButtonElement>("#zhs-watch-stop", content);
  const copyButton = qs<HTMLButtonElement>("#zhs-watch-copy", content);
  const maxInput = qs<HTMLInputElement>("#zhs-watch-max", content);
  const includeInput = qs<HTMLInputElement>("#zhs-watch-include", content);
  const verifyInput = qs<HTMLInputElement>("#zhs-watch-verify", content);
  const dryInput = qs<HTMLInputElement>("#zhs-watch-dry", content);
  const confirmInput = qs<HTMLInputElement>("#zhs-watch-confirm", content);

  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let targetTotal = 0;
  const rows = new Map<number, HTMLElement>();
  let resultLines: string[] = [];

  const planned = (): number => {
    const base = includeInput.checked
      ? options.videoTotal
      : Math.max(0, options.videoTotal - options.videoCompleted);
    const max = maxInput.value ? Math.max(1, Number(maxInput.value) || 1) : null;
    return max === null ? base : Math.min(base, max);
  };

  const syncSummary = () => {
    const count = planned();
    if (dryInput.checked) {
      summaryText.innerHTML = `${icon("spark", 13)} 试运行：将处理 <strong>${count}</strong> 个视频（共 ${options.videoTotal} 个，已完成 ${options.videoCompleted} 个），只生成上报字段，不发送任何请求。`;
      confirmInput.disabled = true;
      confirmInput.checked = false;
    } else {
      summaryText.innerHTML = `${icon("alert", 13)} 真实执行：将秒刷 <strong>${count}</strong> 个视频（共 ${options.videoTotal} 个，已完成 ${options.videoCompleted} 个），按平台协议逐节上报。`;
      confirmInput.disabled = false;
    }
    if (!running) {
      startButton.disabled = !dryInput.checked && !confirmInput.checked;
      startButton.title = startButton.disabled
        ? "请勾选风险确认，或改用试运行"
        : "";
    }
  };

  dryInput.addEventListener("change", syncSummary);
  confirmInput.addEventListener("change", syncSummary);
  includeInput.addEventListener("change", syncSummary);
  maxInput.addEventListener("input", syncSummary);
  syncSummary();

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

  const setProgress = (done: number, total: number) => {
    fill.style.width = `${formatPercent(done, total)}%`;
    countText.textContent = total > 0 ? `${done} / ${total}` : "";
  };

  const setRunningUi = (busy: boolean) => {
    startButton.hidden = busy;
    stopButton.hidden = !busy;
    for (const input of [maxInput, includeInput, verifyInput, dryInput]) {
      input.disabled = busy;
    }
    confirmInput.disabled = busy || dryInput.checked;
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
      detail.textContent = message ?? "";
    }
    row.classList.toggle("is-passed", status === "ok");
    setProgress(status === "running" ? index - 1 : index, targetTotal);
    if (status === "running") statusText.textContent = `正在处理：${label}`;
  };

  const handleProgress = (progress: JobProgress) => {
    if (closed) return;
    if (progress.kind === "zhsPlan") {
      if (progress.job !== "zhs-watch") return;
      targetTotal = progress.total;
      rows.clear();
      log.innerHTML = "";
      setProgress(0, progress.total);
      statusText.textContent =
        progress.total === 0
          ? "没有需要处理的视频"
          : progress.dryRun
            ? `试运行：将为 ${progress.total} 个视频生成上报字段`
            : `准备上报 ${progress.total} 个视频`;
      return;
    }
    if (progress.kind === "zhsStage") {
      if (progress.job !== "zhs-watch") return;
      setProgress(progress.done, progress.total || targetTotal);
      statusText.textContent = progress.label
        ? `正在处理：${progress.label}`
        : "正在处理…";
      return;
    }
    if (progress.kind === "zhsTarget") {
      if (progress.job !== "zhs-watch") return;
      applyTarget(progress.index, progress.label, progress.status, progress.message);
    }
  };

  const copyResults = async () => {
    if (resultLines.length === 0) return;
    const copied = await copyText(resultLines.join("\n"));
    options.onToast(copied ? "结果已复制" : "复制失败，请手动选择日志", copied ? "success" : "error");
  };
  copyButton.addEventListener("click", () => void copyResults());

  const finish = (summary: ZhsWatchSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    stopButton.hidden = true;

    if (summary.cancelled) {
      statusText.textContent = "已取消";
      options.onToast("已取消视频秒刷", "info");
    } else if (summary.dryRun) {
      statusText.textContent = `试运行完成：${summary.total} 个视频计划已生成，未发送任何请求`;
      options.onToast("试运行完成，没有发送视频上报", "success");
    } else if (summary.failed === 0 && summary.ok > 0) {
      statusText.textContent = `完成：${summary.ok} 个已确认，${summary.skipped} 个跳过`;
      options.onToast(`已完成 ${summary.ok} 个视频`, "success");
    } else {
      statusText.textContent = `完成：${summary.ok} 个成功 · ${summary.failed} 个失败`;
      options.onToast(
        `${summary.ok} 个成功，${summary.failed} 个失败，详见日志`,
        summary.failed > 0 ? "error" : "info",
      );
    }

    // Emit rows from the returned outcomes when the live events did not cover
    // them (for example a job that stopped before the first target event).
    summary.outcomes.forEach((outcome, offset) => {
      const status =
        outcome.state === "circuit_broken" ? "failed" : outcome.state;
      if (!rows.has(offset + 1)) {
        applyTarget(offset + 1, outcome.label, status, outcome.message);
      }
    });

    resultLines = summary.outcomes.map(
      (outcome) => `${zhsStatusLabel(outcome.state)}  ${outcome.label}  ${outcome.message}`,
    );
    if (summary.errors.length > 0) {
      resultLines.push("", ...summary.errors);
      const block = document.createElement("div");
      block.className = "watch-error";
      block.textContent = summary.errors.join("\n");
      log.appendChild(block);
    }
    copyButton.hidden = resultLines.length === 0;
    if (!summary.cancelled) setProgress(targetTotal, targetTotal);
    options.onFinished(summary);
  };

  startButton.addEventListener("click", async () => {
    if (running) return;
    if (!dryInput.checked && !confirmInput.checked) {
      options.onToast("真实执行前必须勾选风险确认", "error");
      return;
    }
    running = true;
    rows.clear();
    log.innerHTML = "";
    resultLines = [];
    copyButton.hidden = true;
    setRunningUi(true);
    syncSummary();
    statusText.textContent = "正在抓取视频树…";
    setProgress(0, 0);

    unlisten = await onJobProgress(handleProgress);
    if (closed) {
      unlisten?.();
      unlisten = null;
      return;
    }
    try {
      const summary = await api.zhsWatchVideos({
        course: options.courseId,
        dryRun: dryInput.checked,
        includeCompleted: includeInput.checked,
        maxVideos: maxInput.value ? Math.max(1, Number(maxInput.value)) : null,
        verify: verifyInput.checked,
      });
      if (!closed) finish(summary);
    } catch (error) {
      if (closed) return;
      running = false;
      setRunningUi(false);
      syncSummary();
      const message = errorText(error);
      if (message.includes("已取消")) {
        statusText.textContent = "已取消";
        options.onToast("已取消视频秒刷", "info");
      } else {
        statusText.textContent = "秒刷失败";
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
    void api.zhsCancelJob();
  });
}

function zhsStatusLabel(state: string): string {
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
