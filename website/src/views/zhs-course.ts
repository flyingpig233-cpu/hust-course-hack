import { onZhsProgress, zhsApi } from "../api";
import { errorText, esc, openModal, qs } from "../dom";
import type { ToastTone } from "../dom";
import { formatDuration, formatPercent } from "../format";
import { icon } from "../icons";
import { courseLabel, totalVideos, completedVideos } from "../core/zhs/types";
import type { ZhsCourse, ZhsCourseDetail, ZhsJobProgress, ZhsSessionInfo, ZhsWatchSummary } from "../core/zhs/types";

const STATUS_TEXT: Record<string, string> = {
  running: "上报中",
  ok: "已确认",
  skip: "已跳过",
  failed: "失败",
  dry_run: "已生成",
};

const STATUS_TONE: Record<string, string> = {
  running: "is-running",
  ok: "is-good",
  skip: "is-muted",
  failed: "is-bad",
  dry_run: "is-muted",
};

export interface ZhsHomeHandlers {
  onSelect(courseId: string): void;
  onRefreshCourses(): void;
  onAddCourse(ref: string): void;
}

/** Course list for the Zhihuishu platform, plus the study-page URL fallback. */
export function renderZhsHome(
  main: HTMLElement,
  session: ZhsSessionInfo,
  courses: ZhsCourse[],
  handlers: ZhsHomeHandlers,
): void {
  main.onchange = null;
  main.innerHTML = `
    <section class="home-view">
      <header class="home-head">
        <div>
          <div class="eyebrow">已连接 知到（智慧树）</div>
          <h1>选择一门共享课开始</h1>
          <p class="home-sub">
            当前账号共 ${courses.length} 门共享课 ·
            ${esc(session.real_name || session.uuid || "知到学生")}
          </p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-refresh>${icon("refresh", 15)} 刷新课程</button>
        </div>
      </header>

      <div class="zhs-add-course">
        <div class="zhs-add-copy">
          <strong>课程列表接口不可用时</strong>
          <p>把知到学习页的完整链接粘贴到这里，会解析 <code>recruitAndCourseId</code> 并抓取视频树。</p>
        </div>
        <div class="zhs-add-row">
          <input id="zhs-course-ref" type="text" spellcheck="false" autocomplete="off"
            placeholder="https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=..." />
          <button class="btn" data-add-course>${icon("link", 15)} 解析并添加</button>
        </div>
      </div>

      ${
        courses.length
          ? `<div class="course-grid">${courses
              .map((course, index) => {
                const initial = [...course.name.trim()][0] ?? "课";
                const percent = course.progress === null ? null : Math.round(course.progress);
                return `
                  <button class="course-card" data-course-id="${esc(String(course.course_id))}" style="--delay:${index * 30}ms">
                    <div class="course-card-top">
                      <span class="course-avatar course-avatar-lg tone-${index % 5}">${esc(initial)}</span>
                      <span class="course-code">recruit ${esc(String(course.recruit_id))}</span>
                    </div>
                    <h3>${esc(courseLabel(course))}</h3>
                    <p class="course-card-meta">${esc(course.teacher || "知到共享课")}${
                      percent === null ? "" : ` · 进度 ${percent}%`
                    }</p>
                    <span class="course-card-cta">查看视频树 ${icon("chevron", 14)}</span>
                  </button>
                `;
              })
              .join("")}</div>`
          : `<div class="empty-panel">
              <div class="empty-icon">${icon("folder", 26)}</div>
              <h2>没有解析到共享课</h2>
              <p>可刷新课程列表，或粘贴学习页链接手动添加。polymas / 翻转课暂不支持。</p>
              <button class="btn" data-refresh>${icon("refresh", 15)} 刷新课程列表</button>
            </div>`
      }

      <div class="tip-grid">
        <div class="tip-card">
          <span class="tip-index">01</span>
          <h4>仅支持共享课</h4>
          <p>知到共享课使用 <code>studyvideoh5</code>；polymas、翻转课和智能课不会出现在这里。</p>
        </div>
        <div class="tip-card">
          <span class="tip-index">02</span>
          <h4>默认试运行</h4>
          <p>“秒刷本课视频”默认 dry-run，只生成上报字段；真实执行需要勾选风险确认。</p>
        </div>
        <div class="tip-card">
          <span class="tip-index">03</span>
          <h4>保持知到窗口打开</h4>
          <p>桥接执行的所有请求都发生在知到窗口内；关闭窗口后需要重新连接。</p>
        </div>
      </div>
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
      const ref = input?.value.trim() ?? "";
      if (ref) handlers.onAddCourse(ref);
      return;
    }
    const card = target.closest<HTMLElement>("[data-course-id]");
    if (card) handlers.onSelect(card.dataset.courseId ?? "");
  };
}

export interface ZhsCourseHandlers {
  busy: boolean;
  onBack(): void;
  onRefresh(): void;
  onWatch(): void;
  onMeet(): void;
}

/** Shared-course video tree with the "秒刷本课视频" entry point. */
export function renderZhsCourse(main: HTMLElement, detail: ZhsCourseDetail, handlers: ZhsCourseHandlers): void {
  main.onchange = null;
  main.onclick = null;
  const course = detail.course;
  const videos = totalVideos(detail);
  const completed = completedVideos(detail);
  const percent = formatPercent(completed, videos);
  const lessons = detail.chapters.reduce((total, chapter) => total + chapter.lessons.length, 0);

  main.innerHTML = `
    <div class="course-view">
      <header class="course-head">
        <div class="course-head-copy">
          <div class="eyebrow">知到共享课 · recruit ${esc(String(course.recruit_id))}</div>
          <h1>${esc(courseLabel(course))}</h1>
          <p class="course-sub">${esc(course.teacher || "教师未知")} · 课程 ${esc(String(course.course_id))} · ${detail.chapters.length} 章 ${lessons} 节</p>
        </div>
        <div class="head-actions">
          <button class="icon-button" data-action="back" title="返回课程列表" aria-label="返回课程列表">${icon("folder", 16)}</button>
          <button class="icon-button" data-action="refresh" title="重新抓取" aria-label="重新抓取">${icon("refresh", 16)}</button>
          <button class="btn btn-ghost" data-action="meet">${icon("live", 15)} 见面课</button>
          <button class="btn btn-primary" data-action="watch">${icon("play", 15)} 秒刷本课视频</button>
        </div>
      </header>

      ${
        handlers.busy
          ? `<div class="crawl-banner"><div class="crawl-banner-row">${spinnerMarkup()}<span class="crawl-progress-label">正在重新抓取视频树…</span></div></div>`
          : ""
      }

      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 秒刷属于最高风险形态：视频上报会让平台把课程标记为已完成。默认仅试运行，确认风险后才会真正发送。
      </div>

      <div class="stat-strip">
        <div class="stat-card stat-card-wide">
          <div class="stat-head"><span>视频完成度</span><strong>${completed} / ${videos}</strong></div>
          <div class="progress"><div class="progress-fill fill-good" style="width:${percent}%"></div></div>
          <div class="stat-foot">${percent}% 的小节视频已被平台标记完成</div>
        </div>
        <div class="stat-card"><span class="stat-label">章节</span><strong>${detail.chapters.length}</strong><span class="stat-foot">${lessons} 节课</span></div>
        <div class="stat-card"><span class="stat-label">视频</span><strong>${videos}</strong><span class="stat-foot">按小节统计</span></div>
        <div class="stat-card"><span class="stat-label">已完成</span><strong>${completed}</strong><span class="stat-foot">watchState=1</span></div>
      </div>

      ${
        videos === 0
          ? `<div class="empty-panel compact"><div class="empty-icon">${icon("video", 24)}</div><h2>没有可用的视频小节</h2><p>平台可能返回了空视频树，或该课程属于暂不支持的课程类型。</p></div>`
          : `<div class="tree">${detail.chapters.map((chapter, chapterIndex) => renderChapter(chapter, chapterIndex)).join("")}</div>`
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
    if (target.closest("[data-action='meet']")) {
      handlers.onMeet();
      return;
    }
    if (target.closest("[data-action='watch']")) handlers.onWatch();
  };
}

function spinnerMarkup(): string {
  return `<span class="spinner spinner-sm"></span>`;
}

function renderChapter(chapter: ZhsCourseDetail["chapters"][number], index: number): string {
  const videos = chapter.lessons.reduce((total, lesson) => total + (lesson.videos.length || (lesson.video_id ? 1 : 0)), 0);
  return `
    <details class="tree-node"${index === 0 ? " open" : ""}>
      <summary class="tree-summary">
        <span class="tree-kind">${icon("folder", 16)}</span>
        <span class="tree-title">${esc(chapter.name)}</span>
        <span class="tree-count">${chapter.lessons.length} 节 · ${videos} 个视频</span>
        <span class="tree-chevron">${icon("chevron", 14)}</span>
      </summary>
      <div class="tree-body">
        ${chapter.lessons.map((lesson) => `
          <div class="zhs-lesson">
            <div class="zhs-lesson-head">
              <span class="tree-title">${esc(lesson.name)}</span>
              <span class="tree-count">${lesson.videos.length} 个小节</span>
            </div>
            <div class="task-rows">
              ${
                lesson.videos.length
                  ? lesson.videos.map((video, videoIndex) => `
                      <div class="task-row kind-video${(video.is_studied ?? 0) !== 0 ? " is-done" : ""}">
                        <span class="task-kind">${icon("video", 17)}</span>
                        <div class="task-copy">
                          <div class="task-name">${esc(video.name || `${lesson.name} · 小节 ${videoIndex + 1}`)}</div>
                          <div class="task-meta">${esc(formatDuration(video.video_sec))} · videoId ${esc(String(video.video_id))} · lessonVideoId ${esc(String(video.lesson_video_id))}</div>
                        </div>
                        <div class="task-actions">
                          ${
                            (video.is_studied ?? 0) !== 0
                              ? `<span class="badge badge-good">${icon("check", 12)} 已完成</span>`
                              : `<span class="badge badge-muted">未完成</span>`
                          }
                        </div>
                      </div>
                    `).join("")
                  : `<div class="empty-inline">该节没有视频小节</div>`
              }
            </div>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

export interface ZhsWatchModalOptions {
  courseId: string;
  courseName: string;
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
        对每个未完成的小节调用 <code>prelearningNote</code> 取 noteId，再提交
        <code>saveDatabaseIntervalTimeV2</code>，并用 <code>queryStuyInfo</code> 复核 <code>watchState=1</code>。
        试运行只在本地生成 <code>sdsew</code>/<code>ewssw</code>，不会发送。
      </p>
      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 秒刷视频属于最高风险形态。真实执行前请确认你理解账号风控风险。
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
      <button class="btn btn-ghost" id="zhs-watch-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="zhs-watch-start">${icon("play", 15)} 开始</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#zhs-watch-status", content);
  const countText = qs<HTMLElement>("#zhs-watch-count", content);
  const fill = qs<HTMLElement>("#zhs-watch-fill", content);
  const log = qs<HTMLElement>("#zhs-watch-log", content);
  const startButton = qs<HTMLButtonElement>("#zhs-watch-start", content);
  const stopButton = qs<HTMLButtonElement>("#zhs-watch-stop", content);
  const maxInput = qs<HTMLInputElement>("#zhs-watch-max", content);
  const includeInput = qs<HTMLInputElement>("#zhs-watch-include", content);
  const verifyInput = qs<HTMLInputElement>("#zhs-watch-verify", content);
  const dryInput = qs<HTMLInputElement>("#zhs-watch-dry", content);
  const confirmInput = qs<HTMLInputElement>("#zhs-watch-confirm", content);

  dryInput.addEventListener("change", () => {
    confirmInput.disabled = dryInput.checked;
    if (dryInput.checked) confirmInput.checked = false;
  });
  confirmInput.disabled = dryInput.checked;

  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let targetTotal = 0;
  const rows = new Map<number, HTMLElement>();

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
    for (const input of [maxInput, includeInput, verifyInput, dryInput]) input.disabled = busy;
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

  const applyVideo = (progress: Extract<ZhsJobProgress, { kind: "zhs-video" }>) => {
    let row = rows.get(progress.index);
    if (!row) row = addRow(progress.index, progress.label);
    const chip = row.querySelector<HTMLElement>(".status-chip");
    if (chip) {
      chip.className = `status-chip ${STATUS_TONE[progress.status] ?? ""}`;
      chip.innerHTML = `${progress.status === "running" ? icon("clock", 12) : icon("check", 12)} ${
        STATUS_TEXT[progress.status] ?? progress.status
      }`;
    }
    const detail = row.querySelector<HTMLElement>(".watch-row-detail");
    if (detail) {
      detail.textContent = progress.message ?? "";
      if (progress.message) {
        const pre = document.createElement("pre");
        pre.textContent = progress.message;
        detail.textContent = "";
        detail.appendChild(pre);
      }
    }
    row.classList.toggle("is-passed", progress.status === "ok");
    setProgress(progress.status === "running" ? progress.index - 1 : progress.index, targetTotal);
    if (progress.status === "running") statusText.textContent = `正在处理：${progress.label}`;
  };

  const handleProgress = (progress: ZhsJobProgress) => {
    if (closed) return;
    if (progress.kind === "zhs-crawl") {
      if (progress.total > 0) setProgress(progress.done, progress.total);
      return;
    }
    if (progress.kind === "zhs-plan") {
      targetTotal = progress.total;
      rows.clear();
      log.innerHTML = "";
      setProgress(0, progress.total);
      statusText.textContent = progress.total === 0
        ? "没有需要处理的视频"
        : progress.dryRun
          ? `试运行：将为 ${progress.total} 个视频生成上报字段`
          : `准备上报 ${progress.total} 个视频`;
      return;
    }
    if (progress.kind === "zhs-video") applyVideo(progress);
  };

  const finish = (summary: ZhsWatchSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    if (summary.cancelled) {
      statusText.textContent = "已取消";
      options.onToast("已取消视频秒刷", "info");
    } else if (summary.dryRun) {
      statusText.textContent = `试运行完成：${summary.total} 个视频计划已生成，未发送`;
      options.onToast("试运行完成，没有发送视频上报", "success");
    } else if (summary.failed === 0 && summary.ok > 0) {
      statusText.textContent = `完成：${summary.ok} 个已确认，${summary.skipped} 个跳过`;
      options.onToast(`已完成 ${summary.ok} 个视频`, "success");
    } else {
      statusText.textContent = `完成：${summary.ok} 个成功 · ${summary.failed} 个失败`;
      options.onToast(`${summary.ok} 个成功，${summary.failed} 个失败，详见日志`, summary.failed ? "error" : "info");
    }
    if (summary.errors.length) {
      const block = document.createElement("div");
      block.className = "watch-error";
      block.textContent = summary.errors.join("\n");
      log.appendChild(block);
    }
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
    setRunningUi(true);
    statusText.textContent = "正在抓取视频树…";
    setProgress(0, 0);

    unlisten = await onZhsProgress(handleProgress);
    if (closed) {
      unlisten?.();
      unlisten = null;
      return;
    }
    try {
      const summary = await zhsApi.watchVideos({
        course: options.courseId,
        includeCompleted: includeInput.checked,
        maxVideos: maxInput.value ? Math.max(1, Number(maxInput.value)) : null,
        verify: verifyInput.checked,
        dryRun: dryInput.checked,
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
