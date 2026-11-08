import { demoOn } from './bus';
import { browserApi } from './core/backend';
import { ulBrowserApi } from './core/ul/backend';
import type { UlBackend, UlJobProgress, UlSessionInfo } from './core/ul/types';
import { zhsBrowserApi } from './core/zhs/backend';
import type { ZhsBackend, ZhsJobProgress, ZhsSessionInfo } from './core/zhs/types';
import { isDemo } from './env';
import { mockApi, ulMockApi, zhsMockApi } from './mock';
import type { AnswerBankInfo, CourseDetail, CourseSummary, CrawlOptions, DocumentRequest, DocumentSummary, JobProgress, QuizRequest, QuizSummary, SessionInfo, WatchRequest, WatchSummary } from './types';

export interface Backend {
  openLoginWindow(): Promise<void>;
  sessionInfo(): Promise<SessionInfo | null>;
  disconnect(): Promise<void>;
  listCourses(): Promise<CourseSummary[]>;
  fetchCourse(courseId: string, options: CrawlOptions): Promise<CourseDetail>;
  watchCourse(request: WatchRequest): Promise<WatchSummary>;
  completeDocuments(request: DocumentRequest): Promise<DocumentSummary>;
  completeQuizzes(request: QuizRequest): Promise<QuizSummary>;
  answerBankInfo(): Promise<AnswerBankInfo>;
  cancelJob(): Promise<void>;
  helperScript(): Promise<string>;
  saveTextFile(path: string, contents: string): Promise<void>;
}
export const api: Backend = isDemo ? mockApi : browserApi;
/** Zhihuishu (知到) backend; the demo implementation never sends real reports. */
export const zhsApi: ZhsBackend = isDemo ? zhsMockApi : zhsBrowserApi;
/** Ulearning (优学院) backend; the demo implementation never sends real reports. */
export const ulApi: UlBackend = isDemo ? ulMockApi : ulBrowserApi;
export async function onJobProgress(handler: (progress: JobProgress) => void): Promise<() => void> { return demoOn('job-progress', handler); }
export async function onSessionChanged(handler: (info: SessionInfo) => void): Promise<() => void> { return demoOn('session-changed', handler); }
export async function onLoginClosed(handler: () => void): Promise<() => void> { return demoOn('login-closed', handler); }
export async function onZhsProgress(handler: (progress: ZhsJobProgress) => void): Promise<() => void> { return demoOn('zhs-progress', handler); }
export async function onZhsSessionChanged(handler: (info: ZhsSessionInfo) => void): Promise<() => void> { return demoOn('zhs-session-changed', handler); }
export async function onUlProgress(handler: (progress: UlJobProgress) => void): Promise<() => void> { return demoOn('ul-progress', handler); }
export async function onUlSessionChanged(handler: (info: UlSessionInfo) => void): Promise<() => void> { return demoOn('ul-session-changed', handler); }
