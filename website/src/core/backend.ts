import type { Backend } from '../api.ts';
import { demoEmit } from '../bus.ts';
import { downloadText } from '../platform.ts';
import type { CourseDetail, CourseSummary, JobProgress, QuizSummary, SessionInfo, WatchSummary } from '../types.ts';
import { AnswerBank, type BankData } from './answers.ts';
import { SmartCourseClient, type WorkContext } from './client.ts';
import { allChapters } from './parse.ts';
import { pause, reportUrl, videoTargets, watchTarget } from './playback.ts';
import { checkAnswers, submitWork } from './submit.ts';
import { BridgeTransport } from './transport.ts';

const bridge = new BridgeTransport();
const emit = (event: JobProgress) => demoEmit('job-progress', event);
const client = new SmartCourseClient(bridge, emit);
let session: SessionInfo | null = null;
let courses: CourseSummary[] = [];
let active: AbortController | null = null;
let bankPromise: Promise<AnswerBank> | null = null;
const bank = (): Promise<AnswerBank> => bankPromise ??= fetch(`${import.meta.env.BASE_URL}answer-bank.json`)
  .then(async (response) => {
    if (!response.ok) throw new Error('无法加载内置题库');
    return new AnswerBank(await response.json() as BankData);
  }).catch((error) => { bankPromise = null; throw error; });
const selected = (id: string): CourseSummary => {
  const course = courses.find((c) => c.course_id === id || c.class_id === id || c.name === id);
  if (!session || !course) throw new Error('请先连接并选择课程');
  return course;
};
async function job<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (active) throw new Error('已有任务运行，请先停止当前任务');
  const controller = new AbortController(); active = controller;
  try { return await run(controller.signal); }
  finally { if (active === controller) active = null; }
}
const message = (error: unknown) => error instanceof Error ? error.message : '请求失败';
function works(course: CourseDetail): (WorkContext & { chapter: string })[] {
  const seen = new Set<string>();
  return allChapters(course.chapters).flatMap((ch) => (ch.cards ?? []).flatMap((card) => card.task_points.flatMap((point) => {
    if (point.kind !== 'work' || !point.work_id || seen.has(point.work_id)) return [];
    seen.add(point.work_id);
    return [{ course, knowledge: ch.id, card, point, chapter: ch.title }];
  })));
}

export const browserApi: Backend = {
  async openLoginWindow() {
    await bridge.connect();
    courses = await client.listCourses();
    session = { cookieSource: '浏览器桥接（Cookie 留在学校）', cookieCount: 0 };
    demoEmit('session-changed', session);
  },
  async sessionInfo() { return session; },
  async disconnect() { active?.abort(); bridge.disconnect(); session = null; courses = []; },
  async listCourses() {
    if (!session) throw new Error('请先连接学校页面');
    courses = await client.listCourses(); return courses;
  },
  fetchCourse(id, options) { return job((signal) => client.fetchCourse(selected(id), options, signal)); },
  async cancelJob() { active?.abort(); },
  async answerBankInfo() { const b = await bank(); return { questions: b.size, version: b.data.version ?? null }; },
  async helperScript() {
    const response = await fetch(`${import.meta.env.BASE_URL}hust-course-video-helper.user.js`);
    if (!response.ok) throw new Error('读取脚本失败');
    return response.text();
  },
  async saveTextFile(path, contents) { downloadText(path, contents); },
  watchCourse(request) {
    return job(async (signal) => {
      const summary: WatchSummary = { total: 0, passed: 0, failed: 0, errors: [], cancelled: false };
      try {
        const detail = await client.fetchCourse(selected(request.course), { includeQuestions: false, includeVideoInfo: true }, signal);
        const targets = videoTargets(detail, request.job, request.includeCompleted).slice(0, request.maxVideos ?? Infinity);
        summary.total = targets.length; summary.errors.push(...detail.stats.errors);
        emit({ kind: 'watchPlan', total: targets.length, dryRun: request.dryRun !== false });
        for (let i = 0; i < targets.length; i++) {
          signal.throwIfAborted();
          const target = targets[i];
          const base = { kind: 'watch' as const, index: i + 1, total: targets.length, label: `${target.chapter} / ${target.point.name}`, jobId: target.point.job_id ?? '' };
          emit({ ...base, status: 'running', message: null });
          try {
            reportUrl(target, target.point.duration_secs ?? target.point.video?.duration_secs ?? 0, 4);
            if (request.dryRun !== false) { emit({ ...base, status: 'dry_run', message: '签名计划已生成，未发送上报' }); continue; }
            const passed = await watchTarget(client, target, Math.max(0, request.stepSecs ?? 0), Math.max(0, request.delayMs ?? 1000), signal);
            if (passed) summary.passed++; else summary.failed++;
            emit({ ...base, status: passed ? 'passed' : 'failed', message: passed ? '服务端 isPassed=true' : '服务端未确认完成' });
          } catch (error) {
            signal.throwIfAborted(); summary.failed++; summary.errors.push(message(error));
            emit({ ...base, status: 'error', message: message(error) });
          }
          await pause(Math.max(0, request.delayMs ?? 1000), signal);
        }
      } catch (error) {
        if (signal.aborted) summary.cancelled = true; else throw error;
      }
      return summary;
    });
  },
  completeQuizzes(request) {
    return job(async (signal) => {
      const b = await bank();
      const summary: QuizSummary = { total: 0, submitted: 0, failed: 0, skipped: 0, cancelled: false, dryRun: request.dryRun !== false, skippedGraded: 0, bankQuestions: b.size, planErrors: [], errors: [], works: [] };
      try {
        const detail = await client.fetchCourse(selected(request.course), { includeQuestions: true, includeVideoInfo: false }, signal);
        summary.planErrors.push(...detail.stats.errors);
        const candidates = works(detail).filter((ctx) => !request.work || ctx.point.work_id === request.work);
        summary.skippedGraded = candidates.filter((ctx) => ctx.point.work_status === 'graded').length;
        const targets = candidates.filter((ctx) => ctx.point.work_status !== 'graded').slice(0, request.maxWorks ?? Infinity);
        const incomplete = targets.filter((ctx) => {
          try { checkAnswers(ctx.point.questions, b, detail.course_id, ctx.point.work_id!); return false; } catch { return true; }
        }).length;
        summary.total = targets.length;
        emit({ kind: 'quizPlan', total: targets.length, skippedGraded: summary.skippedGraded, incomplete, dryRun: summary.dryRun, bankQuestions: b.size });
        for (let i = 0; i < targets.length; i++) {
          signal.throwIfAborted();
          const ctx = targets[i], point = ctx.point;
          const info = { workId: point.work_id!, workName: point.name, chapter: ctx.chapter, questionCount: point.questions.length };
          const progress = { kind: 'quiz' as const, index: i + 1, total: targets.length, ...info };
          try { checkAnswers(point.questions, b, detail.course_id, point.work_id!); }
          catch (error) {
            summary.skipped++; summary.planErrors.push(message(error));
            summary.works.push({ ...info, status: 'skipped', message: message(error) });
            emit({ ...progress, status: 'skipped', message: message(error) }); continue;
          }
          emit({ ...progress, status: 'running', message: null });
          try {
            const result = await submitWork(client, ctx, b, signal, summary.dryRun);
            const status = summary.dryRun ? 'dry_run' as const : 'submitted' as const;
            if (!summary.dryRun) summary.submitted++;
            summary.works.push({ ...info, status, message: result }); emit({ ...progress, status, message: result });
          } catch (error) {
            signal.throwIfAborted(); summary.failed++; summary.errors.push(message(error));
            summary.works.push({ ...info, status: 'failed', message: message(error) }); emit({ ...progress, status: 'failed', message: message(error) });
          }
        }
      } catch (error) {
        if (signal.aborted) summary.cancelled = true; else throw error;
      }
      return summary;
    });
  },
};
