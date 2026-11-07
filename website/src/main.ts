import "./styles.css";
import {
  api,
  onJobProgress,
  onLoginClosed,
  onSessionChanged,
  onUlSessionChanged,
  onZhsSessionChanged,
  ulApi,
  zhsApi,
} from "./api";
import { errorText, qs, toast } from "./dom";
import { isDemo } from "./env";
import { safeFileName } from "./format";
import { openExternal, pickSavePath } from "./platform";
import type { CourseDetail, CourseSummary, CrawlOptions, SessionInfo } from "./types";
import type { UlCourse, UlCourseDetail, UlSessionInfo } from "./core/ul/types";
import { ulPlayerUrl } from "./core/ul/types";
import type { ZhsCourse, ZhsCourseDetail, ZhsMeet, ZhsMeetProgress, ZhsSessionInfo } from "./core/zhs/types";
import { renderConnect, renderHome, type LoginStatus, type Platform } from "./views/connect";
import {
  markDocumentCompleted,
  markJobCompleted,
  markWorkSubmitted,
  renderCourse,
  renderCourseError,
  renderCourseLoading,
  updateCrawlProgress,
} from "./views/course";
import { openDocumentModal } from "./views/document";
import { openHelperModal } from "./views/helper";
import { openQuizModal } from "./views/quiz";
import { createSidebar } from "./views/sidebar";
import { openWatchModal } from "./views/watch";
import { openZhsWatchModal, renderZhsCourse, renderZhsHome } from "./views/zhs-course";
import { openZhsMeetWatchModal, renderZhsMeet } from "./views/zhs-meet";
import { openUlWatchModal, renderUlCourse, renderUlHome } from "./views/ul-course";

const app = qs<HTMLElement>("#app");
app.innerHTML = `
  <div class="app-shell">
    <aside class="sidebar" id="sidebar"></aside>
    <main class="main" id="main"></main>
  </div>
`;

const main = qs<HTMLElement>("#main");
const requestedPlatform = new URLSearchParams(location.search).get("platform");

interface UlStore {
  session: UlSessionInfo | null;
  courses: UlCourse[];
  selected: string | null;
  detail: UlCourseDetail | null;
  loading: boolean;
}

interface ZhsStore {
  session: ZhsSessionInfo | null;
  courses: ZhsCourse[];
  selected: string | null;
  detail: ZhsCourseDetail | null;
  meets: ZhsMeet[];
  progress: Map<number, ZhsMeetProgress>;
  loading: boolean;
}

const store = {
  platform: (requestedPlatform === "zhs" ? "zhs" : requestedPlatform === "ul" ? "ul" : "hust") as Platform,
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
  ul: {
    session: null,
    courses: [],
    selected: null,
    detail: null,
    loading: false,
  } as UlStore,
  zhs: {
    session: null,
    courses: [],
    selected: null,
    detail: null,
    meets: [],
    progress: new Map<number, ZhsMeetProgress>(),
    loading: false,
  } as ZhsStore,
};

const sidebar = createSidebar(qs<HTMLElement>("#sidebar"), {
  onSelect: (courseId) => (store.platform === "zhs"
    ? void selectZhsCourse(courseId)
    : store.platform === "ul"
      ? void selectUlCourse(courseId)
      : void selectCourse(courseId)),
  onRefreshCourses: () => (store.platform === "zhs"
    ? void refreshZhsCourses()
    : store.platform === "ul"
      ? void refreshUlCourses()
      : void refreshCourses()),
  onDisconnect: () => void disconnect(),
  onHelper: () => void openHelperModal(),
});

function toSidebarCourse(course: ZhsCourse): CourseSummary {
  return {
    course_id: String(course.course_id),
    class_id: String(course.recruit_id),
    cpi: "",
    name: course.name || `课程 ${course.course_id}`,
    cover_url: null,
    source: null,
    kc_enc: null,
    ck_enc: null,
    clazz_enc: null,
    detail_url: "",
  };
}

function toSidebarUlCourse(course: UlCourse): CourseSummary {
  return {
    course_id: String(course.textbook_id),
    class_id: String(course.class_id),
    cpi: "",
    name: course.name || `课程 ${course.textbook_id}`,
    cover_url: null,
    source: null,
    kc_enc: null,
    ck_enc: null,
    clazz_enc: null,
    detail_url: "",
  };
}

function sidebarSession(): SessionInfo | null {
  if (store.platform === "zhs") {
    const session = store.zhs.session;
    return session ? { cookieSource: session.source, cookieCount: 0 } : null;
  }
  if (store.platform === "ul") {
    const session = store.ul.session;
    return session ? { cookieSource: session.source, cookieCount: 0 } : null;
  }
  return store.session;
}

function updateSidebar(): void {
  sidebar.update({
    session: sidebarSession(),
    courses: store.platform === "zhs"
      ? store.zhs.courses.map(toSidebarCourse)
      : store.platform === "ul"
        ? store.ul.courses.map(toSidebarUlCourse)
        : store.courses,
    selectedId: store.platform === "zhs" ? store.zhs.selected : store.platform === "ul" ? store.ul.selected : store.selectedId,
    disabled: store.platform === "zhs" ? store.zhs.loading : store.platform === "ul" ? store.ul.loading : store.busy,
    platform: store.platform,
  });
}

function currentSummary(): CourseSummary | null {
  return (
    store.courses.find((course) => course.course_id === store.selectedId) ?? null
  );
}

function showHome(): void {
  if (store.platform === "ul") {
    if (!store.ul.session) {
      showConnect();
      return;
    }
    updateSidebar();
    main.onclick = null;
    main.onchange = null;
    renderUlHome(main, store.ul.session, store.ul.courses, {
      onSelect: (courseId) => void selectUlCourse(courseId),
      onRefreshCourses: () => void refreshUlCourses(),
      onAddCourse: (ref) => void addUlCourse(ref),
    });
    return;
  }
  if (store.platform === "zhs") {
    if (!store.zhs.session) {
      showConnect();
      return;
    }
    updateSidebar();
    main.onclick = null;
    main.onchange = null;
    renderZhsHome(main, store.zhs.session, store.zhs.courses, {
      onSelect: (courseId) => void selectZhsCourse(courseId),
      onRefreshCourses: () => void refreshZhsCourses(),
      onAddCourse: (ref) => void addZhsCourse(ref),
    });
    return;
  }
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
  store.zhs.selected = null;
  store.ul.selected = null;
  updateSidebar();
  renderConnect(main, {
    platform: store.platform,
    status: store.loginStatus,
    error: store.loginError,
    onPlatformChange: (platform) => void changePlatform(platform),
    onLogin: () => void startLogin(),
  });
}

/** Switch platforms, disconnecting the previous one when a session exists. */
async function changePlatform(platform: Platform): Promise<void> {
  if (platform === store.platform) return;
  const connected = store.platform === "zhs"
    ? store.zhs.session !== null
    : store.platform === "ul"
      ? store.ul.session !== null
      : store.session !== null;
  if (connected) await disconnect();
  store.platform = platform;
  store.loginStatus = "idle";
  store.loginError = null;
  showConnect();
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
  toast(isDemo ? "已进入演示模式" : "已连接学校课程页面", "success");
}

/** The Zhihuishu popup handshake succeeded; load the shared-course list. */
async function adoptZhsSession(info: ZhsSessionInfo): Promise<void> {
  if (store.zhs.session && store.zhs.session.uuid === info.uuid) return;
  store.zhs.session = info;
  store.loginStatus = "idle";
  store.loginError = null;
  store.zhs.selected = null;
  store.zhs.detail = null;
  store.zhs.meets = [];
  store.zhs.progress.clear();
  updateSidebar();
  try {
    store.zhs.courses = await zhsApi.listCourses();
  } catch (error) {
    store.zhs.courses = [];
    toast(errorText(error), "error");
  }
  updateSidebar();
  showHome();
  toast(isDemo ? "已进入知到演示模式" : "已连接知到页面", "success");
}

/** The Ulearning popup handshake succeeded; the course list is user-added. */
async function adoptUlSession(info: UlSessionInfo): Promise<void> {
  if (store.ul.session) return;
  store.ul.session = info;
  store.loginStatus = "idle";
  store.loginError = null;
  store.ul.selected = null;
  store.ul.detail = null;
  updateSidebar();
  try {
    store.ul.courses = await ulApi.listCourses();
  } catch (error) {
    store.ul.courses = [];
    toast(errorText(error), "error");
  }
  updateSidebar();
  showHome();
  toast(isDemo ? "已进入优学院演示模式" : "已连接优学院页面", "success");
}

async function startLogin(): Promise<void> {
  if (store.loginStatus === "opening" || store.loginStatus === "waiting") return;
  store.loginStatus = "opening";
  store.loginError = null;
  // Re-render after the click event finishes so the pressed button is not
  // detached mid-click.
  window.setTimeout(showConnect, 0);
  try {
    if (store.platform === "ul") {
      const info = await ulApi.connect();
      if (!store.ul.session) await adoptUlSession(info);
      return;
    }
    if (store.platform === "zhs") {
      const info = await zhsApi.connect();
      if (!store.zhs.session) await adoptZhsSession(info);
      return;
    }
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
    await onZhsSessionChanged((info) => {
      if (store.platform === "zhs" && !store.zhs.session) void adoptZhsSession(info);
    });
    await onUlSessionChanged((info) => {
      if (store.platform === "ul" && !store.ul.session) void adoptUlSession(info);
    });
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
    onDocument: (jobId) => openDocument(detail, jobId),
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

// ---------------------------------------------------------------------------
// Zhihuishu flows
// ---------------------------------------------------------------------------

async function selectZhsCourse(courseId: string): Promise<void> {
  if (store.zhs.loading) {
    toast("正在抓取知到课程，请稍候");
    return;
  }
  const summary = store.zhs.courses.find(
    (course) => String(course.course_id) === courseId || String(course.recruit_id) === courseId,
  );
  if (!summary) return;
  store.zhs.selected = String(summary.course_id);
  if (store.zhs.detail && String(store.zhs.detail.course.course_id) === store.zhs.selected) {
    showZhsCourse(store.zhs.detail);
    return;
  }
  await loadZhsCourse(store.zhs.selected);
}

async function loadZhsCourse(courseId: string): Promise<void> {
  if (store.zhs.loading) return;
  store.zhs.loading = true;
  updateSidebar();
  main.innerHTML = `
    <div class="course-view">
      <div class="crawl-card">
        <div class="crawl-orb">${iconRefresh()}</div>
        <h2>正在抓取知到视频树</h2>
        <p>先取课程信息，再请求 <code>videolist</code>；完成状态来自平台的 <code>isStudiedLesson</code>。</p>
        <div class="progress progress-lg"><div class="progress-fill" style="width:0%"></div></div>
      </div>
    </div>
  `;
  let loaded: ZhsCourseDetail | null = null;
  let failed = false;
  try {
    loaded = await zhsApi.courseDetail(courseId);
    store.zhs.detail = loaded;
    store.zhs.courses = store.zhs.courses.map((course) =>
      course.course_id === loaded!.course.course_id ? loaded!.course : course,
    );
  } catch (error) {
    toast(errorText(error), "error");
    store.zhs.selected = null;
    failed = true;
  } finally {
    store.zhs.loading = false;
    updateSidebar();
  }
  if (loaded) showZhsCourse(loaded);
  else if (failed) showHome();
}

function iconRefresh(): string {
  return '<svg class="icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
}

function showZhsCourse(detail: ZhsCourseDetail): void {
  updateSidebar();
  renderZhsCourse(main, detail, {
    busy: store.zhs.loading,
    onBack: () => {
      store.zhs.selected = null;
      store.zhs.detail = null;
      showHome();
    },
    onRefresh: () => void refreshZhsCourse(),
    onWatch: () => openZhsWatch(detail),
    onMeet: () => void openZhsMeet(detail),
  });
}

async function refreshZhsCourse(): Promise<void> {
  const detail = store.zhs.detail;
  if (!detail || store.zhs.loading) return;
  await loadZhsCourse(String(detail.course.course_id));
}

async function refreshZhsCourses(): Promise<void> {
  try {
    store.zhs.courses = await zhsApi.listCourses();
    updateSidebar();
    showHome();
    toast(`知到课程列表已刷新，共 ${store.zhs.courses.length} 门`, "success");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function addZhsCourse(ref: string): Promise<void> {
  try {
    const course = await zhsApi.resolveCourse(ref);
    store.zhs.courses = [...store.zhs.courses.filter((item) => item.course_id !== course.course_id), course];
    updateSidebar();
    toast(`已添加课程：${course.name || course.course_id}`, "success");
    showHome();
  } catch (error) {
    toast(errorText(error), "error");
  }
}

function openZhsWatch(detail: ZhsCourseDetail): void {
  openZhsWatchModal({
    courseId: String(detail.course.course_id),
    courseName: detail.course.name || `课程 ${detail.course.course_id}`,
    onToast: (message, tone) => toast(message, tone),
    onFinished: (summary) => {
      if (!summary.cancelled) void refreshZhsCourse();
    },
  });
}

function openDocument(detail: CourseDetail, jobId?: string | null): void {
  openDocumentModal({
    courseId: detail.course_id,
    courseName: detail.title,
    jobId,
    onToast: (message, tone) => toast(message, tone),
    onCompleted: (jobIds) => {
      let changed = false;
      for (const id of jobIds) {
        changed = markDocumentCompleted(detail, id) || changed;
      }
      if (changed) showDetail(detail);
    },
  });
}

async function openZhsMeet(detail: ZhsCourseDetail): Promise<void> {
  store.zhs.detail = detail;
  store.zhs.progress.clear();
  try {
    const meets = await zhsApi.meetList(String(detail.course.course_id));
    store.zhs.meets = meets;
    showZhsMeet(detail.course, meets);
    for (const meet of meets) {
      if (meet.live_id !== 0) void loadZhsMeetProgress(metAid(meet));
    }
  } catch (error) {
    toast(errorText(error), "error");
  }
}

function metAid(meet: ZhsMeet): string {
  return String(meet.meet_course_id);
}

function showZhsMeet(course: ZhsCourse, meets: ZhsMeet[]): void {
  renderZhsMeet(main, course, meets, store.zhs.progress, {
    busy: store.zhs.loading,
    onBack: () => {
      const detail = store.zhs.detail;
      if (detail) showZhsCourse(detail);
      else showHome();
    },
    onRefresh: () => {
      const detail = store.zhs.detail;
      if (detail) void openZhsMeet(detail);
    },
    onLoadProgress: (meet) => void loadZhsMeetProgress(metAid(meet)),
    onWatch: (meet) => {
      openZhsMeetWatchModal({
        courseId: store.zhs.selected ?? "",
        courseName: course.name,
        meet,
        onToast: (message, tone) => toast(message, tone),
        onFinished: (summary) => {
          if (!summary.cancelled) void reloadZhsMeetProgress();
        },
      });
    },
  });
}

async function loadZhsMeetProgress(meetId: string): Promise<void> {
  const courseId = store.zhs.selected;
  if (!courseId) return;
  try {
    const progress = await zhsApi.meetProgress(courseId, Number(meetId));
    store.zhs.progress.set(Number(meetId), progress);
    const course = store.zhs.detail?.course;
    if (course && store.zhs.meets.length) showZhsMeet(course, store.zhs.meets);
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function reloadZhsMeetProgress(): Promise<void> {
  const course = store.zhs.detail?.course;
  if (!course) return;
  const meets = store.zhs.meets;
  showZhsMeet(course, meets);
  for (const meet of meets) {
    if (meet.live_id !== 0) void loadZhsMeetProgress(metAid(meet));
  }
}

// ---------------------------------------------------------------------------
// Ulearning flows
// ---------------------------------------------------------------------------

async function selectUlCourse(courseId: string): Promise<void> {
  if (store.ul.loading) {
    toast("正在抓取优学院课程，请稍候");
    return;
  }
  const summary = store.ul.courses.find(
    (course) => String(course.textbook_id) === courseId || String(course.class_id) === courseId,
  );
  if (!summary) return;
  store.ul.selected = String(summary.textbook_id);
  if (store.ul.detail && String(store.ul.detail.course.textbook_id) === store.ul.selected) {
    showUlCourse(store.ul.detail);
    return;
  }
  await loadUlCourse(store.ul.selected);
}

async function loadUlCourse(courseId: string): Promise<void> {
  if (store.ul.loading) return;
  store.ul.loading = true;
  updateSidebar();
  main.innerHTML = `
    <div class="course-view">
      <div class="crawl-card">
        <div class="crawl-orb"><span class="spinner"></span></div>
        <h2>正在抓取优学院课程树</h2>
        <p>读取 basicinformation / directory / 每节 studyrecord，页面较多时需要一点时间。</p>
        <div class="progress progress-lg"><div class="progress-fill" style="width:0%"></div></div>
      </div>
    </div>
  `;
  let loaded: UlCourseDetail | null = null;
  let failed = false;
  try {
    loaded = await ulApi.courseDetail(courseId);
    store.ul.detail = loaded;
    store.ul.courses = store.ul.courses.map((course) =>
      course.textbook_id === loaded!.course.textbook_id ? loaded!.course : course,
    );
  } catch (error) {
    toast(errorText(error), "error");
    store.ul.selected = null;
    failed = true;
  } finally {
    store.ul.loading = false;
    updateSidebar();
  }
  if (loaded) showUlCourse(loaded);
  else if (failed) showHome();
}

function showUlCourse(detail: UlCourseDetail): void {
  updateSidebar();
  renderUlCourse(main, detail, {
    busy: store.ul.loading,
    onBack: () => {
      store.ul.selected = null;
      store.ul.detail = null;
      showHome();
    },
    onRefresh: () => void refreshUlCourse(),
    onWatch: () => openUlWatch(detail),
    onOpenPlayer: () => {
      void openExternal(ulPlayerUrl(detail.course, detail.chapters[0]?.chapter_id ?? 0))
        .catch((error) => toast(errorText(error), "error"));
    },
  });
}

async function refreshUlCourse(): Promise<void> {
  const detail = store.ul.detail;
  if (!detail || store.ul.loading) return;
  await loadUlCourse(String(detail.course.textbook_id));
}

async function refreshUlCourses(): Promise<void> {
  try {
    store.ul.courses = await ulApi.listCourses();
    updateSidebar();
    showHome();
    toast(`优学院课程列表已刷新，共 ${store.ul.courses.length} 门`, "success");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function addUlCourse(ref: string): Promise<void> {
  try {
    const course = await ulApi.resolveCourse(ref);
    store.ul.courses = [...store.ul.courses.filter((item) => item.textbook_id !== course.textbook_id), course];
    updateSidebar();
    toast(`已添加课程：${course.name || course.textbook_id}`, "success");
    showHome();
  } catch (error) {
    toast(errorText(error), "error");
  }
}

function openUlWatch(detail: UlCourseDetail): void {
  openUlWatchModal({
    courseRef: String(detail.course.textbook_id),
    courseName: detail.course.name || `课程 ${detail.course.textbook_id}`,
    onToast: (message, tone) => toast(message, tone),
    onFinished: (summary) => {
      if (!summary.cancelled) void refreshUlCourse();
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
  if (store.platform === "ul") {
    await ulApi.disconnect().catch((error) => toast(errorText(error), "error"));
    store.ul.session = null;
    store.ul.courses = [];
    store.ul.selected = null;
    store.ul.detail = null;
    store.loginStatus = "idle";
    store.loginError = null;
    showConnect();
    return;
  }
  if (store.platform === "zhs") {
    await zhsApi.disconnect().catch((error) => toast(errorText(error), "error"));
    store.zhs.session = null;
    store.zhs.courses = [];
    store.zhs.selected = null;
    store.zhs.detail = null;
    store.zhs.meets = [];
    store.zhs.progress.clear();
    store.loginStatus = "idle";
    store.loginError = null;
    showConnect();
    return;
  }
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
  if (store.platform === "ul") {
    try {
      store.ul.session = await ulApi.sessionInfo();
    } catch {
      store.ul.session = null;
    }
    await subscribeAuthEvents();
    if (!store.ul.session) {
      showConnect();
      if (isDemo) {
        window.setTimeout(
          () => toast("优学院演示模式：使用内置示例课程，不会访问真实平台", "info"),
          500,
        );
      }
      return;
    }
    try {
      store.ul.courses = await ulApi.listCourses();
    } catch (error) {
      toast(errorText(error), "error");
    }
    showHome();
    return;
  }
  if (store.platform === "zhs") {
    try {
      store.zhs.session = await zhsApi.sessionInfo();
    } catch {
      store.zhs.session = null;
    }
    await subscribeAuthEvents();
    if (!store.zhs.session) {
      showConnect();
      if (isDemo) {
        window.setTimeout(
          () => toast("知到演示模式：使用内置示例课程，不会访问真实平台", "info"),
          500,
        );
      }
      return;
    }
    try {
      store.zhs.courses = await zhsApi.listCourses();
    } catch (error) {
      toast(errorText(error), "error");
    }
    showHome();
    return;
  }

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
    if (isDemo) {
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
