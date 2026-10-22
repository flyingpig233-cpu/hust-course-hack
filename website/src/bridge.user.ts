import { allowedRequest, CHANNEL, PLATFORM, type HttpRequest } from './core/transport';

// The platform retains its HttpOnly cookies; only response bodies cross the window boundary.
if (window.top === window && location.origin === PLATFORM && window.opener) {
  let origin = '';
  let nonce = '';
  let rejected = false;
  let checking = false;
  let verifiedAt = 0;
  const active = new Map<string, AbortController>();
  const trustedOrigin = (value: string) => {
    try {
      const url = new URL(value);
      return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
    } catch { return false; }
  };
  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (event.source !== window.opener || data?.channel !== CHANNEL) return;
    if (data.type === 'hello') {
      if (rejected || typeof data.nonce !== 'string' || data.nonce.length > 100 || !trustedOrigin(event.origin)) return;
      if (!origin) {
        if (!confirm(`允许课程助手 ${event.origin} 通过此窗口读取课程并执行你在助手中选择的任务？\n\nCookie 不会发送给助手。关闭此窗口可断开连接。`)) { rejected = true; return; }
        origin = event.origin; nonce = data.nonce;
      }
      if (origin !== event.origin || nonce !== data.nonce || checking) return;
      // The initial page may still be the login screen. Do not tell the website
      // that a session exists until the authenticated list endpoint succeeds.
      if (Date.now() - verifiedAt < 2000) return;
      checking = true; verifiedAt = Date.now();
      try {
        const response = await fetch(`${PLATFORM}/fyportal-smartcourse/fyportal/wfw/courselist/getStudyCourse?sectionId=0`, {
          credentials: 'same-origin', mode: 'same-origin', signal: AbortSignal.timeout(8000),
        });
        const body = await response.text();
        if (response.ok && new URL(response.url).pathname.endsWith('/getStudyCourse')
          && !/请先登录|用户登录|<title>[^<]*登录/.test(body)
          && (body.includes('w_couritem') || !/passport|\blogin\b/i.test(body))) {
          window.opener.postMessage({ channel: CHANNEL, type: 'ready', nonce }, origin);
        }
      } catch { /* Wait for the user to finish the official login flow. */ }
      finally { checking = false; }
      return;
    }
    if (!origin || event.origin !== origin || data.nonce !== nonce) return;
    if (data.type === 'disconnect') {
      active.forEach((controller) => controller.abort()); active.clear(); origin = ''; nonce = ''; return;
    }
    if (data.type === 'abort') { active.get(data.id)?.abort(); return; }
    if (data.type !== 'request' || typeof data.id !== 'string' || !data.input || active.has(data.id)) return;
    const input = data.input as HttpRequest;
    const reply = (payload: object) => window.opener?.postMessage({ channel: CHANNEL, type: 'response', nonce, id: data.id, ...payload }, origin);
    if (!allowedRequest(input)) { reply({ error: '桥接拒绝了非课程接口请求' }); return; }
    if (active.size >= 12) { reply({ error: '并发请求过多' }); return; }
    const controller = new AbortController(); active.set(data.id, controller);
    const timeout = setTimeout(() => controller.abort(), 40_000);
    try {
      const response = await fetch(input.url, {
        method: input.method ?? 'GET', body: input.body,
        credentials: 'same-origin', mode: 'same-origin', redirect: 'follow',
        referrer: input.referrer ?? `${PLATFORM}/i-smartcourse/base`, referrerPolicy: 'same-origin',
        headers: input.method === 'POST'
          ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }
          : { 'X-Requested-With': 'XMLHttpRequest' },
        signal: controller.signal,
      });
      if (new URL(response.url).origin !== PLATFORM) throw new Error('请在学校窗口完成登录');
      reply({ response: { body: await response.text(), url: response.url, status: response.status } });
    } catch { reply({ error: '学校请求失败或已取消，请检查此窗口的登录状态。' }); }
    finally { clearTimeout(timeout); active.delete(data.id); }
  });
}
