import {
  ZHS_CHANNEL,
  ZHS_PAGE_ORIGINS,
  allowedZhsRequest,
  trustedSiteOrigin,
  type ZhsHttpRequest,
} from './core/zhs/transport';

// Injected into a Zhihuishu page opened by the static site. It performs the
// same-site API calls (the page keeps its HttpOnly cookies) and returns only the
// response body, status and request id. Every request is checked against the
// shared endpoint allowlist; foreign origins, missing nonces and arbitrary URLs
// are rejected. Install the script, keep the Zhihuishu window open, and allow the
// connection prompt.
if ((ZHS_PAGE_ORIGINS as readonly string[]).includes(location.origin) && window.top === window && window.opener) {
  let origin = '';
  let nonce = '';
  let rejected = false;
  let lastReady = 0;
  // `lc.zhihuishu.com` replaces the global `Map` with a Java-style polyfill, so
  // the popup half keeps its in-flight requests in a plain object.
  const active: Record<string, AbortController> = {};
  let activeCount = 0;

  interface LoginIdentity { uuid: string; userId: number | null }

  /** Read the non-HttpOnly `CASLOGC` cookie the platform itself parses. */
  const readIdentity = (): LoginIdentity | null => {
    const match = document.cookie.match(/(?:^|;\s*)CASLOGC=([^;]+)/);
    if (!match) return null;
    try {
      const value = JSON.parse(decodeURIComponent(match[1])) as { uuid?: string; userId?: number | string };
      if (typeof value.uuid !== 'string' || !value.uuid) return null;
      const userId = Number(value.userId);
      return { uuid: value.uuid, userId: Number.isFinite(userId) && userId > 0 ? userId : null };
    } catch {
      return null;
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
    if (!data || data.channel !== ZHS_CHANNEL) return;
    if (event.source !== window.opener) return;

    if (data.type === 'zhs-hello') {
      if (rejected || typeof data.nonce !== 'string' || data.nonce.length > 100 || !trustedSiteOrigin(event.origin)) return;
      if (!origin) {
        if (!confirm(`允许课程助手 ${event.origin} 通过此窗口读取知到课程并执行你在助手中选择的任务？\n\nCookie 不会发送给助手。关闭此窗口可断开连接。`)) {
          rejected = true;
          return;
        }
        origin = event.origin;
        nonce = data.nonce;
      }
      if (origin !== event.origin || nonce !== data.nonce) return;
      const identity = readIdentity();
      // Do not report ready until the platform session cookie exists; the static
      // site keeps retrying while the user finishes the Zhihuishu login flow.
      if (!identity) return;
      if (Date.now() - lastReady < 1500) return;
      lastReady = Date.now();
      window.opener?.postMessage({
        channel: ZHS_CHANNEL,
        type: 'zhs-ready',
        nonce,
        platform: 'zhihuishu',
        uuid: identity.uuid,
        userId: identity.userId ?? undefined,
      }, origin);
      return;
    }

    if (!origin || event.origin !== origin || data.nonce !== nonce) return;
    if (data.type === 'zhs-disconnect') {
      for (const controller of Object.values(active)) controller.abort();
      for (const key of Object.keys(active)) delete active[key];
      activeCount = 0;
      origin = '';
      nonce = '';
      return;
    }
    if (data.type === 'zhs-abort') {
      if (typeof data.id === 'string') active[data.id]?.abort();
      return;
    }
    if (data.type !== 'zhs-request' || typeof data.id !== 'string' || data.id in active) return;

    const input: ZhsHttpRequest = {
      url: typeof data.url === 'string' ? data.url : '',
      method: data.method === 'POST' ? 'POST' : 'GET',
      body: typeof data.body === 'string' ? data.body : undefined,
    };
    const reply = (payload: object) => window.opener?.postMessage(
      { channel: ZHS_CHANNEL, type: 'zhs-response', nonce, id: data.id, ...payload },
      origin,
    );
    if (!allowedZhsRequest(input)) {
      reply({ error: '桥接拒绝了非知到接口请求' });
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
      const response = await fetch(input.url, {
        method: input.method ?? 'GET',
        body: input.method === 'POST' ? input.body : undefined,
        credentials: 'include',
        mode: 'cors',
        redirect: 'follow',
        headers: input.method === 'POST'
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : undefined,
        signal: controller.signal,
      });
      reply({ status: response.status, text: await response.text() });
    } catch {
      reply({ error: '知到请求失败或已取消，请检查此窗口的登录状态。' });
    } finally {
      clearTimeout(timeout);
      delete active[data.id];
      activeCount -= 1;
    }
  });
}
