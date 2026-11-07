import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { demoOn } from "./bus";
import { isTauri } from "./env";
import { mockApi } from "./mock";
import type {
  AnswerBankInfo,
  CourseDetail,
  CourseSummary,
  CrawlOptions,
  DocumentRequest,
  DocumentSummary,
  JobProgress,
  Platform,
  QuizRequest,
  QuizSummary,
  SessionInfo,
  WatchRequest,
  WatchSummary,
  ZhsCourse,
  ZhsCourseDetail,
  ZhsExceptionStatus,
  ZhsMeet,
  ZhsMeetProgress,
  ZhsMeetWatchRequest,
  ZhsMeetWatchSummary,
  ZhsWatchRequest,
  ZhsWatchSummary,
} from "./types";

const tauriApi = {
  openLoginWindow: (platform: Platform) =>
    invoke<void>("open_login_window", { platform }),
  sessionInfo: () => invoke<SessionInfo | null>("session_info"),
  disconnect: () => invoke<void>("disconnect"),
  listCourses: () => invoke<CourseSummary[]>("list_courses"),
  fetchCourse: (courseId: string, options: CrawlOptions) =>
    invoke<CourseDetail>("fetch_course", { courseId, options }),
  watchCourse: (request: WatchRequest) =>
    invoke<WatchSummary>("watch_course", { request }),
  completeDocuments: (request: DocumentRequest) =>
    invoke<DocumentSummary>("complete_documents", { request }),
  completeQuizzes: (request: QuizRequest) =>
    invoke<QuizSummary>("complete_quizzes", { request }),
  answerBankInfo: () => invoke<AnswerBankInfo>("answer_bank_info"),
  cancelJob: () => invoke<void>("cancel_job"),
  helperScript: () => invoke<string>("helper_script"),
  saveTextFile: (path: string, contents: string) =>
    invoke<void>("save_text_file", { path, contents }),

  // ---- Zhihuishu (知到) -------------------------------------------------
  zhsListCourses: () => invoke<ZhsCourse[]>("zhs_list_courses"),
  zhsAddCourse: (reference: string) =>
    invoke<ZhsCourse>("zhs_add_course", { reference }),
  zhsCourseDetail: (courseId: string) =>
    invoke<ZhsCourseDetail>("zhs_course_detail", { courseId }),
  zhsWatchVideos: (request: ZhsWatchRequest) =>
    invoke<ZhsWatchSummary>("zhs_watch_videos", { request }),
  zhsMeetList: (courseId: string) =>
    invoke<ZhsMeet[]>("zhs_meet_list", { courseId }),
  zhsMeetProgress: (courseId: string, meetId: number) =>
    invoke<ZhsMeetProgress>("zhs_meet_progress", { courseId, meetId }),
  zhsMeetWatch: (request: ZhsMeetWatchRequest) =>
    invoke<ZhsMeetWatchSummary>("zhs_meet_watch", { request }),
  zhsExceptionStatus: (courseId: string) =>
    invoke<ZhsExceptionStatus>("zhs_exception_status", { courseId }),
  zhsCancelJob: () => invoke<void>("zhs_cancel_job"),
};

export type Backend = typeof tauriApi;

export const api: Backend = isTauri ? tauriApi : mockApi;

/** Subscribe to crawl/report progress from the Rust side. */
export async function onJobProgress(
  handler: (progress: JobProgress) => void,
): Promise<() => void> {
  if (!isTauri) return demoOn("job-progress", handler);
  return listen<JobProgress>("job-progress", (event) => handler(event.payload));
}

/** The login window obtained a verified platform session. */
export async function onSessionChanged(
  handler: (info: SessionInfo) => void,
): Promise<() => void> {
  if (!isTauri) return demoOn("session-changed", handler);
  return listen<SessionInfo>("session-changed", (event) =>
    handler(event.payload),
  );
}

/** The login window closed without producing a session. */
export async function onLoginClosed(
  handler: () => void,
): Promise<() => void> {
  if (!isTauri) return demoOn("login-closed", handler);
  return listen("login-closed", () => handler());
}
