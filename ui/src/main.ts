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
import { platformMeta } from "./platforms";
import { openExternal, pickSavePath } from "./platform";
import type {
  CourseDetail,
  CourseSummary,
  CrawlOptions,
  Platform,
  SessionInfo,
  UlCheck,
  UlCourse,
  UlCourseDetail,
  UlWatchSummary,
  ZhsCourse,
  ZhsCourseDetail,
  ZhsMeet,
  ZhsMeetProgress,
  ZhsMeetWatchSummary,
  ZhsWatchSummary,
} from "./types";
import {
  renderConnect,
  renderHome,
  type LoginStatus,
} from "./views/connect";
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
import { createSidebar, type SidebarItem } from "./views/sidebar";
import { openWatchModal } from "./views/watch";
import {
  openZhsWatchModal,
  renderZhsCourse,
  renderZhsCourseError,
  renderZhsHome,
  renderZhsLoading,
  updateZhsLoading,
} from "./views/zhs-course";
import {
  openZhsMeetWatchModal,
  renderZhsMeet,
} from "./views/zhs-meet";
import {
  zhsCompletedVideos,
  zhsCourseLabel,
  zhsTotalVideos,
} from "./zhs";
import {
  openUlWatchModal,
  renderUlCourse,
  renderUlCourseError,
  renderUlHome,
  renderUlLoading,
  ulCourseLabel,
  updateUlLoading,
} from "./views/ul-course";

const app = qs<HTMLElement>("#app");
app.innerHTML = `
  <div class="app-shell">
    <aside class="sidebar" id="sidebar"></aside>
    <main class="main" id="main"></main>
  </div>
`;

const main = qs<HTMLElement>("#main");

type ZhsView = "home" | "course" | "meet";
type UlView = "home" | "course";

const store = {
  /** Platform selected on the connect screen (also the last active platform). */
  platform: "hust" as Platform,
  session: null as SessionInfo | null,
  loginStatus: "idle" as LoginStatus,
  loginError: null as string | null,
  busy: false,
  hust: {
    courses: [] as CourseSummary[],
    selectedId: null as string | null,
    details: new Map<string, CourseDetail>(),
    options: {
      includeQuestions: true,
      includeVideoInfo: true,
      concurrency: 4,
    } as CrawlOptions,
    bankQuestions: null as number | null,
  },
  zhs: {
    courses: [] as ZhsCourse[],
    selectedId: null as string | null,
    detail: null as ZhsCourseDetail | null,
    meets: [] as ZhsMeet[],
    meetProgress: new Map<number, ZhsMeetProgress>(),
    view: "home" as ZhsView,
  },
  ul: {
    courses: [] as UlCourse[],
    selectedId: null as string | null,
    detail: null as UlCourseDetail | null,
    check: null as UlCheck | null,
    checking: false,
    view: "home" as UlView,
  },
};

const sidebar = createSidebar(qs<HTMLElement>("#sidebar"), {
  onSelect: (courseId) => void selectCourse(courseId),
  onRefreshCourses: () => void refreshCourses(),
  onDisconnect: () => void disconnect(),
  onHelper: () => void openHelperModal(),
});

function activePlatform(): Platform {
  return store.session?.platform ?? store.platform;
}

function updateSidebar(): void {
  const session = store.session;
  const platform = activePlatform();
  let courses: SidebarItem[] = [];
  let selectedId: string | null = null;
  if (session && platform === "hust") {
    courses = store.hust.courses.map((course) => ({
      id: course.course_id,
      name: course.name,
      meta: course.course_id,
    }));
    selectedId = store.hust.selectedId;
  } else if (session && platform === "zhihuishu") {
    courses = store.zhs.courses.map((course) => ({
      id: String(course.courseId),
      name: zhsCourseLabel(course),
      meta: `recruit ${course.recruitId}`,
    }));
    selectedId = store.zhs.selectedId;
  } else if (session) {
    courses = store.ul.courses.map((course) => ({
      id: String(course.textbookId),
      name: ulCourseLabel(course),
      meta: `textbook ${course.textbookId}${
        course.classId === null ? "" : ` · 班级 ${course.classId}`
      }`,
    }));
    selectedId = store.ul.selectedId;
  }
  sidebar.update({
    session,
    platform,
    courses,
    selectedId,
    disabled: store.busy,
  });
}

function showHome(): void {
  if (!store.session) {
    showConnect();
    return;
  }
  updateSidebar();
  if (store.session.platform === "hust") {
    main.onclick = null;
    main.onchange = null;
    renderHome(main, store.session, store.hust.courses, {
      onSelect: (courseId) => void selectCourse(courseId),
      onRefreshCourses: () => void refreshCourses(),
      onHelper: () => void openHelperModal(),
    });
    return;
  }
  if (store.session.platform === "ulearning") {
    renderUlHome(main, store.session, store.ul.courses, {
      onSelect: (courseId) => void selectCourse(courseId),
      onRefreshCourses: () => void refreshCourses(),
      onAddCourse: (reference) => void addUlCourse(reference),
    });
    return;
  }
  renderZhsHome(main, store.session, store.zhs.courses, {
    onSelect: (courseId) => void selectCourse(courseId),
    onRefreshCourses: () => void refreshCourses(),
    onAddCourse: (reference) => void addZhsCourse(reference),
  });
}

function showConnect(): void {
  store.hust.selectedId = null;
  store.zhs.selectedId = null;
  store.ul.selectedId = null;
  updateSidebar();
  renderConnect(main, {
    platform: store.platform,
    status: store.loginStatus,
    error: store.loginError,
    onPlatformChange: (platform) => {
      if (store.loginStatus === "opening" || store.loginStatus === "waiting") {
        return;
      }
      store.platform = platform;
      store.loginError = null;
      store.loginStatus = "idle";
      showConnect();
    },
    onLogin: () => void startLogin(),
  });
}

/** Adopt a session established by the login window (or restored on boot). */
async function activateSession(info: SessionInfo, announce: boolean): Promise<void> {
  store.session = info;
  store.platform = info.platform;
  store.loginStatus = "idle";
  store.loginError = null;

  if (info.platform === "hust") {
    store.hust.selectedId = null;
    store.hust.details.clear();
    updateSidebar();
    try {
      store.hust.courses = await api.listCourses();
    } catch (error) {
      toast(errorText(error), "error");
    }
    updateSidebar();
    showHome();
    if (announce) toast(platformMeta(info.platform).connectedToast, "success");
    return;
  }

  if (info.platform === "ulearning") {
    store.ul = {
      courses: [],
      selectedId: null,
      detail: null,
      check: null,
      checking: false,
      view: "home",
    };
    updateSidebar();
    await loadUlCourseList();
    updateSidebar();
    showHome();
    if (announce) toast(platformMeta(info.platform).connectedToast, "success");
    return;
  }

  store.zhs = {
    courses: [],
    selectedId: null,
    detail: null,
    meets: [],
    meetProgress: new Map(),
    view: "home",
  };
  updateSidebar();
  await loadZhsCourseList();
  updateSidebar();
  showHome();
  if (announce) toast(platformMeta(info.platform).connectedToast, "success");
}

async function startLogin(): Promise<void> {
  if (store.loginStatus === "opening" || store.loginStatus === "waiting") return;
  store.loginStatus = "opening";
  store.loginError = null;
  // Re-render after the click event finishes so the pressed button is not
  // detached mid-click.
  window.setTimeout(showConnect, 0);
  try {
    await api.openLoginWindow(store.platform);
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
  store.loginError = platformMeta(store.platform).closedError;
  showConnect();
}

async function subscribeAuthEvents(): Promise<void> {
  try {
    await onSessionChanged((info) => void activateSession(info, true));
    await onLoginClosed(() => handleLoginClosed());
  } catch (error) {
    toast(errorText(error), "error");
  }
}

// ---- HUST SmartCourse flows --------------------------------------------

function currentHustSummary(): CourseSummary | null {
  return (
    store.hust.courses.find(
      (course) => course.course_id === store.hust.selectedId,
    ) ?? null
  );
}

async function selectCourse(courseId: string): Promise<void> {
  if (store.session?.platform === "zhihuishu") {
    await selectZhsCourse(courseId);
    return;
  }
  if (store.session?.platform === "ulearning") {
    await selectUlCourse(courseId);
    return;
  }
  if (store.busy) {
    toast("正在抓取课程，请先取消当前任务");
    return;
  }
  const summary = store.hust.courses.find(
    (course) => course.course_id === courseId,
  );
  if (!summary) return;

  const cached = store.hust.details.get(courseId);
  if (cached && store.hust.selectedId === courseId) return;

  store.hust.selectedId = courseId;
  updateSidebar();
  if (cached) {
    showHustDetail(cached);
    return;
  }
  await loadHustCourse(summary);
}

async function loadHustCourse(summary: CourseSummary): Promise<void> {
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
    loaded = await api.fetchCourse(summary.course_id, store.hust.options);
    store.hust.details.set(summary.course_id, loaded);
  } catch (error) {
    failure = errorText(error);
  } finally {
    unlisten?.();
    store.busy = false;
    updateSidebar();
  }

  if (store.hust.selectedId !== summary.course_id) return;

  if (loaded) {
    showHustDetail(loaded);
    return;
  }
  if (failure?.includes("已取消")) {
    store.hust.selectedId = null;
    toast("已取消抓取", "info");
    showHome();
    return;
  }
  if (failure) {
    renderCourseError(main, summary, failure, () => void loadHustCourse(summary));
  }
}

function refreshHustCourse(): void {
  const summary = currentHustSummary();
  if (!summary || store.busy) return;
  store.hust.details.delete(summary.course_id);
  void loadHustCourse(summary);
}

function showHustDetail(detail: CourseDetail): void {
  renderCourse(main, detail, {
    busy: store.busy,
    options: store.hust.options,
    bankQuestions: store.hust.bankQuestions,
    onRefresh: refreshHustCourse,
    onCancel: () => void cancelCurrentJob(),
    onWatch: (jobId) => openWatch(detail, jobId),
    onDocuments: (jobId) => openDocuments(detail, jobId),
    onQuiz: (workId) => openQuiz(detail, workId),
    onExport: () => void exportDetail(detail),
    onOpenUrl: (url) => {
      void openExternal(url).catch((error) => toast(errorText(error), "error"));
    },
    onOptionsChange: (options) => {
      store.hust.options = options;
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
      if (changed) showHustDetail(detail);
    },
  });
}

function openDocuments(detail: CourseDetail, jobId?: string | null): void {
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
      if (changed) showHustDetail(detail);
    },
  });
}

function openQuiz(detail: CourseDetail, workId?: string | null): void {  openQuizModal({
    courseId: detail.course_id,
    courseName: detail.title,
    workId,
    bankQuestions: store.hust.bankQuestions,
    onToast: (message, tone) => toast(message, tone),
    onSubmitted: (workIds) => {
      let changed = false;
      for (const id of workIds) {
        changed = markWorkSubmitted(detail, id) || changed;
      }
      if (changed) showHustDetail(detail);
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

// ---- Zhihuishu flows ----------------------------------------------------

function findZhsCourse(reference: string): ZhsCourse | null {
  return (
    store.zhs.courses.find(
      (course) =>
        String(course.courseId) === reference ||
        String(course.recruitId) === reference ||
        zhsCourseLabel(course) === reference,
    ) ?? null
  );
}

function upsertZhsCourse(course: ZhsCourse): void {
  const index = store.zhs.courses.findIndex(
    (item) => item.recruitId === course.recruitId,
  );
  if (index >= 0) {
    store.zhs.courses[index] = course;
  } else {
    store.zhs.courses.push(course);
  }
}

async function loadZhsCourseList(): Promise<void> {
  try {
    store.zhs.courses = await api.zhsListCourses();
    if (store.zhs.courses.length === 0) {
      toast(
        "知到没有返回可用的共享课。可粘贴学习页链接（含 recruitAndCourseId）手动添加。",
        "info",
      );
    }
  } catch (error) {
    store.zhs.courses = [];
    toast(
      `知到课程列表接口暂不可用：${errorText(error)}。可粘贴学习页链接手动添加课程。`,
      "error",
    );
  }
}

async function refreshZhsCourses(): Promise<void> {
  await loadZhsCourseList();
  updateSidebar();
  if (!store.zhs.selectedId) showHome();
}

async function addZhsCourse(reference: string): Promise<void> {
  try {
    const course = await api.zhsAddCourse(reference);
    upsertZhsCourse(course);
    updateSidebar();
    toast(`已解析课程：${zhsCourseLabel(course)}`, "success");
    store.zhs.selectedId = String(course.courseId);
    store.zhs.view = "course";
    store.zhs.detail = null;
    await loadZhsDetail(course);
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function selectZhsCourse(courseId: string): Promise<void> {
  if (store.busy) {
    toast("正在抓取课程，请先取消当前任务");
    return;
  }
  const course = findZhsCourse(courseId);
  if (!course) return;
  if (store.zhs.selectedId === courseId && store.zhs.detail) {
    store.zhs.view = "course";
    showZhsCourseView();
    return;
  }
  store.zhs.selectedId = courseId;
  store.zhs.view = "course";
  store.zhs.detail = null;
  store.zhs.meets = [];
  store.zhs.meetProgress.clear();
  updateSidebar();
  await loadZhsDetail(course);
}

async function loadZhsDetail(
  course: ZhsCourse,
  silent = false,
): Promise<void> {
  if (store.busy) return;
  store.busy = true;
  updateSidebar();
  if (!silent) {
    renderZhsLoading(main, course, () => void cancelCurrentJob());
  } else if (store.zhs.detail) {
    // Show the busy banner on the current tree while the silent refresh runs.
    showZhsCourseView();
  }

  let unlisten: (() => void) | null = null;
  let detail: ZhsCourseDetail | null = null;
  let failure: string | null = null;

  try {
    unlisten = await onJobProgress((progress) => {
      if (progress.kind === "zhsStage" && progress.job === "zhs-load") {
        updateZhsLoading(main, progress.done, progress.total, progress.message);
      }
    });
    detail = await api.zhsCourseDetail(String(course.courseId));
    store.zhs.detail = detail;
    upsertZhsCourse(detail.course);
  } catch (error) {
    failure = errorText(error);
  } finally {
    unlisten?.();
    store.busy = false;
    updateSidebar();
  }

  if (store.zhs.selectedId !== String(course.courseId)) return;

  if (detail) {
    store.zhs.view = "course";
    showZhsCourseView();
    return;
  }
  if (failure?.includes("已取消")) {
    store.zhs.selectedId = null;
    store.zhs.view = "home";
    toast("已取消抓取", "info");
    showHome();
    return;
  }
  if (failure) {
    if (silent && store.zhs.detail) {
      // A silent refresh must not replace the working tree with an error card.
      toast(`刷新完成状态失败：${failure}`, "error");
      showZhsCourseView();
      return;
    }
    renderZhsCourseError(main, course, failure, () => void loadZhsDetail(course));
  }
}

/**
 * Re-read the authoritative completion record after a real watch run.
 *
 * `zhs_course_detail` re-queries `queryStuyInfo` (`watchState`) and returns the
 * corrected per-video state and counts, because the `videolist`
 * `isStudiedLesson` flag stays stale after a report. The shared-course list
 * additionally carries the platform's own progress percentage; that lookup is
 * best effort and must never hide the corrected per-video state.
 */
async function refreshZhsAfterWatch(course: ZhsCourse): Promise<void> {
  await loadZhsDetail(course, true);
  const detail = store.zhs.detail;
  if (!detail || detail.course.recruitId !== course.recruitId) return;
  try {
    const courses = await api.zhsListCourses();
    const fresh = courses.find((item) => item.recruitId === course.recruitId);
    if (!fresh) return;
    // Merge the fresh list instead of replacing it: a course added manually
    // from a study-page URL may not appear in the shared-course list.
    for (const item of courses) upsertZhsCourse(item);
    const current = store.zhs.detail;
    if (current && current.course.recruitId === course.recruitId) {
      current.course = {
        ...current.course,
        progress: fresh.progress,
        studiedLessonCount: fresh.studiedLessonCount,
        totalLessonCount: fresh.totalLessonCount,
      };
      if (store.zhs.view === "course") showZhsCourseView();
    }
    updateSidebar();
  } catch {
    // Progress percentage is best effort; the watchState-derived counts above
    // are the authoritative completion record.
  }
}

function showZhsCourseView(): void {
  const detail = store.zhs.detail;
  if (!detail) {
    showHome();
    return;
  }
  const course = detail.course;
  renderZhsCourse(main, detail, {
    busy: store.busy,
    onBack: () => {
      store.zhs.selectedId = null;
      store.zhs.view = "home";
      store.zhs.detail = null;
      store.zhs.meets = [];
      store.zhs.meetProgress.clear();
      updateSidebar();
      showHome();
    },
    onRefresh: () => void loadZhsDetail(course),
    onMeet: () => void loadZhsMeets(course),
    onWatch: () =>
      openZhsWatchModal({
        courseId: String(course.courseId),
        courseName: zhsCourseLabel(course),
        videoTotal: zhsTotalVideos(detail),
        videoCompleted: zhsCompletedVideos(detail),
        onToast: (message, tone) => toast(message, tone),
        onFinished: (summary: ZhsWatchSummary) => {
          // Any real run changes platform state, even a partial or cancelled
          // one, so always re-read the completion record. Dry runs send
          // nothing and the tree cannot have changed.
          if (!summary.dryRun) void refreshZhsAfterWatch(course);
        },
      }),
    onCheck: () => void checkZhsStatus(String(course.courseId)),
  });
}

async function loadZhsMeets(course: ZhsCourse): Promise<void> {
  if (store.busy) return;
  store.busy = true;
  updateSidebar();
  if (store.zhs.detail) showZhsCourseView();

  try {
    const meets = await api.zhsMeetList(String(course.courseId));
    store.zhs.meets = meets;
    store.zhs.meetProgress.clear();
    store.zhs.view = "meet";
    const replayable = meets
      .filter((meet) => meet.liveId !== 0 && (meet.replayUrl ?? "").trim() !== "")
      .slice(0, 6);
    await Promise.allSettled(
      replayable.map(async (meet) => {
        try {
          const progress = await api.zhsMeetProgress(
            String(course.courseId),
            meet.meetCourseId,
          );
          store.zhs.meetProgress.set(meet.meetCourseId, progress);
        } catch {
          // A single progress query failing must not hide the meet list.
        }
      }),
    );
    store.busy = false;
    updateSidebar();
    showZhsMeetView();
  } catch (error) {
    store.busy = false;
    updateSidebar();
    toast(errorText(error), "error");
    showZhsCourseView();
  }
}

function showZhsMeetView(): void {
  const course = store.zhs.detail?.course;
  if (!course) {
    showHome();
    return;
  }
  const meets = store.zhs.meets;
  const replayable = meets.filter(
    (meet) => meet.liveId !== 0 && (meet.replayUrl ?? "").trim() !== "",
  );
  renderZhsMeet(main, course, meets, store.zhs.meetProgress, {
    busy: store.busy,
    onBack: () => showZhsCourseView(),
    onRefresh: () => void loadZhsMeets(course),
    onLoadProgress: (meet) => void loadZhsMeetProgress(course, meet),
    onWatch: (meet) => {
      const selected = meet ? [meet] : replayable;
      const totalMinutes = selected.reduce(
        (total, item) =>
          total + Math.ceil((item.durationSecs ?? 0) / 60),
        0,
      );
      openZhsMeetWatchModal({
        courseId: String(course.courseId),
        courseName: zhsCourseLabel(course),
        meet,
        meetCount: selected.length,
        totalMinutes,
        onToast: (message, tone) => toast(message, tone),
        onFinished: (summary: ZhsMeetWatchSummary) => {
          if (!summary.dryRun && summary.submitted > 0) {
            void loadZhsMeets(course);
          }
        },
      });
    },
    onCheck: () => void checkZhsStatus(String(course.courseId)),
  });
}

async function loadZhsMeetProgress(
  course: ZhsCourse,
  meet: ZhsMeet,
): Promise<void> {
  try {
    const progress = await api.zhsMeetProgress(
      String(course.courseId),
      meet.meetCourseId,
    );
    store.zhs.meetProgress.set(meet.meetCourseId, progress);
    showZhsMeetView();
    toast(
      `${meet.name}：已看 ${progress.watchedCount} / ${progress.totalMinutes} 分钟（${progress.percent}%）`,
      "info",
    );
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function checkZhsStatus(courseId: string): Promise<void> {
  try {
    const status = await api.zhsExceptionStatus(courseId);
    const bad = status.lock || status.abnormal;
    toast(status.message, bad ? "error" : "success");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

// ---- Ulearning (优学院) flows -------------------------------------------

function findUlCourse(reference: string): UlCourse | null {
  return (
    store.ul.courses.find(
      (course) =>
        String(course.textbookId) === reference ||
        (course.ocId !== null && String(course.ocId) === reference) ||
        (course.classId !== null && String(course.classId) === reference) ||
        ulCourseLabel(course) === reference,
    ) ?? null
  );
}

function upsertUlCourse(course: UlCourse): void {
  const index = store.ul.courses.findIndex(
    (item) => item.textbookId === course.textbookId,
  );
  if (index >= 0) {
    store.ul.courses[index] = course;
  } else {
    store.ul.courses.push(course);
  }
}

function ulSectionCount(detail: UlCourseDetail): number {
  return detail.chapters.reduce(
    (total, chapter) => total + chapter.sections.length,
    0,
  );
}

async function loadUlCourseList(): Promise<void> {
  try {
    store.ul.courses = await api.ulListCourses();
    if (store.ul.courses.length === 0) {
      toast(
        "优学院没有返回可用的课程。可粘贴播放器链接（含 courseId / classId）手动添加。",
        "info",
      );
    }
  } catch (error) {
    store.ul.courses = [];
    toast(
      `优学院课程列表接口暂不可用：${errorText(error)}。可粘贴播放器链接手动添加课程。`,
      "error",
    );
  }
}

async function refreshUlCourses(): Promise<void> {
  await loadUlCourseList();
  updateSidebar();
  if (!store.ul.selectedId) showHome();
}

async function addUlCourse(reference: string): Promise<void> {
  if (store.busy) {
    toast("正在执行任务，请先取消当前任务");
    return;
  }
  store.busy = true;
  updateSidebar();
  try {
    const detail = await api.ulCourseDetail(reference);
    upsertUlCourse(detail.course);
    store.ul.selectedId = String(detail.course.textbookId);
    store.ul.detail = detail;
    store.ul.check = null;
    store.ul.view = "course";
    store.busy = false;
    updateSidebar();
    toast(`已解析课程：${ulCourseLabel(detail.course)}`, "success");
    showUlCourseView();
    void runUlCheck(detail.course);
  } catch (error) {
    store.busy = false;
    updateSidebar();
    toast(errorText(error), "error");
  }
}

async function selectUlCourse(courseId: string): Promise<void> {
  if (store.busy) {
    toast("正在执行任务，请先取消当前任务");
    return;
  }
  const course = findUlCourse(courseId);
  if (!course) return;
  if (store.ul.selectedId === courseId && store.ul.detail) {
    store.ul.view = "course";
    showUlCourseView();
    return;
  }
  store.ul.selectedId = courseId;
  store.ul.view = "course";
  store.ul.detail = null;
  store.ul.check = null;
  updateSidebar();
  await loadUlDetail(course);
}

async function loadUlDetail(course: UlCourse): Promise<void> {
  if (store.busy) return;
  store.busy = true;
  updateSidebar();
  renderUlLoading(main, course, () => void cancelCurrentJob());

  let unlisten: (() => void) | null = null;
  let detail: UlCourseDetail | null = null;
  let failure: string | null = null;

  try {
    unlisten = await onJobProgress((progress) => {
      if (progress.kind === "ulStage" && progress.job === "ul-load") {
        updateUlLoading(main, progress.done, progress.total, progress.message);
      }
    });
    detail = await api.ulCourseDetail(String(course.textbookId));
    store.ul.detail = detail;
    store.ul.check = null;
    upsertUlCourse(detail.course);
  } catch (error) {
    failure = errorText(error);
  } finally {
    unlisten?.();
    store.busy = false;
    updateSidebar();
  }

  if (store.ul.selectedId !== String(course.textbookId)) return;

  if (detail) {
    store.ul.view = "course";
    showUlCourseView();
    // Auto-run the read-only completion scan so the tree shows real status.
    void runUlCheck(detail.course);
    return;
  }
  if (failure?.includes("已取消")) {
    store.ul.selectedId = null;
    store.ul.view = "home";
    toast("已取消读取", "info");
    showHome();
    return;
  }
  if (failure) {
    renderUlCourseError(main, course, failure, () => void loadUlDetail(course));
  }
}

async function runUlCheck(course: UlCourse): Promise<void> {
  if (store.ul.checking || store.busy) return;
  store.ul.checking = true;
  showUlCourseView();

  let unlisten: (() => void) | null = null;
  try {
    unlisten = await onJobProgress((progress) => {
      if (progress.kind === "ulStage" && progress.job === "ul-check") {
        const fill = main.querySelector<HTMLElement>(".ul-check-fill");
        if (fill) {
          fill.style.width = `${
            progress.total > 0
              ? Math.min(100, Math.round((progress.done / progress.total) * 100))
              : 0
          }%`;
        }
        const label = main.querySelector<HTMLElement>(".ul-check-label");
        if (label) {
          label.textContent = progress.label
            ? `正在读取每节完成状态：${progress.label}`
            : "正在读取每节完成状态…";
        }
        const count = main.querySelector<HTMLElement>(".ul-check-count");
        if (count) {
          count.textContent =
            progress.total > 0 ? `${progress.done} / ${progress.total}` : "";
        }
      }
    });
    const check = await api.ulCheck(String(course.textbookId));
    store.ul.check = check;
    upsertUlCourse(check.course);
    if (check.cancelled) toast("已取消完成状态检查", "info");
  } catch (error) {
    const message = errorText(error);
    if (message.includes("已取消")) {
      toast("已取消完成状态检查", "info");
    } else {
      toast(message, "error");
    }
  } finally {
    unlisten?.();
    store.ul.checking = false;
    if (store.ul.selectedId === String(course.textbookId)) showUlCourseView();
  }
}

function showUlCourseView(): void {
  const detail = store.ul.detail;
  if (!detail) {
    showHome();
    return;
  }
  const course = detail.course;
  renderUlCourse(main, detail, store.ul.check, {
    busy: store.busy,
    checking: store.ul.checking,
    onBack: () => {
      store.ul.selectedId = null;
      store.ul.view = "home";
      store.ul.detail = null;
      store.ul.check = null;
      updateSidebar();
      showHome();
    },
    onRefresh: () => void loadUlDetail(course),
    onCheck: () => void runUlCheck(course),
    onWatch: () =>
      openUlWatchModal({
        courseId: String(course.textbookId),
        courseName: ulCourseLabel(course),
        sectionTotal: store.ul.check?.sectionCount ?? ulSectionCount(detail),
        completedSections: store.ul.check?.completedSections ?? 0,
        onToast: (message, tone) => toast(message, tone),
        onFinished: (summary: UlWatchSummary) => {
          if (!summary.dryRun && summary.ok > 0) {
            void loadUlDetail(course);
          }
        },
      }),
  });
}

// ---- Shared flows -------------------------------------------------------

async function refreshCourses(): Promise<void> {
  if (store.session?.platform === "zhihuishu") {
    await refreshZhsCourses();
    return;
  }
  if (store.session?.platform === "ulearning") {
    await refreshUlCourses();
    return;
  }
  try {
    const courses = await api.listCourses();
    store.hust.courses = courses;
    const stillExists =
      !store.hust.selectedId ||
      courses.some((course) => course.course_id === store.hust.selectedId);
    if (!stillExists) {
      store.hust.selectedId = null;
      store.hust.details.clear();
      showHome();
    } else if (!store.hust.selectedId) {
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
  const platform = activePlatform();
  try {
    await api.disconnect();
  } catch (error) {
    toast(errorText(error), "error");
  }
  store.session = null;
  store.platform = platform;
  store.hust.courses = [];
  store.hust.selectedId = null;
  store.hust.details.clear();
  store.zhs.courses = [];
  store.zhs.selectedId = null;
  store.zhs.detail = null;
  store.zhs.meets = [];
  store.zhs.meetProgress.clear();
  store.zhs.view = "home";
  store.ul.courses = [];
  store.ul.selectedId = null;
  store.ul.detail = null;
  store.ul.check = null;
  store.ul.checking = false;
  store.ul.view = "home";
  store.busy = false;
  store.loginStatus = "idle";
  store.loginError = null;
  showConnect();
}

async function boot(): Promise<void> {
  updateSidebar();
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

  // A restored session only exists inside Tauri; the demo backend is stateless
  // between page reloads.
  await activateSession(store.session, false);
}

void boot();
