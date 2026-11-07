// ==UserScript==
// @name         知到（智慧树）秒刷助手
// @namespace    hust-course-hack
// @version      0.1.0
// @description  知到学习页一键秒刷本课视频，见面课回放一键补齐考勤（随机覆盖率 + 限速 + 熔断）
// @author       hust-course-hack
// @match        *://studyvideoh5.zhihuishu.com/*
// @match        *://stuonline.zhihuishu.com/*
// @match        *://lc.zhihuishu.com/live/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Browser-side companion of the Zhihuishu client implemented in this repo
// (`src/zhihuishu/`). It reuses the page's own crypto helpers when present
// (`labc`/`l0a1b2c` for the module key, `yxyz`/`y9x8y7z` for AES-CBC) and falls
// back to a self-contained WebCrypto + BigInt implementation when the page
// bundle changes. The wire protocol is the one verified live and written down in
// docs/zhihuishu-miaoshua-plan.md (appendix A).
//
// Nothing here logs cookies, `secretStr` values, `sdsew`/`paramSecret` blobs or
// the user id; log lines only carry counts, labels and normalized error text.
(function () {
  'use strict';

  // Only the top window owns the panel; the player/catalog live in same-origin
  // frames but the API helpers and logged-in globals are on the top window.
  if (window.top !== window.self) return;

  const PANEL_ID = 'zhs-miaoshua-panel';
  const MAX_LOG_LINES = 200;

  // --- protocol constants (see plan appendix A) ---------------------------
  const AES_IV = '1g3qqdh4jvbskb9x';
  const MODULE_KEY_TTL_MS = 30 * 60 * 1000;
  const MODULE_VIDEO = 11;
  const MODULE_MEET = 9;
  const XOR_KEY_VIDEO = 'zzpttjd';
  const XOR_KEY_MEET = 'zhihuishu';

  // Shared RSAES-PKCS1-v1_5 public key used by the `c/has` module-key handshake.
  const PUBLIC_KEY_B64 =
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCgfZmpLpPEpEFRKBe+ZjWJUjPe+7qg7pGqcfN3j2egJ8H2mr' +
    'KwaEqZEnPnpi2O3hN8HRyaFozDOp8gwZiYfiIZjWy0Jr/FNAiiKYh5bq0GsEn+ieMmRyJg/+i1rqizhvCXvFdrd' +
    'GhFTw5EBwTpsGdwe1utdlrvIJUAFWj9Yh4qbQIDAQAB';

  const STUDY_BASE = 'https://studyservice-api.zhihuishu.com';
  const LIVE_BASE = 'https://appcomm-live-api.zhihuishu.com';
  const APPCOMM_USER_BASE = 'https://appcomm-user.zhihuishu.com';

  const VIDEO_LIST_PATH = '/gateway/t/v1/learning/videolist';
  const PRELEARNING_NOTE_PATH = '/gateway/t/v1/learning/prelearningNote';
  const QUERY_STUY_INFO_PATH = '/gateway/t/v1/learning/queryStuyInfo';
  const SAVE_INTERVAL_PATH = '/gateway/t/v1/learning/saveDatabaseIntervalTimeV2';
  const VIDEO_EXCEPTION_PATH = '/gateway/t/v1/cheat/exceptionActionDetail';

  const MEET_HISTORY_PATH = '/app-commserv-live/gateway/t/v1/pc/live/getWatchHistory';
  const MEET_SUBMIT_PATH = '/app-commserv-live/gateway/t/v1/pc/live/setWatchHistorySecret';
  const MEET_EXCEPTION_PATH = '/app-commserv-live/gateway/t/v1/chect/exceptionActionDetail';

  // Meet list endpoint: the live student portal serves it under `onlineSchool`;
  // the `stuonline` variant is the path used by the Rust client. Only the
  // console debug helper uses it (the panel works on the current replay page).
  const MEET_LIST_URLS = [
    'https://online.zhihuishu.com/onlineSchool/json/teachMeeting/listTeachMeetingStu?examV2=ss',
    'https://stuonline.zhihuishu.com/stuonline/teachMeeting/listTeachMeetingStu?examV2=ss',
  ];

  // Safety rails: same defaults as the plan / Rust client.
  const DEFAULT_COVERAGE_MIN = 0.9;
  const DEFAULT_COVERAGE_MAX = 1.0;
  const DEFAULT_DELAY_MIN_MS = 2000;
  const DEFAULT_DELAY_MAX_MS = 6000;
  const MEET_CHECK_EVERY = 10;
  const VIDEO_CHECK_EVERY = 5;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const VIDEO_GAP_MIN_MS = 600;
  const VIDEO_GAP_MAX_MS = 1400;
  const VERIFY_DELAY_MS = 800;
  const MAX_RETRIES = 2;
  const RETRY_BASE_DELAY_MS = 300;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randInt = (min, max) =>
    max <= min ? min : min + Math.floor(Math.random() * (max - min + 1));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  let busy = false;
  let stopRequested = false;
  const logLines = [];

  // -------------------------------------------------------------------------
  // Page identity / page kind
  // -------------------------------------------------------------------------

  // @grant none normally means window === unsafeWindow, but keep the alias for
  // script managers that still expose it.
  function pageWindow() {
    try {
      return typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
    } catch {
      return window;
    }
  }

  function pageKind() {
    const host = location.hostname;
    if (host === 'studyvideoh5.zhihuishu.com') return 'study';
    if (host === 'lc.zhihuishu.com') {
      return location.pathname.includes('/live/vod_room') ? 'replay' : 'live';
    }
    if (host === 'stuonline.zhihuishu.com') return 'stuonline';
    return 'other';
  }

  function isTopPage() {
    return pageKind() !== 'other';
  }

  // Extract the short `uuid` used as the `sdsew` tail (`uuid + "zhs"`). The
  // page exposes it as a global on some builds; otherwise read the non-HttpOnly
  // CASLOGC login cookie. The value itself is never logged.
  function readUserUuid() {
    const win = pageWindow();
    try {
      if (typeof win.uuid === 'string' && win.uuid) return win.uuid;
      if (typeof win.userUuid === 'string' && win.userUuid) return win.userUuid;
    } catch {
      // Ignore pages that block property access.
    }
    const login = readLoginCookie();
    if (login && typeof login.uuid === 'string' && login.uuid) return login.uuid;
    return null;
  }

  function readUserId() {
    const win = pageWindow();
    try {
      if (typeof win.userId === 'number' || typeof win.userId === 'string') {
        const value = Number(win.userId);
        if (Number.isFinite(value) && value > 0) return value;
      }
    } catch {
      // Ignore.
    }
    const login = readLoginCookie();
    if (login && login.userId !== undefined) {
      const value = Number(login.userId);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

  function readLoginCookie() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)CASLOGC=([^;]*)/);
      if (!match) return null;
      return JSON.parse(decodeURIComponent(match[1]));
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Crypto: page globals first, built-in WebCrypto/BigInt fallback second
  // -------------------------------------------------------------------------

  // The legacy lc.zhihuishu.com replay page redefines the global `Map` with a
  // Java-style polyfill, so the script only uses plain objects for its caches.
  const moduleKeyCache = Object.create(null);

  function pageKeyFn() {
    const win = pageWindow();
    try {
      if (typeof win.labc === 'function') return win.labc.bind(win);
      if (typeof win.l0a1b2c === 'function') return win.l0a1b2c.bind(win);
    } catch {
      // Fall through to the built-in handshake.
    }
    return null;
  }

  function pageEncryptFn() {
    const win = pageWindow();
    try {
      if (typeof win.yxyz === 'function') return win.yxyz.bind(win);
      if (typeof win.y9x8y7z === 'function') return win.y9x8y7z.bind(win);
    } catch {
      // Fall through to the built-in AES implementation.
    }
    return null;
  }

  // Resolve a module key. The page helper returns an opaque RSA blob that the
  // page's own encrypt helper understands; the built-in path returns the plain
  // `cKey` string. Both are cached for 30 minutes like the page store does.
  async function getModuleKey(module) {
    const cached = moduleKeyCache[module];
    if (cached && Date.now() - cached.at < MODULE_KEY_TTL_MS) return cached.value;

    let value;
    const keyFn = pageKeyFn();
    if (keyFn) {
      try {
        value = { source: 'page', blob: await keyFn(module) };
      } catch (error) {
        log(`页面密钥函数失败，改用内置实现：${shortError(error)}`);
        value = null;
      }
    }
    if (!value) {
      value = { source: 'builtin', cKey: await fetchModuleKeyBuiltin(module) };
    }
    moduleKeyCache[module] = { at: Date.now(), value };
    return value;
  }

  async function encryptSecret(payloadObject, module) {
    const key = await getModuleKey(module);
    if (key.source === 'page') {
      const encryptFn = pageEncryptFn();
      if (encryptFn) return String(encryptFn(payloadObject, key.blob));
      // The page exposes the key helper but not the encrypt helper (partial
      // bundle change): decode the blob to its cKey and use the built-in AES.
      const parsed = JSON.parse(publicOpUnpad(key.blob));
      if (!parsed || typeof parsed.cKey !== 'string') throw new Error('页面密钥 blob 缺少 cKey');
      return aesCbcEncryptBase64(JSON.stringify(payloadObject), parsed.cKey);
    }
    return aesCbcEncryptBase64(JSON.stringify(payloadObject), key.cKey);
  }

  // --- built-in module-key handshake (RSAES-PKCS1-v1_5 + public op unpad) ---

  const rsaKeyCache = { parsed: null };

  function parsePublicKey() {
    if (rsaKeyCache.parsed) return rsaKeyCache.parsed;
    const bytes = base64ToBytes(PUBLIC_KEY_B64);

    // Minimal DER walk of SubjectPublicKeyInfo: skip AlgorithmIdentifier, enter
    // the BIT STRING, then read the RSAPublicKey SEQUENCE { INTEGER n, INTEGER e }.
    let index = 0;
    const readLength = () => {
      let length = bytes[index++];
      if (length & 0x80) {
        const count = length & 0x7f;
        length = 0;
        for (let i = 0; i < count; i += 1) length = (length << 8) | bytes[index++];
      }
      return length;
    };
    if (bytes[index++] !== 0x30) throw new Error('公钥 DER 解析失败');
    readLength();
    if (bytes[index++] !== 0x30) throw new Error('公钥 DER 解析失败');
    const algorithmLength = readLength();
    index += algorithmLength;
    if (bytes[index++] !== 0x03) throw new Error('公钥 DER 解析失败');
    readLength();
    index += 1; // unused bits
    if (bytes[index++] !== 0x30) throw new Error('公钥 DER 解析失败');
    readLength();
    if (bytes[index++] !== 0x02) throw new Error('公钥 DER 解析失败');
    const nLength = readLength();
    const modulusBytes = bytes.slice(index, index + nLength);
    index += nLength;
    let modulusStart = 0;
    while (modulusStart < modulusBytes.length - 1 && modulusBytes[modulusStart] === 0) {
      modulusStart += 1;
    }
    if (bytes[index++] !== 0x02) throw new Error('公钥 DER 解析失败');
    const eLength = readLength();
    const exponent = bytes.slice(index, index + eLength);
    rsaKeyCache.parsed = {
      n: bytesToBigInt(modulusBytes),
      e: bytesToBigInt(exponent),
      // DER INTEGER keeps a sign byte; the RSA modulus itself is 128 bytes.
      byteLength: modulusBytes.length - modulusStart,
    };
    return rsaKeyCache.parsed;
  }

  function modPow(base, exponent, modulus) {
    let result = 1n;
    let factor = base % modulus;
    let power = exponent;
    while (power > 0n) {
      if (power & 1n) result = (result * factor) % modulus;
      factor = (factor * factor) % modulus;
      power >>= 1n;
    }
    return result;
  }

  async function rsaEncryptModule(module) {
    const payload = utf8Encode(JSON.stringify({ module }));
    const subtle = window.crypto && window.crypto.subtle;
    if (subtle) {
      try {
        const key = await subtle.importKey(
          'spki',
          base64ToBytes(PUBLIC_KEY_B64),
          { name: 'RSAES-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['encrypt'],
        );
        const ciphertext = await subtle.encrypt({ name: 'RSAES-PKCS1-v1_5' }, key, payload);
        return bytesToBase64(new Uint8Array(ciphertext));
      } catch (error) {
        // Fall through to the BigInt PKCS#1 v1.5 encoder below.
      }
    }
    return rsaEncryptModuleBigInt(payload);
  }

  function rsaEncryptModuleBigInt(payload) {
    const { n, e, byteLength } = parsePublicKey();
    const paddingLength = byteLength - payload.length - 3;
    if (paddingLength < 8) throw new Error('RSA 填充长度不足');
    const block = new Uint8Array(byteLength);
    block[0] = 0x00;
    block[1] = 0x02;
    const random = new Uint8Array(paddingLength);
    window.crypto.getRandomValues(random);
    for (let i = 0; i < paddingLength; i += 1) {
      // PKCS#1 v1.5 type 2 padding bytes must be non-zero.
      while (random[i] === 0) window.crypto.getRandomValues(random);
      block[2 + i] = random[i];
    }
    block[2 + paddingLength] = 0x00;
    block.set(payload, 3 + paddingLength);
    const ciphertext = modPow(bytesToBigInt(block), e, n);
    return bytesToBase64(bigIntToBytes(ciphertext, byteLength));
  }

  function publicOpUnpad(blobBase64) {
    const { n, e, byteLength } = parsePublicKey();
    const ciphertext = bytesToBigInt(base64ToBytes(blobBase64));
    if (ciphertext >= n) throw new Error('模块密钥 blob 超出模数范围');
    const encoded = bigIntToBytes(modPow(ciphertext, e, n), byteLength);
    let index = encoded[0] === 0x00 ? 1 : 0;
    if (encoded[index] !== 0x01) throw new Error('模块密钥 PKCS#1 填充无效');
    index += 1;
    while (index < encoded.length && encoded[index] === 0xff) index += 1;
    if (index >= encoded.length || encoded[index] !== 0x00) {
      throw new Error('模块密钥 PKCS#1 填充无效');
    }
    return utf8Decode(encoded.slice(index + 1));
  }

  async function fetchModuleKeyBuiltin(module) {
    const uid = await rsaEncryptModule(module);
    const response = await fetch(
      `${APPCOMM_USER_BASE}/app-commserv-user/c/has?uid=${encodeURIComponent(uid)}`,
      { credentials: 'include' },
    );
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('模块密钥接口返回了非 JSON 内容');
    }
    const blob = json && json.rt && json.rt.sl;
    if (!blob) throw new Error('模块密钥接口缺少 rt.sl');
    const plaintext = publicOpUnpad(String(blob));
    const parsed = JSON.parse(plaintext);
    if (!parsed || typeof parsed.cKey !== 'string' || parsed.cKey.length !== 16) {
      throw new Error('模块密钥 blob 缺少有效的 cKey');
    }
    return parsed.cKey;
  }

  async function aesCbcEncryptBase64(plaintext, cKey) {
    const subtle = window.crypto && window.crypto.subtle;
    if (!subtle) throw new Error('当前浏览器不支持 WebCrypto，无法内置加密');
    const key = await subtle.importKey('raw', utf8Encode(cKey), { name: 'AES-CBC' }, false, [
      'encrypt',
    ]);
    const ciphertext = await subtle.encrypt(
      { name: 'AES-CBC', iv: utf8Encode(AES_IV) },
      key,
      utf8Encode(plaintext),
    );
    return bytesToBase64(new Uint8Array(ciphertext));
  }

  // -------------------------------------------------------------------------
  // Protocol helpers
  // -------------------------------------------------------------------------

  // XOR-encode a field list the way `sdsew` / `paramSecret` are built: join with
  // ';', XOR every character with the repeating key, two hex digits per byte.
  function xorEncode(fields, key) {
    const joined = fields.map(String).join(';');
    let out = '';
    for (let i = 0; i < joined.length; i += 1) {
      let value = joined.charCodeAt(i) ^ key.charCodeAt(i % key.length);
      let hex = value.toString(16);
      if (hex.length < 2) hex = `0${hex}`;
      out += hex.slice(-4);
    }
    return out;
  }

  // Synthetic watch-point sequence (`ewssw`), matching the page helper.
  function watchPoints(durationSecs) {
    const values = ['0', '1'];
    for (let k = 0; k * 1.99 < durationSecs; k += 1) {
      const total = 5 * Math.floor((k * 1.99) / 4.99);
      values.push(String(Math.floor(total / 5) + 2));
    }
    return values.join(',');
  }

  function hms(secs) {
    const hours = Math.floor(secs / 3600);
    const minutes = Math.floor((secs % 3600) / 60);
    const seconds = Math.floor(secs % 60);
    return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
  }

  async function postStudySecret(path, payload) {
    const secretStr = await encryptSecret(payload, MODULE_VIDEO);
    const form = new URLSearchParams();
    form.set('secretStr', secretStr);
    form.set('dateFormate', String(Date.now()));
    const response = await fetch(`${STUDY_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    return parseStudyResponse(await response.text(), path);
  }

  async function getStudySecret(path, payload) {
    const secretStr = await encryptSecret(payload, MODULE_VIDEO);
    const query = new URLSearchParams();
    query.set('secretStr', secretStr);
    query.set('dateFormate', String(Date.now()));
    const response = await fetch(`${STUDY_BASE}${path}?${query.toString()}`, {
      credentials: 'include',
    });
    return parseStudyResponse(await response.text(), path);
  }

  async function getLiveSecret(path, payload) {
    const secretStr = await encryptSecret(payload, MODULE_MEET);
    const query = new URLSearchParams();
    query.set('secretStr', secretStr);
    query.set('_', String(Date.now()));
    const response = await fetch(`${LIVE_BASE}${path}?${query.toString()}`, {
      credentials: 'include',
    });
    return parseLiveResponse(await response.text(), path);
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('接口返回了非 JSON 内容');
    }
  }

  function parseStudyResponse(text, path) {
    const json = parseJson(text);
    if (json && json.code !== undefined && Number(json.code) !== 0) {
      throw new Error(`接口 ${path.split('/').pop()} 返回 code=${json.code}：${maskText(json.message)}`);
    }
    return json ? json.data : null;
  }

  function parseLiveResponse(text, path) {
    const json = parseJson(text);
    if (json && json.success === false) {
      throw new Error(`接口 ${path.split('/').pop()} 返回失败：${maskText(json.msg)}`);
    }
    if (json && json.status !== undefined && String(json.status) !== '200') {
      throw new Error(`接口 ${path.split('/').pop()} 返回 status=${json.status}`);
    }
    return json && json.rt !== undefined ? json.rt : json;
  }

  // -------------------------------------------------------------------------
  // Video course (studyvideoh5) flow
  // -------------------------------------------------------------------------

  function readRecruitAndCourseId() {
    const fromQuery = new URLSearchParams(location.search).get('recruitAndCourseId');
    if (fromQuery) return fromQuery;
    const hash = String(location.hash || '').replace(/^#/, '');
    const queryIndex = hash.indexOf('?');
    if (queryIndex >= 0) {
      return new URLSearchParams(hash.slice(queryIndex + 1)).get('recruitAndCourseId');
    }
    return null;
  }

  function flattenChapterTree(data) {
    const videos = [];
    const chapters = (data && data.videoChapterDtos) || [];
    for (const chapter of chapters) {
      const chapterId = Number(chapter.id) || 0;
      const chapterName = String(chapter.name || '').trim();
      for (const lesson of chapter.videoLessons || []) {
        const lessonId = Number(lesson.id) || 0;
        const lessonName = String(lesson.name || '').trim();
        const smallLessons =
          Array.isArray(lesson.videoSmallLessons) && lesson.videoSmallLessons.length
            ? lesson.videoSmallLessons
            : [lesson];
        for (const small of smallLessons) {
          videos.push({
            chapterId,
            chapterName,
            lessonId: Number(small.lessonId) || lessonId,
            lessonName,
            smallLessonId: Number(small.id) || 0,
            videoId: Number(small.videoId) || 0,
            videoSec: Number(small.videoSec) || 0,
            name: String(small.name || lessonName || '').trim(),
            isStudied: Number(small.isStudiedLesson) || 0,
          });
        }
      }
    }
    return videos.filter((video) => video.videoId > 0 && video.videoSec > 0);
  }

  async function fetchWatchStates(recruitId, videos) {
    const lessonIds = [...new Set(videos.map((video) => video.lessonId).filter(Boolean))];
    const smallLessonIds = [...new Set(videos.map((video) => video.smallLessonId).filter(Boolean))];
    const data = await postStudySecret(QUERY_STUY_INFO_PATH, {
      lessonIds,
      lessonVideoIds: smallLessonIds,
      recruitId,
    });
    const map = (data && data.lv) || {};
    const states = Object.create(null);
    for (const [key, value] of Object.entries(map)) {
      states[Number(key)] = {
        watchState: value && value.watchState !== undefined ? Number(value.watchState) : null,
        studyTotalTime: value && value.studyTotalTime !== undefined ? Number(value.studyTotalTime) : 0,
      };
    }
    return states;
  }

  async function buildVideoPlan() {
    if (pageKind() !== 'study') {
      throw new Error('请在知到学习页（studyvideoh5）使用本功能');
    }
    const recruitAndCourseId = readRecruitAndCourseId();
    if (!recruitAndCourseId) {
      throw new Error('当前 URL 缺少 recruitAndCourseId，请从课程列表进入课程学习页');
    }
    const listData = await postStudySecret(VIDEO_LIST_PATH, { recruitAndCourseId });
    if (!listData || !listData.videoChapterDtos) {
      throw new Error('课程视频列表为空（可能不是共享课或尚未选课）');
    }
    const recruitId = Number(listData.recruitId) || 0;
    const courseId = Number(listData.courseId) || 0;
    if (!recruitId || !courseId) throw new Error('课程列表缺少 recruitId/courseId');
    const allVideos = flattenChapterTree(listData);
    if (!allVideos.length) throw new Error('课程中没有可上报的视频');
    const states = await fetchWatchStates(recruitId, allVideos);
    const pending = allVideos.filter((video) => {
      const state = states[video.smallLessonId];
      return !state || state.watchState !== 1;
    });
    return {
      recruitId,
      courseId,
      totalVideos: allVideos.length,
      completedVideos: allVideos.length - pending.length,
      pending,
    };
  }

  function videoLabel(video) {
    const parts = [video.chapterName, video.lessonName, video.name].filter(Boolean);
    return parts.join(' / ') || `视频 ${video.videoId}`;
  }

  function buildVideoReportPayload(video, uuid, noteId) {
    const total = String(video.videoSec);
    const sdsew = xorEncode(
      [
        video.recruitId,
        video.lessonId,
        video.smallLessonId,
        video.videoId,
        video.chapterId,
        0,
        total,
        total,
        hms(video.videoSec),
        `${uuid}zhs`,
      ],
      XOR_KEY_VIDEO,
    );
    return {
      ewssw: watchPoints(video.videoSec),
      sdsew,
      zwsds: bytesToBase64(utf8Encode(String(noteId))),
      courseId: video.courseId,
    };
  }

  async function videoExceptionCheck(recruitId) {
    const data = await getStudySecret(VIDEO_EXCEPTION_PATH, { recruitId });
    if (!data) return { lock: false };
    const lock = data.lock === true || Number(data.punishType) > 0;
    return {
      lock,
      count: Number(data.count) || 0,
      message: lock ? maskText(data.tipStr) : '',
    };
  }

  async function previewVideoPlan() {
    const plan = await buildVideoPlan();
    const uuid = readUserUuid();
    return {
      recruitId: plan.recruitId,
      courseId: plan.courseId,
      totalVideos: plan.totalVideos,
      completedVideos: plan.completedVideos,
      pending: plan.pending.map((video) => ({
        label: videoLabel(video),
        smallLessonId: video.smallLessonId,
        videoId: video.videoId,
        videoSec: video.videoSec,
        ewssw: watchPoints(video.videoSec),
        sdsew: uuid
          ? xorEncode(
              [
                plan.recruitId,
                video.lessonId,
                video.smallLessonId,
                video.videoId,
                video.chapterId,
                0,
                video.videoSec,
                video.videoSec,
                hms(video.videoSec),
                `${uuid}zhs`,
              ],
              XOR_KEY_VIDEO,
            )
          : null,
      })),
    };
  }

  async function runVideoWatch() {
    const plan = await buildVideoPlan();
    log(
      `本课共 ${plan.totalVideos} 节视频，已完成 ${plan.completedVideos} 节，待秒刷 ${plan.pending.length} 节`,
    );
    if (!plan.pending.length) {
      setStatus('本课视频已全部完成', '#4ade80');
      return { ok: 0, skip: plan.completedVideos, fail: 0, aborted: false };
    }
    const uuid = readUserUuid();
    if (!uuid) throw new Error('无法读取页面 uuid，请确认已登录知到');

    const summary = { ok: 0, skip: 0, fail: 0, aborted: false };
    let consecutiveFailures = 0;
    let processed = [];

    for (let index = 0; index < plan.pending.length; index += 1) {
      if (stopRequested) {
        summary.aborted = true;
        log('已停止，剩余视频未执行');
        break;
      }
      const video = plan.pending[index];
      const label = videoLabel(video);
      setStatus(`秒刷视频 ${index + 1}/${plan.pending.length}…`, '#fbbf24');
      log(`[${index + 1}/${plan.pending.length}] ${label}（${video.videoSec}s）`);

      try {
        const noteData = await postStudySecret(PRELEARNING_NOTE_PATH, {
          ccCourseId: plan.courseId,
          chapterId: video.chapterId,
          isApply: 1,
          lessonId: video.lessonId,
          lessonVideoId: video.smallLessonId,
          recruitId: plan.recruitId,
          videoId: video.videoId,
        });
        const dto = noteData && noteData.studiedLessonDto;
        if (!dto || dto.id === undefined || dto.id === null) {
          throw new Error('prelearningNote 未返回 noteId');
        }
        if (Number(dto.watchState) === 1) {
          summary.skip += 1;
          log('  平台已标记完成，跳过');
          consecutiveFailures = 0;
          continue;
        }

        const payload = buildVideoReportPayload(
          { ...video, recruitId: plan.recruitId, courseId: plan.courseId },
          uuid,
          dto.id,
        );
        const saved = await postStudySecret(SAVE_INTERVAL_PATH, payload);
        if (saved && saved.submitSuccess === false) {
          throw new Error('服务器未确认上报');
        }
        summary.ok += 1;
        consecutiveFailures = 0;
        processed.push(video.smallLessonId);
        log('  上报成功');
      } catch (error) {
        summary.fail += 1;
        consecutiveFailures += 1;
        log(`  失败：${shortError(error)}`);
      }

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        summary.aborted = true;
        log('连续失败过多，已中止整批');
        setStatus('连续失败过多，已中止', '#f87171');
        break;
      }

      if (processed.length && processed.length % VIDEO_CHECK_EVERY === 0) {
        try {
          const status = await videoExceptionCheck(plan.recruitId);
          if (status.lock) {
            summary.aborted = true;
            log(`检测到风控异常，已中止：${status.message || '请到异常记录页查看'}`);
            setStatus('检测到风控异常，已中止', '#f87171');
            break;
          }
        } catch (error) {
          log(`异常检查失败（继续执行）：${shortError(error)}`);
        }
      }

      await sleepInterruptible(randInt(VIDEO_GAP_MIN_MS, VIDEO_GAP_MAX_MS));
    }

    // Final verification: re-query the watch state of everything we reported.
    if (processed.length) {
      await sleep(VERIFY_DELAY_MS);
      try {
        const states = await fetchWatchStates(plan.recruitId, plan.pending);
        let confirmed = 0;
        for (const smallLessonId of processed) {
          const state = states[smallLessonId];
          if (state && state.watchState === 1) confirmed += 1;
        }
        log(`复核：${confirmed}/${processed.length} 节 watchState=1`);
        setStatus(
          summary.aborted ? '已中止（部分已上报）' : `完成：成功 ${summary.ok} 节`,
          summary.aborted ? '#f87171' : '#4ade80',
        );
      } catch (error) {
        log(`复核失败（不影响已上报结果）：${shortError(error)}`);
        setStatus('上报完成，复核失败', '#fbbf24');
      }
    } else if (!summary.aborted) {
      setStatus('没有需要上报的视频', '#4ade80');
    }
    log(
      `视频秒刷结束：成功 ${summary.ok}，跳过 ${summary.skip}，失败 ${summary.fail}${
        summary.aborted ? '，已中止' : ''
      }`,
    );
    return summary;
  }

  // -------------------------------------------------------------------------
  // Meet replay (lc.zhihuishu.com/live/vod_room) flow
  // -------------------------------------------------------------------------

  function readReplayIdentity() {
    const win = pageWindow();
    const numeric = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const identity = {
      recruitId: numeric(win.recruitId),
      liveId: numeric(win.liveCourseId),
      userId: numeric(win.userId),
      uuid: null,
      videos: [],
    };
    try {
      if (typeof win.userUuid === 'string' && win.userUuid) identity.uuid = win.userUuid;
      else if (typeof win.uuid === 'string' && win.uuid) identity.uuid = win.uuid;
    } catch {
      // Ignore.
    }
    if (!identity.uuid) {
      const login = readLoginCookie();
      if (login && typeof login.uuid === 'string' && login.uuid) identity.uuid = login.uuid;
    }
    if (!identity.userId) identity.userId = readUserId();
    if (!identity.recruitId) {
      // The replay URL always carries the ids; fall back to them.
      const params = new URLSearchParams(location.search);
      identity.recruitId = numeric(params.get('recruitId'));
      identity.liveId = identity.liveId || numeric(params.get('liveId'));
    }

    let videoInfo = [];
    try {
      videoInfo = Array.isArray(win.videoInfo) ? win.videoInfo : [];
    } catch {
      videoInfo = [];
    }
    identity.videos = videoInfo
      .map((item, index) => ({
        videoId: numeric(item && item.id),
        duration: Number(item && item.duration) || 0,
        sort: Number(item && item.sort) || index,
      }))
      .filter((item) => item.videoId && item.duration > 0)
      .sort((a, b) => a.sort - b.sort);
    return identity;
  }

  function totalReplaySeconds(identity) {
    if (!identity.videos.length) return 0;
    return identity.videos.reduce((sum, video) => sum + video.duration, 0);
  }

  // Map a global 1-based replay minute to the video that contains it.
  function videoIdForMinute(identity, minute) {
    const offsetSecs = (minute - 1) * 60;
    let cumulative = 0;
    for (const video of identity.videos) {
      cumulative += video.duration;
      if (offsetSecs < cumulative) return video.videoId;
    }
    return identity.videos[identity.videos.length - 1].videoId;
  }

  function parseWatchedMinutes(rt) {
    const raw = Array.isArray(rt) ? rt : String(rt === undefined || rt === null ? '' : rt);
    const parts = Array.isArray(raw) ? raw : raw.split(/[,\s;#]+/);
    const watched = new Set();
    for (const part of parts) {
      const minute = Number(String(part).trim());
      if (Number.isFinite(minute) && minute > 0) watched.add(minute);
    }
    return watched;
  }

  function planMeetMinutes(totalMinutes, watched, targetMinutes) {
    const total = Math.max(1, Math.floor(totalMinutes));
    const target = clamp(Math.floor(targetMinutes), 1, total);
    const need = target - watched.size;
    if (need <= 0) return [];
    const pool = [];
    for (let minute = 1; minute <= total; minute += 1) {
      if (!watched.has(minute)) pool.push(minute);
    }
    if (!pool.length) return [];
    // Keep the covered set random while still progressing forward: shuffle the
    // un-watched minutes, take the needed count and report them in order.
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, Math.min(need, pool.length)).sort((a, b) => a - b);
    return picked;
  }

  function coverageTarget(totalMinutes, coverageMin, coverageMax) {
    const ratio =
      coverageMax > coverageMin
        ? coverageMin + Math.random() * (coverageMax - coverageMin)
        : coverageMin;
    return clamp(Math.ceil(totalMinutes * ratio), 1, totalMinutes);
  }

  function readMeetOptions() {
    const values = {
      coverageMin: readNumberInput('coverage-min', DEFAULT_COVERAGE_MIN),
      coverageMax: readNumberInput('coverage-max', DEFAULT_COVERAGE_MAX),
      delayMin: readNumberInput('delay-min', DEFAULT_DELAY_MIN_MS),
      delayMax: readNumberInput('delay-max', DEFAULT_DELAY_MAX_MS),
    };
    let coverageMin = clamp(values.coverageMin, 0.9, 1);
    let coverageMax = clamp(values.coverageMax, 0.9, 1);
    if (coverageMax < coverageMin) [coverageMin, coverageMax] = [coverageMax, coverageMin];
    let delayMin = Math.max(0, Math.floor(values.delayMin));
    let delayMax = Math.max(0, Math.floor(values.delayMax));
    if (delayMax < delayMin) [delayMin, delayMax] = [delayMax, delayMin];
    return { coverageMin, coverageMax, delayMin, delayMax };
  }

  async function fetchMeetProgress(identity) {
    const rt = await getLiveSecret(MEET_HISTORY_PATH, {
      courseId: identity.liveId,
      userId: identity.userId,
    });
    return parseWatchedMinutes(rt);
  }

  async function meetExceptionCheck(identity) {
    const data = await getLiveSecret(MEET_EXCEPTION_PATH, {
      uuid: identity.uuid || '',
      recruitId: identity.recruitId,
    });
    const lock = !!(data && data.lock === true);
    return { lock, tip: lock ? maskText(data.tipStr) : '' };
  }

  function meetParamSecret(identity, minute) {
    return xorEncode(
      [
        identity.recruitId,
        identity.liveId,
        identity.userId,
        minute,
        '2',
        videoIdForMinute(identity, minute),
      ],
      XOR_KEY_MEET,
    );
  }

  async function submitMeetMinute(identity, minute) {
    await getLiveSecret(MEET_SUBMIT_PATH, {
      paramSecret: meetParamSecret(identity, minute),
      jsonpCallBack: 'jsonpCallBack',
    });
  }

  async function buildMeetPlan() {
    if (pageKind() !== 'replay') {
      throw new Error('请先打开见面课回放页（lc.zhihuishu.com/live/vod_room.html）');
    }
    const identity = readReplayIdentity();
    if (!identity.recruitId || !identity.liveId || !identity.userId) {
      throw new Error('回放页缺少 recruitId/liveId/userId，请刷新页面后重试');
    }
    const totalSecs = totalReplaySeconds(identity);
    if (!totalSecs) throw new Error('无法读取回放时长（videoInfo 为空）');
    const totalMinutes = Math.max(1, Math.ceil(totalSecs / 60));
    const options = readMeetOptions();
    const watched = await fetchMeetProgress(identity);
    const target = coverageTarget(totalMinutes, options.coverageMin, options.coverageMax);
    const minutes = planMeetMinutes(totalMinutes, watched, target);
    return { identity, totalMinutes, totalSecs, watched, target, minutes, options };
  }

  async function previewMeetPlan() {
    const plan = await buildMeetPlan();
    return {
      liveId: plan.identity.liveId,
      totalMinutes: plan.totalMinutes,
      watchedMinutes: plan.watched.size,
      targetMinutes: plan.target,
      pendingMinutes: plan.minutes.length,
      plannedMinutes: plan.minutes.slice(0, 30),
      coverageRange: [plan.options.coverageMin, plan.options.coverageMax],
      delayRangeMs: [plan.options.delayMin, plan.options.delayMax],
    };
  }

  async function runMeetWatch() {
    const plan = await buildMeetPlan();
    log(
      `回放总时长 ${plan.totalMinutes} 分钟，已看 ${plan.watched.size} 分钟，目标 ${plan.target} 分钟`,
    );
    if (!plan.minutes.length) {
      setStatus('已达到目标覆盖率，无需上报', '#4ade80');
      return { ok: 0, fail: 0, target: plan.target, aborted: false };
    }
    log(`将上报 ${plan.minutes.length} 分钟（随机覆盖率 ${plan.options.coverageMin}–${plan.options.coverageMax}）`);

    const summary = { ok: 0, fail: 0, target: plan.target, aborted: false };
    let consecutiveFailures = 0;
    for (let index = 0; index < plan.minutes.length; index += 1) {
      if (stopRequested) {
        summary.aborted = true;
        log('已停止，剩余分钟未上报');
        break;
      }
      const minute = plan.minutes[index];
      setStatus(`上报考勤 ${index + 1}/${plan.minutes.length}（第 ${minute} 分钟）…`, '#fbbf24');

      let sent = false;
      for (let attempt = 0; attempt <= MAX_RETRIES && !sent; attempt += 1) {
        if (stopRequested) break;
        try {
          await submitMeetMinute(plan.identity, minute);
          sent = true;
        } catch (error) {
          if (attempt === MAX_RETRIES) {
            log(`第 ${minute} 分钟上报失败：${shortError(error)}`);
          } else {
            await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          }
        }
      }

      if (sent) {
        summary.ok += 1;
        consecutiveFailures = 0;
        log(`  第 ${minute} 分钟已上报`);
      } else {
        summary.fail += 1;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          summary.aborted = true;
          log('连续上报失败过多，已中止');
          setStatus('连续失败过多，已中止', '#f87171');
          break;
        }
      }

      if ((index + 1) % MEET_CHECK_EVERY === 0) {
        try {
          const status = await meetExceptionCheck(plan.identity);
          if (status.lock) {
            summary.aborted = true;
            log(`检测到风控异常，已中止：${status.tip || '请到异常记录页查看'}`);
            setStatus('检测到风控异常，已中止', '#f87171');
            break;
          }
        } catch (error) {
          log(`异常检查失败（继续执行）：${shortError(error)}`);
        }
      }

      if (index < plan.minutes.length - 1) {
        await sleepInterruptible(randInt(plan.options.delayMin, plan.options.delayMax));
      }
    }

    // Re-read the progress so the log reports the server-confirmed coverage.
    try {
      const watchedAfter = await fetchMeetProgress(plan.identity);
      const coverage = ((watchedAfter.size / plan.totalMinutes) * 100).toFixed(1);
      log(`复核：已看 ${watchedAfter.size}/${plan.totalMinutes} 分钟（${coverage}%）`);
      setStatus(
        summary.aborted
          ? `已中止：成功 ${summary.ok} 分钟`
          : `完成：成功 ${summary.ok} 分钟，覆盖率 ${coverage}%`,
        summary.aborted ? '#f87171' : '#4ade80',
      );
    } catch (error) {
      log(`复核失败（不影响已上报结果）：${shortError(error)}`);
      setStatus(`上报完成：成功 ${summary.ok} 分钟`, '#fbbf24');
    }
    log(`考勤秒刷结束：成功 ${summary.ok}，失败 ${summary.fail}${summary.aborted ? '，已中止' : ''}`);
    return summary;
  }

  // Optional meet-list helper. Only exposed through the console debug handle:
  // the panel operates on the replay page that is already open, whose globals
  // carry every id it needs.
  async function fetchMeetList(recruitId) {
    if (!recruitId) throw new Error('缺少 recruitId');
    const body = new URLSearchParams({
      recruitId: String(recruitId),
      'page.pageNo': '0',
      'page.pageSize': '50',
    });
    let lastError = null;
    for (const url of MEET_LIST_URLS) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        return parseJson(await response.text());
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`见面课列表接口不可用：${shortError(lastError)}`);
  }

  // -------------------------------------------------------------------------
  // Logging / small helpers
  // -------------------------------------------------------------------------

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) logLines.shift();
    const box = document.querySelector(`#${PANEL_ID} .zhs-log`);
    if (box) {
      box.textContent = logLines.slice(-80).join('\n');
      box.scrollTop = box.scrollHeight;
    }
    console.log('[zhs-miaoshua]', message);
  }

  function setStatus(text, color = '#e5e7eb') {
    const node = document.querySelector(`#${PANEL_ID} .zhs-status`);
    if (node) {
      node.textContent = text;
      node.style.color = color;
    }
  }

  function maskText(value) {
    if (value === undefined || value === null) return '';
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }

  function shortError(error) {
    const text = error && error.message ? String(error.message) : String(error);
    return maskText(text);
  }

  async function sleepInterruptible(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (stopRequested) return;
      await sleep(Math.min(200, deadline - Date.now()));
    }
  }

  function readNumberInput(field, fallback) {
    const node = document.querySelector(`#${PANEL_ID} [data-field="${field}"]`);
    if (!node) return fallback;
    const value = Number(node.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const binary = atob(String(text));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function utf8Encode(text) {
    return new TextEncoder().encode(text);
  }

  function utf8Decode(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function bytesToBigInt(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
    return hex ? BigInt(`0x${hex}`) : 0n;
  }

  function bigIntToBytes(value, length) {
    let hex = value.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    hex = hex.padStart(length * 2, '0');
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------

  function createPanel() {
    if (document.getElementById(PANEL_ID) || !document.body) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      width: 360px;
      padding: 12px;
      border-radius: 10px;
      background: #111827;
      color: #e5e7eb;
      font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    `;
    panel.innerHTML = `
      <div style="font-size:14px;font-weight:600;margin-bottom:4px;">知到秒刷助手（视频 / 见面课回放）</div>
      <div class="zhs-status" style="margin-bottom:8px;color:#e5e7eb;">就绪</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
        <button data-action="video">秒刷本课视频</button>
        <button data-action="meet">秒刷当前回放考勤</button>
        <button data-action="stop">停止</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;color:#9ca3af;">
        <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;">覆盖率
          <input data-field="coverage-min" type="number" min="0.9" max="1" step="0.01" value="0.9" style="width:52px;">
          –
          <input data-field="coverage-max" type="number" min="0.9" max="1" step="0.01" value="1" style="width:52px;">
        </label>
        <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;">间隔(ms)
          <input data-field="delay-min" type="number" min="0" step="100" value="2000" style="width:58px;">
          –
          <input data-field="delay-max" type="number" min="0" step="100" value="6000" style="width:58px;">
        </label>
      </div>
      <pre class="zhs-log" style="
        max-height:180px;overflow:auto;margin:0;padding:8px;
        border-radius:6px;background:#030712;color:#9ca3af;
        font:11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
        white-space:pre-wrap;word-break:break-word;
      "></pre>
    `;

    // Scoped styles keep the inline `width` values above and avoid fighting the
    // host page's global button/input rules.
    const style = document.createElement('style');
    style.textContent = `
      #${PANEL_ID} button {
        padding:5px 8px;border:0;border-radius:6px;cursor:pointer;
        background:#374151;color:#f9fafb;font-size:12px;
      }
      #${PANEL_ID} button:hover { background:#4b5563; }
      #${PANEL_ID} button[data-action="stop"] { background:#7f1d1d; }
      #${PANEL_ID} input[type="number"] {
        padding:2px 4px;border:1px solid #374151;border-radius:4px;
        background:#1f2937;color:#f9fafb;font-size:12px;
      }
    `;
    panel.appendChild(style);

    for (const button of panel.querySelectorAll('button')) {
      button.addEventListener('click', () => runAction(button.dataset.action));
    }

    document.body.appendChild(panel);
  }

  async function runAction(action) {
    if (action === 'stop') {
      stopRequested = true;
      setStatus('已请求停止', '#f87171');
      log('已请求停止');
      return;
    }

    if (busy) {
      log('当前任务还在运行，请先停止或等待完成');
      return;
    }

    busy = true;
    stopRequested = false;
    const finish = (text, color) => {
      setStatus(text, color);
      setTimeout(() => {
        if (!busy) setStatus('就绪', '#e5e7eb');
      }, 5000);
    };
    try {
      if (action === 'video') {
        setStatus('读取课程视频列表…', '#fbbf24');
        const summary = await runVideoWatch();
        finish(
          summary.aborted
            ? `已中止：成功 ${summary.ok}，失败 ${summary.fail}`
            : `视频完成：成功 ${summary.ok}，跳过 ${summary.skip}，失败 ${summary.fail}`,
          summary.aborted ? '#f87171' : summary.fail ? '#fbbf24' : '#4ade80',
        );
      } else if (action === 'meet') {
        setStatus('读取回放进度…', '#fbbf24');
        const summary = await runMeetWatch();
        finish(
          summary.aborted
            ? `已中止：成功 ${summary.ok} 分钟`
            : `考勤完成：成功 ${summary.ok} 分钟`,
          summary.aborted ? '#f87171' : summary.fail ? '#fbbf24' : '#4ade80',
        );
      }
    } catch (error) {
      log(`失败: ${shortError(error)}`);
      setStatus(`失败: ${shortError(error)}`, '#f87171');
    } finally {
      busy = false;
      stopRequested = false;
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  // Console-only helpers for a read-only dry-run:
  //   await __zhsMiaoshua.previewVideoPlan()
  //   await __zhsMiaoshua.previewMeetPlan()
  // Both only issue read requests (list / watch state / watched minutes) and
  // print the plan; they never submit anything.
  function exposeDebugHandle() {
    try {
      window.__zhsMiaoshua = {
        pageKind,
        previewVideoPlan,
        previewMeetPlan,
        runVideoWatch,
        runMeetWatch,
        fetchMeetList,
        fetchModuleKey: getModuleKey,
        fetchModuleKeyBuiltin,
        aesCbcEncryptBase64,
        publicOpUnpad,
        parsePublicKey,
        encryptSecret,
        xorEncode,
        watchPoints,
        hms,
      };
    } catch {
      // Ignore pages that forbid extra globals.
    }
  }

  function init() {
    if (!isTopPage()) return;
    createPanel();
    exposeDebugHandle();
    log('知到秒刷助手已加载');
    if (pageKind() === 'study' && !readRecruitAndCourseId()) {
      log('提示：当前 URL 未带 recruitAndCourseId，请从课程列表进入课程学习页');
    }
    if (pageKind() === 'live') {
      log('提示：直播中的页面不支持秒刷，请打开“回放”页（vod_room）');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // The study page swaps views without a full reload; re-add the panel if the
  // page replaced the body (same pattern as the existing video helper).
  new MutationObserver(() => {
    if (isTopPage() && !document.getElementById(PANEL_ID) && document.body) {
      createPanel();
    }
  }).observe(document.documentElement, { childList: true });
})();
