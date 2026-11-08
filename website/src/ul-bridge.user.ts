import {
  UL_CHANNEL,
  UL_COURSEAPI_ORIGIN,
  UL_API_ORIGIN,
  UL_PAGE_ORIGINS,
  allowedUlRequest,
  trustedUlSiteOrigin,
  type UlHttpRequest,
} from './core/ul/transport';

// Injected into a Ulearning page opened by the static site. It performs the
// same-origin API calls and injects the `Authorization` / `UA-AUTHORIZATION`
// headers from the page's own cookie, so the token never crosses the window
// boundary. Requests and responses are limited to the shared endpoint list; the
// page also enforces the site origin, window opener and nonce.
if ((UL_PAGE_ORIGINS as readonly string[]).includes(location.origin) && window.top === window && window.opener) {
  let origin = '';
  let nonce = '';
  let rejected = false;
  let lastReady = 0;
  // lc-style Java polyfills are not expected here, but a plain object keeps the
  // bridge independent of the page's globals.
  const active: Record<string, AbortController> = {};
  let activeCount = 0;

  /** Read the platform's own `AUTHORIZATION` cookie (non-HttpOnly by design). */
  const readToken = (): string => {
    const match = document.cookie.match(/(?:^|;\s*)AUTHORIZATION=([^;]+)/);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]).trim();
    } catch {
      return '';
    }
  };

  window.addEventListener('message', async (event) => {
    const data = event.data as {
      channel?: string;
      type?: string;
      nonce?: string;
      id?: string;
      url?: string;
      method?: string;
      body?: string;
    } | null;
    if (!data || data.channel !== UL_CHANNEL) return;
    if (event.source !== window.opener) return;

    if (data.type === 'ul-hello') {
      if (rejected || typeof data.nonce !== 'string' || data.nonce.length > 100 || !trustedUlSiteOrigin(event.origin)) return;
      if (!origin) {
        if (!confirm(`允许课程助手 ${event.origin} 通过此窗口读取优学院课程并执行你在助手中选择的任务？\n\n登录 token 只在优学院页面内使用，不会发送给助手。关闭此窗口可断开连接。`)) {
          rejected = true;
          return;
        }
        origin = event.origin;
        nonce = data.nonce;
      }
      if (origin !== event.origin || nonce !== data.nonce) return;
      // Do not report ready before the student session cookie exists; the static
      // site keeps retrying while the user finishes the Ulearning login flow.
      if (!readToken()) return;
      if (Date.now() - lastReady < 1500) return;
      lastReady = Date.now();
      window.opener?.postMessage({
        channel: UL_CHANNEL,
        type: 'ul-ready',
        nonce,
        platform: 'ulearning',
      }, origin);
      return;
    }

    if (!origin || event.origin !== origin || data.nonce !== nonce) return;
    if (data.type === 'ul-disconnect') {
      for (const controller of Object.values(active)) controller.abort();
      for (const key of Object.keys(active)) delete active[key];
      activeCount = 0;
      origin = '';
      nonce = '';
      return;
    }
    if (data.type === 'ul-abort') {
      if (typeof data.id === 'string') active[data.id]?.abort();
      return;
    }
    if (data.type !== 'ul-request' || typeof data.id !== 'string' || data.id in active) return;

    const input: UlHttpRequest = {
      url: typeof data.url === 'string' ? data.url : '',
      method: data.method === 'POST' ? 'POST' : 'GET',
      body: typeof data.body === 'string' ? data.body : undefined,
    };
    const reply = (payload: object) => window.opener?.postMessage(
      { channel: UL_CHANNEL, type: 'ul-response', nonce, id: data.id, ...payload },
      origin,
    );
    if (!allowedUlRequest(input)) {
      reply({ error: '桥接拒绝了非优学院接口请求' });
      return;
    }
    if (activeCount >= 8) {
      reply({ error: '并发请求过多' });
      return;
    }
    const controller = new AbortController();
    active[data.id] = controller;
    activeCount += 1;
    const timeout = setTimeout(() => controller.abort(), 40_000);
    try {
      const target = new URL(input.url);
      const headers: Record<string, string> = {};
      if (target.origin === UL_API_ORIGIN || target.origin === UL_COURSEAPI_ORIGIN) {
        const token = readToken();
        if (!token) throw new Error('missing authorization cookie');
        headers.Authorization = token;
        headers['UA-AUTHORIZATION'] = token;
        headers.version = '1';
      }
      if (input.method === 'POST') headers['Content-Type'] = 'application/json;charset=UTF-8';
      if (target.origin === UL_COURSEAPI_ORIGIN) {
        // The course-list / textbook endpoints expect the courseweb AJAX headers.
        headers['Content-Type'] = 'application/json';
        headers.Accept = 'application/json, text/javascript, */*; q=0.01';
      }
      const response = await fetch(input.url, {
        method: input.method ?? 'GET',
        body: input.method === 'POST' ? input.body : undefined,
        credentials: 'include',
        mode: 'cors',
        redirect: 'follow',
        headers,
        signal: controller.signal,
      });
      reply({ status: response.status, text: await response.text() });
    } catch {
      reply({ error: '优学院请求失败或已取消，请检查此窗口的登录状态。' });
    } finally {
      clearTimeout(timeout);
      delete active[data.id];
      activeCount -= 1;
    }
  });
}
