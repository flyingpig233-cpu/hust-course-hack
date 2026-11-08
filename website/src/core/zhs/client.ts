// Zhihuishu HTTP client, aligned with `src/zhihuishu/api.rs`.
//
// Every encrypted endpoint goes through `secretStr` (AES via the module key) and
// every plaintext endpoint is only used by the meet-course replay flow. All
// requests are sent through the bridge transport, so the static site never sees
// a Zhihuishu cookie. Parsing helpers are exported for the offline tests.
import {
  MODULE_MEET,
  MODULE_VIDEO,
  ModuleKeyCache,
  XOR_KEY_COURSE,
  XOR_KEY_MEET,
  bytesToBase64,
  encryptSecret,
  hms,
  moduleKey,
  utf8ToBytes,
  watchPoints,
  xorDecode,
  xorEncode,
} from './crypto.ts';
import {
  ZHS_APPLIVE_ORIGIN,
  ZHS_IM_ORIGIN,
  ZHS_ONLINE_ORIGIN,
  ZHS_ONLINESERVICE_ORIGIN,
  ZHS_STUDYSERVICE_ORIGIN,
  ZHS_STUONLINE_ORIGIN,
  type ZhsHttpRequest,
  type ZhsIdentity,
  type ZhsTransport,
} from './transport.ts';
import type {
  ZhsChapter,
  ZhsCourse,
  ZhsCourseDetail,
  ZhsExceptionStatus,
  ZhsLesson,
  ZhsMeet,
  ZhsMeetProgress,
  ZhsUser,
  ZhsVideo,
  ZhsVideoTarget,
} from './types.ts';

/** Error normalized across the Zhihuishu endpoints. */
export class ZhsApiError extends Error {
  readonly endpoint: string;
  readonly code: number | null;

  constructor(message: string, endpoint: string, code: number | null = null) {
    super(message);
    this.name = 'ZhsApiError';
    this.endpoint = endpoint;
    this.code = code;
  }
}

/** Promise-based sleep that rejects on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('任务已取消', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('任务已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Inclusive random integer helper with an injectable generator for tests. */
export function randomInt(min: number, max: number, random: () => number = Math.random): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return low + Math.floor(random() * (high - low + 1));
}

/** Random pacing guard; the meet and video executors await it between reports. */
export class RateLimiter {
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;

  constructor(minMs: number, maxMs: number, random: () => number = Math.random) {
    this.minMs = Math.max(0, Math.min(minMs, maxMs));
    this.maxMs = Math.max(0, Math.max(minMs, maxMs));
    this.random = random;
  }

  /** Delay for the next request, in milliseconds. */
  nextDelay(random: () => number = this.random): number {
    return randomInt(this.minMs, this.maxMs, random);
  }

  /** Wait for the next delay; rejects when the signal aborts. */
  async wait(signal?: AbortSignal): Promise<number> {
    const delay = this.nextDelay();
    await sleep(delay, signal);
    return delay;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickNum(record: Record<string, unknown>, keys: string[]): number | null {
  return num(pick(record, keys));
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function textOrNull(value: unknown): string | null {
  const result = text(value).trim();
  return result ? result : null;
}

function boolOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function timeText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').slice(0, 19);
  }
  return textOrNull(value);
}

/** Parse one course row from the course-list/course-info responses. */
export function parseCourse(value: unknown): ZhsCourse | null {
  const raw = asRecord(value);
  const recruitId = pickNum(raw, ['recruitId', 'recruit_id']);
  const courseId = pickNum(raw, ['courseId', 'course_id', 'ccCourseId']);
  if (!recruitId || !courseId) return null;
  return {
    recruit_id: recruitId,
    course_id: courseId,
    class_id: pickNum(raw, ['classId', 'class_id']),
    school_id: pickNum(raw, ['schoolId', 'school_id']),
    name: text(pick(raw, ['courseName', 'name', 'course_name'])).trim(),
    teacher: text(pick(raw, ['teacherName', 'teacher', 'teacher_name', 'speakerUserName'])).trim(),
    secret: textOrNull(pick(raw, ['recruitAndCourseId', 'secret', 'courseSecret'])),
    is_apply: pickNum(raw, ['isApply', 'is_apply']),
    course_type: textOrNull(pick(raw, ['courseType', 'course_type', 'type'])),
    progress: pickNum(raw, ['progress', 'studyProgress', 'schedule']),
    studied_lesson_count: pickNum(raw, ['studiedLessonCount', 'studiedCount']),
    total_lesson_count: pickNum(raw, ['totalLessonCount', 'lessonCount']),
    status: pickNum(raw, ['status', 'courseStatus']),
  };
}

/** Find the course array inside the many shapes the platform returns. */
function findArray(body: Record<string, unknown>, keys: string[]): unknown[] {
  const containers = [body, asRecord(body.data), asRecord(body.rt), asRecord(asRecord(body.data).rt)];
  for (const container of containers) {
    for (const key of keys) {
      const value = container[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/** Parse the shared-course list response. */
export function parseCourseList(body: Record<string, unknown>): ZhsCourse[] {
  const rows = findArray(body, ['courseList', 'shareCourseDtos', 'list', 'rows', 'records', 'courses', 'data']);
  const seen = new Set<number>();
  const courses: ZhsCourse[] = [];
  for (const row of rows) {
    // Some list responses nest the ids under a child object (Rust parity).
    const nested = ['courseInfo', 'course', 'recruitCourseDto']
      .map((key) => asRecord(asRecord(row)[key]))
      .find((child) => Object.keys(child).length > 0);
    const course = parseCourse(nested ? { ...nested, ...asRecord(row) } : row);
    if (!course || seen.has(course.recruit_id)) continue;
    seen.add(course.recruit_id);
    courses.push(course);
  }
  return courses;
}

function parseVideo(value: unknown): ZhsVideo | null {
  const raw = asRecord(value);
  const videoId = pickNum(raw, ['videoId', 'video_id']);
  const lessonVideoId = pickNum(raw, ['id', 'lessonVideoId', 'lesson_video_id']);
  const videoSec = pickNum(raw, ['videoSec', 'video_sec', 'duration']);
  if (!videoId || !lessonVideoId || !videoSec || videoSec <= 0) return null;
  return {
    video_id: videoId,
    lesson_video_id: lessonVideoId,
    video_sec: videoSec,
    is_studied: pickNum(raw, ['isStudiedLesson', 'isStudied', 'is_studied']),
    name: text(pick(raw, ['name', 'videoName', 'title'])).trim(),
  };
}

function parseLesson(value: unknown): ZhsLesson | null {
  const raw = asRecord(value);
  const lessonId = pickNum(raw, ['id', 'lessonId', 'lesson_id']);
  if (!lessonId) return null;
  const videos = asArray(pick(raw, ['videoSmallLessons', 'smallLessons', 'videos']))
    .map(parseVideo)
    .filter((video): video is ZhsVideo => video !== null);
  return {
    lesson_id: lessonId,
    name: text(pick(raw, ['name', 'lessonName', 'title'])).trim(),
    is_studied: pickNum(raw, ['isStudiedLesson', 'isStudied', 'is_studied']),
    video_id: pickNum(raw, ['videoId', 'video_id']),
    video_sec: pickNum(raw, ['videoSec', 'video_sec', 'duration']),
    videos,
  };
}

function parseChapter(value: unknown): ZhsChapter | null {
  const raw = asRecord(value);
  const lessons = asArray(pick(raw, ['videoLessons', 'lessons', 'videoLessonDtos']))
    .map(parseLesson)
    .filter((lesson): lesson is ZhsLesson => lesson !== null);
  const name = text(pick(raw, ['name', 'chapterName', 'title'])).trim();
  if (!name && lessons.length === 0) return null;
  return {
    chapter_id: pickNum(raw, ['id', 'chapterId', 'chapter_id']),
    name,
    learning_lesson_status: pickNum(raw, ['learningLessonStatus', 'learning_lesson_status']),
    is_pass: pickNum(raw, ['isPass', 'is_pass']),
    limit_checked: boolOrNull(pick(raw, ['limitChecked', 'limit_checked'])),
    lessons,
  };
}

/** Parse the `videolist` response into the chapter/lesson/video tree. */
export function parseCourseDetail(course: ZhsCourse, body: Record<string, unknown>): ZhsCourseDetail {
  const data = asRecord(pick(body, ['data', 'rt']) ?? body);
  const chapters = asArray(pick(data, ['videoChapterDtos', 'videoChapterDto', 'chapterList', 'chapters']))
    .map(parseChapter)
    .filter((chapter): chapter is ZhsChapter => chapter !== null);
  return { course, chapters };
}

/** Parse the `queryCourse` response and merge it into the given course. */
export function parseCourseInfo(course: ZhsCourse, body: Record<string, unknown>): ZhsCourse {
  const raw = asRecord(pick(body, ['data', 'rt', 'result']) ?? body);
  const parsed = parseCourse({ ...raw, recruitId: raw.recruitId ?? course.recruit_id, courseId: raw.courseId ?? course.course_id });
  if (!parsed) return course;
  return {
    ...course,
    ...parsed,
    recruit_id: parsed.recruit_id || course.recruit_id,
    course_id: parsed.course_id || course.course_id,
    name: parsed.name || course.name,
    teacher: parsed.teacher || course.teacher,
    secret: course.secret ?? parsed.secret,
    class_id: parsed.class_id ?? course.class_id,
    school_id: parsed.school_id ?? course.school_id,
    is_apply: parsed.is_apply ?? course.is_apply,
  };
}

/** Parse one meet-course row from `listTeachMeetingStu`. */
export function parseMeet(value: unknown, course: ZhsCourse): ZhsMeet | null {
  const raw = asRecord(value);
  const meetCourseId = pickNum(raw, ['meetCourseId', 'meetCourseID', 'meet_course_id', 'id', 'meetId'])
    ?? pickNum(raw, ['liveId', 'liveCourseId', 'live_id']);
  const liveId = pickNum(raw, ['liveId', 'liveCourseId', 'liveCourseID', 'liveRoomId', 'courseId', 'live_id']);
  if (!meetCourseId || !liveId) return null;
  return {
    meet_course_id: meetCourseId,
    live_id: liveId,
    video_id: pickNum(raw, ['videoId', 'video_id']),
    recruit_id: pickNum(raw, ['recruitId']) ?? course.recruit_id,
    course_id: pickNum(raw, ['courseId']) ?? course.course_id,
    name: text(pick(raw, ['meetName', 'courseName', 'name', 'title', 'teachMeetingName'])).trim(),
    teacher: text(pick(raw, ['teacherName', 'speakerUserName', 'speakerName', 'teacher', 'hostName'])).trim(),
    start_time: timeText(pick(raw, ['startTime', 'startTimeStr', 'start_time', 'liveStartTime', 'liveTime', 'startDate'])),
    end_time: timeText(pick(raw, ['endTime', 'endTimeStr', 'end_time', 'liveEndTime', 'endDate'])),
    replay_url: textOrNull(pick(raw, ['replayCourseUrl', 'replayUrl', 'replayCourse', 'playbackUrl', 'replay_url'])),
    exam_url: textOrNull(pick(raw, ['examH5Url', 'examUrl', 'examH5', 'quizUrl', 'exam_url'])),
    duration_secs: pickNum(raw, ['duration', 'videoDuration', 'replayDuration', 'durationSec', 'videoSec', 'totalTime']),
    status: pickNum(raw, ['status', 'examStatus', 'meetStatus']),
  };
}

function findPageArray(body: Record<string, unknown>, keys: string[]): unknown[] {
  const containers = [body, asRecord(body.data), asRecord(body.rt), asRecord(asRecord(body.data).rt)];
  for (const container of containers) {
    const direct = findArray(container, keys);
    if (direct.length > 0) return direct;
    for (const pageKey of ['page', 'pagination', 'paging']) {
      const page = asRecord(container[pageKey]);
      for (const key of keys) {
        if (Array.isArray(page[key])) return page[key] as unknown[];
      }
    }
  }
  return [];
}

/** Parse the meet list response (the endpoint may wrap it in several keys). */
export function parseMeetList(body: Record<string, unknown>, course: ZhsCourse): ZhsMeet[] {
  const keys = ['list', 'meetList', 'meetingList', 'teachMeetingList', 'teachMeetingStuList', 'rows', 'records'];
  const rows = findPageArray(body, keys);
  const seen = new Set<number>();
  const meets: ZhsMeet[] = [];
  for (const row of rows) {
    const meet = parseMeet(row, course);
    if (!meet || seen.has(meet.meet_course_id)) continue;
    seen.add(meet.meet_course_id);
    meets.push(meet);
  }
  return meets;
}

function minutesOf(value: unknown): number[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => minutesOf(item));
  }
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? [value] : [];
  if (typeof value === 'string') {
    return value.split(',').map((part) => Number(part.trim())).filter((minute) => Number.isInteger(minute) && minute >= 0);
  }
  const record = asRecord(value);
  for (const key of ['rt', 'data', 'history', 'watchHistory', 'list']) {
    if (record[key] !== undefined) {
      const minutes = minutesOf(record[key]);
      if (minutes.length > 0) return minutes;
    }
  }
  return [];
}

/** Parse `getWatchHistory`'s `rt` CSV/array into ascending unique minutes. */
export function parseWatchHistory(body: Record<string, unknown>): number[] {
  const minutes = minutesOf(body).filter((minute) => minute > 0);
  return [...new Set(minutes)].sort((left, right) => left - right);
}

/** Extract the JSON payload from a JSONP response body (raw JSON is accepted too). */
export function parseJsonp(textBody: string): unknown {
  const trimmed = textBody.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed) as unknown;
  const start = trimmed.indexOf('(');
  const end = trimmed.lastIndexOf(')');
  if (start < 0 || end <= start) throw new ZhsApiError('知到接口返回了非 JSONP 响应', 'jsonp');
  return JSON.parse(trimmed.slice(start + 1, end)) as unknown;
}

/** Parse an anti-cheat status reply (video or meet endpoints). */
export function parseExceptionStatus(value: Record<string, unknown>): ZhsExceptionStatus {
  const data = asRecord(pick(value, ['rt', 'data', 'result']) ?? value);
  const lock = boolOrNull(pick(data, ['lock', 'isLock', 'locked', 'forbid', 'restricted']))
    ?? boolOrNull(pick(value, ['lock', 'isLock']))
    ?? false;
  const endTime = text(pick(data, ['endTime', 'end_time', 'lockEndTime'])).trim();
  const abnormalField = boolOrNull(pick(data, ['abnormal', 'isAbnormal', 'exception', 'punished']));
  const abnormal = abnormalField ?? (endTime.length > 0 || lock);
  const message = text(pick(data, ['tipStr', 'message', 'msg', 'errorMessage'])).trim()
    || text(pick(value, ['message', 'msg', 'tipStr'])).trim();
  return { lock, abnormal, message };
}

export interface ZhsPrelearningNote {
  note_id: number;
  watch_state: number | null;
  study_total_time: number | null;
}

export interface ZhsStuyInfoEntry {
  watch_state: number | null;
  study_total_time: number | null;
}

export interface ZhsVideoReport {
  ewssw: string;
  sdsew: string;
  zwsds: string;
  courseId: number;
}

/**
 * Build the `saveDatabaseIntervalTimeV2` payload. The field order is the one
 * verified live: `[recruitId, lessonId, lessonVideoId, videoId, chapterId, 0,
 * total, total, hms(total), uuid+"zhs"]` with the `zzpttjd` key.
 */
export function buildVideoReport(course: ZhsCourse, target: ZhsVideoTarget, noteId: number, uuid: string): ZhsVideoReport {
  return {
    ewssw: watchPoints(target.video_sec),
    sdsew: xorEncode([
      target.recruit_id || course.recruit_id,
      target.lesson_id,
      target.lesson_video_id,
      target.video_id,
      target.chapter_id,
      0,
      target.video_sec,
      target.video_sec,
      hms(target.video_sec),
      `${uuid}zhs`,
    ], 'zzpttjd'),
    zwsds: bytesToBase64(utf8ToBytes(String(noteId))),
    courseId: course.course_id,
  };
}

export interface ZhsClientOptions {
  moduleKeys?: ModuleKeyCache;
  warn?: (message: string) => void;
}

/** Resolve the recruit/course ids and secret from a study-page URL or secret. */
export interface DecodedCourseRef {
  recruit_id: number | null;
  course_id: number | null;
  secret: string | null;
}

/**
 * Decode the many accepted course references: full study-page URL with
 * `recruitAndCourseId`, `recruitAndCourseId`/`recruitId;courseId` secret,
 * `recruitId;courseId`, `recruitId/courseId`, or a plain id matched against a
 * known course list. Mirrors `ZhsClient::resolve_course` on the Rust side.
 */
export function decodeCourseRef(ref: string, known: ZhsCourse[] = []): DecodedCourseRef {
  const value = ref.trim();
  if (!value) return { recruit_id: null, course_id: null, secret: null };

  const fromSecret = (secret: string): DecodedCourseRef => {
    try {
      const plain = xorDecode(secret, XOR_KEY_COURSE);
      const parts = plain.split(';').map((part) => Number(part));
      if (parts.length >= 2 && parts.every((part) => Number.isFinite(part))) {
        return { recruit_id: parts[0], course_id: parts[1], secret };
      }
    } catch {
      // Not an XOR secret; fall through to the other formats.
    }
    return { recruit_id: null, course_id: null, secret };
  };

  if (/^[0-9a-f]{16,}$/i.test(value)) return fromSecret(value);

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const joined = url.searchParams.get('recruitAndCourseId') ?? url.searchParams.get('recruitAndCourseID');
      if (joined) return fromSecret(joined);
      const recruit = num(url.searchParams.get('recruitId'));
      const course = num(url.searchParams.get('courseId'));
      return { recruit_id: recruit, course_id: course, secret: null };
    } catch {
      return { recruit_id: null, course_id: null, secret: null };
    }
  }

  if (value.includes('recruitAndCourseId=')) {
    const params = new URLSearchParams(value.slice(value.indexOf('?') >= 0 ? value.indexOf('?') + 1 : 0));
    const joined = params.get('recruitAndCourseId');
    if (joined) return fromSecret(joined);
  }

  const separated = value.match(/^(\d+)\s*[;,/]\s*(\d+)$/);
  if (separated) {
    return { recruit_id: Number(separated[1]), course_id: Number(separated[2]), secret: null };
  }

  const single = num(value);
  if (single !== null) {
    const match = known.find((course) => course.course_id === single || course.recruit_id === single);
    if (match) return { recruit_id: match.recruit_id, course_id: match.course_id, secret: match.secret };
    return { recruit_id: null, course_id: single, secret: null };
  }

  const byName = known.find((course) => course.name === value);
  if (byName) return { recruit_id: byName.recruit_id, course_id: byName.course_id, secret: byName.secret };
  return { recruit_id: null, course_id: null, secret: null };
}

/** Result of one `saveDatabaseIntervalTimeV2` call. */
export interface ZhsVideoReportResult {
  submit_success: boolean;
  raw: Record<string, unknown>;
}

/** Client for the Zhihuishu video-course, meet and anti-cheat endpoints. */
export class ZhsClient {
  private readonly transport: ZhsTransport;
  private readonly keyCache: ModuleKeyCache;
  private readonly warn: (message: string) => void;
  private readonly rateLimiter = new RateLimiter(500, 1200);
  private identity: ZhsIdentity | null = null;
  private user: ZhsUser | null = null;

  constructor(transport: ZhsTransport, options: ZhsClientOptions = {}) {
    this.transport = transport;
    this.keyCache = options.moduleKeys ?? new ModuleKeyCache();
    this.warn = options.warn ?? (() => undefined);
  }

  /** Adopt the identity reported by the bridge handshake. */
  setIdentity(identity: ZhsIdentity): void {
    this.identity = identity;
    // A re-connect may be a different account; never keep the previous user.
    this.user = null;
  }

  /** Adopt the authenticated user (also used to fill `uuid`/`userId`). */
  setUser(user: ZhsUser): void {
    this.user = user;
  }

  /** Current numeric user id, when known. */
  get userId(): number | null {
    return this.user?.user_id ?? this.identity?.user_id ?? null;
  }

  /** Current 8-character uuid, when known. */
  get uuid(): string {
    return this.user?.uuid ?? this.identity?.uuid ?? '';
  }

  /** Drop cached module keys (called on disconnect). */
  clearKeys(): void {
    this.keyCache.clear();
  }

  private async key(module: number): Promise<string> {
    return moduleKey(module, this.transport, this.keyCache, this.warn);
  }

  private async send(input: ZhsHttpRequest, endpoint: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let response;
    try {
      response = await this.transport.request(input, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ZhsApiError(error instanceof Error ? error.message : '知到请求失败', endpoint);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ZhsApiError('知到登录已失效，请在知到窗口重新登录。', endpoint, response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ZhsApiError(`知到接口返回 HTTP ${response.status}（${endpoint}）`, endpoint, response.status);
    }
    const bodyText = response.text.trim();
    if (!bodyText) throw new ZhsApiError('知到接口返回了空响应', endpoint);
    if (/请先登录|用户登录|<title>[^<]*登录/.test(bodyText.slice(0, 800))) {
      throw new ZhsApiError('知到登录已失效，请在知到窗口重新登录。', endpoint);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText) as unknown;
    } catch {
      throw new ZhsApiError('知到接口返回了非 JSON 响应', endpoint);
    }
    const body = asRecord(parsed);
    const code = pickNum(body, ['code', 'status', 'errorCode']);
    if (code !== null && code !== 0 && code !== 200 && !('data' in body) && !('rt' in body)) {
      const message = text(pick(body, ['message', 'msg', 'errorMessage'])) || `知到接口返回错误码 ${code}`;
      throw new ZhsApiError(message, endpoint, code);
    }
    return body;
  }

  private async encrypted(
    origin: string,
    path: string,
    payload: Record<string, unknown>,
    module: number,
    method: 'GET' | 'POST',
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const key = await this.key(module);
    const dateFormate = Date.now();
    const secretStr = await encryptSecret(key, JSON.stringify({ ...payload, dateFormate }));
    const query = new URLSearchParams({ secretStr, dateFormate: String(dateFormate) }).toString();
    const input: ZhsHttpRequest = method === 'GET'
      ? { url: `${origin}${path}?${query}`, method: 'GET' }
      : { url: `${origin}${path}`, method: 'POST', body: query };
    return this.send(input, path, signal);
  }

  /** `getLoginUserInfo`: confirm the session and read the account identity. */
  async loginUser(signal?: AbortSignal): Promise<ZhsUser> {
    const body = await this.encrypted(ZHS_STUDYSERVICE_ORIGIN, '/gateway/t/v1/login/getLoginUserInfo', {}, MODULE_VIDEO, 'GET', signal);
    const data = asRecord(pick(body, ['data', 'rt', 'result']) ?? body);
    const uuid = text(pick(data, ['uuid', 'userUuid', 'user_uuid'])).trim() || this.identity?.uuid || '';
    const userId = pickNum(data, ['userId', 'user_id']) ?? this.identity?.user_id ?? 0;
    return {
      user_id: userId,
      uuid,
      real_name: text(pick(data, ['realName', 'real_name', 'userName', 'username'])).trim(),
      school_id: pickNum(data, ['schoolId', 'school_id']),
      is_teacher: boolOrNull(pick(data, ['isTeacher', 'is_teacher'])) === true,
    };
  }

  /** `queryShareCourseInfo`: the shared-course list (endpoint per plan §9). */
  async listCourses(schoolId: number | null = null, signal?: AbortSignal): Promise<ZhsCourse[]> {
    const body = await this.encrypted(
      ZHS_ONLINESERVICE_ORIGIN,
      '/gateway/t/v1/student/course/share/queryShareCourseInfo',
      { status: 0, pageNum: 1, pageSize: 50, schoolId: schoolId ?? 0 },
      MODULE_VIDEO,
      'POST',
      signal,
    );
    const courses = parseCourseList(body);
    if (courses.length === 0) {
      throw new ZhsApiError('课程列表接口没有返回共享课；可粘贴学习页链接手动添加课程。', 'queryShareCourseInfo');
    }
    return courses;
  }

  /** Resolve a pasted study-page URL/secret/ids into a course and query its metadata. */
  async resolveCourse(ref: string, known: ZhsCourse[] = [], signal?: AbortSignal): Promise<ZhsCourse> {
    const decoded = decodeCourseRef(ref, known);
    const resolvedSecret = decoded.secret
      ?? (decoded.recruit_id !== null && decoded.course_id !== null
        ? xorEncode([decoded.recruit_id, decoded.course_id], XOR_KEY_COURSE)
        : null);
    if (!resolvedSecret) throw new ZhsApiError('无法从该输入解析出知到课程，请粘贴完整学习页链接。', 'resolveCourse');
    const base: ZhsCourse = {
      recruit_id: decoded.recruit_id ?? 0,
      course_id: decoded.course_id ?? 0,
      class_id: null,
      school_id: null,
      name: '',
      teacher: '',
      secret: resolvedSecret,
      is_apply: null,
      course_type: null,
      progress: null,
      studied_lesson_count: null,
      total_lesson_count: null,
      status: null,
    };
    const meta = await this.queryCourse(base, signal);
    if (!meta.recruit_id || !meta.course_id) {
      throw new ZhsApiError('知到课程信息不完整（缺少 recruitId/courseId）。', 'queryCourse');
    }
    return meta;
  }

  private async queryCourse(course: ZhsCourse, signal?: AbortSignal): Promise<ZhsCourse> {
    const body = await this.encrypted(
      ZHS_STUDYSERVICE_ORIGIN,
      '/gateway/t/v1/learning/queryCourse',
      { recruitAndCourseId: course.secret ?? '' },
      MODULE_VIDEO,
      'POST',
      signal,
    );
    return parseCourseInfo(course, body);
  }

  /** Fetch the chapter/lesson/video tree for one course. */
  async courseDetail(course: ZhsCourse, signal?: AbortSignal): Promise<ZhsCourseDetail> {
    const secret = course.secret ?? xorEncode([course.recruit_id, course.course_id], XOR_KEY_COURSE);
    const enriched = await this.queryCourse({ ...course, secret }, signal);
    const body = await this.encrypted(
      ZHS_STUDYSERVICE_ORIGIN,
      '/gateway/t/v1/learning/videolist',
      { recruitAndCourseId: secret },
      MODULE_VIDEO,
      'POST',
      signal,
    );
    return parseCourseDetail(enriched, body);
  }

  /** `prelearningNote`: note id used by `zwsds`. */
  async prelearningNote(course: ZhsCourse, target: ZhsVideoTarget, signal?: AbortSignal): Promise<ZhsPrelearningNote> {
    const body = await this.encrypted(
      ZHS_STUDYSERVICE_ORIGIN,
      '/gateway/t/v1/learning/prelearningNote',
      {
        ccCourseId: course.course_id,
        chapterId: String(target.chapter_id),
        isApply: course.is_apply ?? 1,
        lessonId: target.lesson_id,
        lessonVideoId: target.lesson_video_id,
        recruitId: target.recruit_id || course.recruit_id,
        videoId: target.video_id,
      },
      MODULE_VIDEO,
      'POST',
      signal,
    );
    const data = asRecord(pick(body, ['data', 'rt']) ?? body);
    const dto = asRecord(pick(data, ['studiedLessonDto', 'studiedLesson']) ?? data);
    const noteId = pickNum(dto, ['id', 'noteId']);
    if (!noteId) throw new ZhsApiError('知到学习记录接口未返回 noteId', 'prelearningNote');
    return {
      note_id: noteId,
      watch_state: pickNum(dto, ['watchState', 'watch_state']),
      study_total_time: pickNum(dto, ['studyTotalTime', 'study_total_time']),
    };
  }

  /** `queryStuyInfo`: per-video `watchState` used to verify reports. */
  async queryStuyInfo(course: ZhsCourse, targets: ZhsVideoTarget[], signal?: AbortSignal): Promise<Map<number, ZhsStuyInfoEntry>> {
    const lessonIds = [...new Set(targets.map((target) => target.lesson_id))];
    const lessonVideoIds = [...new Set(targets.map((target) => target.lesson_video_id))];
    const body = await this.encrypted(
      ZHS_STUDYSERVICE_ORIGIN,
      '/gateway/t/v1/learning/queryStuyInfo',
      { lessonIds, lessonVideoIds, recruitId: course.recruit_id },
      MODULE_VIDEO,
      'POST',
      signal,
    );
    const data = asRecord(pick(body, ['data', 'rt']) ?? body);
    const live = asRecord(pick(data, ['lv', 'lessonVideo']) ?? {});
    const result = new Map<number, ZhsStuyInfoEntry>();
    for (const [key, value] of Object.entries(live)) {
      const id = Number(key);
      if (!Number.isFinite(id)) continue;
      const entry = asRecord(value);
      result.set(id, {
        watch_state: pickNum(entry, ['watchState', 'watch_state']),
        study_total_time: pickNum(entry, ['studyTotalTime', 'study_total_time']),
      });
    }
    return result;
  }

  /** `saveDatabaseIntervalTimeV2`: report one finished video. */
  async reportVideo(course: ZhsCourse, target: ZhsVideoTarget, noteId: number, signal?: AbortSignal): Promise<ZhsVideoReportResult> {
    const report = buildVideoReport(course, target, noteId, this.uuid);
    const body = await this.encrypted(
      ZHS_STUDYSERVICE_ORIGIN,
      '/gateway/t/v1/learning/saveDatabaseIntervalTimeV2',
      { ...report },
      MODULE_VIDEO,
      'POST',
      signal,
    );
    const data = asRecord(pick(body, ['data', 'rt']) ?? body);
    return { submit_success: boolOrNull(pick(data, ['submitSuccess', 'submit_success'])) === true, raw: body };
  }

  /** Video-course anti-cheat status (`cheat/exceptionActionDetail`). */
  async exceptionStatus(course: ZhsCourse, signal?: AbortSignal): Promise<ZhsExceptionStatus> {
    const payload: Record<string, unknown> = { recruitId: course.recruit_id };
    const schoolId = course.school_id ?? this.user?.school_id ?? null;
    if (schoolId !== null) payload.schoolId = schoolId;
    const body = await this.encrypted(
      ZHS_STUDYSERVICE_ORIGIN,
      '/gateway/t/v1/cheat/exceptionActionDetail',
      payload,
      MODULE_VIDEO,
      'GET',
      signal,
    );
    return parseExceptionStatus(body);
  }

  /**
   * Live (`appcomm-live-api`) `secretStr` request. Mirroring the page helper,
   * the encrypted JSON is exactly the passed payload (no injected
   * `dateFormate`) and the query only adds the `_` cache buster.
   */
  private async liveEncrypted(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const key = await this.key(MODULE_MEET);
    const secretStr = await encryptSecret(key, JSON.stringify(payload));
    const query = new URLSearchParams({ secretStr, _: String(Date.now()) }).toString();
    return this.send({ url: `${ZHS_APPLIVE_ORIGIN}${path}?${query}`, method: 'GET' }, path, signal);
  }

  private static readonly MEET_HISTORY_PATH = '/app-commserv-live/gateway/t/v1/pc/live/getWatchHistory';
  private static readonly MEET_SUBMIT_PATH = '/app-commserv-live/gateway/t/v1/pc/live/setWatchHistorySecret';
  private static readonly MEET_EXCEPTION_PATH = '/app-commserv-live/gateway/t/v1/chect/exceptionActionDetail';

  /**
   * Meet-course list. The student portal serves it from
   * `online.zhihuishu.com/onlineSchool/...`; the legacy `stuonline` endpoint is
   * tried when the primary host fails. Both take the same plain form body.
   */
  async meetList(course: ZhsCourse, signal?: AbortSignal): Promise<ZhsMeet[]> {
    const body = new URLSearchParams({
      recruitId: String(course.recruit_id),
      'page.pageNo': '0',
      'page.pageSize': '50',
    }).toString();
    const primary = `${ZHS_ONLINE_ORIGIN}/onlineSchool/json/teachMeeting/listTeachMeetingStu?examV2=ss`;
    try {
      const response = await this.send({ url: primary, method: 'POST', body }, 'listTeachMeetingStu', signal);
      const meets = parseMeetList(response, course);
      if (meets.length > 0) return meets;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.warn(`知到见面课列表主接口失败：${error instanceof Error ? error.message : '请求失败'}，尝试备用接口`);
    }
    const fallback = `${ZHS_STUONLINE_ORIGIN}/stuonline/teachMeeting/listTeachMeetingStu?examV2=ss`;
    const response = await this.send({ url: fallback, method: 'POST', body }, 'listTeachMeetingStu', signal);
    return parseMeetList(response, course);
  }

  /** Replay video metadata via the JSONP helper; used for the duration/video-id fallback. */
  private async meetVideos(meet: ZhsMeet, signal?: AbortSignal): Promise<Array<{ video_id: number | null; duration: number }>> {
    const response = await this.transport.request({
      url: `${ZHS_IM_ORIGIN}/livehome/getVideosByLiveId?liveId=${meet.live_id}&jsonpCallBack=jsonpCallBack&_=${Date.now()}`,
      method: 'GET',
    }, signal).catch((error: unknown) => {
      throw new ZhsApiError(error instanceof Error ? error.message : '知到回放视频接口失败', 'getVideosByLiveId');
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ZhsApiError(`知到回放视频接口返回 HTTP ${response.status}`, 'getVideosByLiveId', response.status);
    }
    let parsed: unknown;
    try {
      parsed = parseJsonp(response.text);
    } catch {
      throw new ZhsApiError('知到回放视频接口返回了非 JSONP 响应', 'getVideosByLiveId');
    }
    const rows = Array.isArray(parsed) ? parsed : asArray(asRecord(parsed).videos);
    return rows.map((row) => {
      const raw = asRecord(row);
      return {
        video_id: pickNum(raw, ['videoId', 'video_id', 'id']),
        duration: pickNum(raw, ['duration', 'videoSec', 'durationSec']) ?? 0,
      };
    });
  }

  /**
   * Replay length in seconds. The list sometimes reports milliseconds; totals
   * above ~27 hours are normalized down, matching the Rust client.
   */
  private static normalizeDuration(seconds: number): number {
    return seconds > 100_000 ? Math.floor(seconds / 1000) : seconds;
  }

  private async meetTotalSeconds(meet: ZhsMeet, signal?: AbortSignal): Promise<{ seconds: number; videoId: number | null }> {
    if (meet.duration_secs && meet.duration_secs > 0) {
      return { seconds: ZhsClient.normalizeDuration(meet.duration_secs), videoId: meet.video_id };
    }
    const videos = await this.meetVideos(meet, signal);
    const seconds = ZhsClient.normalizeDuration(videos.reduce((total, video) => total + video.duration, 0));
    if (seconds <= 0) throw new ZhsApiError('无法获取见面课回放时长，已停止以免空转。', 'getVideosByLiveId');
    return { seconds, videoId: meet.video_id ?? videos.find((video) => video.video_id)?.video_id ?? null };
  }

  /** Watched minute numbers of one replay (live encrypted `getWatchHistory`). */
  async meetWatchHistory(meet: ZhsMeet, userId: number, signal?: AbortSignal): Promise<number[]> {
    const body = await this.liveEncrypted(ZhsClient.MEET_HISTORY_PATH, {
      courseId: meet.live_id,
      userId,
    }, signal);
    return parseWatchHistory(body);
  }

  /** Replay progress: total minutes from the replay length, watched from history. */
  async meetProgress(meet: ZhsMeet, userId: number, signal?: AbortSignal): Promise<ZhsMeetProgress> {
    const { seconds } = await this.meetTotalSeconds(meet, signal);
    const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
    const watched = await this.meetWatchHistory(meet, userId, signal);
    return {
      total_minutes: totalMinutes,
      watched_minutes: watched,
      watched_count: watched.length,
      percent: Math.round((Math.min(watched.length, totalMinutes) / totalMinutes) * 100),
    };
  }

  /**
   * Report one replay minute: `GET setWatchHistorySecret` with
   * `secretStr = AES(module 9, {paramSecret, jsonpCallBack})`.
   */
  async reportMeetMinute(course: ZhsCourse, meet: ZhsMeet, minute: number, userId: number, videoId: number, signal?: AbortSignal): Promise<number | null> {
    const paramSecret = xorEncode([course.recruit_id, meet.live_id, userId, minute, '2', videoId], XOR_KEY_MEET);
    const body = await this.liveEncrypted(ZhsClient.MEET_SUBMIT_PATH, {
      paramSecret,
      jsonpCallBack: 'jsonpCallBack',
    }, signal);
    return pickNum(body, ['historySum', 'data', 'rt']);
  }

  /** Meet-course anti-cheat status (live encrypted `chect/exceptionActionDetail`). */
  async meetExceptionStatus(course: ZhsCourse, uuid: string, signal?: AbortSignal): Promise<ZhsExceptionStatus> {
    const body = await this.liveEncrypted(ZhsClient.MEET_EXCEPTION_PATH, {
      uuid,
      recruitId: course.recruit_id,
    }, signal);
    return parseExceptionStatus(body);
  }

  /** Resolve the replay video id needed by `setWatchHistorySecret`. */
  async meetVideoId(meet: ZhsMeet, signal?: AbortSignal): Promise<number> {
    if (meet.video_id) return meet.video_id;
    const videos = await this.meetVideos(meet, signal);
    const videoId = videos.find((video) => video.video_id)?.video_id ?? null;
    if (!videoId) throw new ZhsApiError('见面课回放缺少 videoId，无法上报考勤。', 'getVideosByLiveId');
    return videoId;
  }

  /** Pacing helper shared by the video and meet executors. */
  async pace(signal?: AbortSignal): Promise<void> {
    await this.rateLimiter.wait(signal);
  }
}
