import type { Card, Chapter, CourseSummary, PlaybackEnv, Question, TaskKind, TaskPoint, VideoInfo } from '../types.ts';
import { PLATFORM } from './transport.ts';

export const documentOf = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');
export const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
const text = (node: ParentNode, selector: string) => clean(node.querySelector(selector)?.textContent);
const attr = (node: Element | null, key: string): string | null => node?.getAttribute(key)?.trim() || null;
export const hidden = (doc: Document, key: string): string | null => attr(doc.getElementById(key) ?? doc.querySelector(`input[name="${key}"]`), 'value');
const str = (value: unknown): string | null => typeof value === 'string' || typeof value === 'number' ? String(value) : null;
const num = (value: unknown): number | null => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
// Platform JSON is untyped. Keep it at the parsing boundary and retain raw attachments.
export type Json = Record<string, any>;

export function parseCourseList(html: string): CourseSummary[] {
  const doc = documentOf(html);
  const courses = [...doc.querySelectorAll('li.w_couritem')].flatMap((item): CourseSummary[] => {
    const id = attr(item, 'cid') ?? attr(item, 'courseid');
    const name = attr(item, 'cname') ?? attr(item.querySelector('h3 a'), 'title') ?? text(item, 'h3');
    if (!id || !name) return [];
    return [{
      course_id: id, class_id: attr(item, 'classid') ?? '', cpi: attr(item, 'personid') ?? '', name,
      cover_url: attr(item.querySelector('img'), 'src'), source: attr(item, 'source'),
      kc_enc: attr(item, 'kcenc'), ck_enc: attr(item, 'ckenc'), clazz_enc: attr(item, 'clazzenc'),
      detail_url: new URL(attr(item.querySelector("a[href*='opencoursenewfy']"), 'href') ?? `/fyportal-smartcourse/courselist/opencoursenewfy?role=3&courseId=${id}`, PLATFORM).href,
    }];
  });
  if (!courses.length && /passport|用户登录|请先登录|\blogin\b/i.test(html)) throw new Error('学校登录已失效，请在连接窗口中重新登录。');
  return courses;
}

export function parseChapters(html: string): Chapter[] {
  const doc = documentOf(html);
  const root = [...doc.querySelectorAll('ul')].find((ul) => ul.querySelector('.posCatalog_select')) ?? doc.querySelector('ul');
  if (!root) throw new Error('章节目录格式已变化：找不到目录树');
  const walk = (ul: Element, level: number): Chapter[] => [...ul.children].filter((li) => li.tagName === 'LI').flatMap((li) => {
    const div = [...li.children].find((el) => el.matches('div.posCatalog_select'));
    const id = div?.id;
    if (!div || !id) return [];
    const label = div.querySelector('.posCatalog_name, .posCatalog_title');
    const nested = [...li.children].find((el) => el.classList.contains('posCatalog_level'))?.querySelector('ul');
    return [{
      id: id.replace(/^cur/, ''), title: attr(label, 'title') ?? clean(label?.textContent),
      number: text(div, 'em.posCatalog_sbar') || null, level, is_leaf: id.startsWith('cur'),
      completed: div.querySelector('.icon_Completed') ? true : div.querySelector('.icon_Uncompleted') ? false : null,
      children: nested ? walk(nested, level + 1) : [], cards: [],
    }];
  });
  return walk(root, 1);
}

export function allChapters(chapters: Chapter[]): Chapter[] {
  return chapters.flatMap((chapter) => [chapter, ...allChapters(chapter.children)]);
}

export function parseCards(html: string): Card[] {
  const doc = documentOf(html);
  const cards = [...doc.querySelectorAll('#prev_tab ul.prev_ul li, ul.prev_ul li')].map((li, index) => ({
    index: index + 1, card_id: attr(li, 'cardid'), title: attr(li, 'title') ?? `card ${index + 1}`, task_points: [],
  }));
  if (cards.length) return cards;
  const count = Math.min(500, Math.max(1, Number(hidden(doc, 'cardcount')) || 1));
  return Array.from({ length: count }, (_, index) => ({ index: index + 1, card_id: null, title: `card ${index + 1}`, task_points: [] }));
}

/** Extract JSON without eval, even with braces and escaped quotes inside strings. */
export function extractMarg(html: string): Json {
  const matches = [...html.matchAll(/\bmArg\s*=\s*(?=\{)/g)];
  if (!matches.length) throw new Error('卡片中没有 mArg 数据');
  const start = matches.at(-1)!.index! + matches.at(-1)![0].length;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('mArg JSON 不完整');
}

export function parsePlayback(marg: Json): PlaybackEnv | undefined {
  const d = marg.defaults;
  if (!d || typeof d !== 'object') return;
  return {
    user_id: str(d.userid ?? d.userId), clazz_id: str(d.clazzId ?? d.clazzid ?? d.clazzID),
    course_id: str(d.courseid ?? d.courseId), fid: str(d.fid),
    report_url: str(d.reportUrl ?? d.reporturl ?? marg.reportUrl),
    report_interval_secs: num(d.reportTimeInterval ?? d.reportTimeinterval), ktoken: str(d.ktoken),
  };
}

export function parseTasks(marg: Json): TaskPoint[] {
  const kinds: Record<string, TaskKind> = { video: 'video', document: 'document', workid: 'work', work: 'work', audio: 'audio', insertaudio: 'audio', live: 'live', insertlive: 'live' };
  return (Array.isArray(marg.attachments) ? marg.attachments : []).map((a: Json) => {
    const p = a.property ?? {};
    return {
      kind: kinds[a.type] ?? 'other', source_type: str(a.type) ?? '', name: str(p.name ?? p.title) ?? '',
      job_id: str(a.jobid ?? p.jobid), object_id: str(a.objectId ?? p.objectid), mid: str(a.mid ?? p.mid),
      size_bytes: num(p.size), content_ext: str(p.type), completed: typeof a.isPassed === 'boolean' ? a.isPassed : null,
      played_ms: num(a.playTime), duration_secs: num(a.attDuration), work_id: str(p.workid), work_type: str(p.worktype),
      enc: str(a.enc), other_info: str(a.otherInfo ?? p.otherInfo) ?? undefined,
      att_duration_enc: str(a.attDurationEnc ?? p.attDurationEnc) ?? undefined,
      rt: str(a.rt ?? p.rt) ?? undefined, video_face_capture_enc: str(a.videoFaceCaptureEnc ?? p.videoFaceCaptureEnc) ?? undefined,
      questions: [], raw: a,
    };
  });
}

export function parseVideo(json: Json): VideoInfo {
  return {
    duration_secs: num(json.duration), size_bytes: num(json.length), filename: str(json.filename),
    dtoken: str(json.dtoken) ?? undefined, screenshot: str(json.screenshot), thumbnails: str(json.thumbnails),
    download_url: str(json.download), stream_url: str(json.http), hd_stream_url: str(json.httphd), status: str(json.status),
  };
}

export function questionId(node: Element): string {
  return (node.id || node.parentElement?.closest('[id^="question"]')?.id || '').replace(/^question/, '')
    || attr(node.querySelector('[qid]'), 'qid') || (/^\d{5,}$/.test(attr(node, 'data') ?? '') ? attr(node, 'data')! : '');
}

export function parseQuestions(html: string): Question[] {
  const doc = documentOf(html), seen = new Set<string>();
  const nodes = doc.querySelectorAll('div.TiMu');
  return [...(nodes.length ? nodes : doc.querySelectorAll('div.questionLi'))].flatMap((node): Question[] => {
    const id = questionId(node);
    if (id && seen.has(id)) return [];
    seen.add(id);
    const type = text(node, '.newZy_TItle').replace(/^[【\[]|[】\]]$/g, '').trim();
    let stem = text(node, '.qtContent') || text(node, '.Zy_TItle');
    if (type) {
      const index = stem.indexOf(`【${type}】`);
      if (index >= 0 && index <= 12) stem = stem.slice(index + type.length + 2).trim();
      else if (stem.startsWith(type)) stem = stem.slice(type.length).trim();
    }
    if (!stem) return [];
    const answer = (selector: string, blocks: string): string | null => {
      const direct = text(node, selector);
      if (direct) return direct;
      return [...node.querySelectorAll(blocks)].map((block) => clean(block.textContent))
        .filter((value) => value && !/^(我的|正确)答案[：:]$/.test(value))
        .map((value) => value.replace(/第[一二三四五六七八九十\d]+空[：:]\s*/g, '；').replace(/^；/, '').trim()).join('；') || null;
    };
    return [{
      id, question_type: type || null, stem,
      options: [...node.querySelectorAll('ul.Zy_ulTop li')].map((li) => {
        const label = text(li, '.num_option, .num_option_dx, i').replace(/[、.．\s]+$/, '');
        return { label, text: text(li, 'a') || clean(li.textContent).slice(label.length).replace(/^[、.．\s]+/, '') };
      }),
      my_answer: answer('.myAnswer .answerCon', '.myAllAnswerBx .myAnswer'),
      correct_answer: answer('.correctAnswer .answerCon', '.correctAnswerBx .correctAnswer'),
      score: text(node, '.newAnswerScore .scoreNum') || null,
    }];
  });
}
