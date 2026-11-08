// ==UserScript==
// @name         优学院（U学）秒刷助手
// @namespace    hust-course-hack
// @version      0.1.0
// @description  优学院学习页一键秒刷本课视频与章节练习（dry-run 默认、3–5s 随机限速、失败即停）
// @author       hust-course-hack
// @match        *://ua.ulearning.cn/*
// @match        *://courseweb.ulearning.cn/*
// @match        *://umooc.ulearning.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Browser-side companion of the Ulearning (优学院 / U学) protocol documented in
// docs/ulearning/{miaoshua-plan,web-analysis}.md. Records are reported through
// POST /yws/api/personal/sync with a DES-ECB + PKCS7 + Base64 body (hardcoded
// key "12345678") and the dual AUTHORIZATION / UA-AUTHORIZATION headers. The
// script prefers the page's own CryptoJS.DES and falls back to a self-contained
// minimal DES implementation when the page bundle changes.
//
// Safety: dry-run is the default, every section is paced with a random 3–5 s
// delay, the first failure aborts the run (server `2` = anti-cheat stop), and
// nothing logs the AUTHORIZATION token or request bodies.

(function () {
  'use strict';

  if (window.top !== window.self) return;

  const PANEL_ID = 'uly-miaoshua-panel';
  const MAX_LOG_LINES = 200;

  // --- protocol constants (docs/ulearning/miaoshua-plan.md §2) --------------
  const API_FALLBACK = 'https://api.ulearning.cn';
  const DES_KEY = '12345678';
  const COURSE_TYPE = 4;
  const PLATFORM = 'PC';
  const DEFAULT_DELAY_MIN_MS = 3000;
  const DEFAULT_DELAY_MAX_MS = 5000;
  const MAX_STUDY_TIME = 1000;
  const REQUEST_TIMEOUT_MS = 30000;
  const PAGE_TYPE_VIDEO = 6;
  const PAGE_TYPE_PRACTICE = 7;
  const ELEMENT_TYPE_VIDEO = 4;
  const ELEMENT_TYPE_QUESTION = 6;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randInt = (min, max) =>
    max <= min ? min : min + Math.floor(Math.random() * (max - min + 1));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  let busy = false;
  let stopRequested = false;
  const logLines = [];

  // -------------------------------------------------------------------------
  // Page context
  // -------------------------------------------------------------------------

  function pageWindow() {
    try {
      return typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
    } catch {
      return window;
    }
  }

  function pageKind() {
    const host = location.hostname;
    if (host === 'ua.ulearning.cn') return 'player';
    if (host === 'courseweb.ulearning.cn') return 'courseweb';
    if (host === 'umooc.ulearning.cn') return 'umooc';
    return 'other';
  }

  function isTopPage() {
    return pageKind() !== 'other';
  }

  function hashParams() {
    const hash = String(location.hash || '').replace(/^#/, '');
    const index = hash.indexOf('?');
    return new URLSearchParams(index >= 0 ? hash.slice(index + 1) : hash);
  }

  // Resolve the player ids. The player URL is the only place that carries both
  // ids reliably: `?courseId=<textbookId>&chapterId=<idForClass>&classId=<id>`.
  function readContext() {
    const search = new URLSearchParams(location.search);
    const hash = hashParams();
    const pick = (...names) => {
      for (const name of names) {
        const value = search.get(name) || hash.get(name);
        if (value) return value;
      }
      return null;
    };
    const numeric = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    return {
      textbookId: numeric(pick('courseId', 'textbookId', 'textBookId')),
      classId: numeric(pick('classId', 'classID')),
      chapterId: numeric(pick('chapterId')),
      ocId: numeric(pick('ocId')),
      kind: pageKind(),
    };
  }

  function readToken() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)AUTHORIZATION=([^;]*)/);
      if (match) {
        const value = decodeURIComponent(match[1]).trim();
        if (value) return value;
      }
    } catch {
      // Ignore cookie parsing failures.
    }
    try {
      const fromUrl = new URLSearchParams(location.search).get('token');
      if (fromUrl) return fromUrl.trim();
      const fromHash = hashParams().get('token');
      if (fromHash) return fromHash.trim();
    } catch {
      // Ignore.
    }
    try {
      const win = pageWindow();
      if (typeof win.AUTHORIZATION === 'string' && win.AUTHORIZATION.trim()) {
        return win.AUTHORIZATION.trim();
      }
    } catch {
      // Ignore.
    }
    return null;
  }

  function apiBase() {
    try {
      const win = pageWindow();
      if (typeof win.CONFIG_API_HOST === 'string' && /^https?:\/\//.test(win.CONFIG_API_HOST)) {
        return win.CONFIG_API_HOST.replace(/\/$/, '');
      }
    } catch {
      // Ignore.
    }
    return API_FALLBACK;
  }

  // -------------------------------------------------------------------------
  // DES-ECB sync body (page CryptoJS first, built-in fallback second)
  // -------------------------------------------------------------------------

  let pageCryptoJsPromise = null;

  function getPageCryptoJs() {
    if (pageCryptoJsPromise) return pageCryptoJsPromise;
    const win = pageWindow();
    try {
      if (win.CryptoJS && win.CryptoJS.DES) {
        pageCryptoJsPromise = Promise.resolve(win.CryptoJS);
        return pageCryptoJsPromise;
      }
    } catch {
      // Ignore.
    }
    pageCryptoJsPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 1500);
      try {
        if (typeof win.require !== 'function') {
          clearTimeout(timeout);
          resolve(null);
          return;
        }
        // The player loads CryptoJS through RequireJS; the module is already in
        // the registry once the Section model has been used.
        win.require(['CryptoJS'], (module) => {
          clearTimeout(timeout);
          resolve(module && module.DES ? module : null);
        });
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });
    return pageCryptoJsPromise;
  }

  async function encryptSyncBody(payload) {
    const plaintext = JSON.stringify(payload);
    const cryptoJs = await getPageCryptoJs();
    if (cryptoJs && cryptoJs.DES && cryptoJs.enc && cryptoJs.mode && cryptoJs.pad) {
      try {
        return cryptoJs.DES.encrypt(
          plaintext,
          cryptoJs.enc.Utf8.parse(DES_KEY),
          { mode: cryptoJs.mode.ECB, padding: cryptoJs.pad.Pkcs7 },
        ).toString();
      } catch {
        // Fall through to the built-in implementation.
      }
    }
    return desEcbBase64(plaintext, DES_KEY);
  }

  // --- minimal self-contained DES-ECB + PKCS7 + Base64 ---------------------
  // Tables are the FIPS 46-3 standard ones. The implementation is validated
  // against CryptoJS 3.1.9 in the development harness; it only exists so the
  // script keeps working if the page stops shipping CryptoJS.

  const DES_IP = [
    58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6,
    64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
  ];
  const DES_FP = [
    40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30,
    37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
    34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
  ];
  const DES_E = [
    32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18,
    19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
  ];
  const DES_P = [
    16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19,
    13, 30, 6, 22, 11, 4, 25,
  ];
  const DES_PC1 = [
    57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3,
    60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37,
    29, 21, 13, 5, 28, 20, 12, 4,
  ];
  const DES_PC2 = [
    14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41,
    52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
  ];
  const DES_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
  const DES_SBOX = [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11,
      9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7,
      5, 11, 3, 14, 10, 0, 6, 13],
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10,
      6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2,
      11, 6, 7, 12, 0, 5, 14, 9],
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14,
      12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8,
      7, 4, 15, 14, 3, 11, 5, 2, 12],
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12,
      1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8,
      9, 4, 5, 11, 12, 7, 2, 14],
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15,
      10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2,
      13, 6, 15, 0, 9, 10, 4, 5, 3],
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14,
      0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10,
      11, 14, 1, 7, 6, 0, 8, 13],
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5,
      12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4,
      10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11,
      0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13,
      15, 12, 9, 0, 3, 5, 6, 11],
  ];

  function desPermute(bits, table) {
    const out = new Array(table.length);
    for (let i = 0; i < table.length; i += 1) out[i] = bits[table[i] - 1];
    return out;
  }

  function desBytesToBits(bytes) {
    const bits = new Array(bytes.length * 8);
    for (let i = 0; i < bytes.length; i += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        bits[i * 8 + bit] = (bytes[i] >> (7 - bit)) & 1;
      }
    }
    return bits;
  }

  function desBitsToBytes(bits) {
    const bytes = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bytes.length; i += 1) {
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[i * 8 + bit];
      bytes[i] = value;
    }
    return bytes;
  }

  function desRotateLeft(bits, count) {
    return bits.slice(count).concat(bits.slice(0, count));
  }

  function desSubkeys(keyBytes) {
    const keyBits = desPermute(desBytesToBits(keyBytes), DES_PC1);
    let c = keyBits.slice(0, 28);
    let d = keyBits.slice(28);
    const subkeys = [];
    for (let round = 0; round < 16; round += 1) {
      c = desRotateLeft(c, DES_SHIFTS[round]);
      d = desRotateLeft(d, DES_SHIFTS[round]);
      subkeys.push(desPermute(c.concat(d), DES_PC2));
    }
    return subkeys;
  }

  function desBlock(blockBytes, subkeys) {
    let bits = desPermute(desBytesToBits(blockBytes), DES_IP);
    let left = bits.slice(0, 32);
    let right = bits.slice(32);
    for (let round = 0; round < 16; round += 1) {
      const expanded = desPermute(right, DES_E);
      const mixed = new Array(48);
      for (let i = 0; i < 48; i += 1) mixed[i] = expanded[i] ^ subkeys[round][i];
      const sBits = new Array(32);
      for (let group = 0; group < 8; group += 1) {
        const offset = group * 6;
        const row = (mixed[offset] << 1) | mixed[offset + 5];
        const col =
          (mixed[offset + 1] << 3) |
          (mixed[offset + 2] << 2) |
          (mixed[offset + 3] << 1) |
          mixed[offset + 4];
        const value = DES_SBOX[group][row * 16 + col];
        sBits[group * 4] = (value >> 3) & 1;
        sBits[group * 4 + 1] = (value >> 2) & 1;
        sBits[group * 4 + 2] = (value >> 1) & 1;
        sBits[group * 4 + 3] = value & 1;
      }
      const mixedRight = desPermute(sBits, DES_P);
      const nextLeft = right;
      const nextRight = new Array(32);
      for (let i = 0; i < 32; i += 1) nextRight[i] = left[i] ^ mixedRight[i];
      left = nextLeft;
      right = nextRight;
    }
    return desBitsToBytes(desPermute(right.concat(left), DES_FP));
  }

  const BASE64_ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += BASE64_ALPHABET[b0 >> 2];
      out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
      out += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
      out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : '=';
    }
    return out;
  }

  function desEcbBase64(plaintext, keyText) {
    const encoder = new TextEncoder();
    const keyBytes = new Uint8Array(8);
    keyBytes.set(encoder.encode(keyText).slice(0, 8));
    const input = encoder.encode(plaintext);
    const pad = 8 - (input.length % 8);
    const data = new Uint8Array(input.length + pad);
    data.set(input);
    data.fill(pad, input.length);
    const subkeys = desSubkeys(keyBytes);
    const output = new Uint8Array(data.length);
    for (let offset = 0; offset < data.length; offset += 8) {
      output.set(desBlock(data.slice(offset, offset + 8), subkeys), offset);
    }
    return bytesToBase64(output);
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  function authHeaders(extra) {
    const token = readToken();
    if (!token) throw new Error('未找到 AUTHORIZATION token，请先登录优学院');
    return {
      Authorization: token,
      'UA-AUTHORIZATION': token,
      version: '1',
      Accept: 'application/json',
      ...extra,
    };
  }

  async function request(path, options = {}) {
    const method = options.method || 'GET';
    const init = {
      method,
      credentials: 'include',
      headers: authHeaders(
        options.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ),
    };
    if (options.body !== undefined) init.body = options.body;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    init.signal = controller.signal;
    let response;
    try {
      response = await fetch(apiBase() + path, init);
    } catch (error) {
      clearTimeout(timer);
      throw new Error(`网络请求失败：${shortError(error)}`);
    }
    clearTimeout(timer);
    if (response.status === 401 || response.status === 403) {
      throw new Error('登录状态失效（HTTP 401/403），请重新登录优学院');
    }
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!response.ok) {
      throw new Error(`接口 ${path.split('?')[0]} 返回 HTTP ${response.status}`);
    }
    return data;
  }

  function apiGet(path) {
    return request(path);
  }

  // -------------------------------------------------------------------------
  // Course tree / plan
  // -------------------------------------------------------------------------

  function normalizePages(pages) {
    if (!Array.isArray(pages)) return [];
    return pages
      .map((page) => ({
        id: Number(page.id) || 0,
        relationId: Number(page.relationid ?? page.relationId ?? page.id) || 0,
        name: String(page.title || page.name || '').trim(),
        contentType: Number(page.contentType ?? page.type) || 0,
        hide: Number(page.hide) || 0,
      }))
      .filter((page) => page.id || page.relationId);
  }

  async function fetchDirectory(context) {
    const query = context.classId ? `?classId=${context.classId}` : '';
    const data = await apiGet(`/course/stu/${context.textbookId}/directory${query}`);
    const chapters = Array.isArray(data) ? data : data && data.chapters;
    if (!Array.isArray(chapters)) throw new Error('课程目录返回格式异常');
    return chapters.map((chapter) => ({
      id: Number(chapter.nodeid ?? chapter.id) || 0,
      name: String(chapter.nodetitle ?? chapter.name ?? '').trim(),
      hide: Number(chapter.hide) || 0,
      sections: (chapter.items || []).map((section) => ({
        id: Number(section.itemid ?? section.id) || 0,
        title: String(section.title ?? section.name ?? '').trim(),
        hide: Number(section.hide) || 0,
        chapterId: Number(section.id) || 0,
        pages: normalizePages(section.coursepages),
      })),
    }));
  }

  function flattenSections(chapters) {
    const sections = [];
    for (const chapter of chapters) {
      for (const section of chapter.sections) {
        if (!section.id) continue;
        if (section.hide === 1) continue;
        sections.push({ ...section, chapterName: chapter.name });
      }
    }
    return sections;
  }

  function hasPractice(section) {
    return section.pages.some((page) => page.contentType === PAGE_TYPE_PRACTICE);
  }

  async function fetchSectionRecord(sectionId) {
    const data = await apiGet(`/studyrecord/item/${sectionId}?courseType=${COURSE_TYPE}`);
    return data && typeof data === 'object' ? data : {};
  }

  async function fetchInitialize(sectionId) {
    const data = await apiGet(`/studyrecord/initialize/${sectionId}`);
    if (typeof data === 'number') return data;
    if (typeof data === 'string' && /^\d+$/.test(data.trim())) return Number(data);
    if (data && typeof data === 'object') {
      const value = data.studyStartTime ?? data.startTime ?? data.value ?? data.data;
      if (typeof value === 'number') return value;
    }
    return 0;
  }

  async function fetchSectionPages(section) {
    let fresh = [];
    try {
      const data = await apiGet(`/wholepage/item/stu/${section.id}`);
      const list = Array.isArray(data) ? data : data && data.wholepageDTOList;
      if (Array.isArray(list) && list.length) fresh = normalizePages(list);
    } catch {
      // Directory pages are usually complete; fall back to them.
    }
    if (!fresh.length) return section.pages;
    if (!section.pages.length) return fresh;
    // The directory carries contentType/relationId; the section endpoint is the
    // fresher page list. Merge by page id, preferring directory metadata.
    return fresh.map((page) => {
      const known = section.pages.find(
        (candidate) =>
          (candidate.id && candidate.id === page.id) ||
          (candidate.relationId && candidate.relationId === page.relationId),
      );
      return known
        ? {
            id: page.id || known.id,
            relationId: page.relationId || known.relationId,
            name: page.name || known.name,
            contentType: page.contentType || known.contentType,
            hide: page.hide || known.hide,
          }
        : page;
    });
  }

  function videoLengthOf(element) {
    const candidates = [
      element.videoLength,
      element.videoTime,
      element.duration,
      element.time,
      element.length,
      element.resourceTime,
    ];
    for (const value of candidates) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
    return 0;
  }

  async function fetchPageContent(page) {
    return apiGet(`/wholepage/stu/${page.id}`);
  }

  // Build the plan for one section without posting. Throws on API/session
  // failures so the runner can stop on the first error.
  async function planSection(section, mode, dryRun) {
    const record = await fetchSectionRecord(section.id);
    if (Number(record.completion_status) === 1) {
      return { section, status: 'done', message: '平台已标记完成' };
    }
    const pages = await fetchSectionPages(section);
    if (!pages.length) return { section, status: 'skip', message: '节内没有页面' };
    const practicePages = pages.filter((page) => page.contentType === PAGE_TYPE_PRACTICE);
    if (mode === 'video' && practicePages.length) {
      return { section, status: 'skip', message: '含章节练习，交给练习按钮' };
    }
    if (mode === 'practice' && !practicePages.length) {
      return { section, status: 'skip', message: '不是章节练习节' };
    }

    const studyStartTime = await fetchInitialize(section.id);
    const pageRecords = [];
    for (const page of pages) {
      const isPractice = page.contentType === PAGE_TYPE_PRACTICE;
      if (mode === 'video' && isPractice) continue;
      if (mode === 'practice' && !isPractice) continue;
      const content = await fetchPageContent(page);
      const elements = (content && content.coursepageDTOList) || [];
      if (isPractice) {
        pageRecords.push(
          dryRun
            ? buildPracticePageRecordWithoutAnswers(page, elements)
            : await buildPracticePageRecord(page, elements),
        );
      } else {
        pageRecords.push(buildVideoPageRecord(page, elements));
      }
    }

    const payload = {
      itemid: section.id,
      autoSave: 1,
      withoutOld: null,
      complete: 1,
      studyStartTime,
      score: 100,
      pageStudyRecordDTOList: pageRecords,
    };
    // The page sends the cached record version only when it exists; a missing
    // version is simply omitted from the JSON (JSON.stringify drops undefined).
    if (record.version !== undefined && record.version !== null) {
      payload.version = record.version;
    }
    const win = pageWindow();
    if (typeof win.userName === 'string' && win.userName) payload.userName = win.userName;
    return { section, status: 'complete', payload, pageRecords };
  }

  function buildVideoPageRecord(page, elements) {
    const videos = [];
    for (const element of elements) {
      if (Number(element.type) !== ELEMENT_TYPE_VIDEO) continue;
      const videoId = Number(element.resourceid ?? element.resourceId) || 0;
      const length = videoLengthOf(element);
      if (!videoId || !length) continue;
      videos.push({
        videoid: videoId,
        current: length,
        status: 1,
        recordTime: length,
        time: length,
        startEndTimeList: [{ startTime: 0, endTime: length }],
      });
    }
    return {
      pageid: page.relationId || page.id,
      complete: 1,
      studyTime: MAX_STUDY_TIME,
      score: 100,
      answerTime: 1,
      submitTimes: 0,
      questions: [],
      videos,
      speaks: [],
    };
  }

  // dry-run only needs the question count; fetching the answers is read-only but
  // pointless traffic, so the preview skips it.
  function buildPracticePageRecordWithoutAnswers(page, elements) {
    const questionElements = elements.filter(
      (element) => Number(element.type) === ELEMENT_TYPE_QUESTION,
    );
    const questions = [];
    let coursepageId;
    for (const element of questionElements) {
      if (coursepageId === undefined) coursepageId = element.coursepageDTOid;
      for (const question of element.questionDTOList || []) {
        const questionId = question.questionid ?? question.questionId;
        if (questionId === undefined || questionId === null) continue;
        questions.push({
          questionid: questionId,
          answerList: [],
          score: Number(question.score) || 100,
        });
      }
    }
    if (!questions.length) {
      throw new Error(`练习页「${page.name}」没有可提交的题目，已停止`);
    }
    const record = {
      pageid: page.relationId || page.id,
      complete: 1,
      studyTime: MAX_STUDY_TIME,
      score: 100,
      answerTime: 1,
      submitTimes: 1,
      questions,
      videos: [],
      speaks: [],
    };
    if (coursepageId !== undefined) record.coursepageId = coursepageId;
    return record;
  }

  async function buildPracticePageRecord(page, elements) {
    const questionElements = elements.filter(
      (element) => Number(element.type) === ELEMENT_TYPE_QUESTION,
    );
    const questionRecords = [];
    let coursepageId;
    for (const element of questionElements) {
      if (coursepageId === undefined) coursepageId = element.coursepageDTOid;
      const questions = element.questionDTOList || [];
      for (const question of questions) {
        const questionId = question.questionid ?? question.questionId;
        if (questionId === undefined || questionId === null) continue;
        const answerData = await apiGet(
          `/questionAnswer/${questionId}?parentId=${page.relationId || page.id}`,
        );
        const answerList = Array.isArray(answerData && answerData.correctAnswerList)
          ? answerData.correctAnswerList.map((value) => String(value))
          : [];
        if (!answerList.length) {
          throw new Error(`题目 ${questionId} 没有取到平台答案，已停止`);
        }
        questionRecords.push({
          questionid: questionId,
          answerList,
          score: Number(question.score) || 100,
        });
      }
    }
    if (!questionRecords.length) {
      throw new Error(`练习页「${page.name}」没有可提交的题目，已停止`);
    }
    const record = {
      pageid: page.relationId || page.id,
      complete: 1,
      studyTime: MAX_STUDY_TIME,
      score: 100,
      answerTime: 1,
      submitTimes: 1,
      questions: questionRecords,
      videos: [],
      speaks: [],
    };
    if (coursepageId !== undefined) record.coursepageId = coursepageId;
    return record;
  }

  async function submitSection(payload) {
    const body = await encryptSyncBody(payload);
    const data = await request(
      `/yws/api/personal/sync?courseType=${COURSE_TYPE}&platform=${PLATFORM}`,
      { method: 'POST', body },
    );
    const result = typeof data === 'string' ? Number(data) : Number(data);
    if (result === 2) {
      throw new Error('服务端返回 2（判定刷分/终止学习），已停止，请人工确认账号状态');
    }
    if (result !== 1) {
      throw new Error(`sync 返回非 1（${String(data).slice(0, 40)}），已停止`);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Runner
  // -------------------------------------------------------------------------

  function readOptions() {
    const dryRunNode = document.querySelector(`#${PANEL_ID} [data-field="dry-run"]`);
    let delayMin = readNumberInput('delay-min', DEFAULT_DELAY_MIN_MS);
    let delayMax = readNumberInput('delay-max', DEFAULT_DELAY_MAX_MS);
    delayMin = Math.max(0, Math.floor(delayMin));
    delayMax = Math.max(0, Math.floor(delayMax));
    if (delayMax < delayMin) [delayMin, delayMax] = [delayMax, delayMin];
    return {
      dryRun: dryRunNode ? dryRunNode.checked : true,
      delayMin,
      delayMax,
    };
  }

  async function runMode(mode) {
    if (pageKind() !== 'player') {
      throw new Error(
        '请在优学院播放器学习页（ua.ulearning.cn/learnCourse/learnCourse.html?courseId=…&classId=…）使用',
      );
    }
    const context = readContext();
    if (!context.textbookId) {
      throw new Error('URL 缺少 courseId（textbookId），请从课程页点“开始学习”打开播放器');
    }
    if (!readToken()) throw new Error('未找到 AUTHORIZATION token，请先登录优学院');

    const options = readOptions();
    const chapters = await fetchDirectory(context);
    const sections = flattenSections(chapters);
    const targets = sections.filter((section) =>
      mode === 'video' ? !hasPractice(section) : hasPractice(section),
    );
    log(
      `课程 ${context.textbookId}：共 ${sections.length} 节，当前模式（${
        mode === 'video' ? '视频' : '章节练习'
      }）候选 ${targets.length} 节，dry-run=${options.dryRun ? '是' : '否'}`,
    );
    if (!targets.length) {
      setStatus('没有可处理的节', '#fbbf24');
      return { ok: 0, skip: 0, fail: 0, total: 0 };
    }

    const summary = { ok: 0, skip: 0, fail: 0, total: targets.length, aborted: false };
    const processed = [];
    let first = true;
    for (const section of targets) {
      if (stopRequested) {
        summary.aborted = true;
        log('已停止，剩余节未执行');
        break;
      }
      if (!first) await sleepInterruptible(randInt(options.delayMin, options.delayMax));
      first = false;
      const label = `${section.chapterName} / ${section.title || section.id}`;

      let plan;
      try {
        plan = await planSection(section, mode, options.dryRun);
      } catch (error) {
        summary.fail += 1;
        summary.aborted = true;
        log(`失败并停止：${label} → ${shortError(error)}`);
        break;
      }
      if (plan.status === 'done') {
        summary.skip += 1;
        log(`跳过（已完成）：${label}`);
        continue;
      }
      if (plan.status === 'skip') {
        summary.skip += 1;
        log(`跳过：${label}（${plan.message}）`);
        continue;
      }

      const videos = plan.pageRecords.reduce((sum, page) => sum + (page.videos || []).length, 0);
      const questions = plan.pageRecords.reduce(
        (sum, page) => sum + (page.questions || []).length,
        0,
      );
      log(
        `${options.dryRun ? '[dry-run] 计划' : '上报'}：${label}（${plan.pageRecords.length} 页，` +
          `${videos} 个视频，${questions} 题）`,
      );

      if (options.dryRun) {
        summary.ok += 1;
        continue;
      }

      try {
        await submitSection(plan.payload);
      } catch (error) {
        summary.fail += 1;
        summary.aborted = true;
        log(`失败并停止：${label} → ${shortError(error)}`);
        break;
      }
      processed.push(section);
      summary.ok += 1;
      log(`成功：${label}`);
    }

    if (!options.dryRun && processed.length) {
      const confirmed = await verifySections(processed);
      log(`复核：${confirmed}/${processed.length} 节 completion_status=1`);
    }
    log(
      `结束：成功 ${summary.ok}，跳过 ${summary.skip}，失败 ${summary.fail}${
        summary.aborted ? '，已中止' : ''
      }`,
    );
    return summary;
  }

  async function verifySections(sections) {
    let confirmed = 0;
    for (const section of sections) {
      if (stopRequested) break;
      try {
        const record = await fetchSectionRecord(section.id);
        if (Number(record.completion_status) === 1) confirmed += 1;
      } catch {
        // Verification is best-effort; the submission result is already logged.
      }
      await sleep(300);
    }
    return confirmed;
  }

  // -------------------------------------------------------------------------
  // Logging / helpers
  // -------------------------------------------------------------------------

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) logLines.shift();
    const box = document.querySelector(`#${PANEL_ID} .uly-log`);
    if (box) {
      box.textContent = logLines.slice(-80).join('\n');
      box.scrollTop = box.scrollHeight;
    }
    console.log('[uly-miaoshua]', message);
  }

  function setStatus(text, color = '#e5e7eb') {
    const node = document.querySelector(`#${PANEL_ID} .uly-status`);
    if (node) {
      node.textContent = text;
      node.style.color = color;
    }
  }

  function maskText(value) {
    if (value === undefined || value === null) return '';
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
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
      <div style="font-size:14px;font-weight:600;margin-bottom:4px;">优学院秒刷助手（视频 / 章节练习）</div>
      <div class="uly-status" style="margin-bottom:8px;color:#e5e7eb;">就绪</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
        <button data-action="video">秒刷当前课程视频</button>
        <button data-action="practice">秒刷当前章节练习</button>
        <button data-action="stop">停止</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;color:#9ca3af;">
        <label style="display:flex;align-items:center;gap:6px;white-space:nowrap;">
          <input data-field="dry-run" type="checkbox" checked>
          演练（dry-run，只打印计划）
        </label>
        <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;">间隔(ms)
          <input data-field="delay-min" type="number" min="0" step="100" value="3000" style="width:58px;">
          –
          <input data-field="delay-max" type="number" min="0" step="100" value="5000" style="width:58px;">
        </label>
      </div>
      <pre class="uly-log" style="
        max-height:180px;overflow:auto;margin:0;padding:8px;
        border-radius:6px;background:#030712;color:#9ca3af;
        font:11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
        white-space:pre-wrap;word-break:break-word;
      "></pre>
    `;

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
      #${PANEL_ID} input[type="checkbox"] { accent-color:#2563eb; }
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
    try {
      if (action === 'video') {
        setStatus('读取课程目录…', '#fbbf24');
        const summary = await runMode('video');
        setStatus(
          summary.aborted
            ? `已中止：成功 ${summary.ok}，失败 ${summary.fail}`
            : `视频完成：成功 ${summary.ok}，跳过 ${summary.skip}，失败 ${summary.fail}`,
          summary.aborted ? '#f87171' : summary.fail ? '#fbbf24' : '#4ade80',
        );
      } else if (action === 'practice') {
        setStatus('读取课程目录…', '#fbbf24');
        const summary = await runMode('practice');
        setStatus(
          summary.aborted
            ? `已中止：成功 ${summary.ok}，失败 ${summary.fail}`
            : `练习完成：成功 ${summary.ok}，跳过 ${summary.skip}，失败 ${summary.fail}`,
          summary.aborted ? '#f87171' : summary.fail ? '#fbbf24' : '#4ade80',
        );
      }
    } catch (error) {
      log(`失败：${shortError(error)}`);
      setStatus(`失败：${shortError(error)}`, '#f87171');
    } finally {
      busy = false;
      stopRequested = false;
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  // Console-only helpers for a read-only dry-run:
  //   await __ulyMiaoshua.preview('video')
  //   await __ulyMiaoshua.preview('practice')
  function exposeDebugHandle() {
    try {
      window.__ulyMiaoshua = {
        pageKind,
        readContext,
        readOptions,
        encryptSyncBody,
        builtinDes: desEcbBase64,
        preview: async (mode = 'video') => {
          const context = readContext();
          const chapters = await fetchDirectory(context);
          const sections = flattenSections(chapters);
          const targets = sections.filter((section) =>
            mode === 'video' ? !hasPractice(section) : hasPractice(section),
          );
          const plans = [];
          for (const section of targets) {
            let plan;
      try {
        plan = await planSection(section, mode, options.dryRun);
      } catch (error) {
        summary.fail += 1;
        summary.aborted = true;
        log(`失败并停止：${label} → ${shortError(error)}`);
        break;
      }
            plans.push({
              id: section.id,
              title: `${section.chapterName} / ${section.title}`,
              status: plan.status,
              pages: plan.pageRecords ? plan.pageRecords.length : 0,
              videos: plan.pageRecords
                ? plan.pageRecords.reduce((sum, page) => sum + (page.videos || []).length, 0)
                : 0,
              questions: plan.pageRecords
                ? plan.pageRecords.reduce((sum, page) => sum + (page.questions || []).length, 0)
                : 0,
              message: plan.message || '',
            });
            if (plan.status === 'skip' && plans.filter((p) => p.status === 'skip').length >= 3) break;
          }
          return { context, totalSections: sections.length, plans };
        },
      };
    } catch {
      // Ignore pages that forbid extra globals.
    }
  }

  function init() {
    if (!isTopPage()) return;
    createPanel();
    exposeDebugHandle();
    log('优学院秒刷助手已加载');
    if (pageKind() !== 'player') {
      log('提示：秒刷功能需在播放器学习页使用（ua.ulearning.cn/learnCourse）');
    } else {
      const context = readContext();
      if (!context.textbookId) log('提示：URL 缺少 courseId，请从课程页点“开始学习”进入');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  new MutationObserver(() => {
    if (isTopPage() && !document.getElementById(PANEL_ID) && document.body) {
      createPanel();
    }
  }).observe(document.documentElement, { childList: true });
})();
