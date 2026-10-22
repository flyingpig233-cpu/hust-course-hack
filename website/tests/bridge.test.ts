import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/hust-course-bridge.user.js', import.meta.url), 'utf8');
const platform = 'https://smartcourse.hust.edu.cn', channel = 'hust-course-bridge-v1';
function harness(allowed = true, loggedIn = true) {
  const replies: any[] = [], calls: any[] = [], confirmations: string[] = [];
  let listener: (event: any) => Promise<void>;
  const opener = { postMessage(data: unknown, origin: string) { replies.push({ data, origin }); } };
  const window: any = { opener, addEventListener(_name: string, handler: typeof listener) { listener = handler; } };
  window.top = window;
  runInNewContext(script, {
    window, location: { origin: platform }, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    confirm(message: string) { confirmations.push(message); return allowed; },
    async fetch(url: string, options: any) {
      calls.push({ url, options });
      return { ok: true, status: 200, url: loggedIn ? url : `${platform}/passport`, async text() { return loggedIn ? '<li class="w_couritem">synthetic</li>' : '<title>用户登录</title>'; } };
    },
  });
  const send = (data: object, origin = 'https://flyingpig233-cpu.github.io', source: any = opener) => listener!({ data: { channel, nonce: 'test-nonce', ...data }, origin, source });
  return { send, replies, calls, confirmations };
}

test('compiled bridge requires explicit origin consent and authenticated endpoint before ready', async () => {
  const h = harness(); await h.send({ type: 'hello' });
  assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0], /https:\/\/flyingpig233-cpu.github.io/);
  assert.equal(h.calls.length, 1); assert.equal(h.replies[0].data.type, 'ready');
  assert.equal(h.replies[0].origin, 'https://flyingpig233-cpu.github.io');
  const denied = harness(false); await denied.send({ type: 'hello' }); assert.equal(denied.calls.length, 0); assert.equal(denied.replies.length, 0);
  const loggedOut = harness(true, false); await loggedOut.send({ type: 'hello' }); assert.equal(loggedOut.replies.length, 0);
});

test('compiled bridge rejects wrong window, origin, nonce and targets without forwarding', async () => {
  const h = harness();
  await h.send({ type: 'hello' }, 'https://flyingpig233-cpu.github.io', {});
  await h.send({ type: 'hello' }, 'http://evil.example');
  assert.equal(h.confirmations.length, 0);
  await h.send({ type: 'hello' }); h.calls.length = 0; h.replies.length = 0;
  const request = { type: 'request', id: 'one', input: { url: `${platform}/mooc-ans/knowledge/cards` } };
  await h.send(request, 'https://evil.example');
  await h.send({ ...request, nonce: 'wrong' });
  await h.send({ ...request, input: { url: 'https://evil.example/' } });
  assert.equal(h.calls.length, 0); assert.equal(h.replies.length, 1); assert.ok(h.replies[0].data.error);
});

test('compiled bridge forwards same-origin credentials but returns no cookies or headers', async () => {
  const h = harness(); await h.send({ type: 'hello' }); h.calls.length = 0; h.replies.length = 0;
  await h.send({ type: 'request', id: 'two', input: { url: `${platform}/mooc-ans/knowledge/cards`, referrer: `${platform}/mooc-ans/mycourse/studentstudyAjax` } });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.credentials, 'same-origin');
  assert.equal(h.calls[0].options.mode, 'same-origin');
  assert.equal(h.replies[0].data.response.status, 200);
  assert.deepEqual(Object.keys(h.replies[0].data.response).sort(), ['body', 'status', 'url']);
  await h.send({ type: 'disconnect' }); h.calls.length = 0;
  await h.send({ type: 'request', id: 'three', input: { url: `${platform}/mooc-ans/knowledge/cards` } });
  assert.equal(h.calls.length, 0);
});
