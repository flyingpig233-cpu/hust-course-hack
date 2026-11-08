import { onUlProgress, ulApi } from "../api";
import { errorText, esc, openModal, qs } from "../dom";
import type { ToastTone } from "../dom";
import { formatPercent } from "../format";
import { icon } from "../icons";
import type {
  UlCourse,
  UlCourseDetail,
  UlJobProgress,
  UlSessionInfo,
  UlWatchSummary,
} from "../core/ul/types";
import { ulCourseLabel } from "../core/ul/types";

const STATUS_TEXT: Record<string, string> = {
  running: "处理中",
  ok: "已确认",
  skip: "已跳过",
  dry_run: "已计划",
  failed: "失败",
};

const STATUS_TONE: Record<string, string> = {
  running: "is-running",
  ok: "is-good",
  skip: "is-muted",
  dry_run: "is-muted",
  failed: "is-bad",
};

const PAGE_TYPE_LABEL: Record<number, string> = {
  5: "图文",
  6: "视频",
  7: "练习",
};

export interface UlHomeHandlers {
  onSelect(courseId: string): void;
  onRefreshCourses(): void;
  onAddCourse(ref: string): void;
}

/** Ulearning course list plus the player-URL/textbook+class fallback. */
export function renderUlHome(
  main: HTMLElement,
  session: UlSessionInfo,
  courses: UlCourse[],
  handlers: UlHomeHandlers,
): void {
  main.onchange = null;
  main.innerHTML = `
    <section class="home-view">
      <header class="home-head">
        <div>
          <div class="eyebrow">已连接 优学院</div>
          <h1>添加一门优学院课程</h1>
          <p class="home-sub">${courses.length} 门课程 · ${esc(session.source)}</p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-refresh>${icon("refresh", 15)} 刷新课程</button>
        </div>
      </header>

      <div class="zhs-add-course">
        <div class="zhs-add-copy">
          <strong>粘贴播放器链接，或填写 textbookId/classId</strong>
          <p>例如 <code>https://ua.ulearning.cn/learnCourse/learnCourse.html?courseId=47353&amp;classId=1019700</code>，也可以直接输入 <code>47353/1019700</code>。</p>
        </div>
        <div class="zhs-add-row">
          <input id="ul-course-ref" type="text" spellcheck="false" autocomplete="off"
            placeholder="播放器链接 或 47353/1019700" />
          <button class="btn" data-add-course>${icon("link", 15)} 添加课程</button>
        </div>
      </div>

      ${
        courses.length
          ? `<div class="course-grid">${courses
              .map((course, index) => {
                const initial = [...course.name.trim()][0] ?? "课";
                return `
                  <button class="course-card" data-ul-course="${esc(String(course.textbook_id))}" style="--delay:${index * 30}ms">
                    <div class="course-card-top">
                      <span class="course-avatar course-avatar-lg tone-${index % 5}">${esc(initial)}</span>
                      <span class="course-code">textbook ${esc(String(course.textbook_id))}</span>
                    </div>
                    <h3>${esc(ulCourseLabel(course))}</h3>
                    <p class="course-card-meta">${esc(course.teacher || "优学院课程")} · 班级 ${esc(String(course.class_id))}</p>
                    <span class="course-card-cta">查看章 / 节 / 页 ${icon("chevron", 14)}</span>
                  </button>
                `;
              })
              .join("")}</div>`
          : `<div class="empty-panel">
              <div class="empty-icon">${icon("folder", 26)}</div>
              <h2>还没有添加课程</h2>
              <p>优学院没有稳定的“学生课程列表”接口，请从播放器地址栏复制链接后粘贴到上方。</p>
            </div>`
      }

      <div class="tip-grid">
        <div class="tip-card">
          <span class="tip-index">01</span>
          <h4>默认只刷视频节</h4>
          <p>含章节练习的节默认跳过；勾选“同时处理章节练习”后会通过 questionAnswer 取平台答案再提交。</p>
        </div>
        <div class="tip-card">
          <span class="tip-index">02</span>
          <h4>默认试运行</h4>
          <p>dry-run 只读取课程树并生成将发送的 payload 摘要，不发送 sync 请求。</p>
        </div>
        <div class="tip-card">
          <span class="tip-index">03</span>
          <h4>返回 2 立即停止</h4>
          <p>服务端返回 1=已保存、2=判定刷分并终止学习；回包出现 2 时整批立即停止。</p>
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
      const input = main.querySelector<HTMLInputElement>("#ul-course-ref");
      const ref = input?.value.trim() ?? "";
      if (ref) handlers.onAddCourse(ref);
      return;
    }
    const card = target.closest<HTMLElement>("[data-ul-course]");
    if (card) handlers.onSelect(card.dataset.ulCourse ?? "");
  };
}

export interface UlCourseHandlers {
  busy: boolean;
  onBack(): void;
  onRefresh(): void;
  onWatch(): void;
  onOpenPlayer(): void;
}

/** Chapter / section / page tree with the "秒刷本课视频" entry point. */
export function renderUlCourse(main: HTMLElement, detail: UlCourseDetail, handlers: UlCourseHandlers): void {
  main.onchange = null;
  main.onclick = null;
  const course = detail.course;
  const sections = detail.chapters.flatMap((chapter) => chapter.sections);
  const completed = sections.filter((section) => section.completion_status === 1).length;
  const videos = sections.reduce(
    (sum, section) => sum + section.pages.filter((page) => page.content_type === 6).length,
    0,
  );
  const quizzes = sections.reduce(
    (sum, section) => sum + section.pages.filter((page) => page.content_type === 7).length,
    0,
  );

  main.innerHTML = `
    <div class="course-view">
      <header class="course-head">
        <div class="course-head-copy">
          <div class="eyebrow">优学院 · textbook ${esc(String(course.textbook_id))} · class ${esc(String(course.class_id))}</div>
          <h1>${esc(ulCourseLabel(course))}</h1>
          <p class="course-sub">${esc(course.teacher || "教师未知")} · ${detail.chapters.length} 章 ${sections.length} 节${
            course.expired === true ? " · 课程已过期" : ""
          }</p>
        </div>
        <div class="head-actions">
          <button class="icon-button" data-action="back" title="返回课程列表" aria-label="返回课程列表">${icon("folder", 16)}</button>
          <button class="icon-button" data-action="refresh" title="重新抓取" aria-label="重新抓取">${icon("refresh", 16)}</button>
          <button class="icon-button" data-action="open" title="打开优学院播放器" aria-label="打开优学院播放器">${icon("external", 16)}</button>
          <button class="btn btn-primary" data-action="watch">${icon("play", 15)} 秒刷本课视频</button>
        </div>
      </header>

      ${
        handlers.busy
          ? `<div class="crawl-banner"><div class="crawl-banner-row"><span class="spinner spinner-sm"></span><span class="crawl-progress-label">正在重新抓取课程树…</span></div></div>`
          : ""
      }

      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 优学院把“完成”交给前端计算后上报；秒刷属于最高风险形态。默认 dry-run，真实执行需勾选风险确认，且默认只处理纯视频/图文节。
      </div>

      <div class="stat-strip">
        <div class="stat-card stat-card-wide">
          <div class="stat-head"><span>节完成度</span><strong>${completed} / ${sections.length}</strong></div>
          <div class="progress"><div class="progress-fill fill-good" style="width:${formatPercent(completed, sections.length)}%"></div></div>
          <div class="stat-foot">${formatPercent(completed, sections.length)}% 的节被平台标记为完成</div>
        </div>
        <div class="stat-card"><span class="stat-label">章节</span><strong>${detail.chapters.length}</strong><span class="stat-foot">${sections.length} 节</span></div>
        <div class="stat-card"><span class="stat-label">视频页</span><strong>${videos}</strong><span class="stat-foot">contentType=6</span></div>
        <div class="stat-card"><span class="stat-label">练习页</span><strong>${quizzes}</strong><span class="stat-foot">contentType=7</span></div>
      </div>

      ${
        sections.length === 0
          ? `<div class="empty-panel compact"><div class="empty-icon">${icon("folder", 24)}</div><h2>目录为空</h2><p>平台没有返回章 / 节 / 页数据，或该课程已过期。</p></div>`
          : `<div class="tree">${detail.chapters.map((chapter, index) => renderChapter(chapter, index)).join("")}</div>`
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
    if (target.closest("[data-action='open']")) {
      handlers.onOpenPlayer();
      return;
    }
    if (target.closest("[data-action='watch']")) handlers.onWatch();
  };
}

function renderChapter(chapter: UlCourseDetail["chapters"][number], index: number): string {
  const completed = chapter.sections.filter((section) => section.completion_status === 1).length;
  return `
    <details class="tree-node"${index === 0 ? " open" : ""}>
      <summary class="tree-summary">
        <span class="tree-kind">${icon("folder", 16)}</span>
        <span class="tree-title">${esc(chapter.name)}</span>
        <span class="tree-count">${chapter.sections.length} 节 · ${completed} 已完成</span>
        <span class="tree-chevron">${icon("chevron", 14)}</span>
      </summary>
      <div class="tree-body">
        ${chapter.sections.map((section) => renderSection(section)).join("")}
      </div>
    </details>
  `;
}

function renderSection(section: UlCourseDetail["chapters"][number]["sections"][number]): string {
  const done = section.completion_status === 1;
  const pages = section.pages;
  const hasQuiz = pages.some((page) => page.content_type === 7);
  const meta = pages.length
    ? pages.map((page) => PAGE_TYPE_LABEL[page.content_type] ?? `类型 ${page.content_type}`).join(" · ")
    : "页面待抓取";
  return `
    <div class="zhs-lesson">
      <div class="zhs-lesson-head">
        <span class="tree-title">${esc(section.name)}</span>
        <span class="tree-count">
          ${done ? `<span class="badge badge-good">${icon("check", 12)} 已完成</span>` : `<span class="badge badge-muted">未完成</span>`}
          ${hasQuiz ? `<span class="badge badge-warn">含练习</span>` : ""}
        </span>
      </div>
      <div class="task-rows">
        <div class="task-row kind-video${done ? " is-done" : ""}">
          <span class="task-kind">${icon(hasQuiz ? "work" : "video", 17)}</span>
          <div class="task-copy">
            <div class="task-name">${esc(meta)}</div>
            <div class="task-meta">sectionId ${esc(String(section.section_id))}${
              section.video_secs ? ` · ${Math.round(section.video_secs / 60)} 分钟` : ""
            }</div>
          </div>
          <div class="task-actions">
            ${done
              ? `<span class="badge badge-good">${icon("check", 12)} completion_status=1</span>`
              : `<span class="badge badge-muted">completion_status=${section.completion_status ?? "未知"}</span>`}
          </div>
        </div>
      </div>
    </div>
  `;
}

export interface UlWatchModalOptions {
  courseRef: string;
  courseName: string;
  onToast(message: string, tone?: ToastTone): void;
  onFinished(summary: UlWatchSummary): void;
}

/** Video/watch dialog: dry-run by default, risk confirmation for real runs. */
export function openUlWatchModal(options: UlWatchModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="eyebrow">优学院 · 课件</div>
        <h2>秒刷本课视频</h2>
        <p class="modal-sub">${esc(options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      <p class="modal-lead">
        读取章 / 节 / 页目录与每节 completion_status，按实测 payload 构造
        <code>ItemStudyRecordUpdateDTO</code>，DES-ECB 加密后提交
        <code>/yws/api/personal/sync</code>，并用 <code>studyrecord/item</code> 复核。
        试运行只生成摘要，不发送 sync。
      </p>
      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 秒刷课件属于高风险操作，服务端可能返回 2 判定刷分并终止学习。真实执行前请确认你理解风险。
      </div>
      <div class="settings-grid">
        <label class="field">
          <span>最多处理节数</span>
          <input id="ul-watch-max" type="number" min="1" step="1" placeholder="不限" />
          <em>先跑一个小批量</em>
        </label>
        <label class="field">
          <span>最小间隔（毫秒）</span>
          <input id="ul-delay-min" type="number" min="0" step="100" value="3000" />
        </label>
        <label class="field">
          <span>最大间隔（毫秒）</span>
          <input id="ul-delay-max" type="number" min="0" step="100" value="5000" />
        </label>
        <label class="check switch-row">
          <input id="ul-watch-quizzes" type="checkbox" />
          <span>同时处理章节练习（用平台 questionAnswer 作答）</span>
        </label>
        <label class="check switch-row">
          <input id="ul-watch-verify" type="checkbox" checked />
          <span>提交后复核 completion_status</span>
        </label>
        <label class="check switch-row">
          <input id="ul-watch-stop" type="checkbox" checked />
          <span>失败即停（服务端返回 2 时总会停止）</span>
        </label>
        <label class="check switch-row">
          <input id="ul-watch-dry" type="checkbox" checked />
          <span>试运行，只生成上报摘要</span>
        </label>
        <label class="check switch-row risk-confirm">
          <input id="ul-watch-confirm" type="checkbox" />
          <span>我确认已了解风险，按平台协议真实提交学习记录</span>
        </label>
      </div>

      <div class="watch-progress" id="ul-watch-progress">
        <div class="watch-status-row">
          <span id="ul-watch-status">准备就绪</span>
          <span id="ul-watch-count" class="watch-count"></span>
        </div>
        <div class="progress"><div class="progress-fill" id="ul-watch-fill" style="width:0%"></div></div>
        <div class="watch-log" id="ul-watch-log"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="ul-watch-stop-btn" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="ul-watch-start">${icon("play", 15)} 开始</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#ul-watch-status", content);
  const countText = qs<HTMLElement>("#ul-watch-count", content);
  const fill = qs<HTMLElement>("#ul-watch-fill", content);
  const log = qs<HTMLElement>("#ul-watch-log", content);
  const startButton = qs<HTMLButtonElement>("#ul-watch-start", content);
  const stopButton = qs<HTMLButtonElement>("#ul-watch-stop-btn", content);
  const maxInput = qs<HTMLInputElement>("#ul-watch-max", content);
  const delayMinInput = qs<HTMLInputElement>("#ul-delay-min", content);
  const delayMaxInput = qs<HTMLInputElement>("#ul-delay-max", content);
  const quizzesInput = qs<HTMLInputElement>("#ul-watch-quizzes", content);
  const verifyInput = qs<HTMLInputElement>("#ul-watch-verify", content);
  const stopInput = qs<HTMLInputElement>("#ul-watch-stop", content);
  const dryInput = qs<HTMLInputElement>("#ul-watch-dry", content);
  const confirmInput = qs<HTMLInputElement>("#ul-watch-confirm", content);

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
      if (running) void ulApi.cancelJob().catch(() => undefined);
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
    for (const input of [maxInput, delayMinInput, delayMaxInput, quizzesInput, verifyInput, stopInput, dryInput]) {
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

  const applySection = (progress: Extract<UlJobProgress, { kind: "ul-section" }>) => {
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
      detail.innerHTML = "";
      if (progress.message) {
        const pre = document.createElement("pre");
        pre.textContent = progress.message;
        detail.appendChild(pre);
      }
    }
    row.classList.toggle("is-passed", progress.status === "ok");
    setProgress(progress.status === "running" ? progress.index - 1 : progress.index, targetTotal);
    if (progress.status === "running") statusText.textContent = `正在处理：${progress.label}`;
  };

  const appendCircuit = (message: string) => {
    const block = document.createElement("div");
    block.className = "watch-error";
    block.textContent = message;
    log.appendChild(block);
  };

  const handleProgress = (progress: UlJobProgress) => {
    if (closed) return;
    if (progress.kind === "ul-crawl") {
      if (progress.total > 1) setProgress(progress.done, progress.total);
      statusText.textContent = progress.label ? `正在加载：${progress.label}` : "正在加载课程树…";
      return;
    }
    if (progress.kind === "ul-plan") {
      targetTotal = progress.total;
      rows.clear();
      log.innerHTML = "";
      setProgress(0, progress.total);
      statusText.textContent = progress.total === 0
        ? "没有需要处理的节"
        : progress.dryRun
          ? `试运行：${progress.total} 节 / ${progress.videos} 个视频 / ${progress.quizzes} 个练习页`
          : `准备提交 ${progress.total} 节（${progress.videos} 个视频）`;
      return;
    }
    if (progress.kind === "ul-section") {
      applySection(progress);
      return;
    }
    if (progress.kind === "ul-circuit") {
      appendCircuit(`风控熔断：${progress.message}`);
      statusText.textContent = "服务端判定刷分，已停止";
    }
  };

  const finish = (summary: UlWatchSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    if (summary.cancelled) {
      statusText.textContent = "已取消";
      options.onToast("已取消优学院秒刷", "info");
    } else if (summary.dryRun) {
      statusText.textContent = `试运行完成：${summary.total} 节计划已生成，未发送 sync`;
      options.onToast("试运行完成，没有发送学习记录", "success");
    } else if (summary.failed === 0 && summary.ok > 0) {
      statusText.textContent = `完成：${summary.ok} 节已确认，${summary.skipped} 节跳过`;
      options.onToast(`已完成 ${summary.ok} 节`, "success");
    } else {
      statusText.textContent = `完成：${summary.ok} 节成功 · ${summary.failed} 节失败`;
      options.onToast(`${summary.ok} 节成功，${summary.failed} 节失败，详见日志`, summary.failed ? "error" : "info");
    }
    if (summary.errors.length) appendCircuit(summary.errors.join("\n"));
    if (!summary.cancelled) setProgress(targetTotal, targetTotal);
    options.onFinished(summary);
  };

  startButton.addEventListener("click", async () => {
    if (running) return;
    if (!dryInput.checked && !confirmInput.checked) {
      options.onToast("真实执行前必须勾选风险确认", "error");
      return;
    }
    const delayMin = Math.max(0, Number(delayMinInput.value) || 0);
    const delayMax = Math.max(delayMin, Number(delayMaxInput.value) || 0);
    running = true;
    rows.clear();
    log.innerHTML = "";
    setRunningUi(true);
    statusText.textContent = "正在读取课程树…";
    setProgress(0, 0);

    unlisten = await onUlProgress(handleProgress);
    if (closed) {
      unlisten?.();
      unlisten = null;
      return;
    }
    try {
      const summary = await ulApi.watchSections({
        course: options.courseRef,
        dryRun: dryInput.checked,
        includeQuizzes: quizzesInput.checked,
        maxSections: maxInput.value ? Math.max(1, Number(maxInput.value)) : null,
        delayMinMs: delayMin,
        delayMaxMs: delayMax,
        verify: verifyInput.checked,
        stopOnError: stopInput.checked,
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
    void ulApi.cancelJob();
  });
}
