import type { Question } from '../types.ts';
import type { WorkContext, WorkPage } from './client.ts';
import { endpoint, SmartCourseClient } from './client.ts';
import { AnswerBank, encodeAnswer } from './answers.ts';
import { documentOf, hidden, questionId } from './parse.ts';
import { PLATFORM } from './transport.ts';

const perQuestion = /^(?:answer|answerEditor|answertype|tiankongsize|score|type)\d+$/;
const baseFields = ['pyFlag', 'courseId', 'classId', 'api', 'workAnswerId', 'totalQuestionNum', 'fullScore', 'knowledgeid', 'oldSchoolId', 'oldWorkId', 'jobid', 'workRelationId', 'enc_work', 'userId', 'workTimesEnc', 'answerwqbid'];

export function assertComplete(page: WorkPage): void {
  if (page.status === 'graded') throw new Error('作业已批改，跳过提交');
  if (!page.questions.length || page.questions.some((q) => !q.id)) throw new Error('没有抓到完整题目 ID，跳过提交');
  const ids = new Set(page.questions.map((q) => q.id));
  if (ids.size !== page.questions.length) throw new Error('页面包含重复题号');
  const doc = documentOf(page.html);
  const total = hidden(doc, 'totalQuestionNum');
  if (total && /^\d+$/.test(total) && Number(total) !== ids.size) throw new Error('题目数量不完整，跳过提交');
  const rendered = new Set([...doc.querySelectorAll('div.singleQuesId, div.TiMu')].map(questionId).filter(Boolean));
  if (rendered.size && (rendered.size !== ids.size || [...rendered].some((id) => !ids.has(id)))) throw new Error('页面题目与解析结果不一致，跳过提交');
}

export function prepareSubmission(ctx: WorkContext, page: WorkPage, bank: AnswerBank): { url: string; fields: URLSearchParams } {
  assertComplete(page);
  const doc = documentOf(page.html);
  const form = doc.querySelector<HTMLFormElement>('form#form1') ?? [...doc.querySelectorAll('form')].find((f) => f.querySelector('[name="workAnswerId"]'));
  // Require the current tokenized action. Do not invent a fallback URL on the website.
  if (!form?.getAttribute('action')) throw new Error('作业页面缺少提交表单');
  const action = new URL(form.getAttribute('action')!, page.url);
  if (action.origin !== PLATFORM || action.pathname !== '/mooc-ans/work/addStudentWorkNewWeb') throw new Error('作业表单目标不受支持');
  const fields = new URLSearchParams();
  const values = new Map<string, string>();
  for (const input of doc.querySelectorAll<HTMLInputElement>('input')) {
    const key = input.name || input.id;
    if (perQuestion.test(key)) continue;
    if (input.type !== 'hidden' && !baseFields.includes(key)) continue;
    for (const alias of [input.id, input.name].filter(Boolean)) if (!values.get(alias)) values.set(alias, input.value);
    if (input.name) fields.set(input.name, input.value);
  }
  for (const key of ['workAnswerId', 'enc_work']) if (!values.get(key)) throw new Error(`作业缺少 ${key}，请刷新后重试`);
  const { course: c, knowledge, point: p, card } = ctx;
  const canonical: Record<string, string> = {
    pyFlag: values.get('pyFlag') ?? '', courseId: c.course_id, classId: c.class_id, api: values.get('api') || '1',
    workAnswerId: values.get('workAnswerId')!, totalQuestionNum: values.get('totalQuestionNum') || String(page.questions.length),
    fullScore: values.get('fullScore') ?? '', knowledgeid: knowledge, oldSchoolId: values.get('oldSchoolId') ?? '', oldWorkId: p.work_id!,
    jobid: p.job_id ?? `work-${p.work_id}`, workRelationId: values.get('workRelationId') ?? '', enc_work: values.get('enc_work')!,
    userId: card.playback?.user_id ?? values.get('userId') ?? '', workTimesEnc: values.get('workTimesEnc') ?? '',
    answerwqbid: page.questions.map((q) => q.id).join(',') + ',',
  };
  Object.entries(canonical).forEach(([key, value]) => fields.set(key, value));
  for (const q of page.questions) {
    const answer = bank.lookup(q, c.course_id, p.work_id!);
    if (!answer) throw new Error(`题库缺少题目 ${q.id}，整份作业跳过`);
    const type = hidden(doc, `answertype${q.id}`);
    encodeAnswer(q, answer, type !== null && /^\d+$/.test(type) ? Number(type) : undefined).forEach((v, k) => fields.set(k, v));
  }
  // Keep the encrypted query intact; only replace the page helper's own version fields.
  const version = Number(action.searchParams.get('version') ?? 0) + 1;
  const preserved = action.search.slice(1).split('&').filter((part) => !/^(version|ua|formType|saveStatus|pos)=/.test(part));
  action.search = preserved.filter(Boolean).join('&') + `&ua=pc&formType=${encodeURIComponent(form.method.toLowerCase() || 'post')}&saveStatus=1&pos=&version=${version}`;
  return { url: action.href, fields };
}

export function parseSubmitReply(body: string): { success: boolean; message: string } {
  if (/passport|请先登录|用户登录|not logged in/i.test(body)) throw new Error('提交时登录已失效');
  try {
    const data = JSON.parse(body);
    const status = data.status ?? data.success;
    const message = String(data.msg ?? data.message ?? '平台未返回提交结果');
    return { success: status === true || status === 1 || status === 'true' || status === '1' || status === 'success' || (status === undefined && message.includes('成功')), message };
  } catch (error) {
    if (error instanceof SyntaxError) return { success: body.trim() === 'success' || body.trim() === '提交成功', message: '平台未返回标准 JSON，请回到学校页面确认' };
    throw error;
  }
}

export function checkAnswers(questions: Question[], bank: AnswerBank, course: string, work: string): void {
  if (!questions.length) throw new Error('题目为空');
  for (const question of questions) {
    const answer = bank.lookup(question, course, work);
    if (!answer) throw new Error(`题库缺少题目 ${question.id}`);
    encodeAnswer(question, answer);
  }
}

export async function submitWork(client: SmartCourseClient, ctx: WorkContext, bank: AnswerBank, signal: AbortSignal, dryRun: boolean): Promise<string> {
  // Fetch again even though planning already crawled the course. Tokens belong to this page.
  const page = await client.workPage(ctx, signal);
  const request = prepareSubmission(ctx, page, bank);
  if (dryRun) return '试运行：已校验完整题目、答案与新提交表单，未发送提交';
  const validation = await client.text(endpoint('/mooc-ans/work/validate', { classId: ctx.course.class_id, courseId: ctx.course.course_id, knowledgeId: ctx.knowledge, cpi: ctx.course.cpi }), signal, page.url);
  const status = Number(JSON.parse(validation.body).status);
  if (status !== 3) throw new Error(status === 2 ? '平台要求验证码，请到学校页面处理' : '平台未通过提交前校验');
  signal.throwIfAborted();
  const reply = parseSubmitReply(await client.post(request.url, request.fields, page.url, signal));
  if (!reply.success) throw new Error(reply.message);
  return reply.message;
}
