// Types mirror the Rust structs in `src/models.rs` (snake_case) and the GUI
// DTOs in `src-tauri/src` (camelCase). Keep them in sync when the model grows.

export type TaskKind =
  | "video"
  | "document"
  | "work"
  | "audio"
  | "live"
  | "other";

export interface CourseSummary {
  course_id: string;
  class_id: string;
  cpi: string;
  name: string;
  cover_url: string | null;
  source: string | null;
  kc_enc: string | null;
  ck_enc: string | null;
  clazz_enc: string | null;
  detail_url: string;
}

export interface CourseStats {
  chapter_nodes: number;
  leaves: number;
  cards: number;
  task_points: number;
  videos: number;
  documents: number;
  works: number;
  questions: number;
  errors: string[];
}

export interface VideoInfo {
  duration_secs: number | null;
  size_bytes: number | null;
  filename: string | null;
  dtoken?: string;
  screenshot: string | null;
  thumbnails: string | null;
  download_url: string | null;
  stream_url: string | null;
  hd_stream_url: string | null;
  status: string | null;
}

export interface PlaybackEnv {
  user_id: string | null;
  clazz_id: string | null;
  course_id: string | null;
  fid: string | null;
  report_url: string | null;
  report_interval_secs: number | null;
  ktoken: string | null;
}

export interface QuestionOption {
  label: string;
  text: string;
}

export interface Question {
  id: string;
  question_type: string | null;
  stem: string;
  options: QuestionOption[];
  my_answer: string | null;
  correct_answer: string | null;
  score: string | null;
}

export interface TaskPoint {
  kind: TaskKind;
  source_type: string;
  name: string;
  job_id: string | null;
  object_id: string | null;
  mid: string | null;
  size_bytes: number | null;
  content_ext: string | null;
  completed: boolean | null;
  played_ms: number | null;
  duration_secs: number | null;
  work_id: string | null;
  work_type: string | null;
  work_status?: string;
  enc: string | null;
  other_info?: string;
  att_duration_enc?: string;
  rt?: string;
  video_face_capture_enc?: string;
  video?: VideoInfo;
  questions: Question[];
  raw: unknown;
}

export interface Card {
  index: number;
  card_id: string | null;
  title: string;
  task_points: TaskPoint[];
  playback?: PlaybackEnv;
}

export interface Chapter {
  id: string;
  title: string;
  number: string | null;
  level: number;
  is_leaf: boolean;
  completed: boolean | null;
  children: Chapter[];
  cards?: Card[];
}

export interface CourseDetail extends CourseSummary {
  title: string;
  enc: string | null;
  old_enc: string | null;
  openc: string | null;
  final_url: string;
  chapters: Chapter[];
  stats: CourseStats;
}

/** Active platform. Mirrors `Platform` in `src-tauri/src/state.rs`. */
export type Platform = "hust" | "zhihuishu" | "ulearning";

export interface SessionInfo {
  platform: Platform;
  cookieSource: string;
  cookieCount: number;
}

export interface CrawlOptions {
  includeQuestions?: boolean;
  includeVideoInfo?: boolean;
  concurrency?: number;
}

export interface WatchRequest {
  course: string;
  job?: string | null;
  includeCompleted?: boolean;
  stepSecs?: number;
  delayMs?: number;
  maxVideos?: number | null;
  dryRun?: boolean;
}

export interface WatchSummary {
  total: number;
  passed: number;
  failed: number;
  errors: string[];
  cancelled: boolean;
}

export interface DocumentRequest {
  course: string;
  job?: string | null;
  includeCompleted?: boolean;
  dryRun?: boolean;
  maxDocuments?: number | null;
}

export interface DocumentResult {
  jobId: string;
  name: string;
  chapter: string;
  status: "completed" | "failed" | "dry_run";
  message: string | null;
}

export interface DocumentSummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: boolean;
  dryRun: boolean;
  errors: string[];
  documents: DocumentResult[];
}

export interface QuizRequest {
  course: string;
  work?: string | null;
  dryRun?: boolean;
  maxWorks?: number | null;
}

export interface QuizWorkResult {
  workId: string;
  workName: string;
  chapter: string;
  questionCount: number;
  status: "submitted" | "failed" | "skipped" | "dry_run";
  message: string | null;
}

export interface QuizSummary {
  total: number;
  submitted: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
  dryRun: boolean;
  skippedGraded: number;
  bankQuestions: number;
  planErrors: string[];
  errors: string[];
  works: QuizWorkResult[];
}

export interface AnswerBankInfo {
  questions: number;
  version: number | null;
}

export type JobProgress =
  | { kind: "crawl"; done: number; total: number }
  | { kind: "watchPlan"; total: number; dryRun: boolean }
  | {
      kind: "watch";
      index: number;
      total: number;
      label: string;
      jobId: string;
      status: "running" | "passed" | "failed" | "error" | "dry_run";
      message: string | null;
    }
  | { kind: "documentPlan"; total: number; dryRun: boolean }
  | {
      kind: "document";
      index: number;
      total: number;
      chapter: string;
      name: string;
      jobId: string;
      status: "running" | "completed" | "failed" | "dry_run";
      message: string | null;
    }
  | {
      kind: "quizPlan";
      total: number;
      skippedGraded: number;
      incomplete: number;
      dryRun: boolean;
      bankQuestions: number;
    }
  | {
      kind: "quiz";
      index: number;
      total: number;
      workId: string;
      workName: string;
      chapter: string;
      questionCount: number;
      status: "running" | "submitted" | "failed" | "skipped" | "dry_run";
      message: string | null;
    }
  // ---- Zhihuishu (知到) jobs -------------------------------------------
  | {
      kind: "zhsPlan";
      /** `zhs-watch` or `zhs-meet-watch`. */
      job: string;
      /** `videos` or `meet`. */
      stage: string;
      total: number;
      dryRun: boolean;
      skipped: number;
    }
  | {
      kind: "zhsStage";
      job: string;
      /** `loading`, `videos`, `meet_list`, `meet_minutes`, `verify`, `circuit_check`. */
      stage: string;
      done: number;
      total: number;
      label: string;
      message: string;
    }
  | {
      kind: "zhsTarget";
      job: string;
      index: number;
      total: number;
      label: string;
      status:
        | "running"
        | "ok"
        | "skip"
        | "dry_run"
        | "failed"
        | "cancelled"
        | "circuit_broken";
      message: string | null;
      targetMinutes: number | null;
      watchedBefore: number | null;
    }
  // ---- Ulearning (优学院) jobs ------------------------------------------
  | {
      kind: "ulPlan";
      /** `ul-watch`. */
      job: string;
      total: number;
      actionable: number;
      skipped: number;
      dryRun: boolean;
    }
  | {
      kind: "ulStage";
      job: string;
      /** `directory`, `plan`, `submit`, or `verify`. */
      stage: string;
      done: number;
      total: number;
      label: string;
      message: string;
    }
  | {
      kind: "ulTarget";
      job: string;
      index: number;
      total: number;
      label: string;
      status:
        | "ok"
        | "skip"
        | "dry_run"
        | "failed"
        | "cancelled"
        | "circuit_broken";
      message: string | null;
      completionStatus: number | null;
    }
  // ---- Zhihuishu homework / exam job -----------------------------------
  | {
      kind: "zhsExamProgress";
      /** `saving`, `submitting`, or `verifying`. */
      stage: string;
      done: number;
      total: number;
      label: string;
      message: string;
    };

// ---- Zhihuishu (知到) DTOs -------------------------------------------------
// Mirrors `src-tauri/src/zhihuishu.rs`; camelCase over the IPC boundary.

export interface ZhsCourse {
  recruitId: number;
  courseId: number;
  classId: number | null;
  schoolId: number | null;
  name: string;
  teacher: string;
  secret: string | null;
  isApply: number | null;
  courseType: string | null;
  progress: number | null;
  studiedLessonCount: number | null;
  totalLessonCount: number | null;
  status: number | null;
}

export interface ZhsVideo {
  videoId: number;
  /** Small-lesson id (`videoSmallLessons[].id`), also called `lessonVideoId`. */
  lessonVideoId: number;
  videoSec: number;
  isStudied: number | null;
  name: string;
}

export interface ZhsLesson {
  lessonId: number;
  name: string;
  isStudied: number | null;
  videoId: number | null;
  videoSec: number | null;
  videos: ZhsVideo[];
}

export interface ZhsChapter {
  chapterId: number | null;
  name: string;
  learningLessonStatus: number | null;
  isPass: number | null;
  limitChecked: boolean | null;
  lessons: ZhsLesson[];
}

export interface ZhsCourseDetail {
  course: ZhsCourse;
  chapters: ZhsChapter[];
  /** Total playable videos (small lessons) in the tree. */
  totalVideos: number;
  /**
   * Videos the platform records as finished (`watchState == 1`).
   *
   * The backend recomputes this from `queryStuyInfo`; the `isStudied` flag on
   * each video comes from `videolist`, which the platform does not refresh after
   * a report, so prefer these counts over deriving them from the tree.
   */
  completedVideos: number;
}

export interface ZhsExceptionStatus {
  lock: boolean;
  abnormal: boolean;
  message: string;
}

export interface ZhsMeet {
  meetCourseId: number;
  liveId: number;
  videoId: number | null;
  recruitId: number;
  courseId: number;
  name: string;
  teacher: string;
  startTime: string | null;
  endTime: string | null;
  replayUrl: string | null;
  examUrl: string | null;
  durationSecs: number | null;
  status: number | null;
}

export interface ZhsMeetProgress {
  totalMinutes: number;
  watchedMinutes: number[];
  watchedCount: number;
  percent: number;
}

export type ZhsWatchState =
  | "ok"
  | "skip"
  | "dry_run"
  | "failed"
  | "cancelled"
  | "circuit_broken";

export interface ZhsVideoOutcome {
  label: string;
  state: ZhsWatchState;
  watchState: number | null;
  message: string;
}

export interface ZhsWatchSummary {
  total: number;
  ok: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  dryRun: boolean;
  outcomes: ZhsVideoOutcome[];
  errors: string[];
}

export interface ZhsMeetOutcome {
  label: string;
  targetMinutes: number;
  watchedBefore: number;
  submitted: number;
  skipped: number;
  failed: number;
  watchedAfter: number | null;
  state: ZhsWatchState;
  message: string;
}

export interface ZhsMeetWatchSummary {
  meets: number;
  submitted: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  dryRun: boolean;
  outcomes: ZhsMeetOutcome[];
  errors: string[];
}

export interface ZhsWatchRequest {
  /** Course id, recruit id, or a study-page reference. */
  course: string;
  dryRun?: boolean;
  includeCompleted?: boolean;
  maxVideos?: number | null;
  verify?: boolean;
}

export interface ZhsMeetWatchRequest {
  course: string;
  /** Only process this `meetCourseId`; omit to process every replay. */
  meet?: number | null;
  dryRun?: boolean;
  /** Percent (90) or fraction (0.9). */
  coverageMin?: number;
  coverageMax?: number;
  delayMinMs?: number;
  delayMaxMs?: number;
  circuitBreaker?: boolean;
  checkEvery?: number;
}

// ---- Ulearning (优学院) DTOs ----------------------------------------------
// Mirrors `src-tauri/src/ulearning.rs`; camelCase over the IPC boundary.

export interface UlCourse {
  textbookId: number;
  ocId: number | null;
  classId: number | null;
  name: string;
  author: string | null;
  remainingSecs: number | null;
  expired: boolean;
}

export type UlPageKind = "video" | "practice" | "document";

export interface UlPage {
  id: number;
  /** Page id used as `pageid` in the study record. */
  relationId: number;
  name: string;
  contentType: number;
  kind: UlPageKind;
}

export interface UlSection {
  id: number;
  idForClass: number | null;
  name: string;
  hide: number | null;
  pages: UlPage[];
  /** `completion_status == 1`; `null` until the completion scan runs. */
  completed: boolean | null;
}

export interface UlChapter {
  id: number;
  idForClass: number | null;
  name: string;
  hide: number | null;
  sections: UlSection[];
}

export interface UlCourseDetail {
  course: UlCourse;
  chapters: UlChapter[];
  remainingSecs: number | null;
  className: string | null;
  expired: boolean;
}

export interface UlCheck extends UlCourseDetail {
  sectionCount: number;
  completedSections: number;
  videoPages: number;
  practicePages: number;
  documentPages: number;
  cancelled: boolean;
}

export interface UlWatchRequest {
  /** Course id / player URL / `textbookId;classId`. */
  course: string;
  dryRun?: boolean;
  includeCompleted?: boolean;
  maxSections?: number | null;
  delayMinMs?: number;
  delayMaxMs?: number;
  stopOnError?: boolean;
  verify?: boolean;
}

export type UlWatchState =
  | "ok"
  | "skip"
  | "dry_run"
  | "failed"
  | "cancelled"
  | "circuit_broken";

export interface UlOutcome {
  label: string;
  sectionId: number;
  /** `complete`, `complete_practice`, `skip_done`, `skip_unsupported`, `skip_expired`. */
  action: string;
  state: UlWatchState;
  completionStatus: number | null;
  message: string;
}

export interface UlWatchSummary {
  total: number;
  ok: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  dryRun: boolean;
  outcomes: UlOutcome[];
  errors: string[];
}

// ---- Zhihuishu homework / exam DTOs ---------------------------------------
// Mirrors `src-tauri/src/zhs_exam.rs`; camelCase over the IPC boundary. Correct
// answers are represented by option **content**, never by ids (the platform
// randomizes option order between attempts).

export interface ZhsHomework {
  stuExamId: string;
  examId: string;
  name: string;
  state: number | null;
  achieve: number | null;
  achieveCount: number | null;
  backNum: number | null;
  score: number | null;
  problemNum: number | null;
  totalScore: number | null;
  meetCourseType: number | null;
  chapterId: string | null;
  isCheckAnswer: number | null;
  examUserName: string | null;
}

export interface ZhsFinalExam {
  stuExamId: string;
  examId: string;
  name: string;
  problemNum: number | null;
  totalScore: number | null;
  limitTime: number | null;
  remainCount: number | null;
  finalExam: boolean;
}

export interface ZhsExamList {
  submitted: boolean;
  homework: ZhsHomework[];
  finals: ZhsFinalExam[];
  finalsError: string | null;
}

export interface ZhsExamOption {
  id: string;
  content: string;
}

export interface ZhsExamQuestion {
  id: string;
  stem: string;
  kindId: number;
  kindName: string;
  score: number;
  multiple: boolean;
  options: ZhsExamOption[];
}

export interface ZhsExamPaper {
  examName: string;
  courseName: string;
  totalScore: number;
  problemNum: number;
  questionCount: number;
  questions: ZhsExamQuestion[];
}

export type ZhsAnswerSource = "submitted" | "ai_analysis" | "bank";

export interface ZhsPlanQuestion {
  question: ZhsExamQuestion;
  optionIds: string[];
  optionContents: string[];
  source: ZhsAnswerSource;
}

export interface ZhsUnresolved {
  questionId: string;
  stem: string;
}

export interface ZhsExamPlan {
  examId: string;
  examName: string;
  totalScore: number;
  questionCount: number;
  resolved: number;
  unresolved: ZhsUnresolved[];
  complete: boolean;
  questions: ZhsPlanQuestion[];
}

export interface ZhsQuestionResult {
  questionId: string;
  stem: string;
  score: number;
  fullScore: number;
  correct: boolean;
  selectedContents: string[];
}

export interface ZhsAnswerResult {
  dryRun: boolean;
  plan: ZhsExamPlan;
  submitted: boolean;
  score: number | null;
  totalScore: number;
  correctCount: number;
  questionCount: number;
  perQuestion: ZhsQuestionResult[];
  message: string;
  recordedToBank: number;
}

export interface ZhsBankInfo {
  total: number;
  submittedEntries: number;
  aiEntries: number;
  updatedAtUnix: number | null;
  path: string;
}

export interface ZhsRecordAiResult {
  recorded: number;
  skipped: number;
  /** Question ids whose AI panel text was missing/unmappable. */
  skippedQuestionIds: string[];
  bankTotal: number;
  path: string;
}

/** One question that did not earn full marks after a submission. */
export interface ZhsWrongQuestion {
  questionId: string;
  stem: string;
  score: number;
  fullScore: number;
}

/** Payload of the `zhs-exam-result` event (webview attempt finished). */
export interface ZhsExamResultEvent {
  submitted: boolean;
  score: number | null;
  totalScore: number;
  correctCount: number;
  questionCount: number;
  recordedToBank: number;
  /** Non-full-mark questions; the app never auto-retries (attempts are limited). */
  wrongQuestions: ZhsWrongQuestion[];
  message: string;
}

/** Homework / final-exam stats for one shared course. */
export interface ZhsExamSummary {
  homeworkTotal: number;
  homeworkSubmitted: number;
  averageScore: number | null;
  finalExamCount: number;
  finalExamSubmitted: number;
}

/** Result of a 申请重做 request (the flow runs in the exam-list webview). */
export interface ZhsRedoResult {
  started: boolean;
  message: string;
}

/** Payload of the `zhs-exam-redo` event (injected list script finished). */
export interface ZhsRedoEvent {
  examId: string;
  ok: boolean;
  reason: string;
}

export interface ZhsAiEntry {
  questionId?: string | null;
  index?: number | null;
  text: string;
}

/** Payload of the `zhs-exam-ai` event emitted after a harvest is persisted. */
export interface ZhsExamAiEvent {
  recorded: number;
  skipped: number;
  bankTotal: number;
}
