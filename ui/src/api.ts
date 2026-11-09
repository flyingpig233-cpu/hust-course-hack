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
  UlCheck,
  UlCourse,
  UlCourseDetail,
  UlWatchRequest,
  UlWatchSummary,
  WatchRequest,
  WatchSummary,
  ZhsAiEntry,
  ZhsAnswerResult,
  ZhsBankInfo,
  ZhsCourse,
  ZhsCourseDetail,
  ZhsExamAiEvent,
  ZhsExamList,
  ZhsExamPaper,
  ZhsExamPlan,
  ZhsExamResultEvent,
  ZhsExceptionStatus,
  ZhsMeet,
  ZhsMeetProgress,
  ZhsMeetWatchRequest,
  ZhsMeetWatchSummary,
  ZhsRecordAiResult,
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

  // ---- Zhihuishu homework / exam ---------------------------------------
  zhsExamList: (recruitId: number, courseId: number, submitted: boolean) =>
    invoke<ZhsExamList>("zhs_exam_list", { recruitId, courseId, submitted }),
  zhsExamPaper: (
    recruitId: number,
    courseId: number,
    examId: string,
    submitted: boolean,
  ) =>
    invoke<ZhsExamPaper>("zhs_exam_paper", {
      recruitId,
      courseId,
      examId,
      submitted,
    }),
  zhsExamPlan: (recruitId: number, courseId: number, examId: string) =>
    invoke<ZhsExamPlan>("zhs_exam_plan", { recruitId, courseId, examId }),
  zhsExamAnswer: (
    recruitId: number,
    courseId: number,
    examId: string,
    dryRun: boolean,
  ) =>
    invoke<ZhsAnswerResult>("zhs_exam_answer", {
      recruitId,
      courseId,
      examId,
      dryRun,
    }),
  zhsExamBankInfo: () => invoke<ZhsBankInfo>("zhs_exam_bank_info"),
  zhsExamRecordAi: (
    recruitId: number,
    courseId: number,
    examId: string,
    entries: ZhsAiEntry[],
  ) =>
    invoke<ZhsRecordAiResult>("zhs_exam_record_ai", {
      recruitId,
      courseId,
      examId,
      entries,
    }),
  zhsExamOpenCheckWindow: (
    recruitId: number,
    courseId: number,
    examId: string,
  ) =>
    invoke<void>("zhs_exam_open_check_window", {
      recruitId,
      courseId,
      examId,
    }),
  zhsExamOpenAttemptWindow: (
    recruitId: number,
    courseId: number,
    examId: string,
  ) =>
    invoke<void>("zhs_exam_open_attempt_window", {
      recruitId,
      courseId,
      examId,
    }),

  // ---- Ulearning (优学院) -----------------------------------------------
  ulListCourses: () => invoke<UlCourse[]>("ul_list_courses"),
  ulCourseDetail: (courseId: string) =>
    invoke<UlCourseDetail>("ul_course_detail", { courseId }),
  ulCheck: (courseId: string) => invoke<UlCheck>("ul_check", { courseId }),
  ulWatch: (request: UlWatchRequest) =>
    invoke<UlWatchSummary>("ul_watch", { request }),
  ulCancelJob: () => invoke<void>("ul_cancel_job"),
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

/** The AI-analysis harvest window persisted texts into the answer bank. */
export async function onZhsExamAi(
  handler: (event: ZhsExamAiEvent) => void,
): Promise<() => void> {
  if (!isTauri) return demoOn("zhs-exam-ai", handler);
  return listen<ZhsExamAiEvent>("zhs-exam-ai", (event) =>
    handler(event.payload),
  );
}

/** The webview attempt finished and the backend re-read the score. */
export async function onZhsExamResult(
  handler: (event: ZhsExamResultEvent) => void,
): Promise<() => void> {
  if (!isTauri) return demoOn("zhs-exam-result", handler);
  return listen<ZhsExamResultEvent>("zhs-exam-result", (event) =>
    handler(event.payload),
  );
}
