import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { constants, generateKeyPairSync, privateDecrypt, privateEncrypt } from 'node:crypto';
import {
  AES_IV,
  PUBLIC_KEY_B64,
  VIDEO_MODULE_KEY_FALLBACK,
  decryptSecret,
  encryptSecret,
  hms,
  parseHms,
  parsePublicKey,
  rsaEncryptPkcs1v15,
  rsaPublicUnpad,
  watchPoints,
  xorDecode,
  xorEncode,
  MODULE_KEY_TTL_MS,
  ModuleKeyCache,
} from '../src/core/zhs/crypto.ts';
import {
  ZHS_CHANNEL,
  allowedZhsRequest,
  trustedSiteOrigin,
  type ZhsHttpRequest,
} from '../src/core/zhs/transport.ts';
import { buildVideoReport, decodeCourseRef, parseCourseList, parseExceptionStatus, parseJsonp, parseMeetList, parseMeetPage, parseWatchHistory, RateLimiter, randomInt, ZhsClient } from '../src/core/zhs/client.ts';
import { coverageTarget, planMeetMinutes, runMeetWatch, type MeetWatchClient } from '../src/core/zhs/meet.ts';
import { planVideoTargets, runVideoWatch, type VideoWatchClient } from '../src/core/zhs/watch.ts';
import { defaultMeetWatchOptions, defaultWatchOptions } from '../src/core/zhs/types.ts';
import type { ZhsCourse, ZhsCourseDetail, ZhsMeet, ZhsMeetProgress } from '../src/core/zhs/types.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const course: ZhsCourse = {
  recruit_id: 463667,
  course_id: 1000011214,
  class_id: 3001,
  school_id: 360,
  name: '军事理论',
  teacher: '张教授',
  secret: null,
  is_apply: 1,
  course_type: 'share',
  progress: null,
  studied_lesson_count: null,
  total_lesson_count: null,
  status: 1,
};

test('AES-CBC vectors match the verified Node/Java implementation', async () => {
  // Node's crypto module produced these vectors; the page reports the same ones
  // live (see the captured `dateFormate` payload in the recon notes).
  assert.equal(await encryptSecret(VIDEO_MODULE_KEY_FALLBACK, '{"module":11}'), 'c3hL8cDHVoZddI2cmM//VA==');
  assert.equal(
    await encryptSecret(VIDEO_MODULE_KEY_FALLBACK, '{"recruitId":463667,"schoolId":360,"dateFormate":1794058934000}'),
    'CGahwLFhzbTaaGYactOaG9821SDKjSZyY4eQuOCM1KgDLYXxK05GR16eeNXjaOfuyH1lWD/SKgogvCANbLRd2w==',
  );
  assert.equal(await decryptSecret(VIDEO_MODULE_KEY_FALLBACK, 'c3hL8cDHVoZddI2cmM//VA=='), '{"module":11}');
  assert.equal(AES_IV, '1g3qqdh4jvbskb9x');
});

test('XOR encoding joins with semicolons, cycles the key and decodes back', () => {
  assert.equal(xorEncode(['100', '200', '300'], 'zzpttjd'), '4b4a404f465a5441494044');
  assert.equal(xorEncode(['军事理论', '100'], 'zzpttjd'), '51e14ef174768bce4f5b544a');
  assert.equal(xorDecode(xorEncode(['463667', '1000011214'], 'zhihuishu'), 'zhihuishu'), '463667;1000011214');
  assert.equal(xorDecode(xorEncode([1, 2, 3], 'zzpttjd'), 'zzpttjd'), '1;2;3');
  assert.throws(() => xorDecode('zz', 'zzpttjd'));
});

test('hms and watchPoints follow the verified heartbeat sequence', () => {
  assert.equal(hms(0), '00:00:00');
  assert.equal(hms(59), '00:00:59');
  assert.equal(hms(3600), '01:00:00');
  assert.equal(hms(3661), '01:01:01');
  assert.equal(parseHms('01:01:01'), 3661);
  assert.equal(parseHms('01:01'), 61);
  assert.equal(parseHms('bad'), null);
  assert.equal(watchPoints(0), '0,1');
  assert.equal(watchPoints(10), '0,1,2,2,2,3,3,3');
  const points = watchPoints(826).split(',');
  assert.equal(points.length, 418);
  assert.equal(points[0], '0');
  assert.equal(points[1], '1');
  assert.ok(points.every((point) => /^\d+$/.test(point)));
});

test('PKCS#1 v1.5 encryption and public-op unpadding interoperate with OpenSSL', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKeyB64 = (publicKey as Buffer).toString('base64');
  const { modulus, exponent } = parsePublicKey(publicKeyB64);
  assert.ok(modulus > 0n);
  assert.equal(exponent, 65537n);

  // Our PKCS#1 block must decrypt with OpenSSL's private key.
  return (async () => {
    const block = await rsaEncryptPkcs1v15(publicKeyB64, '{"module":9}');
    const plaintext = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(block, 'base64'),
    ).toString('utf8');
    assert.equal(plaintext, '{"module":9}');

    // OpenSSL-produced PKCS#1 blob must unpadded by our public-op helper.
    const blob = privateEncrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from('{"cKey":"azp53h0kft7qi78q","module":11}', 'utf8'),
    ).toString('base64');
    assert.equal(await rsaPublicUnpad(publicKeyB64, blob), '{"cKey":"azp53h0kft7qi78q","module":11}');
    await assert.rejects(() => rsaPublicUnpad(publicKeyB64, Buffer.alloc(8).toString('base64')));
  })();
});

test('queryShareCourseInfo uses module 13, the date field and result.courseOpenDtos', async () => {
  // Sanitized fixture shaped like the live capture (all ids/names replaced).
  const fixture = {
    result: {
      totalCount: 2,
      courseOpenDtos: [
        {
          courseId: 111,
          courseName: '测试课程A',
          teacherName: '张老师',
          progress: '10.9%',
          recruitId: 222,
          secret: 'synthetic-secret',
          classId: 333,
          courseType: 1,
          termName: '2026秋',
        },
        { courseId: 0, courseName: 'invalid-row-without-recruit' },
      ],
    },
    code: 200,
    message: null,
  };
  const cache = new ModuleKeyCache();
  cache.set(13, 'module13-key-16b');
  const requests: ZhsHttpRequest[] = [];
  const client = new ZhsClient({
    async request(input) {
      requests.push(input);
      return { status: 200, text: JSON.stringify(fixture) };
    },
  }, { moduleKeys: cache });
  const courses = await client.listCourses();
  assert.equal(courses.length, 1);
  assert.equal(courses[0].name, '测试课程A');
  assert.equal(courses[0].recruit_id, 222);
  assert.equal(courses[0].course_id, 111);
  assert.equal(courses[0].class_id, 333);
  assert.equal(courses[0].teacher, '张老师');
  assert.equal(courses[0].secret, 'synthetic-secret');
  assert.equal(courses[0].progress, 10.9);
  assert.equal(courses[0].course_type, '1');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.match(requests[0].url, /onlineservice-api\.zhihuishu\.com\/gateway\/t\/v1\/student\/course\/share\/queryShareCourseInfo$/);
  const form = new URLSearchParams(requests[0].body ?? '');
  assert.ok(form.get('date'));
  assert.equal(form.has('dateFormate'), false);
  assert.equal(
    await decryptSecret('module13-key-16b', form.get('secretStr') ?? ''),
    '{"status":0,"pageNo":1,"pageSize":5}',
  );
  assert.equal(allowedZhsRequest({
    url: 'https://onlineservice-api.zhihuishu.com/gateway/t/v1/student/course/share/queryShareCourseInfo',
    method: 'POST',
    body: 'secretStr=x&date=1',
  }), true);
});

test('video exception status treats rt.endTime without lock/abnormal as an abnormal lock', async () => {
  const cache = new ModuleKeyCache();
  cache.set(11, VIDEO_MODULE_KEY_FALLBACK);
  const urls: string[] = [];
  const client = new ZhsClient({
    async request(input) {
      urls.push(input.url);
      return { status: 200, text: JSON.stringify({ rt: { endTime: '2026-11-10 23:59:59', tipStr: '学习异常' } }) };
    },
  }, { moduleKeys: cache });
  const status = await client.exceptionStatus(course);
  assert.equal(status.abnormal, true);
  assert.equal(status.lock, false);
  assert.match(urls[0], /cheat\/exceptionActionDetail/);

  const clean = new ZhsClient({
    async request() { return { status: 200, text: JSON.stringify({ rt: { lock: false } }) }; },
  }, { moduleKeys: cache });
  const cleanStatus = await clean.exceptionStatus(course);
  assert.equal(cleanStatus.abnormal, false);
  assert.equal(cleanStatus.lock, false);
});

test('setIdentity drops the cached user so a reconnect uses the new account', () => {
  const client = new ZhsClient({ async request() { throw new Error('unused'); } });
  client.setIdentity({ platform: 'zhihuishu', uuid: 'AAAA1111', user_id: 111 });
  client.setUser({ user_id: 111, uuid: 'AAAA1111', real_name: 'A', school_id: null, is_teacher: false });
  assert.equal(client.uuid, 'AAAA1111');
  assert.equal(client.userId, 111);

  // Reconnect as another account: the cached user must not leak through.
  client.setIdentity({ platform: 'zhihuishu', uuid: 'BBBB2222', user_id: 222 });
  assert.equal(client.uuid, 'BBBB2222');
  assert.equal(client.userId, 222);

  client.setIdentity({ platform: 'zhihuishu', uuid: 'CCCC3333', user_id: null });
  assert.equal(client.uuid, 'CCCC3333');
  assert.equal(client.userId, null);
});

test('the shared public key and module-key cache are pinned to the protocol', async () => {
  const { modulus } = parsePublicKey(PUBLIC_KEY_B64);
  assert.equal(modulus.toString(2).length, 1024);
  const cache = new ModuleKeyCache();
  cache.set(11, 'azp53h0kft7qi78q', 1_000);
  assert.equal(cache.get(11, 1_000 + MODULE_KEY_TTL_MS - 1), 'azp53h0kft7qi78q');
  assert.equal(cache.get(11, 1_000 + MODULE_KEY_TTL_MS), null);
  assert.equal(cache.get(9, 1_000), null);
});

test('video report layout matches the live-verified sdsew fields', () => {
  const target = {
    recruit_id: 463667,
    course_id: 1000011214,
    chapter_id: 1000116293,
    lesson_id: 1000337351,
    lesson_video_id: 1000244447,
    video_id: 71192505,
    video_sec: 468,
    label: 'video',
    completed: false,
  };
  const report = buildVideoReport(course, target, 1319089322, 'EmobwO8l');
  assert.equal(
    xorDecode(report.sdsew, 'zzpttjd'),
    '463667;1000337351;1000244447;71192505;1000116293;0;468;468;00:07:48;EmobwO8lzhs',
  );
  assert.equal(report.zwsds, Buffer.from('1319089322', 'utf8').toString('base64'));
  assert.equal(report.ewssw, watchPoints(468));
  assert.equal(report.courseId, 1000011214);
});

test('course references decode from URLs, XOR secrets and plain ids', () => {
  const secret = xorEncode([463667, 1000011214], 'zhihuishu');
  const fromUrl = decodeCourseRef(`https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${secret}`);
  assert.deepEqual(fromUrl, { recruit_id: 463667, course_id: 1000011214, secret });
  assert.deepEqual(decodeCourseRef(secret), { recruit_id: 463667, course_id: 1000011214, secret });
  assert.deepEqual(decodeCourseRef('463667;1000011214'), { recruit_id: 463667, course_id: 1000011214, secret: null });
  assert.deepEqual(decodeCourseRef('https://studyvideoh5.zhihuishu.com/stuStudy?recruitId=463667&courseId=1000011214'), {
    recruit_id: 463667,
    course_id: 1000011214,
    secret: null,
  });
  assert.deepEqual(decodeCourseRef('1000011214', [course]), { recruit_id: 463667, course_id: 1000011214, secret: null });
  assert.deepEqual(decodeCourseRef('军事理论', [course]), { recruit_id: 463667, course_id: 1000011214, secret: null });
  assert.deepEqual(decodeCourseRef(''), { recruit_id: null, course_id: null, secret: null });
});

test('meet list uses stuonline /json, pageSize 10 and pages by mapCount', async () => {
  const meetRow = (index: number) => ({
    meetCourseId: 100 + index,
    liveCourseId: 200 + index,
    videoId: 300 + index,
    replayCourseUrl: `https://lc.zhihuishu.com/live/vod_room.html?liveId=${200 + index}`,
    startTime: '2026-11-08 19:00:00',
    endTime: '2026-11-08 20:30:00',
    examH5Url: null,
    taskName: `见面课 ${index}`,
    speakerJson: JSON.stringify([{ name: '张老师' }]),
  });
  const rows0 = Array.from({ length: 10 }, (_, index) => meetRow(index));
  const rows1 = Array.from({ length: 2 }, (_, index) => meetRow(10 + index));
  const requests: ZhsHttpRequest[] = [];
  const client = new ZhsClient({
    async request(input) {
      requests.push(input);
      const pageNo = Number(new URLSearchParams(input.body ?? '').get('page.pageNo') ?? '0');
      return {
        status: 200,
        text: JSON.stringify({ mapCount: 12, maps: pageNo === 0 ? rows0 : rows1 }),
      };
    },
  });
  const meets = await client.meetList(course);
  assert.equal(meets.length, 12);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'POST');
  assert.match(
    requests[0].url,
    /^https:\/\/stuonline\.zhihuishu\.com\/stuonline\/json\/teachMeeting\/listTeachMeetingStu\?examV2=ss$/,
  );
  for (const [pageNo, request] of requests.entries()) {
    const form = new URLSearchParams(request.body ?? '');
    assert.equal(form.get('recruitId'), String(course.recruit_id));
    assert.equal(form.get('page.pageNo'), String(pageNo));
    assert.equal(form.get('page.pageSize'), '10');
  }
  assert.equal(meets[0].meet_course_id, 100);
  assert.equal(meets[0].live_id, 200);
  assert.equal(meets[0].video_id, 300);
  assert.equal(meets[0].replay_url, 'https://lc.zhihuishu.com/live/vod_room.html?liveId=200');
  assert.equal(meets[0].teacher, '张老师');
  assert.notEqual(meets[0].start_time, null);
  assert.equal(meets[11].meet_course_id, 111);

  // Sanitized fixture: mapCount + maps is the live reply shape.
  const parsed = parseMeetPage({ mapCount: 12, maps: rows0 }, course);
  assert.equal(parsed.mapCount, 12);
  assert.equal(parsed.meets.length, 10);
  assert.equal(parsed.meets[9].meet_course_id, 109);

  assert.equal(allowedZhsRequest({
    url: 'https://stuonline.zhihuishu.com/stuonline/json/teachMeeting/listTeachMeetingStu?examV2=ss',
    method: 'POST',
    body: 'recruitId=1&page.pageNo=0&page.pageSize=10',
  }), true);
});

test('meet list falls back to onlineSchool when the stuonline /json endpoint fails', async () => {
  const requests: ZhsHttpRequest[] = [];
  const client = new ZhsClient({
    async request(input) {
      requests.push(input);
      if (input.url.includes('/stuonline/json/')) throw new Error('HTTP 400');
      return {
        status: 200,
        text: JSON.stringify({ mapCount: 1, maps: [{ meetCourseId: 1, liveCourseId: 2, taskName: 'M' }] }),
      };
    },
  });
  const meets = await client.meetList(course);
  assert.equal(meets.length, 1);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /^https:\/\/online\.zhihuishu\.com\/onlineSchool\/json\/teachMeeting\/listTeachMeetingStu\?examV2=ss$/);
});

test('course/meet/history parsers survive the platform response wrappers', () => {
  const courses = parseCourseList({
    data: {
      shareCourseDtos: [
        { recruitId: 1, courseId: 2, courseName: 'A', teacherName: 'T', progress: 12 },
        { recruitId: 1, courseId: 2, courseName: 'duplicate' },
        { recruitId: 0, courseId: 0 },
      ],
    },
  });
  assert.equal(courses.length, 1);
  assert.equal(courses[0].name, 'A');
  assert.equal(courses[0].progress, 12);
  const meets = parseMeetList({
    data: { teachMeetingList: [{ meetCourseId: 9, liveId: 8, name: 'M', replayCourseUrl: 'https://lc.zhihuishu.com/x' }] },
  }, course);
  assert.equal(meets.length, 1);
  assert.equal(meets[0].live_id, 8);
  assert.equal(meets[0].recruit_id, 463667);
  assert.deepEqual(parseWatchHistory({ rt: '3,1,2,2' }), [1, 2, 3]);
  assert.deepEqual(parseWatchHistory({ rt: [4, '5'] }), [4, 5]);
  assert.deepEqual(parseWatchHistory({ rt: '' }), []);
  assert.deepEqual(parseWatchHistory({ data: { history: '1,2' } }), [1, 2]);
  assert.deepEqual(parseWatchHistory({ data: [3, 4] }), [3, 4]);
  assert.deepEqual(parseWatchHistory({ rt: 7 }), [7]);

  // The student portal wraps the meet list in a paged structure.
  const paged = parseMeetList({ data: { page: { list: [{ meetCourseId: 11, liveCourseId: 12, meetName: 'P' }] } } }, course);
  assert.equal(paged.length, 1);
  assert.equal(paged[0].live_id, 12);
  assert.equal(paged[0].meet_course_id, 11);
  assert.deepEqual(parseJsonp('jsonpCallBack([{"duration":60}])'), [{ duration: 60 }]);
  assert.deepEqual(parseJsonp('[{"duration":60}]'), [{ duration: 60 }]);
  assert.equal(parseExceptionStatus({ rt: { lock: true, tipStr: '锁定' } }).lock, true);
  assert.equal(parseExceptionStatus({ data: { endTime: '2026-11-10' } }).abnormal, true);
  assert.equal(parseExceptionStatus({ rt: { lock: false } }).lock, false);
});

test('random coverage, delay ranges and minute plans stay inside their bounds', () => {
  for (let index = 0; index < 100; index += 1) {
    const target = coverageTarget(100, 0.9, 1);
    assert.ok(target >= 90 && target <= 100);
    const delay = randomInt(2000, 6000);
    assert.ok(delay >= 2000 && delay <= 6000);
  }
  assert.equal(coverageTarget(100, 0.9, 1, () => 0), 90);
  assert.equal(coverageTarget(100, 0.9, 1, () => 0.999999), 100);
  assert.equal(coverageTarget(0, 0.9, 1), 0);
  const limiter = new RateLimiter(2000, 6000, () => 0);
  assert.equal(limiter.nextDelay(), 2000);
  assert.equal(limiter.nextDelay(() => 0.5), 4000);

  const progress: ZhsMeetProgress = { total_minutes: 100, watched_minutes: [1, 2, 3], watched_count: 3, percent: 3 };
  const plan = planMeetMinutes(progress, { coverage_min: 0.9, coverage_max: 1 }, () => 0);
  assert.equal(plan.target, 90);
  assert.equal(plan.watchedBefore, 3);
  assert.equal(plan.minutes.length, 87);
  assert.equal(plan.minutes[0], 4);
  assert.ok(plan.minutes.every((minute) => !progress.watched_minutes.includes(minute)));
  for (let index = 1; index < plan.minutes.length; index += 1) {
    assert.ok(plan.minutes[index] > plan.minutes[index - 1]);
  }
  const dropping = planMeetMinutes(progress, { coverage_min: 0.9, coverage_max: 1 }, () => 0.999);
  assert.equal(dropping.target, 100);
  // Up to ~5% may be dropped/refilled from the tail; when the gap is the whole
  // remaining history the refill has nothing to add, so less than `need` is fine.
  assert.ok(dropping.minutes.length >= 90 && dropping.minutes.length <= 97);
  assert.equal(new Set(dropping.minutes).size, dropping.minutes.length);
  assert.ok(dropping.minutes.every((minute) => minute >= 1 && minute <= 100));
  assert.ok(dropping.minutes.every((minute, index) => index === 0 || dropping.minutes[index - 1] < minute));
  assert.ok(dropping.minutes.every((minute) => !progress.watched_minutes.includes(minute)));

  const complete: ZhsMeetProgress = { total_minutes: 20, watched_minutes: Array.from({ length: 20 }, (_, i) => i + 1), watched_count: 20, percent: 100 };
  assert.equal(planMeetMinutes(complete, { coverage_min: 0.9, coverage_max: 1 }, () => 0).minutes.length, 0);
});

test('bridge allowlist blocks foreign hosts, methods and oversized bodies', () => {
  assert.equal(allowedZhsRequest({ url: 'https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/videolist', method: 'POST', body: 'secretStr=x' }), true);
  assert.equal(allowedZhsRequest({ url: 'https://studyservice-api.zhihuishu.com/gateway/t/v1/login/getLoginUserInfo?secretStr=x' }), true);
  assert.equal(allowedZhsRequest({ url: 'https://appcomm-user.zhihuishu.com/app-commserv-user/c/has?uid=x' }), true);
  assert.equal(allowedZhsRequest({ url: 'https://lc.zhihuishu.com/livehome/getVideosByLiveId?liveId=1' }), false);
  assert.equal(allowedZhsRequest({ url: 'https://im.zhihuishu.com/livehome/getVideosByLiveId?liveId=1' }), true);
  assert.equal(allowedZhsRequest({
    url: 'https://online.zhihuishu.com/onlineSchool/json/teachMeeting/listTeachMeetingStu?examV2=ss',
    method: 'POST',
    body: 'recruitId=1&page.pageNo=1&page.pageSize=50',
  }), true);
  assert.equal(allowedZhsRequest({ url: 'https://stuonline.zhihuishu.com/stuonline/teachMeeting/listTeachMeetingStu?examV2=ss', method: 'POST', body: 'x' }), true);
  assert.equal(allowedZhsRequest({ url: 'https://stuonline.zhihuishu.com/stuonline/other', method: 'POST', body: 'x' }), false);
  assert.equal(allowedZhsRequest({
    url: 'https://appcomm-live-api.zhihuishu.com/app-commserv-live/gateway/t/v1/pc/live/setWatchHistorySecret?secretStr=x',
  }), true);
  for (const input of [
    { url: 'https://evil.example/gateway/t/v1/learning/videolist', method: 'POST' as const, body: 'x' },
    { url: 'https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/videolist' },
    { url: 'https://studyservice-api.zhihuishu.com/gateway/t/v1/login/getLoginUserInfo', method: 'POST' as const, body: 'x' },
    { url: 'https://studyservice-api.zhihuishu.com/gateway/t/v1/login/getLoginUserInfo', body: 'x' },
    { url: 'https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/other', method: 'POST' as const, body: 'x' },
    { url: 'https://user:pass@studyservice-api.zhihuishu.com/gateway/t/v1/login/getLoginUserInfo' },
    { url: 'https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/videolist', method: 'POST' as const, body: 'x'.repeat(200_001) },
  ]) {
    assert.equal(allowedZhsRequest(input), false);
  }
  assert.equal(trustedSiteOrigin('https://flyingpig233-cpu.github.io'), true);
  assert.equal(trustedSiteOrigin('http://localhost:1421'), true);
  assert.equal(trustedSiteOrigin('http://evil.example'), false);
  assert.equal(trustedSiteOrigin('https://flyingpig233-cpu.github.io/path'), false);
});

// ---------------------------------------------------------------------------
// Compiled bridge (public/zhihuishu-bridge.user.js)
// ---------------------------------------------------------------------------

const bridgeScript = readFileSync(new URL('../public/zhihuishu-bridge.user.js', import.meta.url), 'utf8');
const pageOrigin = 'https://studyvideoh5.zhihuishu.com';
const siteOrigin = 'https://flyingpig233-cpu.github.io';

function bridgeHarness(options: { cookie?: string; allow?: boolean; brokenMap?: boolean } = {}) {
  const replies: Array<{ data: any; origin: string }> = [];
  const calls: Array<{ url: string; init: any }> = [];
  const confirmations: string[] = [];
  let listener: ((event: any) => Promise<void>) | undefined;
  const opener = { postMessage(data: unknown, origin: string) { replies.push({ data, origin }); } };
  const window: any = { opener, addEventListener(_name: string, handler: (event: any) => Promise<void>) { listener = handler; } };
  window.top = window;
  const cookie = options.cookie ?? `CASLOGC=${encodeURIComponent(JSON.stringify({ uuid: 'AbCd1234', userId: 6000001 }))}`;
  const sandbox: Record<string, unknown> = {
    window,
    location: { origin: pageOrigin },
    document: { cookie },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    decodeURIComponent,
    confirm(message: string) { confirmations.push(message); return options.allow !== false; },
    async fetch(url: string, init: any) {
      calls.push({ url, init });
      return { status: 200, async text() { return '{"code":0,"data":{}}'; } };
    },
  };
  if (options.brokenMap) {
    sandbox.Map = class BrokenMap {
      constructor() { throw new Error('java-style Map polyfill'); }
    };
  }
  runInNewContext(bridgeScript, sandbox);
  const send = (data: object, origin = siteOrigin, source: any = opener) => listener!({
    data: { channel: ZHS_CHANNEL, nonce: 'nonce-1', ...data },
    origin,
    source,
  });
  return { send, replies, calls, confirmations };
}

test('compiled bridge requires consent, login cookie and the matching nonce before ready', async () => {
  const harness = bridgeHarness();
  await harness.send({ type: 'zhs-hello' });
  await tick();
  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0], /flyingpig233-cpu\.github\.io/);
  assert.equal(harness.replies.length, 1);
  assert.equal(harness.replies[0].data.type, 'zhs-ready');
  assert.equal(harness.replies[0].data.platform, 'zhihuishu');
  assert.equal(harness.replies[0].data.uuid, 'AbCd1234');
  assert.equal(harness.replies[0].data.userId, 6000001);
  assert.equal(harness.replies[0].origin, siteOrigin);

  const denied = bridgeHarness({ allow: false });
  await denied.send({ type: 'zhs-hello' });
  await tick();
  assert.equal(denied.replies.length, 0);

  const loggedOut = bridgeHarness({ cookie: '' });
  await loggedOut.send({ type: 'zhs-hello' });
  await tick();
  assert.equal(loggedOut.replies.length, 0);

  const wrongSource = bridgeHarness();
  await wrongSource.send({ type: 'zhs-hello' }, siteOrigin, {});
  assert.equal(wrongSource.confirmations.length, 0);
  await wrongSource.send({ type: 'zhs-hello' }, 'http://evil.example');
  assert.equal(wrongSource.confirmations.length, 0);
});

test('compiled bridge forwards only allowlisted same-site requests and returns no cookies', async () => {
  const harness = bridgeHarness();
  await harness.send({ type: 'zhs-hello' });
  await tick();
  harness.replies.length = 0;

  await harness.send({
    type: 'zhs-request',
    id: 'one',
    url: 'https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/saveDatabaseIntervalTimeV2',
    method: 'POST',
    body: 'secretStr=synthetic&dateFormate=1',
  });
  await tick();
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].init.credentials, 'include');
  assert.equal(harness.calls[0].init.mode, 'cors');
  assert.equal(harness.replies.length, 1);
  assert.equal(harness.replies[0].data.type, 'zhs-response');
  assert.equal(harness.replies[0].data.status, 200);
  assert.equal(harness.replies[0].data.text, '{"code":0,"data":{}}');
  assert.deepEqual(Object.keys(harness.replies[0].data).sort(), ['channel', 'id', 'nonce', 'status', 'text', 'type']);
  assert.equal(harness.replies[0].origin, siteOrigin);

  await harness.send({ type: 'zhs-request', id: 'two', url: 'https://evil.example/x' });
  await tick();
  assert.equal(harness.calls.length, 1);
  assert.ok(harness.replies[1].data.error);

  await harness.send({ type: 'zhs-request', id: 'three', nonce: 'wrong', url: 'https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/videolist', method: 'POST', body: 'x' });
  await tick();
  assert.equal(harness.calls.length, 1);

  await harness.send({ type: 'zhs-disconnect' });
  await harness.send({ type: 'zhs-request', id: 'four', url: 'https://appcomm-user.zhihuishu.com/app-commserv-user/c/has?uid=x' });
  await tick();
  assert.equal(harness.calls.length, 1);
});

test('compiled bridge still works when the page replaced the global Map (lc polyfill)', async () => {
  const harness = bridgeHarness({ brokenMap: true });
  await harness.send({ type: 'zhs-hello' });
  await tick();
  assert.equal(harness.replies[0]?.data.type, 'zhs-ready');
  await harness.send({ type: 'zhs-request', id: 'm1', url: 'https://appcomm-live-api.zhihuishu.com/app-commserv-live/gateway/t/v1/pc/live/getWatchHistory?courseId=1&userId=2' });
  await tick();
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.replies.at(-1)?.data.type, 'zhs-response');
});

// ---------------------------------------------------------------------------
// Executors (offline fake clients)
// ---------------------------------------------------------------------------

function videoDetail(): ZhsCourseDetail {
  return {
    course,
    chapters: [{
      chapter_id: 1000116293,
      name: '第一章',
      learning_lesson_status: 0,
      is_pass: 0,
      limit_checked: null,
      lessons: [{
        lesson_id: 1000337351,
        name: '1.1 国防概述',
        is_studied: 1,
        video_id: null,
        video_sec: null,
        videos: [
          { video_id: 70622143, lesson_video_id: 1000244446, video_sec: 468, is_studied: 1, name: '已完成' },
          { video_id: 71192505, lesson_video_id: 1000244477, video_sec: 826, is_studied: 0, name: '待完成' },
          { video_id: 70796671, lesson_video_id: 1000244461, video_sec: 491, is_studied: 0, name: '待完成二' },
        ],
      }],
    }],
  };
}

function fakeVideoClient(overrides: Partial<VideoWatchClient & { calls: string[] }> = {}) {
  const calls: string[] = [];
  const client: VideoWatchClient & { calls: string[] } = {
    uuid: 'AbCd1234',
    calls,
    async prelearningNote(_course, target) { calls.push('note'); return { note_id: 1319089322, watch_state: 0, study_total_time: 0 }; void target; },
    async reportVideo() { calls.push('report'); return { submit_success: true }; },
    async queryStuyInfo(_course, targets) {
      calls.push('verify');
      return new Map(targets.map((target) => [target.lesson_video_id, { watch_state: 1, study_total_time: target.video_sec }]));
    },
    async exceptionStatus() { calls.push('exception'); return { lock: false, abnormal: false, message: '' }; },
    ...overrides,
  };
  return client;
}

test('video plan skips completed videos and dry-run never calls the network', async () => {
  const detail = videoDetail();
  const options = defaultWatchOptions({ dry_run: true });
  const plan = planVideoTargets(detail, options);
  assert.equal(plan.length, 3);
  assert.equal(plan[1].completed, false);
  const client = fakeVideoClient();
  const outcomes = await runVideoWatch(client, detail, options, new AbortController().signal, { limiter: new RateLimiter(0, 0), verifyDelayMs: 0 });
  assert.deepEqual(outcomes.map((outcome) => outcome.state), ['skip', 'dry_run', 'dry_run']);
  assert.equal(client.calls.length, 0);
  assert.match(outcomes[1].message, /预演/);
});

test('video executor reports, verifies watchState and trips the breaker after 3 failures', async () => {
  const detail = videoDetail();
  const options = defaultWatchOptions({ dry_run: false, include_completed: true });
  const client = fakeVideoClient();
  const outcomes = await runVideoWatch(client, detail, options, new AbortController().signal, { limiter: new RateLimiter(0, 0), verifyDelayMs: 0 });
  assert.deepEqual(outcomes.map((outcome) => outcome.state), ['ok', 'ok', 'ok']);
  assert.equal(outcomes[0].watch_state, 1);
  assert.equal(client.calls.filter((call) => call === 'report').length, 3);

  const broken = fakeVideoClient({ async reportVideo() { return { submit_success: false }; } });
  const failing = await runVideoWatch(broken, detail, options, new AbortController().signal, { limiter: new RateLimiter(0, 0), verifyDelayMs: 0 });
  assert.equal(failing.at(-1)?.state, 'circuit_broken');

  const controller = new AbortController();
  controller.abort();
  const cancelled = await runVideoWatch(fakeVideoClient(), detail, options, controller.signal, { limiter: new RateLimiter(0, 0), verifyDelayMs: 0 });
  assert.equal(cancelled.at(-1)?.state, 'cancelled');
});

const meet: ZhsMeet = {
  meet_course_id: 9001,
  live_id: 66001,
  video_id: 770001,
  recruit_id: 463667,
  course_id: 1000011214,
  name: '见面课 1',
  teacher: '李教授',
  start_time: null,
  end_time: null,
  replay_url: 'https://lc.zhihuishu.com/live/vod_room.html?liveId=66001',
  exam_url: null,
  duration_secs: 600,
  status: 1,
};

function fakeMeetClient(overrides: Partial<MeetWatchClient & { watched: Set<number>; reports: number[]; exceptions: number }> = {}) {
  const watched = new Set<number>();
  const reports: number[] = [];
  let exceptions = 0;
  const progress = (): ZhsMeetProgress => ({
    total_minutes: 10,
    watched_minutes: [...watched].sort((left, right) => left - right),
    watched_count: watched.size,
    percent: watched.size * 10,
  });
  const client: MeetWatchClient & { watched: Set<number>; reports: number[]; exceptions: number } = {
    uuid: 'AbCd1234',
    watched,
    reports,
    get exceptions() { return exceptions; },
    async meetProgress() { return progress(); },
    async reportMeetMinute(_course, _meet, minute) {
      reports.push(minute);
      watched.add(minute);
      return minute;
    },
    async meetExceptionStatus() {
      exceptions += 1;
      return { lock: false, abnormal: false, message: '' };
    },
    async meetVideoId() { return 770001; },
    ...overrides,
  };
  return client;
}

test('meet dry-run computes a 90–100% target without reporting minutes', async () => {
  const client = fakeMeetClient();
  const options = defaultMeetWatchOptions({ dry_run: true, delay_min_ms: 0, delay_max_ms: 0 });
  const outcome = await runMeetWatch(client, course, meet, options, 6000001, new AbortController().signal, {
    limiter: new RateLimiter(0, 0),
    random: () => 0,
  });
  assert.equal(outcome.state, 'dry_run');
  assert.equal(outcome.target_minutes, 9);
  assert.equal(outcome.watched_before, 0);
  assert.equal(client.reports.length, 0);
  assert.match(outcome.message, /未发送/);
});

test('meet executor reports ascending minutes, verifies coverage and honors the circuit breaker', async () => {
  const client = fakeMeetClient();
  const options = defaultMeetWatchOptions({
    dry_run: false,
    delay_min_ms: 0,
    delay_max_ms: 0,
    circuit_breaker: true,
    check_every: 5,
  });
  const outcome = await runMeetWatch(client, course, meet, options, 6000001, new AbortController().signal, {
    limiter: new RateLimiter(0, 0),
    random: () => 0,
  });
  assert.equal(outcome.state, 'ok');
  assert.deepEqual(client.reports, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(outcome.submitted, 9);
  assert.equal(outcome.watched_after, 9);
  assert.ok(client.exceptions >= 1);

  const locked = fakeMeetClient({ async meetExceptionStatus() { return { lock: true, abnormal: false, message: '账号被限制' }; } });
  const broken = await runMeetWatch(locked, course, meet, { ...options, check_every: 1 }, 6000001, new AbortController().signal, {
    limiter: new RateLimiter(0, 0),
    random: () => 0,
  });
  assert.equal(broken.state, 'circuit_broken');
  assert.match(broken.message, /熔断/);

  const nonCompliant = fakeMeetClient({ async reportMeetMinute() { throw new Error('rejected'); } });
  const failed = await runMeetWatch(nonCompliant, course, meet, options, 6000001, new AbortController().signal, {
    limiter: new RateLimiter(0, 0),
    random: () => 0,
  });
  assert.equal(failed.state, 'circuit_broken');
  assert.equal(failed.failed, 3);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await runMeetWatch(fakeMeetClient(), course, meet, options, 6000001, controller.signal, {
    limiter: new RateLimiter(0, 0),
    random: () => 0,
  });
  assert.equal(cancelled.state, 'cancelled');
});

test('meet progress skips when already watched and aborts on cancellation mid-run', async () => {
  const watchedClient = fakeMeetClient();
  for (let minute = 1; minute <= 9; minute += 1) watchedClient.watched.add(minute);
  const skipped = await runMeetWatch(watchedClient, course, meet, defaultMeetWatchOptions({ dry_run: false, delay_min_ms: 0, delay_max_ms: 0 }), 6000001, new AbortController().signal, {
    limiter: new RateLimiter(0, 0),
    random: () => 0,
  });
  assert.equal(skipped.state, 'skip');
  assert.equal(watchedClient.reports.length, 0);

  const controller = new AbortController();
  const cancelling = fakeMeetClient({
    async reportMeetMinute(_course, _meet, minute) {
      controller.abort();
      return minute;
    },
  });
  const outcome = await runMeetWatch(cancelling, course, meet, defaultMeetWatchOptions({ dry_run: false, delay_min_ms: 0, delay_max_ms: 0 }), 6000001, controller.signal, {
    limiter: new RateLimiter(0, 0),
    random: () => 0,
  });
  assert.equal(outcome.state, 'cancelled');
});
