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

export interface SessionInfo {
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
    };
