// Web backend: talks to the axum server (`server/` crate) deployed next to
// the site. Same Backend contract as the Tauri IPC; progress events arrive
// by polling `/api/jobs/current` and are replayed through the demo bus so
// the existing `onJobProgress` consumers keep working.
import { demoEmit } from "./bus";
import type {
  AnswerBankInfo,
  CourseDetail,
  CourseSummary,
  CrawlOptions,
  Platform,
  QuizRequest,
  QuizSummary,
  SessionInfo,
  WatchRequest,
  WatchSummary,
} from "./types";
import type { Backend } from "./api";

const API_BASE = new URL(import.meta.env.BASE_URL || "/", document.baseURI);

const ACCESS_KEY = "coursehack:access-token";
const SESSION_KEY = "coursehack:session-token";

export function getStoredAccessToken(): string {
  return localStorage.getItem(ACCESS_KEY) ?? "";
}

export function webSetAccessToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed) localStorage.setItem(ACCESS_KEY, trimmed);
  else localStorage.removeItem(ACCESS_KEY);
}

export function webClearSessionToken(): void {
  localStorage.removeItem(SESSION_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const access = getStoredAccessToken();
  if (access) headers.set("X-Access-Token", access);
  const session = localStorage.getItem(SESSION_KEY);
  if (session) headers.set("X-Session-Token", session);
  if (typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(new URL(path, API_BASE), { ...init, headers });
  } catch {
    throw new Error("无法连接课程助手服务，请稍后重试");
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message =
      (payload as { error?: string } | null)?.error ??
      `请求失败（HTTP ${response.status}）`;
    if (response.status === 401) {
      if (message.includes("口令")) webSetAccessToken("");
      webClearSessionToken();
    }
    throw new Error(message);
  }
  return payload as T;
}

export interface WebConfig {
  tokenRequired: boolean;
  bankQuestions: number;
  bankVersion: number | null;
  sessionActive: boolean;
}

export async function webConfig(): Promise<WebConfig> {
  return request<WebConfig>("api/config");
}

interface LoginStatus {
  state: "idle" | "pending" | "done" | "failed";
  sessionToken?: string;
  cookieSource?: string;
  cookieCount?: number;
  error?: string;
}

const pollIntervalMs = 900;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open the unified-authentication login window (the official CAS pages
 * relayed by the server) and wait until the session is captured.
 *
 * Mirrors the desktop flow: emits `session-changed` through the demo bus on
 * success and `login-closed` when the user closes the window first.
 */
async function openLoginWindow(platform: Platform): Promise<void> {
  if (platform !== "hust") throw new Error("自部署网页版目前仅支持学在华科大");
  const access = getStoredAccessToken();
  const url = access ? `login/?t=${encodeURIComponent(access)}` : "login/";
  const win = window.open(url, "hust-course-login", "popup=yes,width=600,height=780");
  if (!win) {
    throw new Error("浏览器拦截了登录窗口，请允许本站弹出窗口后重试");
  }
  // The login page itself has a 20-minute server-side timeout.
  const deadline = Date.now() + 21 * 60 * 1000;
  for (;;) {
    await sleep(pollIntervalMs);
    let status: LoginStatus;
    try {
      status = await request<LoginStatus>("api/login/status");
    } catch (error) {
      // An invalid access passcode should surface immediately instead of
      // polling forever; transient network errors keep waiting.
      if (error instanceof Error && error.message.includes("口令")) throw error;
      status = { state: "pending" };
    }
    if (status.state === "done" && status.sessionToken) {
      localStorage.setItem(SESSION_KEY, status.sessionToken);
      demoEmit("session-changed", {
        platform: "hust",
        cookieSource: status.cookieSource ?? "HUST 统一身份认证",
        cookieCount: status.cookieCount ?? 0,
      });
      return;
    }
    if (status.state === "failed") {
      throw new Error(status.error ?? "登录失败，请重试");
    }
    if (Date.now() > deadline) {
      throw new Error("登录超时，请重试");
    }
    if (win.closed) {
      demoEmit("login-closed", null);
      return;
    }
  }
}

interface JobSnapshot<T> {
  running: boolean;
  done: boolean;
  error: string | null;
  result: T | null;
  events: unknown[];
}

async function runJob<T>(
  kind: "fetch" | "watch" | "quiz",
  params: Record<string, unknown>,
): Promise<T> {
  await request("api/jobs", {
    method: "POST",
    body: JSON.stringify({ kind, ...params }),
  });
  let cursor = 0;
  for (;;) {
    await sleep(650);
    const snapshot = await request<JobSnapshot<T>>(
      `api/jobs/current?cursor=${cursor}`,
    );
    for (const event of snapshot.events ?? []) {
      demoEmit("job-progress", event);
    }
    cursor += snapshot.events?.length ?? 0;
    if (snapshot.done) {
      if (snapshot.error) throw new Error(snapshot.error);
      return snapshot.result as T;
    }
  }
}

async function downloadTextFile(path: string, contents: string): Promise<void> {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = path.split(/[\\/]/).pop() || "download.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** These upstream capabilities are not implemented by the self-hosted server yet. */
async function unsupported(): Promise<never> {
  throw new Error("自部署网页版暂不支持此功能，请使用桌面版或独立网站版");
}

export const webApi: Backend = {
  completeDocuments: unsupported,
  zhsListCourses: unsupported,
  zhsAddCourse: unsupported,
  zhsCourseDetail: unsupported,
  zhsWatchVideos: unsupported,
  zhsMeetList: unsupported,
  zhsMeetProgress: unsupported,
  zhsMeetWatch: unsupported,
  zhsExceptionStatus: unsupported,
  zhsCancelJob: unsupported,
  ulListCourses: unsupported,
  ulCourseDetail: unsupported,
  ulCheck: unsupported,
  ulWatch: unsupported,
  ulCancelJob: unsupported,
  openLoginWindow,

  sessionInfo: async () => {
    try {
      const info = await request<SessionInfo | null>("api/session");
      return info ? { ...info, platform: "hust" } : null;
    } catch {
      return null;
    }
  },

  disconnect: async () => {
    try {
      await request("api/session", { method: "DELETE" });
    } finally {
      webClearSessionToken();
    }
  },

  listCourses: () => request<CourseSummary[]>("api/courses"),

  fetchCourse: (courseId: string, options: CrawlOptions) =>
    runJob<CourseDetail>("fetch", { courseId, options }),

  watchCourse: (request_: WatchRequest) =>
    runJob<WatchSummary>("watch", { ...request_ }),

  completeQuizzes: (request_: QuizRequest) =>
    runJob<QuizSummary>("quiz", { ...request_ }),

  answerBankInfo: async (): Promise<AnswerBankInfo> => {
    const config = await webConfig();
    return { questions: config.bankQuestions, version: config.bankVersion };
  },

  cancelJob: () => request("api/jobs/cancel", { method: "POST" }),

  // The userscript helper is a desktop-app fallback; the web version replaces
  // it, so this stays empty and the entry point is hidden.
  helperScript: async () => "",

  saveTextFile: (path: string, contents: string) =>
    downloadTextFile(path, contents),
};
