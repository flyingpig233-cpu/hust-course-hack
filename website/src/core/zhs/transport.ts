// Bridge protocol and request whitelist shared by the website and the injected
// Zhihuishu page script (`src/zhs-bridge.user.ts`). Both ends call
// `allowedZhsRequest`, so the popup can never be used as a general proxy.
//
// Static-site page  <->  Zhihuishu page
//   { type: 'zhs-hello', channel, nonce }
//   { type: 'zhs-ready', channel, nonce, platform: 'zhihuishu', uuid, userId }
//   { type: 'zhs-request', channel, nonce, id, url, method, body? }
//   { type: 'zhs-response', channel, nonce, id, status, text } | { error }
//   { type: 'zhs-abort', nonce, id } / { type: 'zhs-disconnect', nonce }

export const ZHS_CHANNEL = 'zhs-bridge-v1';
export const ZHS_PLATFORM = 'zhihuishu';
export const ZHS_LOGIN_URL = 'https://onlineweb.zhihuishu.com/onlinestuh5';
export const ZHS_PAGE_ORIGINS = [
  'https://onlineweb.zhihuishu.com',
  'https://online.zhihuishu.com',
  'https://studyvideoh5.zhihuishu.com',
  'https://stuonline.zhihuishu.com',
  'https://lc.zhihuishu.com',
] as const;
export const ZHS_STUDYSERVICE_ORIGIN = 'https://studyservice-api.zhihuishu.com';
export const ZHS_ONLINESERVICE_ORIGIN = 'https://onlineservice-api.zhihuishu.com';
export const ZHS_APPLIVE_ORIGIN = 'https://appcomm-live-api.zhihuishu.com';
export const ZHS_STUONLINE_ORIGIN = 'https://stuonline.zhihuishu.com';
export const ZHS_ONLINE_ORIGIN = 'https://online.zhihuishu.com';
export const ZHS_IM_ORIGIN = 'https://im.zhihuishu.com';

export interface ZhsHttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
}

export interface ZhsHttpResponse {
  status: number;
  text: string;
}

export interface ZhsTransport {
  request(input: ZhsHttpRequest, signal?: AbortSignal): Promise<ZhsHttpResponse>;
}

/** Identity reported by the popup after the user allows the connection. */
export interface ZhsIdentity {
  platform: typeof ZHS_PLATFORM;
  uuid: string;
  user_id: number | null;
}

interface RouteRule {
  origin: string;
  method: 'GET' | 'POST';
  path: RegExp;
}

const ROUTES: RouteRule[] = [
  { origin: ZHS_STUDYSERVICE_ORIGIN, method: 'POST', path: /^\/gateway\/t\/v1\/learning\/(queryCourse|videolist|prelearningNote|queryStuyInfo|saveDatabaseIntervalTimeV2)$/ },
  { origin: ZHS_STUDYSERVICE_ORIGIN, method: 'GET', path: /^\/gateway\/t\/v1\/login\/getLoginUserInfo$/ },
  { origin: ZHS_STUDYSERVICE_ORIGIN, method: 'GET', path: /^\/gateway\/t\/v1\/cheat\/exceptionActionDetail$/ },
  { origin: ZHS_ONLINESERVICE_ORIGIN, method: 'POST', path: /^\/gateway\/t\/v1\/student\/course\/share\/queryShareCourseInfo$/ },
  { origin: 'https://appcomm-user.zhihuishu.com', method: 'GET', path: /^\/app-commserv-user\/c\/has$/ },
  { origin: ZHS_APPLIVE_ORIGIN, method: 'GET', path: /^\/app-commserv-live\/gateway\/t\/v1\/pc\/live\/(getWatchHistory|setWatchHistorySecret)$/ },
  { origin: ZHS_APPLIVE_ORIGIN, method: 'GET', path: /^\/app-commserv-live\/gateway\/t\/v1\/chect\/exceptionActionDetail$/ },
  { origin: ZHS_ONLINE_ORIGIN, method: 'POST', path: /^\/onlineSchool\/json\/teachMeeting\/listTeachMeetingStu$/ },
  { origin: ZHS_STUONLINE_ORIGIN, method: 'POST', path: /^\/stuonline\/json\/teachMeeting\/listTeachMeetingStu$/ },
  { origin: ZHS_STUONLINE_ORIGIN, method: 'POST', path: /^\/stuonline\/teachMeeting\/listTeachMeetingStu$/ },
  { origin: ZHS_IM_ORIGIN, method: 'GET', path: /^\/livehome\/getVideosByLiveId$/ },
];

const MAX_BODY_BYTES = 200_000;

/** The popup only forwards these Zhihuishu API endpoints. */
export function allowedZhsRequest(input: ZhsHttpRequest): boolean {
  try {
    if (typeof input.url !== 'string') return false;
    const url = new URL(input.url);
    if (url.username || url.password) return false;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const method = input.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') return false;
    if (method === 'GET' && input.body !== undefined) return false;
    if (method === 'POST' && typeof input.body !== 'string') return false;
    if (typeof input.body === 'string' && input.body.length > MAX_BODY_BYTES) return false;
    return ROUTES.some((route) => route.origin === url.origin && route.method === method && route.path.test(url.pathname));
  } catch {
    return false;
  }
}

/** Trusted static-site origin for the handshake (https, or local development). */
export function trustedSiteOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch {
    return false;
  }
}

/** True when a message origin belongs to one of the matched Zhihuishu pages. */
export function isZhsPageOrigin(origin: string): boolean {
  return (ZHS_PAGE_ORIGINS as readonly string[]).includes(origin);
}

interface PendingRequest {
  resolve(value: ZhsHttpResponse): void;
  reject(error: Error): void;
}

/**
 * Website-side half of the bridge. Mirrors `BridgeTransport` for SmartCourse but
 * speaks the `zhs-*` protocol and validates every response against the popup
 * window, page origin, nonce and request id.
 */
export class ZhsBridgeTransport implements ZhsTransport {
  private popup: Window | null = null;
  private nonce = '';
  private identity: ZhsIdentity | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private stopConnect: (() => void) | null = null;

  constructor() {
    window.addEventListener('message', (event) => {
      const data = event.data as { channel?: string; type?: string; nonce?: string; id?: string; status?: number; text?: string; error?: string } | null;
      if (!data || data.channel !== ZHS_CHANNEL || data.nonce !== this.nonce) return;
      if (event.source !== this.popup || !isZhsPageOrigin(event.origin)) return;
      const pending = data.id ? this.pending.get(data.id) : undefined;
      if (!pending || data.type !== 'zhs-response') return;
      this.pending.delete(data.id as string);
      if (data.error) {
        pending.reject(new Error(data.error));
        return;
      }
      if (typeof data.status !== 'number' || typeof data.text !== 'string') {
        pending.reject(new Error('知到桥接响应格式无效'));
        return;
      }
      pending.resolve({ status: data.status, text: data.text });
    });
  }

  /** Identity reported by the popup; `null` before `connect()` succeeds. */
  get currentIdentity(): ZhsIdentity | null {
    return this.identity;
  }

  /** Open the Zhihuishu page and complete the explicit user handshake. */
  connect(pageUrl: string = ZHS_LOGIN_URL): Promise<ZhsIdentity> {
    this.disconnect();
    this.nonce = crypto.randomUUID();
    // Must run synchronously inside the click handler for popup blockers.
    this.popup = window.open(pageUrl, '_blank', 'popup,width=1160,height=820');
    if (!this.popup) return Promise.reject(new Error('知到窗口被拦截，请允许本站弹出窗口后重试。'));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearInterval(timer);
        clearTimeout(timeout);
        window.removeEventListener('message', ready);
        this.stopConnect = null;
      };
      const ready = (event: MessageEvent) => {
        const data = event.data as { channel?: string; type?: string; nonce?: string; uuid?: string; userId?: number; platform?: string } | null;
        if (!data || data.channel !== ZHS_CHANNEL || data.nonce !== this.nonce) return;
        if (event.source !== this.popup || !isZhsPageOrigin(event.origin)) return;
        if (data.type !== 'zhs-ready' || data.platform !== ZHS_PLATFORM) return;
        this.identity = {
          platform: ZHS_PLATFORM,
          uuid: typeof data.uuid === 'string' ? data.uuid : '',
          user_id: typeof data.userId === 'number' ? data.userId : null,
        };
        cleanup();
        resolve(this.identity);
      };
      const timer = window.setInterval(() => {
        if (this.popup?.closed) {
          cleanup();
          reject(new Error('知到窗口已关闭，请重新连接。'));
          return;
        }
        this.popup?.postMessage({ channel: ZHS_CHANNEL, type: 'zhs-hello', nonce: this.nonce }, '*');
      }, 700);
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('连接知到超时。请安装知到桥接脚本、允许脚本运行，并在知到窗口完成登录后重试。'));
      }, 180_000);
      this.stopConnect = () => {
        cleanup();
        reject(new Error('连接已取消'));
      };
      window.addEventListener('message', ready);
    });
  }

  /** Close the popup and reject every in-flight request. */
  disconnect(): void {
    this.stopConnect?.();
    for (const pending of this.pending.values()) pending.reject(new Error('知到连接已断开'));
    this.pending.clear();
    this.identity = null;
    if (this.popup) {
      this.popup.postMessage({ channel: ZHS_CHANNEL, type: 'zhs-disconnect', nonce: this.nonce }, '*');
      this.popup.close();
    }
    this.popup = null;
    this.nonce = '';
  }

  request(input: ZhsHttpRequest, signal?: AbortSignal): Promise<ZhsHttpResponse> {
    if (!allowedZhsRequest(input)) return Promise.reject(new Error('请求不在知到接口白名单中'));
    if (!this.popup || this.popup.closed) return Promise.reject(new Error('知到连接窗口已关闭，请断开后重新连接。'));
    if (signal?.aborted) return Promise.reject(new DOMException('任务已取消', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
      };
      const abort = () => {
        this.popup?.postMessage({ channel: ZHS_CHANNEL, type: 'zhs-abort', nonce: this.nonce, id }, '*');
        cleanup();
        reject(new DOMException('任务已取消', 'AbortError'));
      };
      const timeout = window.setTimeout(() => {
        this.popup?.postMessage({ channel: ZHS_CHANNEL, type: 'zhs-abort', nonce: this.nonce, id }, '*');
        cleanup();
        reject(new Error('知到接口请求超时，请检查知到窗口。'));
      }, 45_000);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.popup!.postMessage({
        channel: ZHS_CHANNEL,
        type: 'zhs-request',
        nonce: this.nonce,
        id,
        url: input.url,
        method: input.method ?? 'GET',
        body: input.body,
      }, '*');
    });
  }
}
