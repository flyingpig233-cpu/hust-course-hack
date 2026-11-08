// Types mirror the Rust model in `src/zhihuishu/models.rs` (snake_case). Keep the
// field names identical so the website, the CLI and the desktop GUI can be
// compared item by item when the protocol changes.

/** Logged-in student identity. */
export interface ZhsUser {
  user_id: number;
  /** Short opaque token from the `CASLOGC` cookie, 8 characters. */
  uuid: string;
  real_name: string;
  school_id: number | null;
  is_teacher: boolean;
}

/** A shared course (共享课) the student is enrolled in. */
export interface ZhsCourse {
  recruit_id: number;
  course_id: number;
  class_id: number | null;
  school_id: number | null;
  name: string;
  teacher: string;
  /** `recruitAndCourseId` secret from a study page URL, when resolved by URL. */
  secret: string | null;
  is_apply: number | null;
  course_type: string | null;
  progress: number | null;
  studied_lesson_count: number | null;
  total_lesson_count: number | null;
  status: number | null;
}

/** One chapter (章) in the shared-course video tree. */
export interface ZhsChapter {
  chapter_id: number | null;
  name: string;
  learning_lesson_status: number | null;
  is_pass: number | null;
  limit_checked: boolean | null;
  lessons: ZhsLesson[];
}

/** One lesson (节) in a chapter. */
export interface ZhsLesson {
  lesson_id: number;
  name: string;
  is_studied: number | null;
  video_id: number | null;
  video_sec: number | null;
  /** Small lessons (小节), the normal case for shared courses. */
  videos: ZhsVideo[];
}

/** One playable video (小节). */
export interface ZhsVideo {
  video_id: number;
  /** Small-lesson id (`videoSmallLessons[].id`), also called `lessonVideoId`. */
  lesson_video_id: number;
  video_sec: number;
  is_studied: number | null;
  name: string;
}

/** Course tree returned by `ZhsClient.courseDetail`. */
export interface ZhsCourseDetail {
  course: ZhsCourse;
  chapters: ZhsChapter[];
}

/** Anti-cheat / exception status returned by the `exceptionActionDetail` endpoints. */
export interface ZhsExceptionStatus {
  lock: boolean;
  abnormal: boolean;
  message: string;
}

/** A meet course (见面课) replay entry. */
export interface ZhsMeet {
  meet_course_id: number;
  live_id: number;
  video_id: number | null;
  recruit_id: number;
  course_id: number;
  name: string;
  teacher: string;
  start_time: string | null;
  end_time: string | null;
  replay_url: string | null;
  exam_url: string | null;
  duration_secs: number | null;
  status: number | null;
}

/** Replay attendance progress of one meet course. */
export interface ZhsMeetProgress {
  total_minutes: number;
  watched_minutes: number[];
  watched_count: number;
  percent: number;
}

/** Per-video watch options. */
export interface ZhsWatchOptions {
  dry_run: boolean;
  include_completed: boolean;
  max_videos: number | null;
  verify: boolean;
}

/** Replay watch options (random coverage + pacing + circuit breaker). */
export interface ZhsMeetWatchOptions {
  dry_run: boolean;
  coverage_min: number;
  coverage_max: number;
  delay_min_ms: number;
  delay_max_ms: number;
  circuit_breaker: boolean;
  check_every: number;
}

/** Video-course progress stages. */
export type ZhsProgressStage =
  | 'videos'
  | 'meet_list'
  | 'meet_minutes'
  | 'verify'
  | 'circuit_check';

/** Progress snapshot handed to the cancellation callback. */
export interface ZhsProgress {
  stage: ZhsProgressStage;
  done: number;
  total: number;
  label: string;
  message: string;
}

/** Terminal state of one video target or one meet watch run. */
export type ZhsWatchState =
  | 'ok'
  | 'skip'
  | 'dry_run'
  | 'failed'
  | 'cancelled'
  | 'circuit_broken';

/** One planned video target. */
export interface ZhsVideoTarget {
  recruit_id: number;
  course_id: number;
  chapter_id: number;
  lesson_id: number;
  lesson_video_id: number;
  video_id: number;
  video_sec: number;
  label: string;
  completed: boolean;
}

/** Result of one video target. */
export interface ZhsWatchOutcome {
  label: string;
  state: ZhsWatchState;
  watch_state: number | null;
  message: string;
}

/** Result of one meet replay watch run. */
export interface ZhsMeetOutcome {
  label: string;
  target_minutes: number;
  watched_before: number;
  submitted: number;
  skipped: number;
  failed: number;
  watched_after: number | null;
  state: ZhsWatchState;
  message: string;
}

/** Session metadata exposed to the interface. Cookie values stay in the popup. */
export interface ZhsSessionInfo {
  user_id: number | null;
  uuid: string;
  real_name: string;
  source: string;
}

/** Request sent from the interface to the Zhihuishu backend. */
export interface ZhsWatchRequest {
  course: string;
  dryRun?: boolean;
  includeCompleted?: boolean;
  maxVideos?: number | null;
  verify?: boolean;
}

/** Request sent from the interface to the meet backend. */
export interface ZhsMeetWatchRequest {
  course: string;
  meet?: number | null;
  dryRun?: boolean;
  coverageMin?: number;
  coverageMax?: number;
  delayMinMs?: number;
  delayMaxMs?: number;
  circuitBreaker?: boolean;
  checkEvery?: number;
}

/** Aggregated video result returned to the interface. */
export interface ZhsWatchSummary {
  total: number;
  ok: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  dryRun: boolean;
  outcomes: ZhsWatchOutcome[];
  errors: string[];
}

/** Aggregated meet result returned to the interface. */
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

/** UI progress events emitted over the `zhs-progress` bus channel. */
export type ZhsJobProgress =
  | { kind: 'zhs-crawl'; done: number; total: number; label: string }
  | {
      kind: 'zhs-plan';
      stage: 'videos' | 'meet';
      total: number;
      dryRun: boolean;
      skipped: number;
    }
  | {
      kind: 'zhs-video';
      index: number;
      total: number;
      label: string;
      status: 'running' | 'ok' | 'skip' | 'failed' | 'dry_run';
      message: string | null;
    }
  | {
      kind: 'zhs-meet';
      index: number;
      total: number;
      label: string;
      targetMinutes: number;
      watchedBefore: number;
      status: 'running' | 'ok' | 'skip' | 'failed' | 'dry_run';
      message: string | null;
    }
  | {
      kind: 'zhs-minute';
      index: number;
      total: number;
      label: string;
      minute: number;
      status: 'running' | 'ok' | 'failed';
      message: string | null;
    }
  | { kind: 'zhs-circuit'; label: string; message: string };

/** Browser backend contract; the demo implementation mirrors it. */
export interface ZhsBackend {
  connect(): Promise<ZhsSessionInfo>;
  sessionInfo(): Promise<ZhsSessionInfo | null>;
  disconnect(): Promise<void>;
  listCourses(): Promise<ZhsCourse[]>;
  resolveCourse(ref: string): Promise<ZhsCourse>;
  courseDetail(courseRef: string): Promise<ZhsCourseDetail>;
  watchVideos(request: ZhsWatchRequest): Promise<ZhsWatchSummary>;
  meetList(courseRef: string): Promise<ZhsMeet[]>;
  meetProgress(courseRef: string, meetId: number): Promise<ZhsMeetProgress>;
  meetWatch(request: ZhsMeetWatchRequest): Promise<ZhsMeetWatchSummary>;
  cancelJob(): Promise<void>;
}

/** Build the shortest human-readable course label. */
export function courseLabel(course: ZhsCourse): string {
  const name = course.name.trim();
  return name || `课程 ${course.course_id}（recruit ${course.recruit_id}）`;
}

/** All videos of a lesson; lessons without small lessons synthesize one item. */
export function lessonVideos(lesson: ZhsLesson): ZhsVideo[] {
  if (lesson.videos.length > 0) return lesson.videos;
  if (lesson.video_id !== null && lesson.video_sec !== null) {
    return [{
      video_id: lesson.video_id,
      lesson_video_id: lesson.lesson_id,
      video_sec: lesson.video_sec,
      is_studied: lesson.is_studied,
      name: lesson.name,
    }];
  }
  return [];
}

/** Total number of playable videos in a course tree. */
export function totalVideos(detail: ZhsCourseDetail): number {
  return detail.chapters.reduce(
    (total, chapter) => total + chapter.lessons.reduce((sum, lesson) => sum + lessonVideos(lesson).length, 0),
    0,
  );
}

/** Number of videos the platform marks as studied. */
export function completedVideos(detail: ZhsCourseDetail): number {
  return detail.chapters.reduce(
    (total, chapter) => total + chapter.lessons.reduce(
      (sum, lesson) => sum + lessonVideos(lesson).filter((video) => (video.is_studied ?? 0) !== 0).length,
      0,
    ),
    0,
  );
}

/** Default meet watch options (random 90–100% coverage, 2–6s pacing). */
export function defaultMeetWatchOptions(overrides: Partial<ZhsMeetWatchOptions> = {}): ZhsMeetWatchOptions {
  return {
    dry_run: true,
    coverage_min: 0.9,
    coverage_max: 1,
    delay_min_ms: 2000,
    delay_max_ms: 6000,
    circuit_breaker: true,
    check_every: 10,
    ...overrides,
  };
}

/** Default video watch options (dry run, skip completed videos, verify). */
export function defaultWatchOptions(overrides: Partial<ZhsWatchOptions> = {}): ZhsWatchOptions {
  return {
    dry_run: true,
    include_completed: false,
    max_videos: null,
    verify: true,
    ...overrides,
  };
}
