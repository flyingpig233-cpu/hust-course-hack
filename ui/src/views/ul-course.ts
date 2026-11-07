import { api, onJobProgress } from "../api";
import type { ToastTone } from "../dom";
import { copyText, errorText, esc, openModal, qs } from "../dom";
import { formatPercent } from "../format";
import { icon } from "../icons";
import type {
  JobProgress,
  SessionInfo,
  UlCheck,
  UlChapter,
  UlCourse,
  UlCourseDetail,
  UlSection,
  UlWatchSummary,
} from "../types";
import { courseHeadHtml, noticeHtml, statStripHtml } from "./course-shell";

const STATUS_TEXT: Record<string, string> = {
  ok: "已完成",
  skip: "已跳过",
  dry_run: "预演",
  failed: "失败",
  cancelled: "已取消",
  circuit_broken: "已熔断",
};

const STATUS_TONE: Record<string, string> = {
  ok: "is-good",
  skip: "is-muted",
  dry_run: "is-muted",
  failed: "is-bad",
  cancelled: "is-muted",
  circuit_broken: "is-bad",
};

const ACTION_TEXT: Record<string, string> = {
  complete: "可刷",
  complete_practice: "可刷（含练习）",
  skip_done: "已完成",
  skip_unsupported: "跳过（不支持）",
  skip_expired: "跳过（过期）",
};

const PAGE_KIND_TEXT: Record<string, string> = {
  video: "视频",
  practice: "练习",
  document: "图文",
};

const PAGE_KIND_ICON = {
  video: "video",
  practice: "work",
  document: "document",
} as const;

/** Short human-readable course label. */
export function ulCourseLabel(course: UlCourse): string {
  const name = course.name.trim();
  return name || `课程 ${course.textbookId}`;
}

function sectionCount(chapters: UlChapter[]): number {
  return chapters.reduce((total, chapter) => total + chapter.sections.length, 0);
}

function pageCounts(chapters: UlChapter[]): {
  video: number;
  practice: number;
  document: number;
} {
  const counts = { video: 0, practice: 0, document: 0 };
  for (const chapter of chapters) {
    for (const section of chapter.sections) {
      const sectionCounts = sectionPageCounts(section);
      counts.video += sectionCounts.video;
      counts.practice += sectionCounts.practice;
      counts.document += sectionCounts.document;
    }
  }
  return counts;
}

function sectionPageCounts(section: UlSection): {
  video: number;
  practice: number;
  document: number;
} {
  const counts = { video: 0, practice: 0, document: 0 };
  for (const page of section.pages) counts[page.kind] += 1;
  return counts;
}

export interface UlHomeHandlers {
  onSelect(courseId: string): void;
  onRefreshCourses(): void;
  onAddCourse(reference: string): void;
}

/** Course list for the Ulearning platform, plus the player-URL fallback. */
export function renderUlHome(
  main: HTMLElement,
  session: SessionInfo,
  courses: UlCourse[],
  handlers: UlHomeHandlers,
): void {
  main.onchange = null;
  main.innerHTML = `
    <section class="home-view">
      <header class="home-head">
        <div>
          <div class="eyebrow">已连接 优学院（U学）</div>
          <h1>选择一门课程开始</h1>
          <p class="home-sub">
            当前账号共 ${courses.length} 门课程 ·
            ${esc(session.cookieSource)} · 会话包含 ${session.cookieCount} 项 Cookie
          </p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-refresh>${icon("refresh", 15)} 刷新课程</button>
        </div>
      </header>

      <div class="zhs-add-course">
        <div class="zhs-add-copy">
          <strong>课程列表接口不可用？</strong>
          <p>把优学院播放器链接（含 <code>courseId</code> / <code>classId</code>）粘贴到这里，会解析后加入列表。</p>
        </div>
        <div class="zhs-add-row">
          <input id="ul-course-ref" type="text" spellcheck="false" autocomplete="off"
            placeholder="https://ua.ulearning.cn/learnCourse/learnCourse.html?courseId=47353&classId=1019700" />
          <button class="btn" data-add-course>${icon("link", 15)} 解析并添加</button>
        </div>
      </div>

      ${
        courses.length
          ? `<div class="course-grid">${courses
              .map((course, index) => {
                const initial = [...course.name.trim()][0] ?? "课";
                const remaining = course.remainingSecs ?? null;
                const foot =
                  remaining === null
                    ? "有效期未知"
                    : remaining < 0
                      ? "已过期"
                      : `剩余 ${Math.max(1, Math.round(remaining / 86400))} 天`;
                return `
                  <button class="course-card" data-course-id="${esc(
                    String(course.textbookId),
                  )}" style="--delay:${index * 30}ms">
                    <div class="course-card-top">
                      <span class="course-avatar course-avatar-lg tone-${index % 5}">${esc(
                        initial,
                      )}</span>
                      <span class="course-code">textbook ${esc(String(course.textbookId))}</span>
                    </div>
                    <h3>${esc(ulCourseLabel(course))}</h3>
                    <p class="course-card-meta">${esc(course.author || "优学院课程")} · ${esc(
                      foot,
                    )}</p>
                    <span class="course-card-cta">查看课程目录 ${icon("chevron", 14)}</span>
                  </button>
                `;
              })
              .join("")}</div>`
          : `<div class="empty-panel">
              <div class="empty-icon">${icon("folder", 26)}</div>
              <h2>没有解析到优学院课程</h2>
              <p>课程列表接口未返回数据，可稍后刷新，或粘贴播放器链接手动添加。课程过期后将拒绝执行。</p>
              <button class="btn" data-refresh>${icon("refresh", 15)} 刷新课程列表</button>
            </div>`
      }

      <div class="tip-grid">
        <div class="tip-card">
          <span class="tip-index">01</span>
          <h4>先检查再秒刷</h4>
          <p>打开课程后可先“检查完成状态”，读取每节 <code>completion_status</code>，再做决定。</p>
        </div>
        <div class="tip-card">
          <span class="tip-index">02</span>
          <h4>默认试运行</h4>
          <p>秒刷弹窗默认 dry-run，只生成计划与条目；真实执行需要勾选风险确认。</p>
        </div>
        <div class="tip-card">
          <span class="tip-index">03</span>
          <h4>限速与熔断</h4>
          <p>真实执行默认 3–5 秒间隔；服务端返回 2 会立即中止整批，界面不会伪造完成。</p>
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
      const reference = input?.value.trim() ?? "";
      if (reference) handlers.onAddCourse(reference);
      return;
    }
    const card = target.closest<HTMLElement>("[data-course-id]");
    if (card) handlers.onSelect(card.dataset.courseId ?? "");
  };
}

export function renderUlLoading(
  main: HTMLElement,
  course: UlCourse,
  onCancel: () => void,
): void {
  main.onchange = null;
  main.innerHTML = `
    <div class="course-view">
      ${courseHeadHtml({
        eyebrow: `优学院 · textbook ${course.textbookId}`,
        title: ulCourseLabel(course),
        subtitle: "正在读取课程目录。",
        actions: "",
      })}
      <div class="crawl-card">
        <div class="crawl-orb">${icon("refresh", 28)}</div>
        <h2>正在读取课程目录</h2>
        <p>优学院课程目录一次返回章 / 节 / 页结构，通常几秒内完成。</p>
        <div class="progress progress-lg">
          <div class="progress-fill ul-loading-fill" style="width: 0%"></div>
        </div>
        <div class="crawl-meta">
          <span class="ul-loading-label">正在请求目录接口…</span>
          <span class="ul-loading-count"></span>
        </div>
        <button class="btn btn-ghost" data-cancel>${icon("stop", 14)} 取消</button>
      </div>
    </div>
  `;
  main.onclick = (event) => {
    if ((event.target as HTMLElement).closest("[data-cancel]")) onCancel();
  };
}

export function updateUlLoading(
  main: HTMLElement,
  done: number,
  total: number,
  label?: string,
): void {
  const fill = main.querySelector<HTMLElement>(".ul-loading-fill");
  if (fill) fill.style.width = `${formatPercent(done, total)}%`;
  const text = main.querySelector<HTMLElement>(".ul-loading-label");
  if (text && label) text.textContent = label;
  const count = main.querySelector<HTMLElement>(".ul-loading-count");
  if (count && total > 0) count.textContent = `${done} / ${total}`;
}

export function renderUlCourseError(
  main: HTMLElement,
  course: UlCourse,
  message: string,
  onRetry: () => void,
): void {
  main.onchange = null;
  main.innerHTML = `
    <div class="course-view">
      ${courseHeadHtml({
        eyebrow: `优学院 · textbook ${course.textbookId}`,
        title: ulCourseLabel(course),
        subtitle: "课程目录读取未完成",
        actions: "",
      })}
      <div class="error-card">
        <div class="error-icon">${icon("alert", 24)}</div>
        <h2>读取课程目录失败</h2>
        <pre class="error-detail">${esc(message)}</pre>
        <p class="hint">如果提示登录失效，请在连接页重新登录优学院。</p>
        <button class="btn btn-primary" data-retry>${icon("refresh", 15)} 重试</button>
      </div>
    </div>
  `;
  main.onclick = (event) => {
    if ((event.target as HTMLElement).closest("[data-retry]")) onRetry();
  };
}

export interface UlCourseHandlers {
  busy: boolean;
  checking: boolean;
  onBack(): void;
  onRefresh(): void;
  onCheck(): void;
  onWatch(): void;
}

/** Chapter / section / page tree with the completion entry points. */
export function renderUlCourse(
  main: HTMLElement,
  detail: UlCourseDetail,
  check: UlCheck | null,
  handlers: UlCourseHandlers,
): void {
  const course = detail.course;
  const chapters = check?.chapters ?? detail.chapters;
  const sections = check?.sectionCount ?? sectionCount(chapters);
  const counts = pageCounts(chapters);
  const completed = check?.completedSections ?? 0;
  const percent = formatPercent(completed, sections);
  const expired = check?.expired ?? detail.expired;
  const remaining = check?.remainingSecs ?? detail.remainingSecs;
  const remainingText =
    remaining === null
      ? "有效期未知"
      : remaining < 0
        ? "课程已过期"
        : `剩余约 ${Math.max(1, Math.round(remaining / 86400))} 天`;

  main.onchange = null;
  main.innerHTML = `
    <div class="course-view">
      ${courseHeadHtml({
        eyebrow: `优学院 · textbook ${course.textbookId}${
          course.ocId === null ? "" : ` · course ${course.ocId}`
        }`,
        title: ulCourseLabel(course),
        subtitle: `${detail.className ?? course.classId ?? "班级未知"} · ${
          course.author ?? "作者未知"
        } · ${remainingText} · ${chapters.length} 章 ${sections} 节`,
        actions: `
          <button class="icon-button" data-action="back" title="返回课程列表" aria-label="返回课程列表">${icon("folder", 16)}</button>
          <button class="icon-button" data-action="refresh" title="重新读取目录" aria-label="重新读取目录">${icon("refresh", 16)}</button>
          <button class="btn btn-ghost" data-action="check" ${handlers.busy ? "disabled" : ""}>${icon(
            "shield",
            15,
          )} 检查完成状态</button>
          <button class="btn btn-primary" data-action="watch" ${expired ? "disabled" : ""}>${icon(
            "play",
            15,
          )} 秒刷本课</button>
        `,
      })}

      ${
        handlers.checking
          ? `<div class="crawl-banner"><div class="crawl-banner-row"><span class="spinner spinner-sm"></span><span class="crawl-progress-label ul-check-label">正在读取每节完成状态…</span><span class="watch-count ul-check-count"></span></div><div class="progress"><div class="progress-fill ul-check-fill" style="width:0%"></div></div></div>`
          : handlers.busy
            ? `<div class="crawl-banner"><div class="crawl-banner-row"><span class="spinner spinner-sm"></span><span class="crawl-progress-label">正在读取课程目录…</span></div></div>`
            : ""
      }

      ${noticeHtml(
        "alert",
        `秒刷会按节提交课件完成记录：视频页与含答案的练习页都会处理，${
          expired ? "该课程已过期，已禁用执行；" : ""
        }默认仅试运行，确认真实执行前不会发送。`,
      )}

      ${statStripHtml([
        {
          label: "课件完成度",
          value: check ? `${completed} / ${sections}` : `— / ${sections}`,
          foot: check
            ? `${percent}% 的节已被平台标记完成（completion_status=1）`
            : "点击“检查完成状态”读取每节完成情况",
          wide: true,
          progress: percent,
        },
        { label: "章", value: String(chapters.length), foot: `${sections} 节` },
        { label: "视频页", value: String(counts.video) },
        { label: "练习页", value: String(counts.practice) },
      ])}

      ${
        sections === 0
          ? `<div class="empty-panel compact"><div class="empty-icon">${icon("folder", 24)}</div><h2>课程目录为空</h2><p>平台没有返回可用的章 / 节 / 页，可能该课程需要重新激活或没有权限。</p></div>`
          : `<div class="tree">${chapters
              .map((chapter, index) => renderChapter(chapter, index, check !== null))
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
    if (target.closest("[data-action='watch']")) handlers.onWatch();
  };
}

function renderChapter(
  chapter: UlChapter,
  index: number,
  checked: boolean,
): string {
  const pages = chapter.sections.reduce(
    (total, section) => total + section.pages.length,
    0,
  );
  return `
    <details class="tree-node"${index === 0 ? " open" : ""}>
      <summary class="tree-summary">
        <span class="tree-kind">${icon("folder", 16)}</span>
        <span class="tree-title">${esc(chapter.name)}</span>
        <span class="tree-count">${chapter.sections.length} 节 · ${pages} 页</span>
        <span class="tree-chevron">${icon("chevron", 14)}</span>
      </summary>
      <div class="tree-body">
        ${chapter.sections.map((section) => renderSection(section, checked)).join("")}
      </div>
    </details>
  `;
}

function renderSection(section: UlSection, checked: boolean): string {
  const counts = sectionPageCounts(section);
  const countText = [
    `${section.pages.length} 页`,
    counts.video > 0 ? `视频 ${counts.video}` : "",
    counts.practice > 0 ? `练习 ${counts.practice}` : "",
    counts.document > 0 ? `图文 ${counts.document}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const badge =
    section.completed === true
      ? `<span class="badge badge-good">${icon("check", 12)} 已完成</span>`
      : section.completed === false
        ? `<span class="badge badge-muted">未完成</span>`
        : checked
          ? `<span class="badge badge-muted">未查询</span>`
          : "";
  return `
    <div class="ul-section">
      <div class="ul-section-head">
        <span class="tree-title">${esc(section.name)}</span>
        <span class="tree-count">${esc(countText)}</span>
        ${badge}
      </div>
      <div class="task-rows">
        ${
          section.pages.length
            ? section.pages.map(renderPage).join("")
            : `<div class="empty-inline">该节没有页面</div>`
        }
      </div>
    </div>
  `;
}

function renderPage(page: UlSection["pages"][number]): string {
  const kind = page.kind;
  return `
    <div class="task-row kind-${kind}">
      <span class="task-kind">${icon(PAGE_KIND_ICON[kind], 17)}</span>
      <div class="task-copy">
        <div class="task-name">${esc(page.name || `页面 ${page.id}`)}</div>
        <div class="task-meta">${esc(PAGE_KIND_TEXT[kind])} · pageId ${esc(
          String(page.id),
        )} · relationId ${esc(String(page.relationId))}</div>
      </div>
      <div class="task-actions">
        <span class="badge badge-muted">${esc(PAGE_KIND_TEXT[kind])}</span>
      </div>
    </div>
  `;
}

export interface UlWatchModalOptions {
  courseId: string;
  courseName: string;
  /** Sections reported by the completion scan, when available. */
  sectionTotal: number;
  completedSections: number;
  onToast(message: string, tone?: ToastTone): void;
  onFinished(summary: UlWatchSummary): void;
}

/** Section completion dialog: dry-run by default, risk confirmation for real runs. */
export function openUlWatchModal(options: UlWatchModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="eyebrow">优学院 · 课件秒刷</div>
        <h2>秒刷本课</h2>
        <p class="modal-sub">${esc(options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      <p class="modal-lead">
        先读取章 / 节 / 页并跳过已完成的节，再对可处理的节提交
        <code>/yws/api/personal/sync</code> 完成记录（视频节与含答案的练习节）。试运行只在本地生成计划和 payload 摘要，不会发送。
      </p>
      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} 秒刷课件属于高风险操作。真实执行前请确认你理解账号风控与课程进度判定风险。
      </div>
      <div class="settings-grid">
        <label class="field">
          <span>最多处理节数</span>
          <input id="ul-watch-max" type="number" min="1" step="1" placeholder="不限" />
          <em>先跑一个小批量</em>
        </label>
        <label class="field">
          <span>最小间隔（毫秒）</span>
          <input id="ul-watch-delay-min" type="number" min="0" step="500" value="3000" />
        </label>
        <label class="field">
          <span>最大间隔（毫秒）</span>
          <input id="ul-watch-delay-max" type="number" min="0" step="500" value="5000" />
        </label>
        <label class="check switch-row">
          <input id="ul-watch-include" type="checkbox" />
          <span>重新提交已完成的节</span>
        </label>
        <label class="check switch-row">
          <input id="ul-watch-verify" type="checkbox" checked />
          <span>每节提交后复核 completion_status</span>
        </label>
        <label class="check switch-row">
          <input id="ul-watch-stop" type="checkbox" checked />
          <span>任一节失败即停止</span>
        </label>
        <label class="check switch-row">
          <input id="ul-watch-dry" type="checkbox" checked />
          <span>试运行，只生成计划</span>
        </label>
        <label class="check switch-row risk-confirm">
          <input id="ul-watch-confirm" type="checkbox" />
          <span>我确认已了解风险，按优学院协议真实提交课件完成记录</span>
        </label>
      </div>
      <div class="risk-summary" id="ul-watch-summary"></div>

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
      <button class="btn btn-ghost" id="ul-watch-copy" hidden>${icon("copy", 14)} 复制结果</button>
      <button class="btn btn-ghost" id="ul-watch-stop" hidden>${icon("stop", 14)} 停止</button>
      <button class="btn btn-ghost" data-close>关闭</button>
      <button class="btn btn-primary" id="ul-watch-start">${icon("play", 15)} 开始</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#ul-watch-status", content);
  const countText = qs<HTMLElement>("#ul-watch-count", content);
  const fill = qs<HTMLElement>("#ul-watch-fill", content);
  const log = qs<HTMLElement>("#ul-watch-log", content);
  const summaryText = qs<HTMLElement>("#ul-watch-summary", content);
  const startButton = qs<HTMLButtonElement>("#ul-watch-start", content);
  const stopButton = qs<HTMLButtonElement>("#ul-watch-stop", content);
  const copyButton = qs<HTMLButtonElement>("#ul-watch-copy", content);
  const maxInput = qs<HTMLInputElement>("#ul-watch-max", content);
  const delayMinInput = qs<HTMLInputElement>("#ul-watch-delay-min", content);
  const delayMaxInput = qs<HTMLInputElement>("#ul-watch-delay-max", content);
  const includeInput = qs<HTMLInputElement>("#ul-watch-include", content);
  const verifyInput = qs<HTMLInputElement>("#ul-watch-verify", content);
  const stopInput = qs<HTMLInputElement>("#ul-watch-stop", content);
  const dryInput = qs<HTMLInputElement>("#ul-watch-dry", content);
  const confirmInput = qs<HTMLInputElement>("#ul-watch-confirm", content);

  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let targetTotal = 0;
  let planActionable = 0;
  let planSkipped = 0;
  let resultLines: string[] = [];
  const rows = new Map<number, HTMLElement>();

  const planned = (): number => {
    const base = includeInput.checked
      ? options.sectionTotal
      : Math.max(0, options.sectionTotal - options.completedSections);
    const max = maxInput.value ? Math.max(1, Number(maxInput.value) || 1) : null;
    return max === null ? base : Math.min(base, max);
  };

  const syncSummary = () => {
    const count = planned();
    const delayMin = Math.max(0, Number(delayMinInput.value) || 0);
    const delayMax = Math.max(delayMin, Number(delayMaxInput.value) || 0);
    const scope = `共 ${options.sectionTotal} 节，已完成 ${options.completedSections} 节`;
    if (dryInput.checked) {
      summaryText.innerHTML = `${icon("spark", 13)} 试运行：将扫描并计划最多 <strong>${count}</strong> 节（${scope}），只生成计划与 payload 摘要，不发送任何请求。`;
      confirmInput.disabled = true;
      confirmInput.checked = false;
    } else {
      summaryText.innerHTML = `${icon("alert", 13)} 真实执行：将处理最多 <strong>${count}</strong> 节（${scope}），按 ${delayMin}–${delayMax} 毫秒随机间隔提交；服务端返回 2 会立即中止。`;
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
  delayMinInput.addEventListener("input", syncSummary);
  delayMaxInput.addEventListener("input", syncSummary);
  syncSummary();

  const close = openModal(content, {
    wide: true,
    onClose: () => {
      closed = true;
      unlisten?.();
      unlisten = null;
      if (running) void api.ulCancelJob().catch(() => undefined);
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
    for (const input of [
      maxInput,
      delayMinInput,
      delayMaxInput,
      includeInput,
      verifyInput,
      stopInput,
      dryInput,
    ]) {
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
      chip.innerHTML = `${status === "ok" ? icon("check", 12) : icon("clock", 12)} ${
        STATUS_TEXT[status] ?? status
      }`;
    }
    const detail = row.querySelector<HTMLElement>(".watch-row-detail");
    if (detail) detail.textContent = message ?? "";
    row.classList.toggle("is-passed", status === "ok");
    setProgress(index, targetTotal);
    if (status === "ok" || status === "dry_run") {
      statusText.textContent = `已完成：${label}`;
    }
  };

  const handleProgress = (progress: JobProgress) => {
    if (closed) return;
    if (progress.kind === "ulPlan") {
      if (progress.job !== "ul-watch") return;
      targetTotal = progress.total;
      planActionable = progress.actionable;
      planSkipped = progress.skipped;
      rows.clear();
      log.innerHTML = "";
      setProgress(0, progress.total);
      statusText.textContent =
        progress.total === 0
          ? "没有可处理的节"
          : progress.dryRun
            ? `试运行：${progress.total} 节中可处理 ${progress.actionable} 节（跳过 ${progress.skipped} 节）`
            : `准备处理 ${progress.actionable} / ${progress.total} 节`;
      return;
    }
    if (progress.kind === "ulStage") {
      if (progress.job !== "ul-watch") return;
      const stageText =
        progress.stage === "directory"
          ? "读取课程目录"
          : progress.stage === "plan"
            ? "生成计划"
            : progress.stage === "submit"
              ? "提交完成记录"
              : "复核完成状态";
      statusText.textContent = progress.label
        ? `${stageText}：${progress.label}`
        : `正在${stageText}…`;
      if (progress.total > 0) setProgress(progress.done, progress.total);
      return;
    }
    if (progress.kind === "ulTarget") {
      if (progress.job !== "ul-watch") return;
      applyTarget(progress.index, progress.label, progress.status, progress.message);
    }
  };

  const copyResults = async () => {
    if (resultLines.length === 0) return;
    const copied = await copyText(resultLines.join("\n"));
    options.onToast(
      copied ? "结果已复制" : "复制失败，请手动选择日志",
      copied ? "success" : "error",
    );
  };
  copyButton.addEventListener("click", () => void copyResults());

  const finish = (summary: UlWatchSummary) => {
    running = false;
    setRunningUi(false);
    startButton.hidden = true;
    stopButton.hidden = true;

    if (summary.cancelled) {
      statusText.textContent = "已取消";
      options.onToast("已取消课件秒刷", "info");
    } else if (summary.dryRun) {
      statusText.textContent =
        planActionable === 0
          ? `试运行完成：没有可处理的节（跳过 ${planSkipped} 节），未发送任何请求`
          : `试运行完成：${planActionable} 节可处理、${planSkipped} 节跳过（计划与 payload 摘要已生成，未发送）`;
      options.onToast("试运行完成，没有发送完成记录", "success");
    } else if (summary.failed === 0 && summary.ok > 0) {
      statusText.textContent = `完成：${summary.ok} 节成功，${summary.skipped} 节跳过`;
      options.onToast(`已完成 ${summary.ok} 节`, "success");
    } else {
      statusText.textContent = `完成：${summary.ok} 节成功 · ${summary.failed} 节失败 · ${summary.skipped} 节跳过`;
      options.onToast(
        `${summary.ok} 节成功，${summary.failed} 节失败，详见日志`,
        summary.failed > 0 ? "error" : "info",
      );
    }

    summary.outcomes.forEach((outcome, offset) => {
      const status = outcome.state === "circuit_broken" ? "failed" : outcome.state;
      if (!rows.has(offset + 1)) {
        applyTarget(
          offset + 1,
          outcome.label,
          status,
          `${ACTION_TEXT[outcome.action] ?? outcome.action} · ${outcome.message}`,
        );
      }
    });

    resultLines = summary.outcomes.map(
      (outcome) =>
        `[${STATUS_TEXT[outcome.state] ?? outcome.state}] ${outcome.label} · ${
          ACTION_TEXT[outcome.action] ?? outcome.action
        } · ${outcome.message}`,
    );
    if (summary.errors.length > 0) {
      resultLines.push("", ...summary.errors);
      const block = document.createElement("div");
      block.className = "watch-error";
      block.textContent = summary.errors.join("\n");
      log.appendChild(block);
    }
    copyButton.hidden = resultLines.length === 0;
    if (!summary.cancelled) {
      const barTotal = summary.dryRun ? planActionable : targetTotal;
      setProgress(barTotal, barTotal);
    }
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
    resultLines = [];
    copyButton.hidden = true;
    setRunningUi(true);
    syncSummary();
    statusText.textContent = "正在读取课程目录…";
    setProgress(0, 0);

    unlisten = await onJobProgress(handleProgress);
    if (closed) {
      unlisten?.();
      unlisten = null;
      return;
    }
    try {
      const summary = await api.ulWatch({
        course: options.courseId,
        dryRun: dryInput.checked,
        includeCompleted: includeInput.checked,
        maxSections: maxInput.value ? Math.max(1, Number(maxInput.value)) : null,
        delayMinMs: delayMin,
        delayMaxMs: delayMax,
        stopOnError: stopInput.checked,
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
        options.onToast("已取消课件秒刷", "info");
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
    void api.ulCancelJob();
  });
}
