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
  ZhsExamSummary,
  ZhsWatchSummary,
} from "../types";
import {
  zhsCompletedVideos,
  zhsCourseKey,
  zhsCourseKindLabel,
  zhsCourseLabel,
  zhsLessonVideos,
  zhsTotalVideos,
} from "../zhs";
import { courseHeadHtml, statStripHtml } from "./course-shell";

const STATUS_TEXT: Record<string, string> = {
  running: "上报中",
  ok: "已完成（平台记录）",
  skip: "跳过（已完成）",
  dry_run: "已计划",
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
  const kindOrder: Array<{ kind: ZhsCourse["kind"]; label: string }> = [
    { kind: "shared", label: "共享课" },
    { kind: "ai", label: "AI 智课" },
    { kind: "school", label: "智慧课程" },
    { kind: "other", label: "其他" },
  ];
  const grouped = kindOrder
    .map((entry) => ({
      ...entry,
      items: courses.filter((course) => course.kind === entry.kind),
    }))
    .filter((group) => group.items.length > 0);
  const cardFor = (course: ZhsCourse, index: number): string => {
    const initial = [...course.name.trim()][0] ?? "课";
    const percent =
      course.progress === null ? null : Math.round(course.progress);
    const readonly = course.kind !== "shared";
    return `
      <button class="course-card${readonly ? " is-readonly" : ""}" data-course-id="${esc(
        zhsCourseKey(course),
      )}" style="--delay:${index * 30}ms">
        <div class="course-card-top">
          <span class="course-avatar course-avatar-lg tone-${index % 5}">${esc(initial)}</span>
          ${
            readonly
              ? `<span class="course-kind-badge">${esc(
                  zhsCourseKindLabel(course),
                )}</span>`
              : `<span class="course-code">共享课</span>`
          }
        </div>
        <h3>${esc(zhsCourseLabel(course))}</h3>
        <p class="course-card-meta">${esc(course.teacher || "知到课程")}${
          percent === null ? "" : ` · 进度 ${percent}%`
        }</p>
      </button>
    `;
  };
  main.innerHTML = `
    <section class="home-view">
      <header class="home-head">
        <div>
          <h1>我的课程</h1>
          <p class="home-sub">${courses.length} 门课程</p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-refresh>${icon("refresh", 15)} 刷新课程</button>
        </div>
      </header>

      <div class="zhs-add-course">
        <div class="zhs-add-row">
          <input id="zhs-course-ref" type="text" spellcheck="false" autocomplete="off"
            placeholder="课程学习页链接" aria-label="课程学习页链接" />
          <button class="btn" data-add-course>${icon("link", 15)} 添加</button>
        </div>
      </div>
      ${
        grouped.length
          ? grouped
              .map(
                (group) => `
            <section class="course-section">
              <div class="course-section-head">
                <h2>${esc(group.label)}</h2>
                <span class="count-pill">${group.items.length}</span>
              </div>
              <div class="course-grid">${group.items
                .map((course, index) => cardFor(course, index))
                .join("")}</div>
            </section>`,
              )
              .join("")
          : `<div class="empty-panel">
              <div class="empty-icon">${icon("folder", 26)}</div>
              <h2>没有解析到课程</h2>
              <p>知到课程列表接口未返回数据，可稍后刷新，或粘贴学习页链接手动添加共享课。</p>
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

/** Read-only info panel for course kinds whose platform protocol is not wired yet. */
export function renderZhsUnsupportedCourse(
  main: HTMLElement,
  course: ZhsCourse,
  onBack: () => void,
): void {
  main.onchange = null;
  main.onclick = null;
  const kind = zhsCourseKindLabel(course);
  main.innerHTML = `
    <div class="course-view">
      <header class="course-head">
        <div class="course-head-copy">
          <div class="eyebrow">知到 · ${esc(kind)} · 只读</div>
          <h1>${esc(zhsCourseLabel(course))}</h1>
          <p class="course-sub">${esc(course.teacher || "教师未知")} · ${esc(kind)}</p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-back>${icon("chevron", 15)} 返回课程列表</button>
        </div>
      </header>
      <div class="inline-notice notice-warn">${icon("alert", 14)} <span>该课程类型暂不支持秒刷/作业，仅支持列表查看。</span></div>
      <div class="stat-strip">
        <div class="stat-card"><span class="stat-label">课程</span><strong>${esc(zhsCourseLabel(course))}</strong></div>
        <div class="stat-card"><span class="stat-label">教师</span><strong>${esc(course.teacher || "未知")}</strong></div>
        <div class="stat-card"><span class="stat-label">类型</span><strong>${esc(kind)}</strong></div>
        <div class="stat-card"><span class="stat-label">访问</span><strong>只读</strong></div>
      </div>
      <p class="exam-hint">后续会按平台协议逐步支持；当前不会向该课程发送任何请求。</p>
    </div>
  `;
  main.onclick = (event) => {
    if ((event.target as HTMLElement).closest("[data-back]")) onBack();
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
          <h1>${esc(zhsCourseLabel(course))}</h1>

        </div>
      </header>
      <div class="crawl-card">
        <div class="crawl-orb">${icon("refresh", 28)}</div>
        <h2>正在加载视频</h2>
        <div class="progress progress-lg">
          <div class="progress-fill zhs-loading-fill" style="width: 0%"></div>
        </div>
        <div class="crawl-meta">
          <span class="zhs-loading-label">加载中…</span>
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
          <h1>${esc(zhsCourseLabel(course))}</h1>

        </div>
      </header>
      <div class="error-card">
        <div class="error-icon">${icon("alert", 24)}</div>
        <h2>加载失败</h2>
        <pre class="error-detail">${esc(message)}</pre>
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
  onExam(): void;
  onCheck(): void;
}

/** Shared-course video tree with the "完成视频" entry point. */
export function renderZhsCourse(
  main: HTMLElement,
  detail: ZhsCourseDetail,
  handlers: ZhsCourseHandlers,
  examSummary: ZhsExamSummary | null = null,
): void {
  main.onchange = null;
  main.onclick = null;
  const course = detail.course;
  const videos = zhsTotalVideos(detail);
  const completed = zhsCompletedVideos(detail);
  const pending = Math.max(0, videos - completed);
  const percent = formatPercent(completed, videos);
  const platformProgress =
    course.progress === null ? null : Math.round(course.progress);
  const lessons = detail.chapters.reduce(
    (total, chapter) => total + chapter.lessons.length,
    0,
  );

  main.innerHTML = `
    <div class="course-view">
      ${courseHeadHtml({
        title: zhsCourseLabel(course),
        subtitle: course.teacher || "",
        actions: `
          <button class="icon-button" data-action="back" title="返回课程列表" aria-label="返回课程列表">${icon("folder", 16)}</button>
          <button class="icon-button" data-action="refresh" title="刷新" aria-label="刷新">${icon("refresh", 16)}</button>
          <button class="icon-button" data-action="check" title="检查风控状态" aria-label="检查风控状态">${icon("shield", 16)}</button>
          <button class="btn btn-ghost" data-action="meet">${icon("live", 15)} 见面课</button>
          <button class="btn btn-ghost" data-action="exam">${icon("work", 15)} 作业/考试</button>
          <button class="btn btn-primary" data-action="watch">${icon("play", 15)} 完成视频</button>
        `,
      })}
      ${
        handlers.busy
          ? `<div class="crawl-banner"><div class="crawl-banner-row"><span class="spinner spinner-sm"></span><span class="crawl-progress-label">正在加载视频…</span></div></div>`
          : ""
      }

      ${statStripHtml([
        {
          label: "视频完成度",
          value: `${completed} / ${videos}`,
          wide: true,
          progress: percent,
        },
        {
          label: "平台进度",
          value: platformProgress === null ? "—" : `${platformProgress}%`,
          foot: "来自共享课列表",
        },
        { label: "待处理", value: String(pending), foot: "可秒刷的小节视频" },
        { label: "章节", value: String(detail.chapters.length), foot: `${lessons} 节课` },
        { label: "视频", value: String(videos),  },
        { label: "已完成", value: String(completed),  },
        ...(examSummary
          ? [
              {
                label: "作业/测验",
                value: `${examSummary.homeworkSubmitted} / ${examSummary.homeworkTotal}`,
                foot:
                  examSummary.averageScore === null
                    ? "已完成（暂无平均分）"
                    : `已完成 · 平均 ${examSummary.averageScore} 分`,
              },
              {
                label: "期末",
                value:
                  examSummary.finalExamCount === 0
                    ? "—"
                    : `${examSummary.finalExamSubmitted} / ${examSummary.finalExamCount}`,
                foot: "已完成 / 全部（不自动提交）",
              },
            ]
          : []),
      ])}
      ${
        videos === 0
          ? `<div class="empty-panel compact"><div class="empty-icon">${icon("video", 24)}</div><h2>暂无视频</h2></div>`
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
    if (target.closest("[data-action='exam']")) {
      handlers.onExam();
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
                          )}</div>
                        </div>
                        <div class="task-actions">
                          ${
                            (video.isStudied ?? 0) !== 0
                              ? `<span class="badge badge-good" title="平台记录 watchState=1">${icon("check", 12)} 已完成（平台记录）</span>`
                              : `<span class="badge badge-muted" title="平台尚未记录完成，可被秒刷计划选中">待处理</span>`
                          }
                        </div>
                      </div>
                    `,
                      )
                      .join("")
                  : `<div class="empty-inline">暂无视频</div>`
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

/** Video completion dialog: confirmation before submitting. */
export function openZhsWatchModal(options: ZhsWatchModalOptions): void {
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
      <p>确认完成视频？此操作将向平台提交记录，可能影响账号或成绩。</p>

      <div class="watch-progress" id="zhs-watch-progress" hidden>
        <div class="watch-status-row">
          <span id="zhs-watch-status">就绪</span>
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
      <button class="btn btn-primary" id="zhs-watch-start">${icon("play", 15)} 确认执行</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#zhs-watch-status", content);
  const countText = qs<HTMLElement>("#zhs-watch-count", content);
  const fill = qs<HTMLElement>("#zhs-watch-fill", content);
  const log = qs<HTMLElement>("#zhs-watch-log", content);
  const startButton = qs<HTMLButtonElement>("#zhs-watch-start", content);
  const stopButton = qs<HTMLButtonElement>("#zhs-watch-stop", content);
  const copyButton = qs<HTMLButtonElement>("#zhs-watch-copy", content);

  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let targetTotal = 0;
  const rows = new Map<number, HTMLElement>();
  let resultLines: string[] = [];

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
    if (busy) qs<HTMLElement>(".watch-progress", content).hidden = false;
    startButton.hidden = busy;
    stopButton.hidden = !busy;
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
            ? `试运行 · ${progress.total} 个视频`
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
    options.onToast(copied ? "结果已复制" : "复制失败", copied ? "success" : "error");
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
      statusText.textContent = `试运行完成 · ${summary.total} 个视频`;
      options.onToast("试运行完成", "success");
    } else if (summary.failed === 0 && summary.ok > 0) {
      statusText.textContent = `完成：${summary.ok} 个已确认，${summary.skipped} 个跳过`;
      options.onToast(`已完成 ${summary.ok} 个视频`, "success");
    } else {
      statusText.textContent = `完成：${summary.ok} 个成功 · ${summary.failed} 个失败`;
      options.onToast(
        `${summary.ok} 个成功，${summary.failed} 个失败`,
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
    running = true;
    rows.clear();
    log.innerHTML = "";
    resultLines = [];
    copyButton.hidden = true;
    setRunningUi(true);
    statusText.textContent = "正在加载视频…";
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
        dryRun: false,
        includeCompleted: false,
        maxVideos: null,
        verify: true,
      });
      if (!closed) finish(summary);
    } catch (error) {
      if (closed) return;
      running = false;
      setRunningUi(false);
        const message = errorText(error);
      if (message.includes("已取消")) {
        statusText.textContent = "已取消";
        options.onToast("已取消视频秒刷", "info");
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

function zhsStatusLabel(state: string): string {
  switch (state) {
    case "ok":
      return "[已完成（平台记录）]";
    case "skip":
      return "[跳过（已完成）]";
    case "dry_run":
      return "[已计划]";
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
