import { demoOn } from './bus';
import { browserApi } from './core/backend';
import { isDemo } from './env';
import { mockApi } from './mock';
import type { AnswerBankInfo, CourseDetail, CourseSummary, CrawlOptions, JobProgress, QuizRequest, QuizSummary, SessionInfo, WatchRequest, WatchSummary } from './types';

export interface Backend {
  openLoginWindow(): Promise<void>;
  sessionInfo(): Promise<SessionInfo | null>;
  disconnect(): Promise<void>;
  listCourses(): Promise<CourseSummary[]>;
  fetchCourse(courseId: string, options: CrawlOptions): Promise<CourseDetail>;
  watchCourse(request: WatchRequest): Promise<WatchSummary>;
  completeQuizzes(request: QuizRequest): Promise<QuizSummary>;
  answerBankInfo(): Promise<AnswerBankInfo>;
  cancelJob(): Promise<void>;
  helperScript(): Promise<string>;
  saveTextFile(path: string, contents: string): Promise<void>;
}
export const api: Backend = isDemo ? mockApi : browserApi;
export async function onJobProgress(handler: (progress: JobProgress) => void): Promise<() => void> { return demoOn('job-progress', handler); }
export async function onSessionChanged(handler: (info: SessionInfo) => void): Promise<() => void> { return demoOn('session-changed', handler); }
export async function onLoginClosed(handler: () => void): Promise<() => void> { return demoOn('login-closed', handler); }
