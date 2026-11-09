import { api, onZhsExamAi, onZhsExamResult } from "../api";
import type { ToastTone } from "../dom";
import { errorText, esc, openModal, qs } from "../dom";
import { icon } from "../icons";
import type {
  ZhsAiEntry,
  ZhsBankInfo,
  ZhsExamList,
  ZhsExamPaper,
  ZhsHomework,
} from "../types";

export interface ZhsExamModalOptions {
  recruitId: number;
  courseId: number;
  courseName: string;
  onToast(message: string, tone?: ToastTone): void;
}

type Tab = "pending" | "submitted";
type View = "list" | "paper" | "import" | "bank";

/**
 * Maintainer escape hatch: 「采集 AI解析」 and 「手动导入」 populate the answer
 * bank from real submissions; they are NOT end-user features. They are only
 * shown when the app is opened with `#dev` (for example clicking the app title
 * then appending `#dev` to the URL). Normal users only see list → 看试卷 →
 * 网页作答/网页重做.
 */
const MAINTAINER_MODE = /^#\/?dev$/.test(window.location.hash);

const STATE_TEXT: Record<number, string> = {
  0: "未提交",
  1: "已提交",
};

function stateText(homework: ZhsHomework): string {
  if (homework.state === null) return "状态未知";
  return STATE_TEXT[homework.state] ?? `状态 ${homework.state}`;
}

function isSubmitted(homework: ZhsHomework): boolean {
  return (
    homework.state === 1 || homework.achieve !== null || homework.score !== null
  );
}

function attemptText(homework: ZhsHomework): string {
  const remaining = homework.backNum;
  if (remaining === null) return "次数未知";
  return `剩余尝试 ${remaining} 次`;
}

function paperBadges(homework: ZhsHomework): string {
  const bits: string[] = [];
  if (homework.problemNum !== null) bits.push(`${homework.problemNum} 题`);
  if (homework.totalScore !== null) bits.push(`总分 ${homework.totalScore}`);
  if (homework.meetCourseType === 1) bits.push("见面课测验");
  if (homework.score !== null) bits.push(`得分 ${homework.score}`);
  bits.push(attemptText(homework));
  return bits
    .map((bit) => `<span class="exam-badge">${esc(bit)}</span>`)
    .join("");
}

/**
 * Homework / exam manager for one Zhihuishu shared course.
 *
 * The platform blocks direct API attempts with a slider captcha, so the actual
 * attempt is driven in an isolated webview: the user completes the slider once,
 * the injected script shows the bank plan and only answers/submits after an
 * explicit click. This modal itself is read-only apart from opening that window.
 */
export function openZhsExamModal(options: ZhsExamModalOptions): void {
  const content = document.createElement("div");
  content.className = "watch-modal zhs-exam-modal";
  content.innerHTML = `
    <div class="modal-head">
      <div>
        <div class="eyebrow">知到 · 作业与考试</div>
        <h2>作业 / 单元测试 / 期末</h2>
        <p class="modal-sub">${esc(options.courseName)}</p>
      </div>
      <button class="icon-button" data-close aria-label="关闭">${icon("close", 18)}</button>
    </div>
    <div class="modal-body">
      <div class="exam-toolbar">
        <div class="exam-tabs" role="tablist">
          <button class="exam-tab is-active" data-tab="pending">未提交</button>
          <button class="exam-tab" data-tab="submitted">已提交</button>
        </div>
        <div class="exam-toolbar-actions">
          <button class="btn btn-sm btn-ghost" data-action="bank">${icon("document", 13)} 题库统计</button>
          <button class="btn btn-sm btn-ghost" data-action="refresh">${icon("refresh", 13)} 刷新</button>
        </div>
      </div>
      <div class="inline-notice notice-warn">
        ${icon("alert", 14)} <span>使用顺序：<strong>网页作答</strong>（窗口内手动完成滑块验证）→ 计划完整时直接自动提交；不完整时点红色 <strong>容错试做</strong>（未解析题任选首项，会得低分）→ 之后在「已提交」点 <strong>网页重做</strong> 重新作答并提交。严格模式（计划完整）才会自动提交；期末仅列出、不自动提交。</span>
      </div>
      <div id="zhs-exam-body" class="exam-body"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>关闭</button>
    </div>
  `;

  const body = qs<HTMLElement>("#zhs-exam-body", content);
  const tabs = Array.from(
    content.querySelectorAll<HTMLButtonElement>(".exam-tab"),
  );
  const bankButton = content.querySelector<HTMLButtonElement>(
    "[data-action='bank']",
  );
  const refreshButton = content.querySelector<HTMLButtonElement>(
    "[data-action='refresh']",
  );

  let tab: Tab = "pending";
  let view: View = "list";
  let pending: ZhsExamList | null = null;
  let submitted: ZhsExamList | null = null;
  let paper: ZhsExamPaper | null = null;
  let paperTitle = "";
  let bank: ZhsBankInfo | null = null;
  let importing: ZhsHomework | null = null;
  let busy = false;
  let closed = false;
  let lastAttempt: ZhsHomework | null = null;
  let justSubmitted: ZhsHomework | null = null;
  let justHarvested = false;
  const listeners: Array<() => void> = [];
  const recentToasts = new Map<string, number>();
  let recentAuthHintAt = 0;
  const AUTH_HINT =
    "登录状态失效或考试接口未就绪：请重新登录知到，或稍后点「刷新」。";

  /** Toast with a 4 s per-message cooldown and one actionable auth hint. */
  function notify(message: string, tone?: ToastTone): void {
    const key = message.trim();
    const now = Date.now();
    const last = recentToasts.get(key) ?? 0;
    if (now - last < 4000) return;
    recentToasts.set(key, now);
    if (/登录状态失效|is not json|getStudentHomework|HTML|login/i.test(key)) {
      if (now - recentAuthHintAt < 4000) return;
      recentAuthHintAt = now;
      options.onToast(AUTH_HINT, tone === "success" ? "info" : "error");
      return;
    }
    options.onToast(message, tone);
  }

  const close = openModal(content, {
    wide: true,
    onClose: () => {
      closed = true;
      for (const stop of listeners) stop();
      listeners.length = 0;
    },
  });

  content.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-close]")) close();
  });

  for (const button of tabs) {
    button.addEventListener("click", () => setTab(button.dataset.tab as Tab));
  }
  bankButton?.addEventListener("click", () => void loadBank());
  refreshButton?.addEventListener("click", () => void loadList(true));

  function setTab(next: Tab): void {
    tab = next;
    for (const button of tabs) {
      button.classList.toggle("is-active", button.dataset.tab === next);
    }
    const loaded = next === "submitted" ? submitted : pending;
    if (loaded === null) {
      void loadList();
      return;
    }
    view = "list";
    render();
  }

  function currentList(): ZhsExamList | null {
    return tab === "submitted" ? submitted : pending;
  }

  async function loadList(force = false): Promise<void> {
    if (busy && !force) return;
    busy = true;
    view = "list";
    render();
    try {
      const list = await api.zhsExamList(
        options.recruitId,
        options.courseId,
        tab === "submitted",
      );
      if (tab === "submitted") submitted = list;
      else pending = list;
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      busy = false;
      render();
    }
  }

  async function loadBank(): Promise<void> {
    busy = true;
    view = "bank";
    render();
    try {
      bank = await api.zhsExamBankInfo();
    } catch (error) {
      notify(errorText(error), "error");
      view = "list";
    } finally {
      busy = false;
      render();
    }
  }

  async function openPaper(homework: ZhsHomework): Promise<void> {
    busy = true;
    view = "paper";
    paper = null;
    paperTitle = homework.name;
    render();
    try {
      paper = await api.zhsExamPaper(
        options.recruitId,
        options.courseId,
        homework.examId,
        true,
      );
    } catch (error) {
      notify(errorText(error), "error");
      view = "list";
    } finally {
      busy = false;
      render();
    }
  }

  async function openAttempt(homework: ZhsHomework): Promise<void> {
    const ok = window.confirm(
      `打开网页作答窗口：${homework.name}\n\n` +
        `1. 窗口会加载平台「作答」页；若出现滑块验证，请先在窗口内手动完成（只此一次）。\n` +
        `2. 完成后脚本会读取题目并向本地答案库请求计划，窗口内显示「已解析 X/Y 题」和未解析列表。\n` +
        `3. 计划完整：点「开始自动作答（全解析）」严格提交；计划不完整：点红色「容错试做」（未解析题任选首项，会得低分）先提交，之后在「已提交」点「网页重做」重新提交。\n\n` +
        `真实提交可能消耗一次尝试机会。确认打开窗口？`,
    );
    if (!ok) return;
    try {
      await api.zhsExamOpenAttemptWindow(
        options.recruitId,
        options.courseId,
        homework.examId,
      );
      lastAttempt = homework;
      notify(
        "作答窗口已打开：请完成滑块验证，并在窗口内确认计划后点击「开始自动作答」或红色「容错试做」",
        "info",
      );
      // The attempt may finish while this modal is open; refresh next time.
      pending = null;
      submitted = null;
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  async function openHarvest(homework: ZhsHomework): Promise<void> {
    const ok = window.confirm(
      `打开 AI解析采集窗口？\n\n` +
        `窗口会加载「查看已提交试卷」页，逐个点击「AI解析」并收集解析文本写入本地答案库；\n` +
        `不会提交试卷、不会作答。采集需要几分钟，请保持窗口打开。`,
    );
    if (!ok) return;
    try {
      await api.zhsExamOpenCheckWindow(
        options.recruitId,
        options.courseId,
        homework.examId,
      );
      notify("采集窗口已打开：完成后会提示写入结果", "info");
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  async function submitImport(): Promise<void> {
    if (!importing) return;
    const textarea = body.querySelector<HTMLTextAreaElement>(
      "#zhs-exam-import",
    );
    const raw = textarea?.value.trim() ?? "";
    if (!raw) {
      notify("请先粘贴 JSON", "error");
      return;
    }
    let entries: ZhsAiEntry[];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        entries = parsed.map((item) => {
          const row = item as Partial<ZhsAiEntry>;
          return {
            questionId: row.questionId ?? null,
            index: row.index ?? null,
            text: String(row.text ?? ""),
          };
        });
      } else if (parsed && typeof parsed === "object") {
        entries = Object.entries(parsed as Record<string, unknown>).map(
          ([questionId, value]) => ({
            questionId,
            index: null,
            text: typeof value === "string" ? value : JSON.stringify(value),
          }),
        );
      } else {
        throw new Error("JSON 必须是 {questionId: 解析文本} 或条目数组");
      }
    } catch (error) {
      notify(`JSON 解析失败：${errorText(error)}`, "error");
      return;
    }
    busy = true;
    render();
    try {
      const recorded = await api.zhsExamRecordAi(
        options.recruitId,
        options.courseId,
        importing.examId,
        entries,
      );
      notify(
        `已写入 ${recorded.recorded} 题，跳过 ${recorded.skipped} 题；题库共 ${recorded.bankTotal} 条`,
        "success",
      );
      importing = null;
      view = "list";
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      busy = false;
      render();
    }
  }

  // ---- render -----------------------------------------------------------

  function render(): void {
    if (closed) return;
    if (view === "list") renderList();
    else if (view === "paper") renderPaper();
    else if (view === "bank") renderBank();
    else renderImport();
  }

  function renderLoading(text: string): void {
    body.innerHTML = `<div class="exam-loading"><span class="spinner spinner-sm"></span> ${esc(
      text,
    )}</div>`;
  }

  function renderList(): void {
    const list = currentList();
    if (busy && !list) {
      renderLoading("正在读取作业/考试列表…");
      return;
    }
    if (!list) {
      renderLoading("正在读取作业/考试列表…");
      void loadList();
      return;
    }
    const homework = list.homework;
    const finals = list.finals;
    const cards = homework
      .map((item) => {
        const submittedPaper = isSubmitted(item);
        const isNext =
          tab === "submitted" && justSubmitted?.examId === item.examId;
        const harvestPrimary = MAINTAINER_MODE && isNext && !justHarvested;
        const retakePrimary = isNext && (!MAINTAINER_MODE || justHarvested);
        return `
        <article class="exam-card${isNext ? " is-next-step" : ""}">
          <div class="exam-card-main">
            <div class="exam-card-head">
              <span class="kind-pill kind-work">${icon("work", 13)} ${
                submittedPaper ? "已提交" : "待作答"
              }</span>
              <span class="badge ${
                submittedPaper ? "badge-good" : "badge-muted"
              }">${esc(stateText(item))}</span>
              ${isNext ? `<span class="badge badge-warn">刚提交</span>` : ""}
            </div>
            <h3>${esc(item.name)}</h3>
            <p class="exam-card-meta">${paperBadges(item)}</p>
          </div>
          <div class="exam-card-actions">
            ${
              submittedPaper
                ? `<button class="btn btn-sm btn-ghost" data-act="paper" data-id="${esc(
                    item.examId,
                  )}">${icon("document", 13)} 看试卷</button>
                   ${
                     MAINTAINER_MODE
                       ? `<button class="btn btn-sm ${
                           harvestPrimary ? "btn-primary" : ""
                         }" data-act="harvest" data-id="${esc(item.examId)}">${icon(
                           "spark",
                           13,
                         )} 采集 AI解析${harvestPrimary ? "（下一步）" : ""}</button>
                          <button class="btn btn-sm btn-ghost" data-act="import" data-id="${esc(
                            item.examId,
                          )}">${icon("copy", 13)} 手动导入</button>`
                       : ""
                   }
                   <button class="btn btn-sm ${
                     retakePrimary ? "btn-primary" : "btn-ghost"
                   }" data-act="attempt" data-id="${esc(item.examId)}">${icon(
                     "play",
                     13,
                   )} 网页重做</button>`
                : `<button class="btn btn-sm btn-primary" data-act="attempt" data-id="${esc(
                    item.examId,
                  )}">${icon("play", 13)} 网页作答（滑块）</button>`
            }
          </div>
        </article>`;
      })
      .join("");

    const finalsHtml = finals.length
      ? `
        <div class="exam-section-title">${icon(
          "alert",
          14,
        )} 期末 / 教程考试（仅 1 次机会，不自动提交）</div>
        ${finals
          .map(
            (item) => `
            <article class="exam-card is-final">
              <div class="exam-card-main">
                <div class="exam-card-head">
                  <span class="kind-pill kind-live">${icon("live", 13)} 期末</span>
                  <span class="badge badge-warn">仅 1 次机会 · 不自动提交</span>
                </div>
                <h3>${esc(item.name)}</h3>
                <p class="exam-card-meta">
                  ${
                    item.problemNum === null
                      ? ""
                      : `<span class="exam-badge">${item.problemNum} 题</span>`
                  }
                  ${
                    item.totalScore === null
                      ? ""
                      : `<span class="exam-badge">总分 ${item.totalScore}</span>`
                  }
                  ${
                    item.limitTime === null
                      ? ""
                      : `<span class="exam-badge">限时 ${item.limitTime} 分钟</span>`
                  }
                  ${
                    item.remainCount === null
                      ? ""
                      : `<span class="exam-badge">剩余 ${item.remainCount} 次</span>`
                  }
                </p>
              </div>
              <div class="exam-card-actions">
                <button class="btn btn-sm btn-ghost" data-act="final-hint">${icon(
                  "document",
                  13,
                )} 查看说明</button>
              </div>
            </article>`,
          )
          .join("")}`
      : "";

    // End users are guided to retake-and-submit only; the harvest step is a
    // maintainer task (hidden behind `#dev`).
    const nextStepBanner =
      tab === "submitted" && justSubmitted
        ? MAINTAINER_MODE
          ? `
      <div class="exam-next-step">
        <div class="exam-next-step-main">
          <strong>「${esc(justSubmitted.name)}」已提交${
            justHarvested ? "，AI解析已写入答案库" : ""
          }。</strong>
          <p>${
            justHarvested
              ? "维护模式：点「网页重做」按答案库作答并提交。"
              : "维护模式：先「采集 AI解析」写入答案库（仅维护者使用），完成后再「网页重做」。"
          }</p>
        </div>
        ${
          justHarvested
            ? `<button class="btn btn-primary" data-act="attempt" data-id="${esc(
                justSubmitted.examId,
              )}">${icon("play", 14)} 网页重做</button>`
            : `<button class="btn btn-primary" data-act="harvest" data-id="${esc(
                justSubmitted.examId,
              )}">${icon("spark", 14)} 采集 AI解析</button>`
        }
      </div>`
          : `
      <div class="exam-next-step">
        <div class="exam-next-step-main">
          <strong>「${esc(justSubmitted.name)}」已提交。</strong>
          <p>下一步：点「重做并提交」重新作答；窗口内仍需手动完成滑块验证。</p>
        </div>
        <button class="btn btn-primary" data-act="attempt" data-id="${esc(
          justSubmitted.examId,
        )}">${icon("play", 14)} 重做并提交</button>
      </div>`
        : "";

    body.innerHTML = `
      ${nextStepBanner}
      ${
        list.finalsError
          ? `<div class="inline-notice notice-warn">${icon(
              "alert",
              14,
            )} 期末列表读取失败：${esc(list.finalsError)}</div>`
          : ""
      }
      ${
        homework.length
          ? cards
          : `<div class="empty-panel compact"><div class="empty-icon">${icon(
              "work",
              24,
            )}</div><h2>${
              tab === "submitted" ? "没有已提交的作业" : "没有待作答的作业"
            }</h2><p>可点击“刷新”重新读取；期末只在此处列出，不自动提交。</p></div>`
      }
      ${finalsHtml}
    `;

    body.onclick = (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<HTMLElement>("[data-act]");
      if (!button) return;
      const act = button.dataset.act;
      const item = homework.find(
        (entry) => entry.examId === (button.dataset.id ?? ""),
      );
      if (act === "paper" && item) void openPaper(item);
      else if (act === "harvest" && item) void openHarvest(item);
      else if (act === "import" && item) {
        importing = item;
        view = "import";
        render();
      } else if (act === "attempt" && item) void openAttempt(item);
      else if (act === "final-hint") {
        notify(
          "期末考试只有 1 次机会，GUI 仅列出、不自动提交，也不读取未提交试卷（读取会开始计时）。请在平台网页端自行参加。",
          "info",
        );
      }
    };
  }

  function renderPaper(): void {
    if (busy || !paper) {
      renderLoading("正在读取试卷（只读，不会进入考试）…");
      return;
    }
    body.innerHTML = `
      <div class="exam-view-head">
        <button class="btn btn-sm btn-ghost" data-back>${icon("chevron", 13)} 返回列表</button>
        <div class="exam-view-title">${esc(paperTitle)}</div>
      </div>
      <p class="exam-hint">
        ${esc(paper.examName)} · ${paper.questionCount} 题 · 总分 ${paper.totalScore} · 平台不提供正确答案
      </p>
      <div class="exam-question-list">
        ${paper.questions
          .map(
            (question, index) => `
            <div class="exam-question">
              <div class="exam-question-head">
                <span class="exam-index">${index + 1}</span>
                <span class="exam-kind">${esc(question.kindName || "选择题")} · ${question.score} 分</span>
              </div>
              <div class="exam-stem">${esc(question.stem)}</div>
              <div class="exam-options">
                ${question.options
                  .map(
                    (option) => `
                    <div class="exam-option">
                      <span class="exam-option-id">${esc(option.id)}</span>
                      <span>${esc(option.content)}</span>
                    </div>`,
                  )
                  .join("")}
              </div>
            </div>`,
          )
          .join("")}
      </div>
    `;
    body.onclick = (event) => {
      if ((event.target as HTMLElement).closest("[data-back]")) {
        view = "list";
        render();
      }
    };
  }

  function renderBank(): void {
    const info = bank;
    const head = `
      <div class="exam-view-head">
        <button class="btn btn-sm btn-ghost" data-back>${icon("chevron", 13)} 返回列表</button>
        <div class="exam-view-title">答案库统计</div>
      </div>`;
    if (!info) {
      body.innerHTML = `${head}<div class="exam-loading"><span class="spinner spinner-sm"></span> 正在读取答案库…</div>`;
    } else {
      body.innerHTML = `
        ${head}
        <div class="stat-strip">
          <div class="stat-card">
            <span class="stat-label">总条目</span>
            <strong>${info.total}</strong>
          </div>
          <div class="stat-card">
            <span class="stat-label">已提交满分</span>
            <strong>${info.submittedEntries}</strong>
          </div>
          <div class="stat-card">
            <span class="stat-label">AI解析</span>
            <strong>${info.aiEntries}</strong>
          </div>
          <div class="stat-card">
            <span class="stat-label">最近更新</span>
            <strong>${
              info.updatedAtUnix
                ? esc(new Date(info.updatedAtUnix * 1000).toLocaleString())
                : "—"
            }</strong>
          </div>
        </div>
        <p class="exam-hint">存储位置：<code>${esc(info.path)}</code></p>
      `;
    }
    body.onclick = (event) => {
      if ((event.target as HTMLElement).closest("[data-back]")) {
        view = "list";
        render();
      }
    };
  }

  function renderImport(): void {
    if (!importing) {
      view = "list";
      render();
      return;
    }
    body.innerHTML = `
      <div class="exam-view-head">
        <button class="btn btn-sm btn-ghost" data-back>${icon("chevron", 13)} 返回列表</button>
        <div class="exam-view-title">手动导入 · ${esc(importing.name)}</div>
      </div>
      <p class="exam-hint">
        粘贴 AI解析 文本 JSON：<code>{"questionId": "解析文本", ...}</code>，或
        <code>[{"questionId": "...", "index": 0, "text": "..."}]</code>。
        只有已提交试卷可以写入答案库。
      </p>
      <textarea id="zhs-exam-import" class="exam-import-area" spellcheck="false"
        placeholder='{"demo-q-3": "正确答案是A。国防是国家生存与发展的安全保障……"}'></textarea>
      <div class="exam-import-actions">
        <button class="btn btn-primary" data-import-submit ${
          busy ? "disabled" : ""
        }>${icon("save", 14)} 写入答案库</button>
      </div>
    `;
    body.onclick = (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-back]")) {
        importing = null;
        view = "list";
        render();
        return;
      }
      if (target.closest("[data-import-submit]")) void submitImport();
    };
  }

  // ---- live events ------------------------------------------------------

  if (MAINTAINER_MODE) {
    void onZhsExamAi((event) => {
      if (closed) return;
      notify(
        `AI解析写入完成：记录 ${event.recorded} 题、跳过 ${event.skipped} 题；题库共 ${event.bankTotal} 条`,
        "success",
      );
      bank = null;
      pending = null;
      submitted = null;
      if (justSubmitted) {
        justHarvested = true;
        if (tab === "submitted") void loadList(true);
      }
      if (view === "bank") void loadBank();
    })
      .then((stop) => listeners.push(stop))
      .catch(() => undefined);
  }

  void onZhsExamResult((event) => {
    if (closed) return;
    notify(
      event.score === null
        ? "网页作答已提交（成绩待平台刷新）"
        : `网页作答已提交：${event.score} 分，正确 ${event.correctCount}/${event.questionCount} 题。下一步：点「重做并提交」重新作答。`,
      event.correctCount === event.questionCount ? "success" : "info",
    );
    const homework = lastAttempt;
    lastAttempt = null;
    pending = null;
    submitted = null;
    if (homework) {
      // Mark the paper as submitted and surface the retake-and-submit step.
      justSubmitted = homework;
      justHarvested = false;
      if (tab !== "submitted") {
        tab = "submitted";
        for (const button of tabs) {
          button.classList.toggle("is-active", button.dataset.tab === "submitted");
        }
      }
      view = "list";
      void loadList(true);
    } else if (view === "list") {
      render();
    }
  })
    .then((stop) => listeners.push(stop))
    .catch(() => undefined);

  render();
  void loadList();
}
