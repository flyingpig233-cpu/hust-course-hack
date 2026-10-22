import { esc, qs, spinner } from "../dom";
import {
  answerLabels,
  chapterNumber,
  formatBytes,
  formatDuration,
  formatPercent,
  isAnswerSelected,
  kindLabel,
  workStatusLabel,
} from "../format";
import { icon } from "../icons";
import type {
  Card,
  Chapter,
  CourseDetail,
  CourseSummary,
  CrawlOptions,
  Question,
  TaskKind,
  TaskPoint,
} from "../types";

export interface CourseHandlers {
  busy: boolean;
  options: CrawlOptions;
  bankQuestions: number | null;
  onRefresh(): void;
  onCancel(): void;
  onWatch(jobId?: string | null): void;
  onQuiz(workId?: string | null): void;
  onExport(): void;
  onOpenUrl(url: string): void;
  onOptionsChange(options: CrawlOptions): void;
}

interface PointRef {
  chapter: Chapter;
  point: TaskPoint;
}

function walkPoints(chapters: Chapter[], out: PointRef[] = []): PointRef[] {
  for (const chapter of chapters) {
    for (const card of chapter.cards ?? []) {
      for (const point of card.task_points) out.push({ chapter, point });
    }
    walkPoints(chapter.children, out);
  }
  return out;
}

function countLeaves(chapters: Chapter[]): number {
  return chapters.reduce(
    (total, chapter) =>
      total + (chapter.is_leaf ? 1 : 0) + countLeaves(chapter.children),
    0,
  );
}

function kindIcon(kind: TaskKind): string {
  switch (kind) {
    case "video":
      return "video";
    case "document":
      return "document";
    case "work":
      return "work";
    case "audio":
      return "audio";
    case "live":
      return "live";
    default:
      return "other";
  }
}

function chapterLabel(chapter: Chapter): string {
  const number = chapterNumber(chapter.number);
  return number ? `${number} ${chapter.title}` : chapter.title;
}

function completionBadge(completed: boolean | null): string {
  if (completed === true) {
    return `<span class="badge badge-good">${icon("check", 12)} 已完成</span>`;
  }
  if (completed === false) return `<span class="badge badge-muted">未完成</span>`;
  return "";
}

function emptyState(title: string, body: string, iconName = "folder"): string {
  return `
    <div class="empty-panel compact">
      <div class="empty-icon">${icon(iconName, 24)}</div>
      <h2>${esc(title)}</h2>
      <p>${body}</p>
    </div>
  `;
}

export function renderCourseLoading(
  main: HTMLElement,
  summary: CourseSummary,
  onCancel: () => void,
): void {
  main.innerHTML = `
    <div class="course-view">
      <header class="course-head">
        <div class="course-head-copy">
          <div class="eyebrow">${esc(summary.course_id)}</div>
          <h1>${esc(summary.name)}</h1>
          <p class="course-sub">正在获取课程首页与章节结构，随后逐个抓取知识点。</p>
        </div>
      </header>
      <div class="crawl-card">
        <div class="crawl-orb">${icon("refresh", 28)}</div>
        <h2>正在抓取课程数据</h2>
        <p>每个知识点的卡片、测验题目与视频签名会并发请求，通常需要几十秒。</p>
        <div class="progress progress-lg">
          <div class="progress-fill crawl-progress-fill" style="width: 0%"></div>
        </div>
        <div class="crawl-meta">
          <span class="crawl-progress-label">正在解析章节目录…</span>
          <span class="crawl-progress-count"></span>
        </div>
        <button class="btn btn-ghost" data-cancel>${icon("stop", 14)} 取消抓取</button>
      </div>
    </div>
  `;
  main.onclick = (event) => {
    if ((event.target as HTMLElement).closest("[data-cancel]")) onCancel();
  };
  main.onchange = null;
}

export function renderCourseError(
  main: HTMLElement,
  summary: CourseSummary,
  message: string,
  onRetry: () => void,
): void {
  main.innerHTML = `
    <div class="course-view">
      <header class="course-head">
        <div class="course-head-copy">
          <div class="eyebrow">${esc(summary.course_id)}</div>
          <h1>${esc(summary.name)}</h1>
          <p class="course-sub">${esc(summary.class_id)} · 抓取未完成</p>
        </div>
      </header>
      <div class="error-card">
        <div class="error-icon">${icon("alert", 24)}</div>
        <h2>抓取课程失败</h2>
        <pre class="error-detail">${esc(message)}</pre>
        <p class="hint">如果提示登录过期，请重新导出 cookies.txt 后再连接。</p>
        <button class="btn btn-primary" data-retry>${icon("refresh", 15)} 重试</button>
      </div>
    </div>
  `;
  main.onclick = (event) => {
    if ((event.target as HTMLElement).closest("[data-retry]")) onRetry();
  };
  main.onchange = null;
}

export function updateCrawlProgress(
  main: HTMLElement,
  done: number,
  total: number,
): void {
  const percent = formatPercent(done, total);
  const fill = main.querySelector<HTMLElement>(".crawl-progress-fill");
  if (fill) fill.style.width = `${percent}%`;
  const label = main.querySelector<HTMLElement>(".crawl-progress-label");
  if (label) {
    label.textContent =
      total > 0 ? "正在抓取知识点" : "正在解析章节目录…";
  }
  const count = main.querySelector<HTMLElement>(".crawl-progress-count");
  if (count) count.textContent = total > 0 ? `${done} / ${total} · ${percent}%` : "";
}

export function markJobCompleted(detail: CourseDetail, jobId: string): boolean {
  let changed = false;
  for (const { point } of walkPoints(detail.chapters)) {
    if (
      point.kind === "video" &&
      point.job_id === jobId &&
      point.completed !== true
    ) {
      point.completed = true;
      point.played_ms = (point.duration_secs ?? 1) * 1000;
      changed = true;
    }
  }
  return changed;
}

/** Mark a work as submitted locally; the platform still owns the final grade. */
export function markWorkSubmitted(detail: CourseDetail, workId: string): boolean {
  if (!workId) return false;
  let changed = false;
  for (const { point } of walkPoints(detail.chapters)) {
    if (
      point.kind === "work" &&
      point.work_id === workId &&
      point.work_status !== "graded" &&
      point.work_status !== "submitted"
    ) {
      point.work_status = "submitted";
      changed = true;
    }
  }
  return changed;
}

type TabId = "outline" | "tasks" | "quiz" | "diagnostics";

let lastTab: TabId = "outline";

export function renderCourse(
  main: HTMLElement,
  detail: CourseDetail,
  handlers: CourseHandlers,
): void {
  const points = walkPoints(detail.chapters);
  const videos = points.filter(({ point }) => point.kind === "video");
  const videosDone = videos.filter(({ point }) => point.completed === true).length;
  const videoPercent = formatPercent(videosDone, videos.length);
  const errors = detail.stats.errors;
  const stats = detail.stats;

  main.innerHTML = `
    <div class="course-view">
      <header class="course-head">
        <div class="course-head-copy">
          <div class="eyebrow">课程 · ${esc(detail.course_id)}</div>
          <h1>${esc(detail.title)}</h1>
          <p class="course-sub">
            班级 ${esc(detail.class_id)} · cpi ${esc(detail.cpi)} · ${stats.chapter_nodes} 个目录节点
          </p>
        </div>
        <div class="head-actions">
          <button class="icon-button" data-action="open" title="在浏览器打开课程页" aria-label="在浏览器打开课程页">${icon(
            "external",
            16,
          )}</button>
          <button class="icon-button" data-action="export" title="导出课程 JSON" aria-label="导出课程 JSON">${icon(
            "download",
            16,
          )}</button>
          <button class="icon-button" data-action="refresh" title="重新抓取" aria-label="重新抓取">${icon(
            "refresh",
            16,
          )}</button>
          <details class="options-popover">
            <summary class="btn btn-ghost">${icon("settings", 15)} 抓取设置</summary>
            <div class="popover-card">
              <label class="switch-row">
                <input type="checkbox" data-option="questions" ${
                  handlers.options.includeQuestions !== false ? "checked" : ""
                } />
                <span>抓取章节测验题目</span>
              </label>
              <label class="switch-row">
                <input type="checkbox" data-option="video" ${
                  handlers.options.includeVideoInfo !== false ? "checked" : ""
                } />
                <span>抓取视频签名信息</span>
              </label>
              <label class="field-row">
                <span>并发数</span>
                <input type="number" min="1" max="8" value="${handlers.options.concurrency ?? 4}" data-option="concurrency" />
              </label>
              <p class="hint">修改后点击右上角刷新按钮生效。</p>
            </div>
          </details>
          <button class="btn btn-primary" data-action="quiz">${icon("work", 15)} 完成题目</button>
          <button class="btn btn-ghost" data-action="watch">${icon("play", 15)} 完成视频</button>
        </div>
      </header>

      ${
        handlers.busy
          ? `<div class="crawl-banner">
              <div class="crawl-banner-row">
                ${spinner("spinner-sm")}
                <span class="crawl-progress-label">正在重新抓取课程…</span>
                <span class="crawl-progress-count"></span>
                <button class="btn btn-sm btn-ghost" data-cancel>取消</button>
              </div>
              <div class="progress"><div class="progress-fill crawl-progress-fill" style="width:0%"></div></div>
            </div>`
          : ""
      }

      <div class="stat-strip">
        <div class="stat-card stat-card-wide">
          <div class="stat-head"><span>视频完成度</span><strong>${videosDone} / ${videos.length}</strong></div>
          <div class="progress"><div class="progress-fill fill-good" style="width:${videoPercent}%"></div></div>
          <div class="stat-foot">${videoPercent}% 的视频任务点已完成</div>
        </div>
        <div class="stat-card"><span class="stat-label">知识点</span><strong>${stats.leaves}</strong><span class="stat-foot">${stats.cards} 张卡片</span></div>
        <div class="stat-card"><span class="stat-label">任务点</span><strong>${stats.task_points}</strong><span class="stat-foot">${stats.documents} 个文档</span></div>
        <div class="stat-card"><span class="stat-label">测验</span><strong>${stats.works}</strong><span class="stat-foot">${stats.questions} 道题目</span></div>
        ${
          errors.length
            ? `<div class="stat-card stat-card-warn"><span class="stat-label">抓取警告</span><strong>${errors.length}</strong><span class="stat-foot">在“诊断”中查看</span></div>`
            : ""
        }
      </div>

      <div class="tab-bar" role="tablist">
        <button class="tab" data-tab="outline" role="tab">课程目录</button>
        <button class="tab" data-tab="tasks" role="tab">任务点 <span class="tab-count">${points.length}</span></button>
        <button class="tab" data-tab="quiz" role="tab">测验 <span class="tab-count">${stats.questions}</span></button>
        <button class="tab" data-tab="diagnostics" role="tab">诊断${
          errors.length ? '<span class="tab-dot"></span>' : ""
        }</button>
      </div>
      <div class="tab-panel" id="tab-panel"></div>
    </div>
  `;

  const panel = qs<HTMLElement>("#tab-panel", main);
  let kindFilter: TaskKind | "all" = "all";
  let onlyTodo = false;
  let activeTab: TabId = lastTab;

  const renderTaskRows = () => {
    const rows = points
      .filter(({ point }) => kindFilter === "all" || point.kind === kindFilter)
      .filter(({ point }) => !onlyTodo || point.completed !== true);

    const body = main.querySelector<HTMLElement>("#task-rows");
    if (!body) return;
    if (rows.length === 0) {
      body.innerHTML = `<tr><td colspan="6" class="table-empty">没有匹配的任务点</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .map(({ chapter, point }) => {
        const done = point.completed === true;
        const status =
          point.completed === null
            ? `<span class="status-chip">未知</span>`
            : done
              ? `<span class="status-chip is-good">已完成</span>`
              : `<span class="status-chip is-muted">未完成</span>`;
        const duration =
          point.kind === "video"
            ? `${formatDuration(point.duration_secs)} · ${formatBytes(point.size_bytes)}`
            : formatBytes(point.size_bytes);
        const progress =
          point.kind === "video" && point.duration_secs
            ? Math.min(
                100,
                Math.round(
                  ((point.played_ms ?? 0) / (point.duration_secs * 1000)) * 100,
                ),
              )
            : 0;
        const action =
          point.kind === "video" && point.job_id
            ? `<button class="btn btn-sm" data-watch-job="${esc(point.job_id)}">${icon("play", 13)} ${done ? "重报" : "完成"}</button>`
            : point.kind === "work" && point.questions.length
              ? `<button class="btn btn-sm" data-work-id="${esc(point.work_id ?? "")}">${icon("work", 13)} 题目</button>`
              : "";
        return `
          <tr>
            <td>${status}</td>
            <td><span class="kind-pill kind-${point.kind}">${icon(kindIcon(point.kind), 13)} ${kindLabel(point.kind)}</span></td>
            <td>
              <div class="cell-title" title="${esc(point.name)}">${esc(point.name)}</div>
              ${point.kind === "video" ? `<div class="cell-progress"><span style="width:${progress}%"></span></div>` : ""}
            </td>
            <td class="cell-muted">${esc(chapterLabel(chapter))}</td>
            <td class="cell-muted">${duration}</td>
            <td class="cell-action">${action}</td>
          </tr>
        `;
      })
      .join("");
  };

  const renderPanel = () => {
    for (const button of main.querySelectorAll<HTMLElement>("[data-tab]")) {
      button.classList.toggle("is-active", button.dataset.tab === activeTab);
    }
    if (activeTab === "outline") {
      panel.innerHTML = renderOutline(detail);
    } else if (activeTab === "tasks") {
      panel.innerHTML = renderTasksTab(points.length);
      renderTaskRows();
    } else if (activeTab === "quiz") {
      panel.innerHTML = renderQuiz(detail, handlers.options, handlers.bankQuestions);
    } else {
      panel.innerHTML = renderDiagnostics(detail);
    }
  };

  const setTab = (tab: TabId) => {
    activeTab = tab;
    lastTab = tab;
    renderPanel();
  };

  main.onclick = (event) => {
    const target = event.target as HTMLElement;
    const tabButton = target.closest<HTMLElement>("[data-tab]");
    if (tabButton) {
      setTab(tabButton.dataset.tab as TabId);
      return;
    }
    const quizWork = target.closest<HTMLElement>("[data-quiz-work]");
    if (quizWork) {
      handlers.onQuiz(quizWork.dataset.quizWork ?? null);
      return;
    }
    if (target.closest("[data-action='quiz']")) {
      handlers.onQuiz();
      return;
    }
    if (target.closest("[data-action='watch']")) {
      handlers.onWatch();
      return;
    }
    if (target.closest("[data-action='refresh']")) {
      handlers.onRefresh();
      return;
    }
    if (target.closest("[data-action='export']")) {
      handlers.onExport();
      return;
    }
    if (target.closest("[data-action='open']")) {
      handlers.onOpenUrl(detail.final_url);
      return;
    }
    if (target.closest("[data-cancel]")) {
      handlers.onCancel();
      return;
    }
    const watchButton = target.closest<HTMLElement>("[data-watch-job]");
    if (watchButton) {
      handlers.onWatch(watchButton.dataset.watchJob ?? null);
      return;
    }
    const workButton = target.closest<HTMLElement>("[data-work-id]");
    if (workButton) {
      setTab("quiz");
      const workId = workButton.dataset.workId ?? "";
      if (workId) {
        window.setTimeout(() => {
          document
            .getElementById(`work-${workId}`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 30);
      }
      return;
    }
    if (target.closest("[data-expand]")) {
      for (const node of panel.querySelectorAll<HTMLDetailsElement>(
        "details.tree-node",
      )) {
        node.open = true;
      }
      return;
    }
    if (target.closest("[data-collapse]")) {
      for (const node of panel.querySelectorAll<HTMLDetailsElement>(
        "details.tree-node",
      )) {
        node.open = false;
      }
      return;
    }
    const kindChip = target.closest<HTMLElement>("[data-kind]");
    if (kindChip) {
      kindFilter = (kindChip.dataset.kind as TaskKind | "all") ?? "all";
      for (const chip of main.querySelectorAll<HTMLElement>("[data-kind]")) {
        chip.classList.toggle("is-active", chip === kindChip);
      }
      renderTaskRows();
    }
  };

  main.onchange = (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === "only-todo") {
      onlyTodo = target.checked;
      renderTaskRows();
      return;
    }
    if (target.matches("[data-option]")) {
      handlers.onOptionsChange({
        includeQuestions:
          main.querySelector<HTMLInputElement>("[data-option='questions']")
            ?.checked ?? true,
        includeVideoInfo:
          main.querySelector<HTMLInputElement>("[data-option='video']")
            ?.checked ?? true,
        concurrency: Math.max(
          1,
          Math.min(
            8,
            Number(
              main.querySelector<HTMLInputElement>(
                "[data-option='concurrency']",
              )?.value ?? 4,
            ) || 4,
          ),
        ),
      });
    }
  };

  renderPanel();
}

function renderTasksTab(total: number): string {
  const kinds: Array<TaskKind | "all"> = [
    "all",
    "video",
    "document",
    "work",
    "audio",
    "live",
    "other",
  ];
  return `
    <div class="filter-bar">
      <div class="chip-group">
        ${kinds
          .map(
            (kind) =>
              `<button class="filter-chip${kind === "all" ? " is-active" : ""}" data-kind="${kind}">${
                kind === "all" ? `全部 ${total}` : kindLabel(kind)
              }</button>`,
          )
          .join("")}
      </div>
      <label class="check"><input type="checkbox" id="only-todo" /> 只看未完成</label>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>状态</th>
            <th>类型</th>
            <th>名称</th>
            <th>所属知识点</th>
            <th>时长 / 大小</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="task-rows"></tbody>
      </table>
    </div>
  `;
}

function renderOutline(detail: CourseDetail): string {
  if (detail.chapters.length === 0) {
    return emptyState(
      "这门课程没有章节数据",
      "平台可能对这类课程返回空目录（常见于军事理论、导论类课程），这不是抓取失败。可以稍后重新抓取，或在浏览器中打开课程页确认。",
    );
  }
  const openLeaves = countLeaves(detail.chapters) <= 10;
  return `
    <div class="tree-toolbar">
      <span>${countLeaves(detail.chapters)} 个知识点 · ${detail.stats.cards} 张卡片</span>
      <div class="tree-tools">
        <button class="text-button" data-expand>展开全部</button>
        <button class="text-button" data-collapse>收起全部</button>
      </div>
    </div>
    <div class="tree">${detail.chapters
      .map((chapter) => renderChapter(chapter, openLeaves))
      .join("")}</div>
  `;
}

function renderChapter(chapter: Chapter, openLeaves: boolean): string {
  const cards = chapter.cards ?? [];
  const taskCount = cards.reduce((total, card) => total + card.task_points.length, 0);
  const leaf = chapter.is_leaf || chapter.children.length === 0;
  const number = chapterNumber(chapter.number);
  const open = chapter.level <= 1 || (openLeaves && leaf) ? " open" : "";
  return `
    <details class="tree-node${leaf ? " is-leaf" : ""}"${open}>
      <summary class="tree-summary">
        <span class="tree-kind">${icon(leaf ? "document" : "folder", 16)}</span>
        ${number ? `<span class="tree-number">${esc(number)}</span>` : ""}
        <span class="tree-title">${esc(chapter.title)}</span>
        ${completionBadge(chapter.completed)}
        <span class="tree-count">${leaf ? `${taskCount} 个任务` : `${countLeaves(chapter.children)} 个知识点`}</span>
        <span class="tree-chevron">${icon("chevron", 14)}</span>
      </summary>
      <div class="tree-body">
        ${
          cards.length
            ? cards.map((card) => renderCard(card)).join("")
            : leaf
              ? `<div class="empty-inline">该知识点没有可直接读取的卡片</div>`
              : ""
        }
        ${chapter.children.map((child) => renderChapter(child, openLeaves)).join("")}
      </div>
    </details>
  `;
}

function renderCard(card: Card): string {
  return `
    <section class="card-block">
      <header class="card-head">
        <span class="card-tab">卡片 ${card.index}</span>
        <h3>${esc(card.title)}</h3>
        <span class="card-count">${card.task_points.length} 个任务点</span>
      </header>
      <div class="task-rows">
        ${card.task_points.map((point) => renderTaskRow(point)).join("")}
      </div>
    </section>
  `;
}

function renderTaskRow(point: TaskPoint): string {
  const done = point.completed === true;
  const meta: string[] = [];
  if (point.kind === "video") {
    if (point.duration_secs) meta.push(formatDuration(point.duration_secs));
    if (point.played_ms && point.duration_secs) {
      const percent = Math.min(
        100,
        Math.round((point.played_ms / (point.duration_secs * 1000)) * 100),
      );
      meta.push(`已看 ${percent}%`);
    }
    if (point.size_bytes) meta.push(formatBytes(point.size_bytes));
  } else if (point.size_bytes) {
    meta.push(formatBytes(point.size_bytes));
  }
  if (point.content_ext) meta.push(point.content_ext.toUpperCase());
  if (point.questions.length) meta.push(`${point.questions.length} 道题`);
  const status = workStatusLabel(point.work_status);
  if (status) meta.push(status);

  let action = "";
  if (point.kind === "video" && point.job_id) {
    action = done
      ? `<span class="badge badge-good">${icon("check", 12)} 已完成</span>`
      : `<button class="btn btn-sm" data-watch-job="${esc(point.job_id)}">${icon("play", 13)} 完成</button>`;
  } else if (point.kind === "work" && point.questions.length) {
    action = `<button class="btn btn-sm" data-work-id="${esc(point.work_id ?? "")}">${icon("work", 13)} 查看题目</button>`;
  }

  return `
    <div class="task-row kind-${point.kind}${done ? " is-done" : ""}">
      <span class="task-kind">${icon(kindIcon(point.kind), 17)}</span>
      <div class="task-copy">
        <div class="task-name" title="${esc(point.name)}">${esc(point.name)}</div>
        <div class="task-meta">${meta.length ? esc(meta.join(" · ")) : "—"}</div>
      </div>
      <div class="task-actions">${action}</div>
    </div>
  `;
}

function renderQuiz(
  detail: CourseDetail,
  options: CrawlOptions,
  bankQuestions: number | null,
): string {
  const works = walkPoints(detail.chapters).filter(
    ({ point }) => point.kind === "work",
  );
  const withQuestions = works.filter(({ point }) => point.questions.length > 0);

  if (withQuestions.length === 0) {
    if (options.includeQuestions === false) {
      return emptyState(
        "抓取时跳过了测验题目",
        "这次抓取关闭了“抓取章节测验题目”。在右上角抓取设置中开启后点击刷新即可显示。",
        "work",
      );
    }
    return emptyState(
      "没有可显示的题目",
      "平台上未批改的作业通常只返回题目页；如果这里为空，可能是当前课程没有章节测验，或题目接口要求重新登录。",
      "work",
    );
  }

  const actionable = withQuestions.filter(
    ({ point }) =>
      point.work_status !== "graded" && point.work_status !== "submitted",
  );

  return `
    <div class="quiz-banner">
      <div class="quiz-banner-copy">
        <strong>一键完成题目</strong>
        <p>内置题库 ${bankQuestions ?? "…"} 题 · 已批改作业自动跳过 · 题库缺答案的作业不会提交</p>
      </div>
      ${
        actionable.length > 0
          ? `<button class="btn btn-primary" data-action="quiz">${icon("work", 14)} 完成 ${actionable.length} 个作业</button>`
          : `<span class="badge badge-good">${icon("check", 12)} 没有待提交作业</span>`
      }
    </div>
    <div class="quiz-list">
      ${withQuestions
        .map(({ chapter, point }) => {
          const workId = point.work_id ?? "";
          const graded = point.work_status === "graded";
          const submitted = point.work_status === "submitted";
          const statusBadge = graded
            ? `<span class="badge badge-good">已批改</span>`
            : submitted
              ? `<span class="badge badge-good">已提交</span>`
              : point.work_status === "in_progress"
                ? `<span class="badge badge-warn">未批改</span>`
                : "";
          const canSubmit = !graded && !submitted && workId.length > 0;
          return `
            <article class="quiz-group" id="work-${esc(workId)}">
              <header class="quiz-head">
                <div>
                  <div class="quiz-kicker">${esc(chapterLabel(chapter))}</div>
                  <h3>${esc(point.name)}</h3>
                </div>
                <div class="quiz-head-meta">
                  ${
                    canSubmit
                      ? `<button class="btn btn-sm" data-quiz-work="${esc(workId)}">${icon("work", 12)} 提交本题</button>`
                      : ""
                  }
                  ${statusBadge}
                  <span class="badge badge-muted">${point.questions.length} 题</span>
                </div>
              </header>
              ${
                submitted
                  ? `<div class="inline-notice">${icon("check", 14)} 已提交，等待平台批改；刷新课程可获取最终结果。</div>`
                  : !graded && point.work_status === "in_progress"
                    ? `<div class="inline-notice">${icon("alert", 14)} 该作业尚未批改，平台不返回正确答案；可以用内置题库一键提交。</div>`
                    : ""
              }
              <div class="questions">
                ${point.questions
                  .map((question, index) => renderQuestion(question, index + 1))
                  .join("")}
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function questionTypeTone(type: string | null): string {
  if (!type) return "tone-gray";
  if (type.includes("多选")) return "tone-violet";
  if (type.includes("判断")) return "tone-amber";
  if (type.includes("填空") || type.includes("简答")) return "tone-green";
  return "tone-blue";
}

function renderQuestion(question: Question, index: number): string {
  const correct = question.correct_answer;
  const mine = question.my_answer;
  const mineLabels = answerLabels(mine).sort();
  const correctLabels = answerLabels(correct).sort();
  const mineWrong =
    mine &&
    correct &&
    mineLabels.length > 0 &&
    correctLabels.length > 0 &&
    mineLabels.join(",") !== correctLabels.join(",");

  const options = question.options
    .map((option) => {
      const isCorrect = isAnswerSelected(option.label, option.text, correct);
      const isMine = isAnswerSelected(option.label, option.text, mine);
      const classes = [
        "option",
        isCorrect ? "is-correct" : "",
        isMine ? "is-mine" : "",
        isMine && mineWrong && !isCorrect ? "is-wrong" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `
        <li class="${classes}">
          <span class="option-label">${esc(option.label)}</span>
          <span class="option-text">${esc(option.text)}</span>
          <span class="option-tags">
            ${isMine ? '<span class="tag tag-mine">我的</span>' : ""}
            ${isCorrect && correct ? '<span class="tag tag-correct">答案</span>' : ""}
          </span>
        </li>
      `;
    })
    .join("");

  const fillIn =
    question.options.length === 0
      ? `<div class="answer-lines">
          <div>我的答案：<strong>${esc(mine ?? "未作答")}</strong></div>
          ${correct ? `<div class="is-good">正确答案：<strong>${esc(correct)}</strong></div>` : ""}
        </div>`
      : "";

  return `
    <article class="question">
      <div class="question-head">
        <span class="question-index">${index}</span>
        <span class="kind-pill ${questionTypeTone(question.question_type)}">${esc(
          question.question_type ?? "题目",
        )}</span>
        ${question.score ? `<span class="question-score">${esc(question.score)} 分</span>` : ""}
      </div>
      <div class="question-stem">${esc(question.stem)}</div>
      ${options ? `<ul class="options">${options}</ul>` : ""}
      ${fillIn}
      <div class="question-foot">
        ${
          question.options.length > 0
            ? `<span>我的答案：<strong class="${mineWrong ? "is-bad" : ""}">${esc(
                mine ?? "未作答",
              )}</strong></span>`
            : ""
        }
        ${correct ? `<span>正确答案：<strong class="is-good">${esc(correct)}</strong></span>` : ""}
        ${question.score ? `<span>得分：<strong>${esc(question.score)}</strong></span>` : ""}
      </div>
    </article>
  `;
}

function renderDiagnostics(detail: CourseDetail): string {
  const errors = detail.stats.errors;
  return `
    <div class="diagnostics">
      <section class="diag-card">
        <h3>${icon("spark", 16)} 抓取统计</h3>
        <div class="kv-grid">
          <div><span>目录节点</span><strong>${detail.stats.chapter_nodes}</strong></div>
          <div><span>知识点</span><strong>${detail.stats.leaves}</strong></div>
          <div><span>卡片</span><strong>${detail.stats.cards}</strong></div>
          <div><span>任务点</span><strong>${detail.stats.task_points}</strong></div>
          <div><span>视频</span><strong>${detail.stats.videos}</strong></div>
          <div><span>文档</span><strong>${detail.stats.documents}</strong></div>
          <div><span>测验</span><strong>${detail.stats.works}</strong></div>
          <div><span>题目</span><strong>${detail.stats.questions}</strong></div>
        </div>
      </section>

      <section class="diag-card">
        <h3>${icon("link", 16)} 课程标识</h3>
        <div class="kv-list">
          <div><span>课程 id</span><code>${esc(detail.course_id)}</code></div>
          <div><span>班级 id</span><code>${esc(detail.class_id)}</code></div>
          <div><span>cpi</span><code>${esc(detail.cpi)}</code></div>
          <div><span>enc</span><code>${esc(detail.enc ?? "—")}</code></div>
          <div><span>openc</span><code>${esc(detail.openc ?? "—")}</code></div>
          <div><span>课程页</span><code class="truncate">${esc(detail.final_url)}</code></div>
        </div>
        <div class="diag-actions">
          <button class="btn btn-sm" data-action="open">${icon("external", 13)} 打开课程页</button>
          <button class="btn btn-sm" data-action="export">${icon("download", 13)} 导出 JSON</button>
        </div>
      </section>

      <section class="diag-card">
        <h3>${icon("alert", 16)} 抓取警告 <span class="count-pill">${errors.length}</span></h3>
        ${
          errors.length
            ? `<ul class="error-list">${errors
                .map((error) => `<li><pre>${esc(error)}</pre></li>`)
                .join("")}</ul>`
            : `<p class="hint">没有警告，所有知识点都成功抓取。</p>`
        }
      </section>

      <section class="diag-card">
        <h3>${icon("shield", 16)} 数据说明</h3>
        <ul class="note-list">
          <li>视频的 <code>download_url</code> / <code>stream_url</code> 带时效签名，过期后需重新抓取。</li>
          <li><code>dtoken</code>、<code>otherInfo</code>、<code>attDurationEnc</code> 与会话和视频绑定，不保存、不复用。</li>
          <li>未批改的测验只返回题目，不返回正确答案。</li>
          <li>单个知识点失败不会中断整门课程，错误会列在上方。</li>
        </ul>
      </section>
    </div>
  `;
}
