// Ulearning HTTP client, aligned with the verified player protocol
// (`docs/ulearning/{miaoshua-plan,web-analysis}.md`).
//
// Every request goes through the `ul-bridge` transport, which runs inside a
// Ulearning page: it reads the `AUTHORIZATION` cookie and adds both
// `Authorization` and `UA-AUTHORIZATION` headers itself, so the static site
// never sees the token. Bodies of `sync` requests are DES-ECB encrypted here.
import { desEncryptEcbBase64 } from './crypto.ts';
import { UL_API_ORIGIN, type UlHttpRequest, type UlTransport } from './transport.ts';
import type {
  UlChapter,
  UlCourse,
  UlCourseDetail,
  UlPage,
  UlPagePlan,
  UlQuestion,
  UlSection,
  UlVideo,
} from './types.ts';

/** Normalized Ulearning error. */
export class UlApiError extends Error {
  readonly endpoint: string;
  readonly code: number | null;

  constructor(message: string, endpoint: string, code: number | null = null) {
    super(message);
    this.name = 'UlApiError';
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

/** Inclusive random integer with an injectable generator for tests. */
export function randomInt(min: number, max: number, random: () => number = Math.random): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return low + Math.floor(random() * (high - low + 1));
}

/** Random pacing guard between `sync` submissions. */
export class RateLimiter {
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;

  constructor(minMs: number, maxMs: number, random: () => number = Math.random) {
    this.minMs = Math.max(0, Math.min(minMs, maxMs));
    this.maxMs = Math.max(0, Math.max(minMs, maxMs));
    this.random = random;
  }

  nextDelay(random: () => number = this.random): number {
    return randomInt(this.minMs, this.maxMs, random);
  }

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

function findRows(body: Record<string, unknown>, keys: string[]): unknown[] {
  const containers = [body, asRecord(body.data), asRecord(body.rt), asRecord(body.result), asRecord(asRecord(body.data).data)];
  for (const container of containers) {
    for (const key of keys) {
      if (Array.isArray(container[key])) return container[key] as unknown[];
    }
    for (const pageKey of ['page', 'pagination', 'paging']) {
      const page = asRecord(container[pageKey]);
      for (const key of keys) {
        if (Array.isArray(page[key])) return page[key] as unknown[];
      }
    }
  }
  return [];
}

/** Payload of a player URL / manual reference. */
export interface UlCourseRef {
  textbook_id: number;
  class_id: number | null;
  oc_id: number | null;
  chapter_id: number | null;
}

/** Parse a player URL, `textbookId/classId`, `textbookId,classId` or plain id. */
export function parseCourseRef(ref: string): UlCourseRef | null {
  const value = ref.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const textbook = num(url.searchParams.get('courseId'));
      if (!textbook) return null;
      return {
        textbook_id: textbook,
        class_id: num(url.searchParams.get('classId')) ?? num(url.searchParams.get('classid')),
        oc_id: num(url.searchParams.get('ocId')) ?? num(url.searchParams.get('oc_id')),
        chapter_id: num(url.searchParams.get('chapterId')),
      };
    } catch {
      return null;
    }
  }
  const separated = value.match(/^(\d+)\s*[/,;\s]\s*(\d+)$/);
  if (separated) {
    return { textbook_id: Number(separated[1]), class_id: Number(separated[2]), oc_id: null, chapter_id: null };
  }
  const single = num(value);
  if (single !== null) return { textbook_id: single, class_id: null, oc_id: null, chapter_id: null };
  return null;
}

/** Parse `/course/{textbookId}/basicinformation`. */
export function parseBasicInformation(body: Record<string, unknown>): { name: string; teacher: string; locale: string | null; oc_id: number | null } {
  const data = asRecord(pick(body, ['data', 'result', 'course']) ?? body);
  return {
    name: text(pick(data, ['courseName', 'name', 'textbookName', 'title'])).trim(),
    teacher: text(pick(data, ['teacherName', 'teacher', 'createUserName'])).trim(),
    locale: text(pick(data, ['locale', 'lang'])).trim() || null,
    oc_id: pickNum(data, ['ocId', 'oc_id', 'courseOcId']),
  };
}

/** `remaining.time < 0` means the course is over and reporting makes no sense. */
export function parseRemaining(body: Record<string, unknown>): { expired: boolean | null; seconds: number | null } {
  const data = asRecord(pick(body, ['data', 'result', 'rt']) ?? body);
  const seconds = pickNum(data, ['time', 'remainingTime', 'remaining']);
  return { expired: seconds === null ? null : seconds < 0, seconds };
}

function parsePage(value: unknown): UlPage | null {
  const raw = asRecord(value);
  const pageId = pickNum(raw, ['id', 'pageId', 'page_id']);
  if (!pageId) return null;
  const relationId = pickNum(raw, ['relationId', 'relationid', 'relationID']) ?? pageId;
  return {
    page_id: pageId,
    relation_id: relationId,
    name: text(pick(raw, ['name', 'pageName', 'title'])).trim(),
    content_type: pickNum(raw, ['contentType', 'content_type', 'type']) ?? 0,
  };
}

function parseSection(value: unknown, chapterId: number, chapterName: string): UlSection | null {
  const raw = asRecord(value);
  const sectionId = pickNum(raw, ['id', 'sectionId', 'itemid', 'itemId']);
  if (!sectionId) return null;
  const pages = asArray(pick(raw, ['pageList', 'pageDTOList', 'pages', 'children']))
    .map(parsePage)
    .filter((page): page is UlPage => page !== null);
  return {
    section_id: sectionId,
    name: text(pick(raw, ['name', 'sectionName', 'title'])).trim(),
    chapter_id: chapterId,
    chapter_name: chapterName,
    pages,
    completion_status: pickNum(raw, ['completionStatus', 'completion_status']),
    video_secs: pickNum(raw, ['videoLength', 'videoSec', 'duration']),
  };
}

function parseChapter(value: unknown): UlChapter | null {
  const raw = asRecord(value);
  const chapterId = pickNum(raw, ['id', 'chapterId', 'chapter_id']);
  if (!chapterId) return null;
  const name = text(pick(raw, ['name', 'chapterName', 'title'])).trim();
  const sections = asArray(pick(raw, ['sectionList', 'sectionDTOList', 'sections', 'items', 'children']))
    .map((section) => parseSection(section, chapterId, name))
    .filter((section): section is UlSection => section !== null);
  return { chapter_id: chapterId, name, sections };
}

/** Parse `/course/stu/{textbookId}/directory?classId=`. */
export function parseDirectory(body: Record<string, unknown>): UlChapter[] {
  const rows = findRows(body, ['chapterList', 'chapterDTOList', 'chapters', 'list', 'children', 'data']);
  return rows
    .map(parseChapter)
    .filter((chapter): chapter is UlChapter => chapter !== null);
}

/** Parse `studyrecord/item/{sectionId}`; `completion_status==1` means finished. */
export function parseSectionRecord(body: Record<string, unknown>): { completion_status: number | null; study_time: number | null; version: string | null } {
  const data = asRecord(pick(body, ['data', 'rt', 'result', 'record']) ?? body);
  return {
    completion_status: pickNum(data, ['completion_status', 'completionStatus', 'status']),
    study_time: pickNum(data, ['studyTime', 'study_time']),
    version: text(pick(data, ['version'])).trim() || null,
  };
}

/** Parse `wholepage/item/stu/{sectionId}`: the section's page list. */
export function parseWholepageItem(body: Record<string, unknown>): UlPage[] {
  const data = asRecord(pick(body, ['data', 'rt', 'result']) ?? body);
  const rows = asArray(pick(data, ['wholepageDTOList', 'wholepageList', 'pageList', 'pages']));
  return rows.map(parsePage).filter((page): page is UlPage => page !== null);
}

/** Parsed page content (`wholepage/stu/{pageId}`). */
export interface UlPageContent {
  content_type: number;
  coursepage_id: number | null;
  videos: UlVideo[];
  questions: UlQuestion[];
}

/** Parse `wholepage/stu/{pageId}`: videos and exercise questions of one page. */
export function parsePageContent(body: Record<string, unknown>): UlPageContent {
  const data = asRecord(pick(body, ['data', 'rt', 'result']) ?? body);
  const contentType = pickNum(data, ['contentType', 'content_type']) ?? 0;
  const elements = asArray(pick(data, ['coursepageDTOList', 'coursepageList', 'elements']));
  const videos: UlVideo[] = [];
  const questions: UlQuestion[] = [];
  let coursepageId: number | null = null;
  for (const element of elements) {
    const raw = asRecord(element);
    const type = pickNum(raw, ['type']) ?? 0;
    // The exercise component is the type=6 element; the first element is often a
    // title/text block and must not become `coursepageId`.
    if (type === 6 && coursepageId === null) {
      coursepageId = pickNum(raw, ['coursepageDTOid', 'coursepageId', 'id']);
    }
    const videoId = pickNum(raw, ['resourceid', 'resourceId', 'videoid', 'videoId']);
    const duration = pickNum(raw, ['videoLength', 'videoSec', 'duration']);
    if (type === 4 || (videoId !== null && duration !== null)) {
      if (videoId !== null && duration !== null && duration > 0) videos.push({ video_id: videoId, duration_secs: duration });
    }
    for (const question of asArray(pick(raw, ['questionDTOList', 'questions']))) {
      const questionRaw = asRecord(question);
      const questionId = pickNum(questionRaw, ['questionid', 'questionId', 'id']);
      if (!questionId) continue;
      questions.push({
        question_id: questionId,
        score: pickNum(questionRaw, ['score', 'questionScore']) ?? 5,
        answers: [],
      });
    }
  }
  coursepageId = coursepageId ?? pickNum(data, ['coursepageDTOid', 'coursepageId']);
  return { content_type: contentType, coursepage_id: coursepageId, videos, questions };
}

/** Parse `/questionAnswer/{questionId}?parentId={pageId}`. */
export function parseQuestionAnswer(body: Record<string, unknown>): string[] {
  const data = asRecord(pick(body, ['data', 'result']) ?? body);
  const raw = pick(data, ['correctAnswerList', 'correctAnswerlist', 'answerList', 'answers']);
  if (Array.isArray(raw)) return raw.map((item) => text(item).trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

/** Parse `/studyrecord/initialize/{sectionId}`. */
export function parseInitialize(body: Record<string, unknown>): number {
  const data = asRecord(pick(body, ['data', 'rt', 'result']) ?? body);
  const value = pickNum(data, ['studyStartTime', 'studyStartTimeStamp', 'startTime', 'time']);
  return value ?? Math.floor(Date.now() / 1000);
}

export interface UlClientOptions {
  warn?: (message: string) => void;
}

/** Client for the Ulearning course/directory/record endpoints. */
export class UlearningClient {
  private readonly transport: UlTransport;
  private readonly warn: (message: string) => void;
  private readonly limiter = new RateLimiter(3000, 5000);
  private readonly answers = new Map<number, string[]>();

  constructor(transport: UlTransport, options: UlClientOptions = {}) {
    this.transport = transport;
    this.warn = options.warn ?? (() => undefined);
  }

  private async send(input: UlHttpRequest, endpoint: string, signal?: AbortSignal): Promise<string> {
    let response;
    try {
      response = await this.transport.request(input, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new UlApiError(error instanceof Error ? error.message : '优学院请求失败', endpoint);
    }
    if (response.status === 401 || response.status === 403) {
      throw new UlApiError('优学院登录已失效，请在优学院窗口重新登录。', endpoint, response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new UlApiError(`优学院接口返回 HTTP ${response.status}（${endpoint}）`, endpoint, response.status);
    }
    return response.text;
  }

  private async json(input: UlHttpRequest, endpoint: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const bodyText = (await this.send(input, endpoint, signal)).trim();
    if (!bodyText) throw new UlApiError('优学院接口返回了空响应', endpoint);
    if (/请先登录|用户登录|<title>[^<]*登录/.test(bodyText.slice(0, 800))) {
      throw new UlApiError('优学院登录已失效，请在优学院窗口重新登录。', endpoint);
    }
    try {
      return asRecord(JSON.parse(bodyText) as unknown);
    } catch {
      throw new UlApiError('优学院接口返回了非 JSON 响应', endpoint);
    }
  }

  /** `GET /course/{textbookId}/basicinformation`. */
  async basicInformation(textbookId: number, signal?: AbortSignal): Promise<ReturnType<typeof parseBasicInformation>> {
    const body = await this.json({ url: `${UL_API_ORIGIN}/course/${textbookId}/basicinformation` }, 'basicinformation', signal);
    return parseBasicInformation(body);
  }

  /** `GET /course/{textbookId}/remaining`. */
  async remaining(textbookId: number, signal?: AbortSignal): Promise<ReturnType<typeof parseRemaining>> {
    const body = await this.json({ url: `${UL_API_ORIGIN}/course/${textbookId}/remaining` }, 'remaining', signal);
    return parseRemaining(body);
  }

  /** `GET /course/stu/{textbookId}/directory?classId=`. */
  async directory(textbookId: number, classId: number, signal?: AbortSignal): Promise<UlChapter[]> {
    const url = `${UL_API_ORIGIN}/course/stu/${textbookId}/directory?classId=${classId}`;
    const body = await this.json({ url }, 'directory', signal);
    return parseDirectory(body);
  }

  /** `GET /studyrecord/item/{sectionId}?courseType=4`. */
  async sectionRecord(sectionId: number, signal?: AbortSignal): Promise<ReturnType<typeof parseSectionRecord>> {
    const body = await this.json({
      url: `${UL_API_ORIGIN}/studyrecord/item/${sectionId}?courseType=4`,
    }, 'studyrecord', signal);
    return parseSectionRecord(body);
  }

  /** `GET /wholepage/item/stu/{sectionId}`: page list of a section. */
  async wholepageItem(sectionId: number, signal?: AbortSignal): Promise<UlPage[]> {
    const body = await this.json({
      url: `${UL_API_ORIGIN}/wholepage/item/stu/${sectionId}`,
    }, 'wholepage/item', signal);
    return parseWholepageItem(body);
  }

  /** `GET /wholepage/stu/{pageId}`: video/question content of a page. */
  async pageContent(pageId: number, signal?: AbortSignal): Promise<UlPageContent> {
    const body = await this.json({
      url: `${UL_API_ORIGIN}/wholepage/stu/${pageId}`,
    }, 'wholepage', signal);
    return parsePageContent(body);
  }

  /** `GET /studyrecord/initialize/{sectionId}`: server-supplied study start time. */
  async initialize(sectionId: number, signal?: AbortSignal): Promise<number> {
    const body = await this.json({
      url: `${UL_API_ORIGIN}/studyrecord/initialize/${sectionId}`,
    }, 'initialize', signal);
    return parseInitialize(body);
  }

  /** `GET /questionAnswer/{questionId}?parentId={pageId}` (cached per question). */
  async questionAnswer(questionId: number, pageId: number, signal?: AbortSignal): Promise<string[]> {
    const cached = this.answers.get(questionId);
    if (cached) return cached;
    const body = await this.json({
      url: `${UL_API_ORIGIN}/questionAnswer/${questionId}?parentId=${pageId}`,
    }, 'questionAnswer', signal);
    const answers = parseQuestionAnswer(body);
    if (answers.length > 0) this.answers.set(questionId, answers);
    return answers;
  }

  /** `POST /yws/api/personal/sync?courseType=4&platform=PC` with a DES body. */
  async sync(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ response: number | null; text: string }> {
    const body = desEncryptEcbBase64(JSON.stringify(payload));
    const responseText = (await this.send({
      url: `${UL_API_ORIGIN}/yws/api/personal/sync?courseType=4&platform=PC`,
      method: 'POST',
      body,
    }, 'sync', signal)).trim();
    const response = num(responseText);
    return { response, text: responseText.slice(0, 200) };
  }

  /** Course metadata + chapter tree + per-section completion status. */
  async courseDetail(ref: UlCourse, signal?: AbortSignal): Promise<UlCourseDetail> {
    const [basic, remaining, chapters] = await Promise.all([
      this.basicInformation(ref.textbook_id, signal).catch((error: unknown) => {
        this.warn(error instanceof Error ? error.message : '课程信息读取失败');
        return null;
      }),
      this.remaining(ref.textbook_id, signal).catch(() => null),
      this.directory(ref.textbook_id, ref.class_id, signal),
    ]);
    const course: UlCourse = {
      ...ref,
      name: basic?.name || ref.name,
      teacher: basic?.teacher || ref.teacher,
      locale: basic?.locale ?? ref.locale,
      oc_id: ref.oc_id ?? basic?.oc_id ?? null,
      expired: remaining?.expired ?? ref.expired,
    };
    // Fill completion_status for every section (limited concurrency).
    const flat = chapters.flatMap((chapter) => chapter.sections);
    let next = 0;
    const worker = async () => {
      while (next < flat.length) {
        const section = flat[next];
        next += 1;
        try {
          const record = await this.sectionRecord(section.section_id, signal);
          section.completion_status = record.completion_status;
        } catch (error) {
          signal?.throwIfAborted();
          section.completion_status = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, flat.length) }, worker));
    signal?.throwIfAborted();
    return { course, chapters };
  }

  /** Fill one page plan (page id, videos, questions) for the executor. */
  async describePage(page: UlPage, options: { include_quizzes: boolean }, signal?: AbortSignal): Promise<UlPagePlan | null> {
    const content = await this.pageContent(page.page_id, signal);
    const plan: UlPagePlan = {
      page_id: page.page_id,
      relation_id: page.relation_id,
      content_type: content.content_type || page.content_type,
      coursepage_id: content.coursepage_id,
      videos: content.videos,
      questions: [],
    };
    if (content.questions.length > 0) {
      if (!options.include_quizzes) return null;
      const questions: UlQuestion[] = [];
      for (const question of content.questions) {
        const answers = await this.questionAnswer(question.question_id, page.page_id, signal);
        if (answers.length === 0) return null;
        questions.push({ ...question, answers });
      }
      plan.questions = questions;
    }
    return plan;
  }

  /** Pacing helper used by the executor. */
  async pace(signal?: AbortSignal): Promise<void> {
    await this.limiter.wait(signal);
  }
}
