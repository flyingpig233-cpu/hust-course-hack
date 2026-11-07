// Ulearning (优学院) data model, mirroring the verified page protocol.
// Levels: Course -> Chapter(讲) -> Section(节) -> Page(页面) -> PageElement.
// A page `contentType` is 5 text, 6 video, 7 exercise.

/** One course the user added by its player URL (`textbookId` + `classId`). */
export interface UlCourse {
  textbook_id: number;
  class_id: number;
  /** External course id (`ocId`) shown by courseweb, when known. */
  oc_id: number | null;
  name: string;
  teacher: string;
  locale: string | null;
  /** `remaining.time < 0` means the course has expired and cannot be reported. */
  expired: boolean | null;
}

/** One page of a section. `relation_id` is what the record upload calls `pageid`. */
export interface UlPage {
  page_id: number;
  relation_id: number;
  name: string;
  content_type: number;
}

/** One section (节), id = `itemid` in the record payload. */
export interface UlSection {
  section_id: number;
  name: string;
  chapter_id: number;
  chapter_name: string;
  pages: UlPage[];
  /** `completion_status` from `/studyrecord/item/{sectionId}` (1 = finished). */
  completion_status: number | null;
  /** Replay length of the whole section in seconds, when known. */
  video_secs: number | null;
}

/** One chapter (讲). */
export interface UlChapter {
  chapter_id: number;
  name: string;
  sections: UlSection[];
}

export interface UlCourseDetail {
  course: UlCourse;
  chapters: UlChapter[];
}

/** One video resource of a page. */
export interface UlVideo {
  video_id: number;
  duration_secs: number;
}

/** One exercise question of a page (answers resolved through `questionAnswer`). */
export interface UlQuestion {
  question_id: number;
  score: number;
  answers: string[];
}

export type UlSectionAction =
  | 'complete'
  | 'skip_done'
  | 'skip_quiz'
  | 'skip_invalid'
  | 'skip_expired';

/** A page ready to be included in one sync payload. */
export interface UlPagePlan {
  page_id: number;
  relation_id: number;
  content_type: number;
  coursepage_id: number | null;
  videos: UlVideo[];
  questions: UlQuestion[];
}

/** One planned section. */
export interface UlSectionPlan {
  section_id: number;
  section_name: string;
  chapter_id: number;
  chapter_name: string;
  pages: UlPagePlan[];
  action: UlSectionAction;
  reason: string | null;
}

/** Per-section watch options. */
export interface UlWatchOptions {
  dry_run: boolean;
  include_quizzes: boolean;
  max_sections: number | null;
  delay_min_ms: number;
  delay_max_ms: number;
  verify: boolean;
  stop_on_error: boolean;
}

/** Default options: dry run, videos only, paced, stop on first rejection. */
export function defaultUlWatchOptions(overrides: Partial<UlWatchOptions> = {}): UlWatchOptions {
  return {
    dry_run: true,
    include_quizzes: false,
    max_sections: null,
    delay_min_ms: 2000,
    delay_max_ms: 4000,
    verify: true,
    stop_on_error: true,
    ...overrides,
  };
}

/** Progress callbacks (stage names mirror the CLI report). */
export type UlProgressStage = 'directory' | 'sections' | 'sync' | 'verify' | 'circuit';

export interface UlProgress {
  stage: UlProgressStage;
  done: number;
  total: number;
  label: string;
  message: string;
}

export type UlWatchState = 'ok' | 'skip' | 'dry_run' | 'failed' | 'cancelled' | 'circuit_broken';

/** Result of one planned section. */
export interface UlSectionOutcome {
  label: string;
  state: UlWatchState;
  pages: number;
  response: number | null;
  message: string;
}

/** Session metadata exposed to the interface; the token never crosses the bridge. */
export interface UlSessionInfo {
  logged_in: boolean;
  source: string;
}

/** Request sent from the interface to the Ulearning backend. */
export interface UlWatchRequest {
  course: string;
  dryRun?: boolean;
  includeQuizzes?: boolean;
  maxSections?: number | null;
  delayMinMs?: number;
  delayMaxMs?: number;
  verify?: boolean;
  stopOnError?: boolean;
}

/** Aggregated result returned to the interface. */
export interface UlWatchSummary {
  total: number;
  ok: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  dryRun: boolean;
  outcomes: UlSectionOutcome[];
  errors: string[];
}

/** UI progress events emitted over the `ul-progress` bus channel. */
export type UlJobProgress =
  | { kind: 'ul-plan'; total: number; videos: number; quizzes: number; skippedDone: number; dryRun: boolean }
  | { kind: 'ul-crawl'; done: number; total: number; label: string }
  | {
      kind: 'ul-section';
      index: number;
      total: number;
      label: string;
      status: 'running' | 'ok' | 'skip' | 'dry_run' | 'failed';
      message: string | null;
    }
  | { kind: 'ul-circuit'; label: string; message: string };

/** Browser backend contract; the demo implementation mirrors it. */
export interface UlBackend {
  connect(): Promise<UlSessionInfo>;
  sessionInfo(): Promise<UlSessionInfo | null>;
  disconnect(): Promise<void>;
  listCourses(): Promise<UlCourse[]>;
  resolveCourse(ref: string): Promise<UlCourse>;
  courseDetail(courseRef: string): Promise<UlCourseDetail>;
  watchSections(request: UlWatchRequest): Promise<UlWatchSummary>;
  cancelJob(): Promise<void>;
}

/** Short human-readable course label. */
export function ulCourseLabel(course: UlCourse): string {
  return course.name.trim() || `课程 ${course.textbook_id}`;
}

/** Player page URL of a course, used in the interface for "open course". */
export function ulPlayerUrl(course: UlCourse, chapterId = 0): string {
  const params = new URLSearchParams({
    courseId: String(course.textbook_id),
    classId: String(course.class_id),
  });
  if (chapterId > 0) params.set('chapterId', String(chapterId));
  return `https://ua.ulearning.cn/learnCourse/learnCourse.html?${params.toString()}`;
}

/** Human label of a planned section. */
export function ulSectionLabel(plan: UlSectionPlan): string {
  const chapter = plan.chapter_name.trim();
  return chapter ? `${chapter} / ${plan.section_name}` : plan.section_name;
}

/** Aggregate counters for the interface summary. */
export function summarizeUlOutcomes(outcomes: UlSectionOutcome[]): {
  ok: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  circuitBroken: boolean;
} {
  return {
    ok: outcomes.filter((outcome) => outcome.state === 'ok').length,
    skipped: outcomes.filter((outcome) => outcome.state === 'skip' || outcome.state === 'dry_run').length,
    failed: outcomes.filter((outcome) => outcome.state === 'failed').length,
    cancelled: outcomes.some((outcome) => outcome.state === 'cancelled'),
    circuitBroken: outcomes.some((outcome) => outcome.state === 'circuit_broken'),
  };
}
