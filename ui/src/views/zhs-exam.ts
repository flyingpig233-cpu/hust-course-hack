import { api, onZhsExamAi, onZhsExamRedo, onZhsExamResult } from "../api";
import type { ToastTone } from "../dom";
import { errorText, esc, openModal, qs } from "../dom";
import { icon } from "../icons";
import type {
  ZhsAiEntry,
  ZhsBankInfo,
  ZhsExamList,
  ZhsExamPaper,
  ZhsExamSummary,
  ZhsHomework,
} from "../types";

export interface ZhsExamModalOptions {
  recruitId: number;
  courseId: number;
  courseName: string;
  /** Course-page stat summary (fetched in parallel with the course detail). */
  summary?: ZhsExamSummary | null;
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

/**
 * Platform state codes observed on the real account (2026-11):
 * 1 = 未提交 (pending list), 4 = 已提交 (submitted list). 2/3 are best-effort
 * labels for grading states; unknown values fall back to the raw number.
 */
const STATE_TEXT: Record<number, string> = {
  1: "未提交",
  2: "待批阅",
  3: "批阅中",
  4: "已提交",
};

/**
 * State badge. The list is already split by the `submitted` flag passed to
 * `zhs_exam_list`, so that flag — not the state code — decides the card mode.
 */
function stateBadge(homework: ZhsHomework, submittedFlag: boolean): {
  label: string;
  title: string;
} {
  if (homework.state === null) {
    return {
      label: submittedFlag ? "已提交" : "未提交",
      title: "平台未返回 state 字段，按列表类型显示",
    };
  }
  const label =
    STATE_TEXT[homework.state] ?? `状态 ${homework.state}`;
  return {
    label,
    title: `平台 state=${homework.state}（列表：${
      submittedFlag ? "已提交" : "未提交"
    }）`,
  };
}

function attemptText(homework: ZhsHomework): string {
  const remaining = homework.backNum;
  if (remaining === null) return "剩余重做次数未知";
  return `剩余重做 ${remaining} 次`;
}

/**
 * Platform 「作业成绩」 equals the API `score` field; `achieve` is not shown as
 * a best score on the submitted page, so only `score` is displayed. The raw
 * `score/achieve` values stay in the badge tooltip for diagnostics.
 */
function scoreText(homework: ZhsHomework): string | null {
  const score = homework.score ?? homework.achieve;
  return score === null ? null : `得分 ${score}`;
}

function paperBadges(homework: ZhsHomework): string {
  const bits: string[] = [];
  if (homework.problemNum !== null) bits.push(`${homework.problemNum} 题`);
  if (homework.totalScore !== null) bits.push(`总分 ${homework.totalScore}`);
  if (homework.meetCourseType === 1) bits.push("见面课测验");
  const score = scoreText(homework);
  if (score !== null) bits.push(score);
  bits.push(attemptText(homework));
  const raw = `平台字段：score=${homework.score ?? "null"} achieve=${
    homework.achieve ?? "null"
  } backNum=${homework.backNum ?? "null"} achieveCount=${
    homework.achieveCount ?? "null"
  } state=${homework.state ?? "null"}`;
  return bits
    .map(
      (bit) =>
        `<span class="exam-badge" title="${esc(raw)}">${esc(bit)}</span>`,
    )
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
        <p class="modal-sub" id="zhs-exam-summary"></p>
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
  let examSummary: ZhsExamSummary | null = options.summary ?? null;
  let redoUnsupported = false;
  let redoBusy = false;
  let pendingRedo: ZhsHomework | null = null;
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

  function summaryText(summary: ZhsExamSummary): string {
    const average =
      summary.averageScore === null ? "—" : `${summary.averageScore}`;
    return (
      `作业/测验 ${summary.homeworkSubmitted} / ${summary.homeworkTotal} 已完成` +
      ` · 平均 ${average} 分` +
      ` · 期末 ${summary.finalExamSubmitted} / ${summary.finalExamCount} 已完成`
    );
  }

  function renderSummaryLine(): void {
    const el = qs<HTMLElement>("#zhs-exam-summary", content);
    if (!el) return;
    el.textContent = examSummary ? summaryText(examSummary) : "";
  }

  async function refreshSummary(): Promise<void> {
    try {
      examSummary = await api.zhsExamSummary(options.recruitId, options.courseId);
      renderSummaryLine();
      render();
    } catch {
      // Stats are best effort; the 作业/考试 list stays usable without them.
    }
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
      void refreshSummary();
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

  async function openAttempt(
    homework: ZhsHomework,
    askConfirm = true,
  ): Promise<void> {
    const ok =
      !askConfirm ||
      window.confirm(
      `打开网页作答窗口：${homework.name}\n\n` +
        `1. 窗口会加载平台「作答」页；若出现滑块/安全验证（网易易盾），请先在窗口内手动完成（只此一次，自动继续）。\n` +
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

  /** 申请重做: the list webview performs the click sequence and reports an event. */
  async function openRedo(homework: ZhsHomework): Promise<void> {
    if (redoBusy) return;
    if (homework.backNum === 0) {
      notify("平台显示剩余重做次数为 0，无法申请重做。", "info");
      return;
    }
    const ok = window.confirm(
      `申请重做：${homework.name}\n\n` +
        `会打开考试列表窗口，自动切到「已提交」并点击「申请重做」→「确定」。\n` +
        `成功后自动刷新列表并打开作答窗口（窗口内仍需手动完成滑块/安全验证）。\n` +
        `是否继续？`,
    );
    if (!ok) return;
    redoBusy = true;
    pendingRedo = homework;
    try {
      const result = await api.zhsExamRedo(
        options.recruitId,
        options.courseId,
        homework.name || homework.examId,
      );
      notify(result.message || "已打开考试列表窗口，正在自动申请重做…", "info");
    } catch (error) {
      pendingRedo = null;
      redoBusy = false;
      const message = errorText(error);
      if (/抓包|暂不可用|applyRedo|待确认|不支持/.test(message)) {
        redoUnsupported = true;
      }
      notify(message, "error");
      if (view === "list") render();
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
        const submittedPaper = tab === "submitted";
        const state = stateBadge(item, submittedPaper);
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
              }" title="${esc(state.title)}">${esc(state.label)}</span>
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
                   <button class="btn btn-sm btn-ghost" data-act="redo" data-id="${esc(
                     item.examId,
                   )}" ${
                     redoUnsupported || item.backNum === 0 ? "disabled" : ""
                   } title="${
                     redoUnsupported
                       ? "平台重做接口参数待确认，暂不可用"
                       : item.backNum === 0
                         ? "剩余重做次数为 0"
                         : "申请一次重做，成功后自动打开作答窗口"
                   }">${icon("refresh", 13)} 申请重做</button>
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
      else if (act === "redo" && item) void openRedo(item);
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

  void onZhsExamRedo((event) => {
    if (closed) return;
    const homework = pendingRedo;
    pendingRedo = null;
    redoBusy = false;
    if (!event.ok) {
      notify(
        `申请重做失败：${event.reason || "未知原因"}（窗口已保留，可查看诊断面板和日志）`,
        "error",
      );
      render();
      return;
    }
    notify("申请重做成功，正在刷新列表并打开作答窗口…", "success");
    pending = null;
    submitted = null;
    tab = "pending";
    for (const button of tabs) {
      button.classList.toggle("is-active", button.dataset.tab === "pending");
    }
    view = "list";
    void (async () => {
      await loadList(true);
      const list = currentList();
      const target =
        list?.homework.find((item) => item.examId === event.examId) ??
        homework;
      if (target) await openAttempt(target, false);
    })();
  })
    .then((stop) => listeners.push(stop))
    .catch(() => undefined);

  void onZhsExamResult((event) => {
    if (closed) return;
    const wrong = event.wrongQuestions ?? [];
    const wrongHint =
      wrong.length === 0
        ? ""
        : `；错 ${wrong.length} 题：${wrong
            .slice(0, 3)
            .map((question) => question.stem || question.questionId)
            .join("、")}${wrong.length > 3 ? "…" : ""}（不会自动重试）`;
    notify(
      event.score === null
        ? `网页作答已提交（成绩待平台刷新）${wrongHint}`
        : `网页作答已提交：${event.score} 分，正确 ${event.correctCount}/${event.questionCount} 题${wrongHint}。下一步：点「重做并提交」重新作答。`,
      wrong.length === 0 ? "success" : "info",
    );
    void refreshSummary();
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
