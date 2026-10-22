import "./styles.css";
import {
  api,
  onJobProgress,
  onLoginClosed,
  onSessionChanged,
} from "./api";
import { errorText, qs, toast } from "./dom";
import { isTauri } from "./env";
import { safeFileName } from "./format";
import { openExternal, pickSavePath } from "./platform";
import type { CourseDetail, CourseSummary, CrawlOptions, SessionInfo } from "./types";
import { renderConnect, renderHome, type LoginStatus } from "./views/connect";
import {
  markJobCompleted,
  markWorkSubmitted,
  renderCourse,
  renderCourseError,
  renderCourseLoading,
  updateCrawlProgress,
} from "./views/course";
import { openHelperModal } from "./views/helper";
import { openQuizModal } from "./views/quiz";
import { createSidebar } from "./views/sidebar";
import { openWatchModal } from "./views/watch";

const app = qs<HTMLElement>("#app");
app.innerHTML = `
  <div class="app-shell">
    <aside class="sidebar" id="sidebar"></aside>
    <main class="main" id="main"></main>
  </div>
`;

const main = qs<HTMLElement>("#main");

const store = {
  session: null as SessionInfo | null,
  courses: [] as CourseSummary[],
  selectedId: null as string | null,
  busy: false,
  details: new Map<string, CourseDetail>(),
  options: {
    includeQuestions: true,
    includeVideoInfo: true,
    concurrency: 4,
  } as CrawlOptions,
  bankQuestions: null as number | null,
  loginStatus: "idle" as LoginStatus,
  loginError: null as string | null,
};

const sidebar = createSidebar(qs<HTMLElement>("#sidebar"), {
  onSelect: (courseId) => void selectCourse(courseId),
  onRefreshCourses: () => void refreshCourses(),
  onDisconnect: () => void disconnect(),
  onHelper: () => void openHelperModal(),
});

function updateSidebar(): void {
  sidebar.update({
    session: store.session,
    courses: store.courses,
    selectedId: store.selectedId,
    disabled: store.busy,
  });
}

function currentSummary(): CourseSummary | null {
  return (
    store.courses.find((course) => course.course_id === store.selectedId) ?? null
  );
}

function showHome(): void {
  if (!store.session) {
    showConnect();
    return;
  }
  updateSidebar();
  main.onclick = null;
  main.onchange = null;
  renderHome(main, store.session, store.courses, {
    onSelect: (courseId) => void selectCourse(courseId),
    onRefreshCourses: () => void refreshCourses(),
    onHelper: () => void openHelperModal(),
  });
}

function showConnect(): void {
  store.selectedId = null;
  updateSidebar();
  renderConnect(main, {
    status: store.loginStatus,
    error: store.loginError,
    onLogin: () => void startLogin(),
  });
}

/** The login window verified the platform session. */
async function adoptSession(info: SessionInfo): Promise<void> {
  store.session = info;
  store.loginStatus = "idle";
  store.loginError = null;
  store.selectedId = null;
  store.details.clear();
  updateSidebar();

  try {
    store.courses = await api.listCourses();
  } catch (error) {
    toast(errorText(error), "error");
  }
  updateSidebar();
  showHome();
  toast("已通过学校统一身份认证登录", "success");
}

async function startLogin(): Promise<void> {
  if (store.loginStatus === "opening" || store.loginStatus === "waiting") return;
  store.loginStatus = "opening";
  store.loginError = null;
  // Re-render after the click event finishes so the pressed button is not
  // detached mid-click.
  window.setTimeout(showConnect, 0);
  try {
    await api.openLoginWindow();
    if (store.session) return;
    store.loginStatus = "waiting";
    showConnect();
  } catch (error) {
    store.loginStatus = "failed";
    store.loginError = errorText(error);
    showConnect();
  }
}

function handleLoginClosed(): void {
  if (store.session) return;
  if (store.loginStatus !== "opening" && store.loginStatus !== "waiting") return;
  store.loginStatus = "failed";
  store.loginError =
    "登录窗口已关闭，未获取到学校会话。请重新打开登录窗口完成统一身份认证。";
  showConnect();
}

async function subscribeAuthEvents(): Promise<void> {
  try {
    await onSessionChanged((info) => void adoptSession(info));
    await onLoginClosed(() => handleLoginClosed());
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function selectCourse(courseId: string): Promise<void> {
  if (store.busy) {
    toast("正在抓取课程，请先取消当前任务");
    return;
  }
  const summary = store.courses.find(
    (course) => course.course_id === courseId,
  );
  if (!summary) return;

  const cached = store.details.get(courseId);
  if (cached && store.selectedId === courseId) return;

  store.selectedId = courseId;
  updateSidebar();
  if (cached) {
    showDetail(cached);
    return;
  }
  await loadCourse(summary);
}

async function loadCourse(summary: CourseSummary): Promise<void> {
  if (store.busy) return;
  store.busy = true;
  updateSidebar();
  renderCourseLoading(main, summary, () => void cancelCurrentJob());

  let unlisten: (() => void) | null = null;
  let loaded: CourseDetail | null = null;
  let failure: string | null = null;

  try {
    unlisten = await onJobProgress((progress) => {
      if (progress.kind === "crawl") {
        updateCrawlProgress(main, progress.done, progress.total);
      }
    });
    loaded = await api.fetchCourse(summary.course_id, store.options);
    store.details.set(summary.course_id, loaded);
  } catch (error) {
    failure = errorText(error);
  } finally {
    unlisten?.();
    store.busy = false;
    updateSidebar();
  }

  if (store.selectedId !== summary.course_id) return;

  if (loaded) {
    showDetail(loaded);
    return;
  }
  if (failure?.includes("已取消")) {
    store.selectedId = null;
    toast("已取消抓取", "info");
    showHome();
    return;
  }
  if (failure) {
    renderCourseError(main, summary, failure, () => void loadCourse(summary));
  }
}

function refreshCourse(): void {
  const summary = currentSummary();
  if (!summary || store.busy) return;
  store.details.delete(summary.course_id);
  void loadCourse(summary);
}

function showDetail(detail: CourseDetail): void {
  renderCourse(main, detail, {
    busy: store.busy,
    options: store.options,
    bankQuestions: store.bankQuestions,
    onRefresh: refreshCourse,
    onCancel: () => void cancelCurrentJob(),
    onWatch: (jobId) => openWatch(detail, jobId),
    onQuiz: (workId) => openQuiz(detail, workId),
    onExport: () => void exportDetail(detail),
    onOpenUrl: (url) => {
      void openExternal(url).catch((error) => toast(errorText(error), "error"));
    },
    onOptionsChange: (options) => {
      store.options = options;
      toast("抓取设置已更新，点击刷新后生效");
    },
  });
}

function openWatch(detail: CourseDetail, jobId?: string | null): void {
  openWatchModal({
    courseId: detail.course_id,
    courseName: detail.title,
    jobId,
    onToast: (message, tone) => toast(message, tone),
    onPassed: (jobIds) => {
      let changed = false;
      for (const id of jobIds) {
        changed = markJobCompleted(detail, id) || changed;
      }
      if (changed) showDetail(detail);
    },
  });
}

function openQuiz(detail: CourseDetail, workId?: string | null): void {
  openQuizModal({
    courseId: detail.course_id,
    courseName: detail.title,
    workId,
    bankQuestions: store.bankQuestions,
    onToast: (message, tone) => toast(message, tone),
    onSubmitted: (workIds) => {
      let changed = false;
      for (const id of workIds) {
        changed = markWorkSubmitted(detail, id) || changed;
      }
      if (changed) showDetail(detail);
    },
  });
}

async function exportDetail(detail: CourseDetail): Promise<void> {
  try {
    const path = await pickSavePath(
      `${safeFileName(detail.title)}.json`,
      "课程 JSON",
      ["json"],
    );
    if (!path) return;
    const payload = {
      generated_at_unix: Math.floor(Date.now() / 1000),
      course: detail,
    };
    await api.saveTextFile(path, JSON.stringify(payload, null, 2));
    toast("课程 JSON 已导出", "success");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function refreshCourses(): Promise<void> {
  try {
    const courses = await api.listCourses();
    store.courses = courses;
    const stillExists =
      !store.selectedId || courses.some((course) => course.course_id === store.selectedId);
    if (!stillExists) {
      store.selectedId = null;
      store.details.clear();
      showHome();
    } else if (!store.selectedId) {
      showHome();
    }
    updateSidebar();
    toast(`课程列表已刷新，共 ${courses.length} 门课程`, "success");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function cancelCurrentJob(): Promise<void> {
  try {
    await api.cancelJob();
    toast("正在取消任务…", "info");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function disconnect(): Promise<void> {
  if (store.busy) {
    await api.cancelJob().catch(() => undefined);
  }
  try {
    await api.disconnect();
  } catch (error) {
    toast(errorText(error), "error");
  }
  store.session = null;
  store.courses = [];
  store.selectedId = null;
  store.details.clear();
  store.busy = false;
  store.loginStatus = "idle";
  store.loginError = null;
  showConnect();
}

async function boot(): Promise<void> {
  updateSidebar();
  try {
    store.bankQuestions = (await api.answerBankInfo()).questions;
  } catch {
    store.bankQuestions = null;
  }
  await subscribeAuthEvents();
  try {
    store.session = await api.sessionInfo();
  } catch (error) {
    toast(errorText(error), "error");
  }

  if (!store.session) {
    showConnect();
    if (!isTauri) {
      window.setTimeout(
        () => toast("演示模式：使用内置示例课程，不会访问真实平台", "info"),
        500,
      );
    }
    return;
  }

  try {
    store.courses = await api.listCourses();
  } catch (error) {
    toast(errorText(error), "error");
  }
  updateSidebar();
  showHome();
}

void boot();
