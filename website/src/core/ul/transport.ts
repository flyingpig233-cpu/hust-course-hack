// Bridge protocol and request whitelist shared by the website and the injected
// Ulearning page script (`src/ul-bridge.user.ts`). Both ends enforce the same
// allowlist; the popup also injects the `Authorization` / `UA-AUTHORIZATION`
// headers from its own cookie so the token never reaches the static site.
//
// Static page <-> Ulearning page:
//   { type: 'ul-hello', channel, nonce }
//   { type: 'ul-ready', channel, nonce, platform: 'ulearning' }
//   { type: 'ul-request', channel, nonce, id, url, method, body? }
//   { type: 'ul-response', channel, nonce, id, status, text } | { error }
//   { type: 'ul-abort', nonce, id } / { type: 'ul-disconnect', nonce }

export const UL_CHANNEL = 'ul-bridge-v1';
export const UL_PLATFORM = 'ulearning';
export const UL_LOGIN_URL = 'https://courseweb.ulearning.cn/ulearning/index.html#/index/courseList';
export const UL_PAGE_ORIGINS = [
  'https://courseweb.ulearning.cn',
  'https://ua.ulearning.cn',
] as const;
export const UL_API_ORIGIN = 'https://api.ulearning.cn';
export const UL_COURSEAPI_ORIGIN = 'https://courseapi.ulearning.cn';

export interface UlHttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
}

export interface UlHttpResponse {
  status: number;
  text: string;
}

export interface UlTransport {
  request(input: UlHttpRequest, signal?: AbortSignal): Promise<UlHttpResponse>;
}

interface RouteRule {
  origin: string;
  method: 'GET' | 'POST';
  path: RegExp;
}

const ROUTES: RouteRule[] = [
  // Course structure and metadata.
  { origin: UL_API_ORIGIN, method: 'GET', path: /^\/user$/ },
  { origin: UL_API_ORIGIN, method: 'GET', path: /^\/course\/\d+\/(remaining|basicinformation)$/ },
  { origin: UL_API_ORIGIN, method: 'GET', path: /^\/classes\/\d+$/ },
  { origin: UL_API_ORIGIN, method: 'GET', path: /^\/course\/stu\/\d+\/directory$/ },
  { origin: UL_API_ORIGIN, method: 'GET', path: /^\/wholepage\/(chapter|item)\/stu\/\d+$/ },
  { origin: UL_API_ORIGIN, method: 'GET', path: /^\/wholepage\/stu\/\d+$/ },
  // Learning records.
  { origin: UL_API_ORIGIN, method: 'GET', path: /^\/studyrecord\/(initialize|item)\/\d+$/ },
  { origin: UL_API_ORIGIN, method: 'GET', path: /^\/questionAnswer\/\d+$/ },
  { origin: UL_API_ORIGIN, method: 'POST', path: /^\/yws\/api\/personal\/sync$/ },
  { origin: UL_API_ORIGIN, method: 'POST', path: /^\/user\/currentUnit$/ },
  // Course list + textbook mapping (live 2026-11-08, courseapi host).
  { origin: UL_COURSEAPI_ORIGIN, method: 'GET', path: /^\/courses\/students$/ },
  { origin: UL_COURSEAPI_ORIGIN, method: 'GET', path: /^\/textbook\/student\/\d+\/list$/ },
];

const MAX_BODY_BYTES = 200_000;

/** Only these Ulearning API endpoints may be called through the popup. */
export function allowedUlRequest(input: UlHttpRequest): boolean {
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
export function trustedUlSiteOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch {
    return false;
  }
}

/** True when a message origin belongs to one of the matched Ulearning pages. */
export function isUlPageOrigin(origin: string): boolean {
  return (UL_PAGE_ORIGINS as readonly string[]).includes(origin);
}

interface PendingRequest {
  resolve(value: UlHttpResponse): void;
  reject(error: Error): void;
}

/** Website-side half of the Ulearning bridge. */
export class UlBridgeTransport implements UlTransport {
  private popup: Window | null = null;
  private nonce = '';
  private identity: { platform: typeof UL_PLATFORM } | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private stopConnect: (() => void) | null = null;

  constructor() {
    window.addEventListener('message', (event) => {
      const data = event.data as { channel?: string; type?: string; nonce?: string; id?: string; status?: number; text?: string; error?: string } | null;
      if (!data || data.channel !== UL_CHANNEL || data.nonce !== this.nonce) return;
      if (event.source !== this.popup || !isUlPageOrigin(event.origin)) return;
      const pending = data.id ? this.pending.get(data.id) : undefined;
      if (!pending || data.type !== 'ul-response') return;
      this.pending.delete(data.id as string);
      if (data.error) {
        pending.reject(new Error(data.error));
        return;
      }
      if (typeof data.status !== 'number' || typeof data.text !== 'string') {
        pending.reject(new Error('优学院桥接响应格式无效'));
        return;
      }
      pending.resolve({ status: data.status, text: data.text });
    });
  }

  /** Open the Ulearning page and complete the explicit handshake. */
  connect(pageUrl: string = UL_LOGIN_URL): Promise<{ platform: typeof UL_PLATFORM }> {
    this.disconnect();
    this.nonce = crypto.randomUUID();
    // Must run synchronously inside the click handler for popup blockers.
    this.popup = window.open(pageUrl, '_blank', 'popup,width=1160,height=820');
    if (!this.popup) return Promise.reject(new Error('优学院窗口被拦截，请允许本站弹出窗口后重试。'));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearInterval(timer);
        clearTimeout(timeout);
        window.removeEventListener('message', ready);
        this.stopConnect = null;
      };
      const ready = (event: MessageEvent) => {
        const data = event.data as { channel?: string; type?: string; nonce?: string; platform?: string } | null;
        if (!data || data.channel !== UL_CHANNEL || data.nonce !== this.nonce) return;
        if (event.source !== this.popup || !isUlPageOrigin(event.origin)) return;
        if (data.type !== 'ul-ready' || data.platform !== UL_PLATFORM) return;
        this.identity = { platform: UL_PLATFORM };
        cleanup();
        resolve(this.identity);
      };
      const timer = window.setInterval(() => {
        if (this.popup?.closed) {
          cleanup();
          reject(new Error('优学院窗口已关闭，请重新连接。'));
          return;
        }
        this.popup?.postMessage({ channel: UL_CHANNEL, type: 'ul-hello', nonce: this.nonce }, '*');
      }, 700);
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('连接优学院超时。请安装优学院桥接脚本、允许脚本运行，并在优学院窗口完成登录后重试。'));
      }, 180_000);
      this.stopConnect = () => {
        cleanup();
        reject(new Error('连接已取消'));
      };
      window.addEventListener('message', ready);
    });
  }

  get currentIdentity(): { platform: typeof UL_PLATFORM } | null {
    return this.identity;
  }

  /** Close the popup and reject every in-flight request. */
  disconnect(): void {
    this.stopConnect?.();
    for (const pending of this.pending.values()) pending.reject(new Error('优学院连接已断开'));
    this.pending.clear();
    this.identity = null;
    if (this.popup) {
      this.popup.postMessage({ channel: UL_CHANNEL, type: 'ul-disconnect', nonce: this.nonce }, '*');
      this.popup.close();
    }
    this.popup = null;
    this.nonce = '';
  }

  request(input: UlHttpRequest, signal?: AbortSignal): Promise<UlHttpResponse> {
    if (!allowedUlRequest(input)) return Promise.reject(new Error('请求不在优学院接口白名单中'));
    if (!this.popup || this.popup.closed) return Promise.reject(new Error('优学院连接窗口已关闭，请断开后重新连接。'));
    if (signal?.aborted) return Promise.reject(new DOMException('任务已取消', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
      };
      const abort = () => {
        this.popup?.postMessage({ channel: UL_CHANNEL, type: 'ul-abort', nonce: this.nonce, id }, '*');
        cleanup();
        reject(new DOMException('任务已取消', 'AbortError'));
      };
      const timeout = window.setTimeout(() => {
        this.popup?.postMessage({ channel: UL_CHANNEL, type: 'ul-abort', nonce: this.nonce, id }, '*');
        cleanup();
        reject(new Error('优学院接口请求超时，请检查优学院窗口。'));
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
        channel: UL_CHANNEL,
        type: 'ul-request',
        nonce: this.nonce,
        id,
        url: input.url,
        method: input.method ?? 'GET',
        body: input.body,
      }, '*');
    });
  }
}
