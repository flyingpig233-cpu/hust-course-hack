import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  desDecryptEcbBase64,
  desEncryptBlock,
  desEncryptEcbBase64,
  hexToBytes,
  bytesToHex,
} from '../src/core/ul/crypto.ts';
import {
  UL_CHANNEL,
  allowedUlRequest,
  trustedUlSiteOrigin,
} from '../src/core/ul/transport.ts';
import {
  parseBasicInformation,
  parseCourseRef,
  parseDirectory,
  parseInitialize,
  parsePageContent,
  parseQuestionAnswer,
  parseRemaining,
  parseSectionRecord,
  parseWholepageItem,
  randomInt,
  RateLimiter,
} from '../src/core/ul/client.ts';
import { buildSectionPayload, planSections, runSectionWatch, type UlWatchClient } from '../src/core/ul/watch.ts';
import { defaultUlWatchOptions, summarizeUlOutcomes } from '../src/core/ul/types.ts';
import type { UlCourse, UlCourseDetail, UlSectionPlan } from '../src/core/ul/types.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const course: UlCourse = {
  textbook_id: 47353,
  class_id: 1019700,
  oc_id: 165508,
  name: '习近平新时代中国特色社会主义思想概论',
  teacher: '王老师',
  locale: 'zh_CN',
  expired: false,
};

test('DES-ECB matches the FIPS block vector and OpenSSL PKCS#7 vectors', () => {
  const block = desEncryptBlock(hexToBytes('0123456789abcdef'), hexToBytes('133457799bbcdff1'));
  assert.equal(bytesToHex(block), '85e813540f0ab405');
  // Vectors generated independently with `openssl enc -des-ecb -provider legacy`.
  assert.equal(desEncryptEcbBase64('hello'), 'uhbGoCVxJa8=');
  assert.equal(desEncryptEcbBase64('{"a":1}'), 'voMb9bxrG2Y=');
  assert.equal(
    desEncryptEcbBase64('{"itemid":2377981,"complete":1}'),
    '+rydL4Ll3U9fTNud6KUNjrSzi1LghsQKw/2u23f/y1Y=',
  );
  assert.equal(desDecryptEcbBase64('uhbGoCVxJa8='), 'hello');
  assert.equal(
    desDecryptEcbBase64('+rydL4Ll3U9fTNud6KUNjrSzi1LghsQKw/2u23f/y1Y='),
    '{"itemid":2377981,"complete":1}',
  );
  assert.throws(() => desDecryptEcbBase64('AAAA'));
});

function videoPlan(): UlSectionPlan {
  return {
    section_id: 2377981,
    section_name: '1.1 思想的产生背景',
    chapter_id: 141351390,
    chapter_name: '第一讲',
    action: 'complete',
    reason: null,
    pages: [{
      page_id: 2377982,
      relation_id: 2377982,
      content_type: 6,
      coursepage_id: null,
      videos: [{ video_id: 1563126, duration_secs: 1326 }],
      questions: [],
    }],
  };
}

test('sync payload matches the live-verified ItemStudyRecordUpdateDTO byte for byte', () => {
  const payload = buildSectionPayload(videoPlan(), 1794062059);
  assert.equal(
    JSON.stringify(payload),
    '{"itemid":2377981,"autoSave":1,"withoutOld":null,"complete":1,"studyStartTime":1794062059,'
    + '"score":100,"pageStudyRecordDTOList":[{"pageid":2377982,"complete":1,"studyTime":1000,'
    + '"score":100,"answerTime":1,"submitTimes":0,"questions":[],"videos":[{"videoid":1563126,'
    + '"current":1326,"status":1,"recordTime":1326,"time":1326,'
    + '"startEndTimeList":[{"startTime":0,"endTime":1326}]}],"speaks":[]}]}',
  );
  const quizPlan: UlSectionPlan = {
    ...videoPlan(),
    section_id: 2379018,
    pages: [{
      page_id: 2379019,
      relation_id: 2379019,
      content_type: 7,
      coursepage_id: 888,
      videos: [],
      questions: [{ question_id: 11, score: 5, answers: ['D'] }],
    }],
  };
  const quiz = JSON.stringify(buildSectionPayload(quizPlan, 100));
  assert.match(quiz, /"coursepageId":888/);
  assert.match(quiz, /"submitTimes":1/);
  assert.match(quiz, /"questions":\[{"questionid":11,"answerList":\["D"\],"score":5}\]/);
  assert.match(quiz, /"videos":\[\]/);
});

test('player URLs and manual textbook/class references decode', () => {
  assert.deepEqual(
    parseCourseRef('https://ua.ulearning.cn/learnCourse/learnCourse.html?courseId=47353&chapterId=141351390&classId=1019700'),
    { textbook_id: 47353, class_id: 1019700, oc_id: null, chapter_id: 141351390 },
  );
  assert.deepEqual(parseCourseRef('47353/1019700'), { textbook_id: 47353, class_id: 1019700, oc_id: null, chapter_id: null });
  assert.deepEqual(parseCourseRef('47353 1019700'), { textbook_id: 47353, class_id: 1019700, oc_id: null, chapter_id: null });
  assert.deepEqual(parseCourseRef('47353'), { textbook_id: 47353, class_id: null, oc_id: null, chapter_id: null });
  assert.equal(parseCourseRef('不知道'), null);
});

test('directory, record, page, answer and remaining parsers tolerate platform wrappers', () => {
  const chapters = parseDirectory({
    data: {
      chapterList: [{
        id: 141351390,
        name: '第一讲',
        sectionList: [{
          id: 2377981,
          name: '1.1 背景',
          pageList: [{ id: 2377982, relationId: 2377982, name: '视频', contentType: 6 }],
        }],
      }],
    },
  });
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].sections[0].section_id, 2377981);
  assert.equal(chapters[0].sections[0].pages[0].relation_id, 2377982);

  assert.equal(parseSectionRecord({ data: { completion_status: 1 } }).completion_status, 1);
  assert.equal(parseSectionRecord({ completion_status: 0 }).completion_status, 0);
  assert.deepEqual(
    parseWholepageItem({ itemid: 1, wholepageDTOList: [{ id: 2, relationId: 3, name: 'p', contentType: 6 }] }),
    [{ page_id: 2, relation_id: 3, name: 'p', content_type: 6 }],
  );
  const videoPage = parsePageContent({
    data: {
      contentType: 6,
      coursepageDTOList: [{ type: 4, coursepageDTOid: 777, resourceid: 1563126, videoLength: 1326 }],
    },
  });
  assert.equal(videoPage.content_type, 6);
  assert.equal(videoPage.coursepage_id, 777);
  assert.deepEqual(videoPage.videos, [{ video_id: 1563126, duration_secs: 1326 }]);
  assert.deepEqual(videoPage.questions, []);
  const quizPage = parsePageContent({
    data: {
      contentType: 7,
      coursepageDTOList: [{ type: 6, coursepageDTOid: 888, questionDTOList: [{ questionid: 11, score: 5 }] }],
    },
  });
  assert.deepEqual(quizPage.questions, [{ question_id: 11, score: 5, answers: [] }]);
  assert.deepEqual(parseQuestionAnswer({ correctAnswerList: ['D'] }), ['D']);
  assert.deepEqual(parseQuestionAnswer({ data: { correctAnswerList: ['A', 'C'] } }), ['A', 'C']);
  assert.equal(parseInitialize({ data: { studyStartTime: 1794062059 } }), 1794062059);
  assert.equal(parseRemaining({ data: { time: -1 } }).expired, true);
  assert.equal(parseRemaining({ data: { time: 3600 } }).expired, false);
  assert.equal(parseBasicInformation({ data: { courseName: 'C', teacherName: 'T', locale: 'zh_CN' } }).name, 'C');
});

const detail: UlCourseDetail = {
  course,
  chapters: [{
    chapter_id: 141351390,
    name: '第一讲',
    sections: [
      {
        section_id: 1,
        name: 'done',
        chapter_id: 141351390,
        chapter_name: '第一讲',
        pages: [{ page_id: 11, relation_id: 11, name: 'v', content_type: 6 }],
        completion_status: 1,
        video_secs: 60,
      },
      {
        section_id: 2,
        name: 'video',
        chapter_id: 141351390,
        chapter_name: '第一讲',
        pages: [{ page_id: 21, relation_id: 22, name: 'v', content_type: 6 }],
        completion_status: 0,
        video_secs: 60,
      },
      {
        section_id: 3,
        name: 'quiz',
        chapter_id: 141351390,
        chapter_name: '第一讲',
        pages: [{ page_id: 31, relation_id: 31, name: 'q', content_type: 7 }],
        completion_status: 0,
        video_secs: null,
      },
      {
        section_id: 4,
        name: 'document',
        chapter_id: 141351390,
        chapter_name: '第一讲',
        pages: [{ page_id: 41, relation_id: 41, name: 'd', content_type: 10 }],
        completion_status: 0,
        video_secs: null,
      },
      {
        section_id: 5,
        name: 'text',
        chapter_id: 141351390,
        chapter_name: '第一讲',
        pages: [{ page_id: 51, relation_id: 51, name: 't', content_type: 5 }],
        completion_status: 0,
        video_secs: null,
      },
    ],
  }],
};

function planClient(answers: Record<number, string[]> = {}) {
  const contents: Record<number, ReturnType<typeof parsePageContent>> = {
    11: { content_type: 6, coursepage_id: null, videos: [{ video_id: 1, duration_secs: 60 }], questions: [] },
    21: { content_type: 6, coursepage_id: null, videos: [{ video_id: 2, duration_secs: 60 }], questions: [] },
    31: { content_type: 7, coursepage_id: 888, videos: [], questions: [{ question_id: 11, score: 5, answers: [] }] },
    41: { content_type: 10, coursepage_id: null, videos: [], questions: [] },
    51: { content_type: 5, coursepage_id: null, videos: [], questions: [] },
  };
  return {
    async wholepageItem() { return []; },
    async pageContent(pageId: number) { return contents[pageId] ?? { content_type: 0, coursepage_id: null, videos: [], questions: [] }; },
    async questionAnswer(questionId: number) { return answers[questionId] ?? []; },
  };
}

test('plan skips done/quiz/unsupported sections and can include exercises', async () => {
  const options = defaultUlWatchOptions({ dry_run: true });
  const plans = await planSections(planClient(), detail, options, new AbortController().signal);
  const actions = Object.fromEntries(plans.map((plan) => [plan.section_id, plan.action]));
  assert.deepEqual(actions, { 1: 'skip_done', 2: 'complete', 3: 'skip_quiz', 4: 'skip_invalid', 5: 'complete' });
  assert.equal(plans.find((plan) => plan.section_id === 2)?.pages[0].relation_id, 22);

  const withQuiz = await planSections(
    planClient({ 11: ['D'] }),
    detail,
    defaultUlWatchOptions({ include_quizzes: true }),
    new AbortController().signal,
  );
  const quizPlan = withQuiz.find((plan) => plan.section_id === 3);
  assert.equal(quizPlan?.action, 'complete');
  assert.deepEqual(quizPlan?.pages[0].questions[0].answers, ['D']);

  const missingAnswer = await planSections(
    planClient(),
    detail,
    defaultUlWatchOptions({ include_quizzes: true }),
    new AbortController().signal,
  );
  assert.equal(missingAnswer.find((plan) => plan.section_id === 3)?.action, 'skip_invalid');

  const limited = await planSections(planClient(), detail, defaultUlWatchOptions({ max_sections: 1 }), new AbortController().signal);
  assert.equal(limited.filter((plan) => plan.action === 'complete').length, 1);

  const expired = await planSections(
    planClient(),
    { ...detail, course: { ...course, expired: true } },
    options,
    new AbortController().signal,
  );
  assert.ok(expired.every((plan) => plan.action === 'skip_expired'));

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await planSections(planClient(), detail, options, controller.signal), []);
});

function watchClient(overrides: Partial<UlWatchClient & { calls: string[] }> = {}) {
  const calls: string[] = [];
  const client: UlWatchClient & { calls: string[] } = {
    calls,
    async initialize() { calls.push('initialize'); return 1794062059; },
    async sync() { calls.push('sync'); return { response: 1, text: '1' }; },
    async sectionRecord() { calls.push('verify'); return { completion_status: 1 }; },
    async wholepageItem() { return []; },
    async pageContent() { return { content_type: 6, coursepage_id: null, videos: [], questions: [] }; },
    async questionAnswer() { return []; },
    ...overrides,
  };
  return client;
}

function completePlan(sectionId = 2377981): UlSectionPlan {
  return { ...videoPlan(), section_id: sectionId };
}

test('dry-run executor never initializes or submits and reports payload size', async () => {
  const client = watchClient();
  const outcomes = await runSectionWatch(
    client,
    [completePlan(), { ...completePlan(2), action: 'skip_done', reason: '已标记完成' }],
    defaultUlWatchOptions({ dry_run: true }),
    new AbortController().signal,
    { limiter: new RateLimiter(0, 0) },
  );
  assert.deepEqual(outcomes.map((outcome) => outcome.state), ['dry_run', 'skip']);
  assert.equal(client.calls.length, 0);
  assert.match(outcomes[0].message, /未发送/);
});

test('real executor initializes, submits, verifies and stops immediately on response 2', async () => {
  const client = watchClient();
  const options = defaultUlWatchOptions({ dry_run: false, delay_min_ms: 0, delay_max_ms: 0 });
  const outcomes = await runSectionWatch(client, [completePlan()], options, new AbortController().signal, {
    limiter: new RateLimiter(0, 0),
  });
  assert.deepEqual(outcomes.map((outcome) => outcome.state), ['ok']);
  assert.deepEqual(client.calls, ['initialize', 'sync', 'verify']);
  assert.equal(outcomes[0].response, 1);

  const rejected = watchClient({ async sync() { return { response: 2, text: '2' }; } });
  const rejectedOutcomes = await runSectionWatch(rejected, [completePlan(), completePlan(2)], options, new AbortController().signal, {
    limiter: new RateLimiter(0, 0),
  });
  assert.equal(rejectedOutcomes.length, 1);
  assert.equal(rejectedOutcomes[0].state, 'circuit_broken');
  assert.equal(rejectedOutcomes[0].response, 2);

  const failed = watchClient({ async sync() { return { response: 0, text: '0' }; } });
  const failedOutcomes = await runSectionWatch(failed, [completePlan()], options, new AbortController().signal, {
    limiter: new RateLimiter(0, 0),
  });
  assert.equal(failedOutcomes[0].state, 'failed');

  const verifyFailed = watchClient({ async sectionRecord() { return { completion_status: 0 }; } });
  const verifyOutcomes = await runSectionWatch(verifyFailed, [completePlan()], options, new AbortController().signal, {
    limiter: new RateLimiter(0, 0),
  });
  assert.equal(verifyOutcomes[0].state, 'failed');
  assert.match(verifyOutcomes[0].message, /completion_status=0/);
});

test('random pacing stays inside the configured window and summaries count states', () => {
  assert.ok(randomInt(2000, 4000) >= 2000 && randomInt(2000, 4000) <= 4000);
  const limiter = new RateLimiter(2000, 4000, () => 0);
  assert.equal(limiter.nextDelay(), 2000);
  assert.equal(limiter.nextDelay(() => 0.999999), 4000);
  const summary = summarizeUlOutcomes([
    { label: 'a', state: 'ok', pages: 1, response: 1, message: '' },
    { label: 'b', state: 'dry_run', pages: 1, response: null, message: '' },
    { label: 'c', state: 'skip', pages: 1, response: null, message: '' },
    { label: 'd', state: 'failed', pages: 1, response: null, message: '' },
    { label: 'e', state: 'cancelled', pages: 1, response: null, message: '' },
  ]);
  assert.deepEqual(summary, { ok: 1, skipped: 2, failed: 1, cancelled: true, circuitBroken: false });
});

test('bridge allowlist only accepts Ulearning API routes and methods', () => {
  assert.equal(allowedUlRequest({ url: 'https://api.ulearning.cn/course/stu/47353/directory?classId=1019700' }), true);
  assert.equal(allowedUlRequest({ url: 'https://api.ulearning.cn/studyrecord/item/2377981?courseType=4' }), true);
  assert.equal(allowedUlRequest({ url: 'https://api.ulearning.cn/questionAnswer/11?parentId=31' }), true);
  assert.equal(allowedUlRequest({ url: 'https://api.ulearning.cn/yws/api/personal/sync?courseType=4&platform=PC', method: 'POST', body: 'x' }), true);
  for (const input of [
    { url: 'https://evil.example/course/stu/1/directory' },
    { url: 'https://api.ulearning.cn/yws/api/personal/sync?courseType=4' },
    { url: 'https://api.ulearning.cn/course/stu/1/directory', method: 'POST' as const, body: 'x' },
    { url: 'https://api.ulearning.cn/studyrecord/item/1?courseType=4', body: 'x' },
    { url: 'https://api.ulearning.cn/questionAnswer/1?parentId=2', method: 'POST' as const, body: 'x' },
    { url: 'https://user:pass@api.ulearning.cn/course/stu/1/directory' },
    { url: 'https://api.ulearning.cn/yws/api/personal/sync?courseType=4', method: 'POST' as const, body: 'x'.repeat(200_001) },
  ]) {
    assert.equal(allowedUlRequest(input), false);
  }
  assert.equal(trustedUlSiteOrigin('https://flyingpig233-cpu.github.io'), true);
  assert.equal(trustedUlSiteOrigin('http://localhost:1421'), true);
  assert.equal(trustedUlSiteOrigin('http://evil.example'), false);
});

// ---------------------------------------------------------------------------
// Compiled Ulearning bridge
// ---------------------------------------------------------------------------

const bridgeScript = readFileSync(new URL('../public/ulearning-bridge.user.js', import.meta.url), 'utf8');
const pageOrigin = 'https://courseweb.ulearning.cn';
const siteOrigin = 'https://flyingpig233-cpu.github.io';
const token = 'demo-token-value';

function bridgeHarness(options: { cookie?: string } = {}) {
  const replies: Array<{ data: any; origin: string }> = [];
  const calls: Array<{ url: string; init: any }> = [];
  const confirmations: string[] = [];
  let listener: ((event: any) => Promise<void>) | undefined;
  const opener = { postMessage(data: unknown, origin: string) { replies.push({ data, origin }); } };
  const window: any = { opener, addEventListener(_name: string, handler: (event: any) => Promise<void>) { listener = handler; } };
  window.top = window;
  const cookie = options.cookie ?? `AUTHORIZATION=${encodeURIComponent(token)}`;
  runInNewContext(bridgeScript, {
    window,
    location: { origin: pageOrigin },
    document: { cookie },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    decodeURIComponent,
    confirm(message: string) { confirmations.push(message); return true; },
    async fetch(url: string, init: any) {
      calls.push({ url, init });
      return { status: 200, async text() { return '1'; } };
    },
  });
  const send = (data: object, origin = siteOrigin, source: any = opener) => listener!({
    data: { channel: UL_CHANNEL, nonce: 'nonce-1', ...data },
    origin,
    source,
  });
  return { send, replies, calls, confirmations };
}

test('compiled bridge waits for the login token and hides it from the static site', async () => {
  const harness = bridgeHarness();
  await harness.send({ type: 'ul-hello' });
  await tick();
  assert.equal(harness.confirmations.length, 1);
  assert.equal(harness.replies[0].data.type, 'ul-ready');
  assert.equal(harness.replies[0].data.platform, 'ulearning');
  assert.ok(!JSON.stringify(harness.replies).includes(token));

  const loggedOut = bridgeHarness({ cookie: '' });
  await loggedOut.send({ type: 'ul-hello' });
  await tick();
  assert.equal(loggedOut.replies.length, 0);

  const wrongSource = bridgeHarness();
  await wrongSource.send({ type: 'ul-hello' }, siteOrigin, {});
  assert.equal(wrongSource.confirmations.length, 0);
});

test('compiled bridge injects both auth headers and rejects non-whitelisted requests', async () => {
  const harness = bridgeHarness();
  await harness.send({ type: 'ul-hello' });
  await tick();
  harness.replies.length = 0;

  await harness.send({
    type: 'ul-request',
    id: 'one',
    url: 'https://api.ulearning.cn/yws/api/personal/sync?courseType=4&platform=PC',
    method: 'POST',
    body: 'ciphertext',
  });
  await tick();
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].init.headers.Authorization, token);
  assert.equal(harness.calls[0].init.headers['UA-AUTHORIZATION'], token);
  assert.equal(harness.calls[0].init.headers.version, '1');
  assert.equal(harness.calls[0].init.credentials, 'include');
  assert.equal(harness.replies[0].data.type, 'ul-response');
  assert.equal(harness.replies[0].data.status, 200);
  assert.deepEqual(Object.keys(harness.replies[0].data).sort(), ['channel', 'id', 'nonce', 'status', 'text', 'type']);
  assert.ok(!JSON.stringify(harness.replies).includes(token));

  await harness.send({ type: 'ul-request', id: 'two', url: 'https://evil.example/course/stu/1/directory' });
  await tick();
  assert.equal(harness.calls.length, 1);
  assert.ok(harness.replies[1].data.error);

  await harness.send({ type: 'ul-request', id: 'three', url: 'https://api.ulearning.cn/course/stu/1/directory', method: 'POST', body: 'x' });
  await tick();
  assert.equal(harness.calls.length, 1);

  await harness.send({ type: 'ul-disconnect' });
  await harness.send({ type: 'ul-request', id: 'four', url: 'https://api.ulearning.cn/course/stu/1/directory' });
  await tick();
  assert.equal(harness.calls.length, 1);
});
