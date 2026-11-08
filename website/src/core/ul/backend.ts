// Browser backend for Ulearning (优学院). Mirrors `core/backend.ts`: one running
// job at a time, progress on the local bus, all network through the bridge.
import { demoEmit } from '../../bus.ts';
import { parseCourseRef, UlearningClient } from './client.ts';
import { UlBridgeTransport } from './transport.ts';
import { planSections, runSectionWatch } from './watch.ts';
import type {
  UlBackend,
  UlCourse,
  UlCourseDetail,
  UlJobProgress,
  UlSectionPlan,
  UlSessionInfo,
  UlWatchRequest,
  UlWatchSummary,
} from './types.ts';
import { defaultUlWatchOptions } from './types.ts';

const bridge = new UlBridgeTransport();
const client = new UlearningClient(bridge, { warn: (message) => console.warn(message) });
let session: UlSessionInfo | null = null;
let courses: UlCourse[] = [];
let active: AbortController | null = null;

const emit = (event: UlJobProgress) => demoEmit('ul-progress', event);
const message = (error: unknown) => (error instanceof Error ? error.message : '请求失败');

function requireSession(): UlSessionInfo {
  if (!session) throw new Error('请先连接优学院页面');
  return session;
}

async function job<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (active) throw new Error('已有任务运行，请先停止当前任务');
  const controller = new AbortController();
  active = controller;
  try {
    return await run(controller.signal);
  } finally {
    if (active === controller) active = null;
  }
}

function findCourse(ref: string): UlCourse | undefined {
  return courses.find(
    (course) => String(course.textbook_id) === ref || course.name === ref,
  );
}

async function resolve(ref: string, signal?: AbortSignal): Promise<UlCourse> {
  requireSession();
  const known = findCourse(ref);
  if (known && !ref.startsWith('http')) return known;
  const parsed = parseCourseRef(ref) ?? (known ? {
    textbook_id: known.textbook_id,
    class_id: known.class_id,
    oc_id: known.oc_id,
    chapter_id: null,
  } : null);
  if (!parsed) throw new Error('无法解析优学院课程，请粘贴播放器链接（含 courseId/classId）。');
  if (parsed.class_id === null) {
    const cached = courses.find((course) => course.textbook_id === parsed.textbook_id);
    if (cached) return cached;
    throw new Error('缺少 classId：请粘贴完整播放器链接，或按「textbookId classId」格式填写。');
  }
  let basic: { name: string; teacher: string; locale: string | null; oc_id: number | null } | null = null;
  try {
    basic = await client.basicInformation(parsed.textbook_id, signal);
  } catch (error) {
    signal?.throwIfAborted();
    console.warn('优学院课程信息读取失败', message(error));
  }
  const course: UlCourse = {
    textbook_id: parsed.textbook_id,
    class_id: parsed.class_id,
    oc_id: parsed.oc_id ?? basic?.oc_id ?? null,
    name: basic?.name ?? '',
    teacher: basic?.teacher ?? '',
    locale: basic?.locale ?? null,
    expired: null,
  };
  courses = [...courses.filter((item) => item.textbook_id !== course.textbook_id), course];
  return course;
}

function countQuizzes(plan: UlSectionPlan): number {
  return plan.pages.filter((page) => page.questions.length > 0).length;
}

async function watch(request: UlWatchRequest, signal: AbortSignal): Promise<UlWatchSummary> {
  const course = await resolve(request.course, signal);
  const options = defaultUlWatchOptions({
    dry_run: request.dryRun !== false,
    include_quizzes: request.includeQuizzes === true,
    max_sections: request.maxSections ?? null,
    delay_min_ms: Math.max(0, request.delayMinMs ?? 3000),
    delay_max_ms: Math.max(0, request.delayMaxMs ?? 5000),
    verify: request.verify !== false,
    stop_on_error: request.stopOnError !== false,
  });
  emit({ kind: 'ul-crawl', done: 0, total: 1, label: course.name || String(course.textbook_id) });
  const detail = await client.courseDetail(course, signal);
  const plans = await planSections(client, detail, options, signal, {
    progress: (progress) => emit({ kind: 'ul-crawl', done: progress.done, total: progress.total, label: progress.label }),
  });
  const complete = plans.filter((plan) => plan.action === 'complete');
  emit({
    kind: 'ul-plan',
    total: complete.length,
    videos: complete.reduce((sum, plan) => sum + plan.pages.reduce((total, page) => total + page.videos.length, 0), 0),
    quizzes: complete.reduce((sum, plan) => sum + countQuizzes(plan), 0),
    skippedDone: plans.filter((plan) => plan.action === 'skip_done').length,
    dryRun: options.dry_run,
  });
  const outcomes = await runSectionWatch(client, plans, options, signal, {
    outcome: (outcome, index, total) => {
      const status = outcome.state === 'ok'
        ? 'ok'
        : outcome.state === 'dry_run'
          ? 'dry_run'
          : outcome.state === 'failed' || outcome.state === 'circuit_broken'
            ? 'failed'
            : 'skip';
      emit({
        kind: 'ul-section',
        index: index + 1,
        total,
        label: outcome.label,
        status,
        message: outcome.message,
      });
      if (outcome.state === 'circuit_broken') {
        emit({ kind: 'ul-circuit', label: outcome.label, message: outcome.message });
      }
    },
  });
  const summary: UlWatchSummary = {
    total: complete.length,
    ok: outcomes.filter((outcome) => outcome.state === 'ok').length,
    skipped: outcomes.filter((outcome) => outcome.state === 'skip' || outcome.state === 'dry_run').length,
    failed: outcomes.filter((outcome) => outcome.state === 'failed' || outcome.state === 'circuit_broken').length,
    cancelled: signal.aborted || outcomes.some((outcome) => outcome.state === 'cancelled'),
    dryRun: options.dry_run,
    outcomes,
    errors: outcomes
      .filter((outcome) => outcome.state === 'failed' || outcome.state === 'circuit_broken')
      .map((outcome) => `${outcome.label}：${outcome.message}`),
  };
  return summary;
}

/** Browser implementation of the Ulearning backend. */
export const ulBrowserApi: UlBackend = {
  async connect(): Promise<UlSessionInfo> {
    await bridge.connect();
    session = { logged_in: true, source: '优学院桥接（Cookie 留在优学院）' };
    demoEmit('ul-session-changed', session);
    return session;
  },

  async sessionInfo(): Promise<UlSessionInfo | null> {
    return session;
  },

  async disconnect(): Promise<void> {
    active?.abort();
    bridge.disconnect();
    session = null;
    courses = [];
  },

  async listCourses(): Promise<UlCourse[]> {
    requireSession();
    return [...courses];
  },

  async resolveCourse(ref: string): Promise<UlCourse> {
    return resolve(ref);
  },

  async courseDetail(courseRef: string): Promise<UlCourseDetail> {
    requireSession();
    const course = await resolve(courseRef);
    emit({ kind: 'ul-crawl', done: 0, total: 1, label: course.name || String(course.textbook_id) });
    return client.courseDetail(course);
  },

  watchSections(request: UlWatchRequest): Promise<UlWatchSummary> {
    return job((signal) => watch(request, signal));
  },

  async cancelJob(): Promise<void> {
    active?.abort();
  },
};
