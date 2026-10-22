import type { Question, QuestionOption } from '../types.ts';

export interface BankAnswer {
  question_id: string; course_id?: string; work_id?: string; question_type: string;
  stem: string; options: QuestionOption[]; answer: string; answer_labels: string[];
  answer_blanks: string[]; answer_text: string;
}
export interface BankData { version?: number; question_index: Record<string, BankAnswer>; stem_index: Record<string, string[]> }
const labels = ['判断题', '单选题', '多选题', '填空题', '简答题', '名词解释', '论述题', '排序题'];
export function normalizeStem(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase().replace(new RegExp(`^(${labels.join('|')})\\s*[:：]`), '').replace(/[^\p{L}\p{N}]/gu, '');
}
export class AnswerBank {
  readonly data: BankData;
  constructor(data: BankData) {
    this.data = data;
    if (!data.question_index || !Object.keys(data.question_index).length || !data.stem_index) throw new Error('题库格式错误');
  }
  get size(): number { return Object.keys(this.data.question_index).length; }
  lookup(q: Question, course?: string, work?: string): BankAnswer | undefined {
    if (this.data.question_index[q.id]) return this.data.question_index[q.id];
    const bare = q.stem.normalize('NFKC').trim().toLowerCase()
      .replace(new RegExp(`^(?:【|\\[)?(${labels.join('|')})(?:】|\\])?\\s*[:：]?\\s*`), '');
    for (const key of [normalizeStem(q.stem), normalizeStem(bare), ...labels.map((label) => normalizeStem(label + bare))]) {
      const candidates = (this.data.stem_index[key] ?? []).map((id) => this.data.question_index[id]).filter(Boolean);
      const match = candidates.find((a) => (!course || a.course_id === course) && (!work || a.work_id === work));
      if (match) return match;
      // Never resolve conflicting answers arbitrarily when ids changed.
      if (candidates.length && candidates.every((a) => a.answer === candidates[0].answer)) return candidates[0];
    }
    return;
  }
}

export function questionType(raw: string | null): number | undefined {
  const value = raw?.trim().replace(/^[【\[]|[】\]]$/g, '') ?? '';
  if (/^\d+$/.test(value)) return Number(value);
  const codes: Record<string, number> = { 单选题: 0, 单选: 0, 单项选择: 0, 多选题: 1, 多选: 1, 多项选择: 1, 填空题: 2, 填空: 2, 判断题: 3, 判断: 3, 简答题: 4, 简答: 4, 问答: 4, 名词解释: 5, 论述题: 6, 计算题: 7, 其它: 8, 其他: 8, 分录题: 9, 资料题: 10, 连线题: 11, 排序题: 13, 完型填空: 14, 完形填空: 14, 阅读理解: 15, 口语题: 18, 听力题: 19, 共用选项题: 20, 测评题: 21 };
  return codes[value];
}

const truth = (raw: string): boolean | undefined => {
  const value = raw.trim().toLowerCase();
  if (['true', '对', '正确', '是', '√', '1', 'yes', 'right'].includes(value)) return true;
  if (['false', '错', '错误', '否', '×', '0', 'no', 'wrong'].includes(value)) return false;
  return;
};

export function encodeAnswer(q: Question, a: BankAnswer, typeOverride?: number): URLSearchParams {
  const type = typeOverride ?? questionType(q.question_type) ?? questionType(a.question_type);
  if (type === undefined) throw new Error(`题目 ${q.id} 的题型不受支持`);
  const fields = new URLSearchParams({ [`answertype${q.id}`]: String(type) });
  const labels = (a.answer_labels?.length ? a.answer_labels : (a.answer.toUpperCase().match(/[A-Z]/g) ?? [])).map((v) => v.trim().toUpperCase());
  if (type === 0 || type === 1) {
    if (!labels.length || labels.some((v) => !/^[A-Z]$/.test(v))) throw new Error(`题目 ${q.id} 缺少选项答案`);
    if (type === 0 && labels.length !== 1) throw new Error(`题目 ${q.id} 单选答案不唯一`);
    fields.set(`answer${q.id}`, type === 0 ? labels[0] : [...new Set(labels)].sort().join(''));
  } else if (type === 2 || type === 14) {
    const blanks = (a.answer_blanks?.length ? a.answer_blanks : a.answer.split(/[；;]/)).map((v) => v.trim());
    if (!blanks.length || blanks.some((v) => !v)) throw new Error(`题目 ${q.id} 缺少填空答案`);
    fields.set(`tiankongsize${q.id}`, String(blanks.length));
    blanks.forEach((blank, i) => { fields.set(`answer${q.id}${i + 1}`, blank); fields.set(`answerEditor${q.id}${i + 1}`, blank); });
  } else if (type === 3) {
    const candidates = [a.answer_text, ...(a.answer_labels ?? []), a.answer, ...(a.answer_blanks ?? [])].filter(Boolean);
    let value = candidates.map(truth).find((v) => v !== undefined);
    const options = q.options.length ? q.options : a.options ?? [];
    if (value === undefined) for (const candidate of candidates) {
      value = truth(options.find((o) => o.label.toUpperCase() === candidate.toUpperCase())?.text ?? '');
      if (value !== undefined) break;
    }
    if (value === undefined) value = candidates.includes('A') ? true : candidates.includes('B') ? false : undefined;
    if (value === undefined) throw new Error(`题目 ${q.id} 缺少判断答案`);
    fields.set(`answer${q.id}`, String(value));
  } else {
    const value = (a.answer_text || a.answer).trim();
    if (!value) throw new Error(`题目 ${q.id} 答案为空`);
    fields.set(`answer${q.id}`, value);
    if (type >= 4 && type <= 10) fields.set(`answerEditor${q.id}`, value);
  }
  return fields;
}
