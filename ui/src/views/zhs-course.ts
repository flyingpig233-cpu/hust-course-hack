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
              : `<span class="course-code">recruit ${esc(String(course.recruitId))}</span>`
          }
        </div>
        <h3>${esc(zhsCourseLabel(course))}</h3>
        <p class="course-card-meta">${esc(course.teacher || "知到课程")}${
          percent === null ? "" : ` · 进度 ${percent}%`
        }</p>
        <span class="course-card-cta">${
          readonly ? "查看信息" : "查看视频树"
        } ${icon("chevron", 14)}</span>
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

type ZhsWatchScope = "all" | "limit";

/**
 * Video completion dialog.
 *
 * Laid out as three numbered decisions — 范围 / 选项 / 模式 — because the
 * dry-run and the real run are the same plan but very different consequences.
 * Dry-run stays the default; the danger section and the confirmation checkbox
 * only appear (and only gate) the real path, and the primary button always says
 * which path it will take.
 */
export function openZhsWatchModal(options: ZhsWatchModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal zhs-watch-modal";
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
      <div class="watch-summary-strip">
        <div class="watch-summary-cell">
          <span>待处理</span>
          <strong id="zhs-sum-pending">0</strong>
        </div>
        <div class="watch-summary-cell">
          <span>已完成（平台记录）</span>
          <strong id="zhs-sum-done">${options.videoCompleted}</strong>
        </div>
        <div class="watch-summary-cell">
          <span>总计</span>
          <strong id="zhs-sum-total">${options.videoTotal}</strong>
        </div>
        <p class="watch-summary-note" id="zhs-sum-note"></p>
      </div>

      <section class="watch-section">
        <header class="watch-section-head">
          <h3>1. 范围</h3>
          <p>这次要处理哪些小节视频</p>
        </header>
        <div class="watch-choice-row" id="zhs-scope">
          <button type="button" class="watch-choice is-active" data-scope="all" aria-pressed="true">
            <strong>全部待处理</strong>
            <small>平台尚未记录完成的小节</small>
          </button>
          <button type="button" class="watch-choice" data-scope="limit" aria-pressed="false">
            <strong>只处理前几个</strong>
            <small>先跑一个小批量验证流程</small>
          </button>
        </div>
        <label class="field" id="zhs-max-field" hidden>
          <span>最多处理视频数</span>
          <input id="zhs-watch-max" type="number" min="1" step="1" placeholder="例如 5" />
          <em>按视频树顺序处理前 N 个</em>
        </label>
      </section>

      <section class="watch-section">
        <header class="watch-section-head">
          <h3>2. 选项</h3>
          <p>默认跳过平台已记录完成的小节，避免重复上报</p>
        </header>
        <label class="check switch-row">
          <input id="zhs-watch-include" type="checkbox" />
          <span>重新上报已完成的视频<em>开启后待处理范围会包含平台已完成的小节</em></span>
        </label>
        <label class="check switch-row">
          <input id="zhs-watch-verify" type="checkbox" checked />
          <span>每节上报后复核 watchState<em>更稳妥，但每节会多一次查询</em></span>
        </label>
      </section>

      <section class="watch-section">
        <header class="watch-section-head">
          <h3>3. 模式</h3>
          <p>试运行只在本地生成上报字段，不会发送任何请求</p>
        </header>
        <div class="watch-mode-row" id="zhs-mode">
          <label class="watch-mode is-active" data-mode="dry">
            <input type="radio" name="zhs-watch-mode" value="dry" checked />
            <span>
              <strong>试运行（默认）</strong>
              <small>生成 sdsew / ewssw 字段，不发送</small>
            </span>
          </label>
          <label class="watch-mode" data-mode="real">
            <input type="radio" name="zhs-watch-mode" value="real" />
            <span>
              <strong>真实上报</strong>
              <small>按平台协议逐节提交视频进度</small>
            </span>
          </label>
        </div>
      </section>

      <section class="watch-danger" id="zhs-watch-danger" hidden>
        <div class="watch-danger-head">${icon("alert", 15)} 真实执行风险确认</div>
        <p>秒刷视频属于最高风险形态，可能触发平台风控或影响成绩判定。勾选并确认后才会真正发送上报请求。</p>
        <label class="check switch-row risk-confirm">
          <input id="zhs-watch-confirm" type="checkbox" />
          <span>我确认已了解风险，按平台协议真实上报视频进度</span>
        </label>
      </section>

      <details class="watch-tech">
        <summary>技术细节（协议步骤）</summary>
        <p>每个待处理小节：<code>prelearningNote</code> 获取 fresh noteId → <code>saveDatabaseIntervalTimeV2</code> 提交 <code>sdsew</code>/<code>ewssw</code>/<code>zwsds</code> →（可选）<code>queryStuyInfo</code> 复核 <code>watchState=1</code>。试运行只完成本地字段构造，不发送请求。</p>
      </details>

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
      <button class="btn btn-primary" id="zhs-watch-start">${icon("play", 15)} 开始试运行</button>
    </div>
  `;

  const statusText = qs<HTMLElement>("#zhs-watch-status", content);
  const countText = qs<HTMLElement>("#zhs-watch-count", content);
  const fill = qs<HTMLElement>("#zhs-watch-fill", content);
  const log = qs<HTMLElement>("#zhs-watch-log", content);
  const pendingText = qs<HTMLElement>("#zhs-sum-pending", content);
  const doneText = qs<HTMLElement>("#zhs-sum-done", content);
  const totalText = qs<HTMLElement>("#zhs-sum-total", content);
  const summaryNote = qs<HTMLElement>("#zhs-sum-note", content);
  const startButton = qs<HTMLButtonElement>("#zhs-watch-start", content);
  const stopButton = qs<HTMLButtonElement>("#zhs-watch-stop", content);
  const copyButton = qs<HTMLButtonElement>("#zhs-watch-copy", content);
  const maxInput = qs<HTMLInputElement>("#zhs-watch-max", content);
  const maxField = qs<HTMLElement>("#zhs-max-field", content);
  const includeInput = qs<HTMLInputElement>("#zhs-watch-include", content);
  const verifyInput = qs<HTMLInputElement>("#zhs-watch-verify", content);
  const confirmInput = qs<HTMLInputElement>("#zhs-watch-confirm", content);
  const danger = qs<HTMLElement>("#zhs-watch-danger", content);
  const scopeButtons = Array.from(
    content.querySelectorAll<HTMLButtonElement>("[data-scope]"),
  );
  const modeInputs = Array.from(
    content.querySelectorAll<HTMLInputElement>("input[name='zhs-watch-mode']"),
  );
  const modeCards = Array.from(
    content.querySelectorAll<HTMLElement>("[data-mode]"),
  );

  let running = false;
  let closed = false;
  let unlisten: (() => void) | null = null;
  let targetTotal = 0;
  /** Videos the plan skips because the platform already recorded them. */
  let planSkipped = 0;
  let scope: ZhsWatchScope = "all";
  const rows = new Map<number, HTMLElement>();
  let resultLines: string[] = [];

  const dryRun = (): boolean =>
    modeInputs.find((input) => input.checked)?.value !== "real";

  const maxVideos = (): number | null => {
    const raw = maxInput.value.trim();
    if (!raw) return null;
    const value = Math.floor(Number(raw));
    return Number.isFinite(value) && value >= 1 ? value : null;
  };

  /** Videos eligible by options, before the scope limit. */
  const eligibleVideos = (): number =>
    includeInput.checked
      ? options.videoTotal
      : Math.max(0, options.videoTotal - options.videoCompleted);

  /** Live count of the videos this plan would process. */
  const plannedVideos = (): number => {
    const eligible = eligibleVideos();
    if (scope === "all") return eligible;
    const max = maxVideos();
    return max === null ? 0 : Math.min(eligible, max);
  };

  const syncUi = () => {
    const dry = dryRun();
    const pending = plannedVideos();
    pendingText.textContent = String(pending);
    doneText.textContent = String(options.videoCompleted);
    totalText.textContent = String(options.videoTotal);

    // The danger path only exists for a real run; the checkbox only gates it.
    danger.hidden = dry;
    danger.setAttribute("aria-hidden", dry ? "true" : "false");
    if (dry) confirmInput.checked = false;
    confirmInput.disabled = dry || running;

    for (const button of scopeButtons) {
      const active = button.dataset.scope === scope;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.disabled = running;
    }
    for (const card of modeCards) {
      const active = (card.dataset.mode === "real") !== dry;
      card.classList.toggle("is-active", active);
    }
    maxField.hidden = scope !== "limit";
    maxInput.disabled = running || scope !== "limit";
    includeInput.disabled = running;
    verifyInput.disabled = running;
    for (const input of modeInputs) input.disabled = running;

    const notes: string[] = [];
    if (includeInput.checked) {
      notes.push("已开启重新上报：待处理范围包含平台已完成的小节。");
    }
    if (scope === "limit") {
      notes.push(
        maxVideos() === null
          ? "请输入要处理的数量（≥ 1）。"
          : `只处理按顺序的前 ${pending} 个。`,
      );
    }
    if (!dry && !confirmInput.checked) {
      notes.push("真实执行前需要勾选下方风险确认。");
    }
    if (pending === 0) notes.push("没有待处理的视频。");
    summaryNote.textContent = notes.join(" ");

    if (running) return;
    startButton.innerHTML = dry
      ? `${icon("play", 15)} 开始试运行`
      : `${icon("alert", 15)} 确认真实执行`;
    const missingCount = scope === "limit" && maxVideos() === null;
    startButton.disabled =
      pending === 0 || missingCount || (!dry && !confirmInput.checked);
    startButton.title = startButton.disabled
      ? missingCount
        ? "请先填写要处理的数量"
        : pending === 0
          ? "没有待处理的视频"
          : "请勾选风险确认，或改回试运行"
      : "";
  };

  for (const button of scopeButtons) {
    button.addEventListener("click", () => {
      const next = button.dataset.scope;
      scope = next === "limit" ? "limit" : "all";
      syncUi();
      if (scope === "limit") maxInput.focus();
    });
  }
  maxInput.addEventListener("input", syncUi);
  includeInput.addEventListener("change", syncUi);
  verifyInput.addEventListener("change", syncUi);
  for (const input of modeInputs) input.addEventListener("change", syncUi);
  confirmInput.addEventListener("change", syncUi);
  syncUi();

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
    running = busy;
    startButton.hidden = busy;
    stopButton.hidden = !busy;
    stopButton.disabled = false;
    stopButton.innerHTML = `${icon("stop", 14)} 停止`;
    syncUi();
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
      planSkipped = progress.skipped;
      rows.clear();
      log.innerHTML = "";
      setProgress(0, progress.total);
      pendingText.textContent = String(progress.total);
      const skipped =
        progress.skipped > 0 ? `，跳过（已完成）${progress.skipped} 个` : "";
      statusText.textContent =
        progress.total === 0
          ? "没有待处理的视频"
          : progress.dryRun
            ? `试运行：已计划 ${progress.total} 个视频${skipped}，不会发送请求`
            : `真实执行：将上报 ${progress.total} 个视频${skipped}`;
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
    setRunningUi(false);
    startButton.hidden = true;
    stopButton.hidden = true;
    // A finished run is read-only; close and reopen the dialog to plan again.
    for (const button of scopeButtons) button.disabled = true;
    for (const input of [
      maxInput,
      includeInput,
      verifyInput,
      confirmInput,
      ...modeInputs,
    ]) {
      input.disabled = true;
    }

    const skipped =
      summary.skipped > 0 ? `，跳过（已完成）${summary.skipped} 个` : "";
    const skippedPlan =
      planSkipped > 0 ? `，跳过（已完成）${planSkipped} 个` : "";
    if (summary.cancelled) {
      statusText.textContent = "已取消";
      options.onToast("已取消视频秒刷", "info");
      summaryNote.textContent = "本次执行已取消，完成度以刷新后的平台记录为准。";
    } else if (summary.dryRun) {
      // `summary.skipped` counts the dry-run rows themselves, so report the
      // plan's skip count (videos the platform already recorded) instead.
      statusText.textContent = `试运行完成：已计划 ${summary.total} 个视频${skippedPlan}，未发送任何请求`;
      summaryNote.textContent =
        "试运行只生成上报字段。切换为真实上报并勾选风险确认后才会发送。";
      options.onToast("试运行完成，没有发送视频上报", "success");
    } else if (summary.failed === 0 && summary.ok > 0) {
      statusText.textContent = `完成：${summary.ok} 个已完成（平台记录）${skipped}`;
      summaryNote.textContent = "正在按平台记录刷新完成度…";
      options.onToast(`平台已记录 ${summary.ok} 个视频完成`, "success");
    } else {
      statusText.textContent = `完成：${summary.ok} 个已完成（平台记录） · ${summary.failed} 个失败${skipped}`;
      summaryNote.textContent = "正在按平台记录刷新完成度…";
      options.onToast(
        `${summary.ok} 个成功，${summary.failed} 个失败，详见日志`,
        summary.failed > 0 ? "error" : "info",
      );
    }

    // Emit rows from the returned outcomes when the live events did not cover
    // them (for example a job that stopped before the first target event).
    summary.outcomes.forEach((outcome, offset) => {
      const status = outcome.state === "circuit_broken" ? "failed" : outcome.state;
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
    const dry = dryRun();
    if (!dry && !confirmInput.checked) {
      options.onToast("真实执行前必须勾选风险确认", "error");
      return;
    }
    const max = maxVideos();
    if (scope === "limit" && max === null) {
      options.onToast("请输入要处理的数量（≥ 1）", "error");
      return;
    }
    running = true;
    rows.clear();
    log.innerHTML = "";
    resultLines = [];
    planSkipped = 0;
    copyButton.hidden = true;
    setRunningUi(true);
    statusText.textContent = "正在抓取视频树并复核平台完成状态…";
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
        dryRun: dry,
        includeCompleted: includeInput.checked,
        maxVideos: scope === "limit" ? max : null,
        verify: verifyInput.checked,
      });
      if (!closed) finish(summary);
    } catch (error) {
      if (closed) return;
      setRunningUi(false);
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
