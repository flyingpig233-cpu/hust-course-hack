export const PLATFORM = 'https://smartcourse.hust.edu.cn';
export const CHANNEL = 'hust-course-bridge-v1';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  referrer?: string;
}
export interface HttpResponse { body: string; url: string; status: number }
export interface Transport { request(input: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> }

/** Both ends enforce this list. The bridge cannot act as a general-purpose proxy. */
export function allowedRequest(input: HttpRequest): boolean {
  try {
    const url = new URL(input.url);
    if (url.origin !== PLATFORM || url.username || url.password) return false;
    if (input.referrer && new URL(input.referrer).origin !== PLATFORM) return false;
    if (input.method === 'POST') return url.pathname === '/mooc-ans/work/addStudentWorkNewWeb';
    if (input.method && input.method !== 'GET') return false;
    return [
      '/fyportal-smartcourse/fyportal/wfw/courselist/getStudyCourse',
      '/fyportal-smartcourse/courselist/opencoursenewfy',
      '/mooc-ans/mycourse/studentstudycourselist',
      '/mooc-ans/mycourse/studentstudyAjax',
      '/mooc-ans/knowledge/cards',
      '/mooc-ans/api/work',
      '/mooc-ans/work/validate',
    ].includes(url.pathname) || /^\/ananas\/status\/[\w-]+$/.test(url.pathname)
      || /^\/mooc-ans\/multimedia\/log\/a\/[\w-]+\/[\w.-]+$/.test(url.pathname);
  } catch { return false; }
}

export class BridgeTransport implements Transport {
  private popup: Window | null = null;
  private nonce = '';
  private pending = new Map<string, { resolve(value: HttpResponse): void; reject(error: Error): void }>();
  private stopConnect: (() => void) | null = null;

  constructor() {
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (event.origin !== PLATFORM || event.source !== this.popup || data?.channel !== CHANNEL || data.nonce !== this.nonce) return;
      const pending = this.pending.get(data.id);
      if (!pending || data.type !== 'response') return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else if (data.response && typeof data.response.body === 'string' && typeof data.response.url === 'string') pending.resolve(data.response);
      else pending.reject(new Error('桥接响应格式无效'));
    });
  }

  connect(): Promise<void> {
    this.disconnect();
    this.nonce = crypto.randomUUID();
    // Must run synchronously in the click handler for popup blockers.
    this.popup = window.open(`${PLATFORM}/i-smartcourse/base`, '_blank', 'popup,width=1100,height=800');
    if (!this.popup) return Promise.reject(new Error('登录窗口被拦截，请允许本站弹出窗口后重试。'));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearInterval(timer); clearTimeout(timeout); window.removeEventListener('message', ready);
        this.stopConnect = null;
      };
      const ready = (event: MessageEvent) => {
        const data = event.data;
        if (event.origin !== PLATFORM || event.source !== this.popup || data?.channel !== CHANNEL || data.nonce !== this.nonce || data.type !== 'ready') return;
        cleanup(); resolve();
      };
      const timer = window.setInterval(() => {
        if (this.popup?.closed) { cleanup(); reject(new Error('学校窗口已关闭，请重新连接。')); return; }
        this.popup?.postMessage({ channel: CHANNEL, type: 'hello', nonce: this.nonce }, PLATFORM);
      }, 700);
      const timeout = window.setTimeout(() => {
        cleanup(); reject(new Error('连接超时。请安装桥接脚本、允许脚本运行，完成学校登录后重试；若浏览器隔离了登录窗口，请先在学校页面登录，再重新连接。'));
      }, 180_000);
      this.stopConnect = () => { cleanup(); reject(new Error('连接已取消')); };
      window.addEventListener('message', ready);
    });
  }

  disconnect(): void {
    this.stopConnect?.();
    for (const pending of this.pending.values()) pending.reject(new Error('连接已断开'));
    this.pending.clear();
    this.popup?.postMessage({ channel: CHANNEL, type: 'disconnect', nonce: this.nonce }, PLATFORM);
    this.popup?.close(); this.popup = null; this.nonce = '';
  }

  request(input: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    if (!allowedRequest(input)) return Promise.reject(new Error('请求不在课程接口白名单中'));
    if (!this.popup || this.popup.closed) return Promise.reject(new Error('学校连接窗口已关闭，请断开后重新连接。'));
    if (signal?.aborted) return Promise.reject(new DOMException('任务已取消', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const abort = () => {
        this.popup?.postMessage({ channel: CHANNEL, type: 'abort', nonce: this.nonce, id }, PLATFORM);
        cleanup(); reject(new DOMException('任务已取消', 'AbortError'));
      };
      const timeout = window.setTimeout(() => {
        this.popup?.postMessage({ channel: CHANNEL, type: 'abort', nonce: this.nonce, id }, PLATFORM);
        cleanup(); reject(new Error('课程接口请求超时，请检查学校连接窗口。'));
      }, 45_000);
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.popup!.postMessage({ channel: CHANNEL, type: 'request', nonce: this.nonce, id, input }, PLATFORM);
    });
  }
}
