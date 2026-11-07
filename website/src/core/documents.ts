// Document (PDF) task-point planning and `wxcard` attachment parsing.
//
// The platform's H5 card page emits one `jtoken` per attachment inside
// `window.AttachmentSetting`; `/mooc-ans/job/document` needs that token to mark
// one document 任务点 as read. The contract is ported from the official
// Chaoxing client (flutter_chaoxing 0.4.2, `fetchDocumentJobs` /
// `reportDocumentRead`). Keep this module pure so it can be unit-tested.
import type { CourseDetail, DocumentTarget } from '../types.ts';
import { allChapters, type Json } from './parse.ts';

/** One attachment identity parsed out of `window.AttachmentSetting`. */
export interface DocumentAttachment {
  jobId: string;
  jtoken: string;
  objectId: string | null;
  type: string | null;
}

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

/** Index of the `}` closing the JSON object that starts at `start`, string-aware. */
function closingBrace(source: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i;
  }
  return -1;
}

const withAttachments = (value: unknown): Json | null =>
  isRecord(value) && Array.isArray(value.attachments) ? value : null;

/**
 * Extract the `window.AttachmentSetting = {...}` object from a `wxcard`
 * response. The endpoint normally answers with an HTML page, but a direct JSON
 * body carrying `attachments` is accepted as well. Returns null when the
 * response holds no usable attachment data (logged out, not a card page, or a
 * changed page layout).
 */
export function parseAttachmentSetting(body: string): Json | null {
  const source = body.replace(/^\uFEFF/, '');
  const trimmed = source.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const direct = withAttachments(JSON.parse(trimmed));
      if (direct) return direct;
    } catch {
      // Not a JSON body: keep looking for the embedded assignment.
    }
  }
  // `window.AttachmentSetting` and a bare `AttachmentSetting` both appear in
  // platform pages, so search for the shortest common marker.
  for (let at = source.indexOf('AttachmentSetting'); at >= 0; at = source.indexOf('AttachmentSetting', at + 1)) {
    const start = at + 'AttachmentSetting'.length;
    const eq = source.indexOf('=', start);
    if (eq < 0) continue;
    const brace = source.indexOf('{', eq);
    if (brace < 0) continue;
    // Only `= {...}` is accepted; `= null;` must not capture an unrelated object.
    if (source.slice(eq + 1, brace).trim() !== '') continue;
    const end = closingBrace(source, brace);
    if (end < 0) continue;
    try {
      const decoded = withAttachments(JSON.parse(source.slice(brace, end + 1)));
      if (decoded) return decoded;
    } catch {
      // Malformed JSON: try the next occurrence.
    }
  }
  return null;
}

/** Normalised attachments of one `AttachmentSetting` object. */
export function parseAttachments(setting: Json | null): DocumentAttachment[] {
  const raw = setting?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): DocumentAttachment[] => {
    if (!isRecord(item)) return [];
    const jobId = text(item.jobid);
    if (!jobId) return [];
    const property = isRecord(item.property) ? item.property : {};
    return [{
      jobId,
      jtoken: text(item.jtoken),
      objectId: text(property.objectid ?? property.objectId) || null,
      type: text(item.type) || null,
    }];
  });
}

/**
 * Resolve the `jtoken` the document report needs. Matching is by `jobid`
 * first, with `property.objectid` as a fallback, mirroring the official client.
 */
export function attachmentJToken(setting: Json | null, jobId: string, objectId?: string | null): string | null {
  if (!jobId) return null;
  let fallback: string | null = null;
  for (const attachment of parseAttachments(setting)) {
    if (attachment.jobId === jobId && attachment.jtoken) return attachment.jtoken;
    if (objectId && attachment.objectId === objectId && !fallback && attachment.jtoken) fallback = attachment.jtoken;
  }
  return fallback;
}

/**
 * Plan the document task points of a crawled course.
 *
 * The card id is required to fetch the attachment list, so documents without a
 * card id (or without a job id) are skipped and explained through `errors`.
 * Documents the platform reports as completed are skipped unless
 * `includeCompleted` is set; the platform usually returns `null` for document
 * completion, so most documents are included.
 */
export function collectDocumentTargets(detail: CourseDetail, includeCompleted = false): { targets: DocumentTarget[]; errors: string[] } {
  const targets: DocumentTarget[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const chapter of allChapters(detail.chapters)) {
    for (const card of chapter.cards ?? []) {
      for (const point of card.task_points) {
        if (point.kind !== 'document') continue;
        if (point.completed === true && !includeCompleted) continue;
        const name = point.name || '未命名文档';
        if (!point.job_id) {
          errors.push(`知识点「${chapter.title}」的文档「${name}」缺少 job id，已跳过`);
          continue;
        }
        if (!card.card_id) {
          errors.push(`知识点「${chapter.title}」的文档「${name}」缺少 card id，无法获取 jtoken，已跳过`);
          continue;
        }
        const key = `${chapter.id}:${point.job_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({
          course_id: detail.course_id,
          class_id: detail.class_id,
          cpi: detail.cpi,
          knowledge_id: chapter.id,
          knowledge_title: chapter.title,
          card_id: card.card_id,
          job_id: point.job_id,
          object_id: point.object_id || null,
          name,
          size_bytes: point.size_bytes,
          content_ext: point.content_ext,
          completed: point.completed,
        });
      }
    }
  }
  return { targets, errors };
}
