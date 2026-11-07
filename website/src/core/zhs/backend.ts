// Browser backend for the Zhihuishu (知到) platform. Mirrors `core/backend.ts`
// for SmartCourse: a single running job, progress events over the local bus, and
// all network access behind the bridge transport. The static site never reads a
// Zhihuishu cookie; the popup keeps them.
import { demoEmit } from '../../bus.ts';
import { decodeCourseRef, ZhsClient } from './client.ts';
import { runMeetWatch } from './meet.ts';
import { ZhsBridgeTransport } from './transport.ts';
import type {
  ZhsBackend,
  ZhsCourse,
  ZhsCourseDetail,
  ZhsJobProgress,
  ZhsMeet,
  ZhsMeetProgress,
  ZhsMeetWatchOptions,
  ZhsMeetWatchRequest,
  ZhsMeetWatchSummary,
  ZhsSessionInfo,
  ZhsWatchRequest,
  ZhsWatchSummary,
} from './types.ts';
import { courseLabel, defaultMeetWatchOptions, defaultWatchOptions } from './types.ts';
import { planVideoTargets, runVideoWatch, summarizeVideoOutcomes } from './watch.ts';

const bridge = new ZhsBridgeTransport();
const client = new ZhsClient(bridge, {
  warn: (message) => console.warn(message),
});
let session: ZhsSessionInfo | null = null;
let courses: ZhsCourse[] = [];
let active: AbortController | null = null;

const emit = (event: ZhsJobProgress) => demoEmit('zhs-progress', event);
const message = (error: unknown) => (error instanceof Error ? error.message : '请求失败');

function requireSession(): ZhsSessionInfo {
  if (!session) throw new Error('请先连接知到页面');
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

function findCourse(ref: string): ZhsCourse | undefined {
  const local = courses.find(
    (course) => String(course.course_id) === ref || String(course.recruit_id) === ref || course.name === ref,
  );
  if (local) return local;
  const decoded = decodeCourseRef(ref, courses);
  if (decoded.recruit_id !== null && decoded.course_id !== null) {
    const byId = courses.find((course) => course.recruit_id === decoded.recruit_id);
    if (byId) return byId;
  }
  if (decoded.course_id !== null) {
    return courses.find((course) => course.course_id === decoded.course_id);
  }
  return undefined;
}

async function selectCourse(ref: string, signal?: AbortSignal): Promise<ZhsCourse> {
  requireSession();
  const local = findCourse(ref);
  if (local) return local;
  const resolved = await client.resolveCourse(ref, courses, signal);
  courses = [...courses.filter((course) => course.recruit_id !== resolved.recruit_id), resolved];
  return resolved;
}

function coverage(request: number | undefined, fallback: number): number {
  const value = request === undefined ? fallback : request;
  return Math.min(1, Math.max(0, value > 1 ? value / 100 : value));
}

async function watch(request: ZhsWatchRequest, signal: AbortSignal): Promise<ZhsWatchSummary> {
  const course = await selectCourse(request.course, signal);
  emit({ kind: 'zhs-crawl', done: 0, total: 1, label: '抓取视频树' });
  const detail = await client.courseDetail(course, signal);
  const options = defaultWatchOptions({
    dry_run: request.dryRun !== false,
    include_completed: request.includeCompleted === true,
    max_videos: request.maxVideos ?? null,
    verify: request.verify !== false,
  });
  if (!options.dry_run && !client.uuid) {
    throw new Error('知到会话缺少 uuid，请重新连接知到');
  }
  const plan = planVideoTargets(detail, options);
  emit({
    kind: 'zhs-plan',
    stage: 'videos',
    total: plan.length,
    dryRun: options.dry_run,
    skipped: plan.filter((target) => target.completed && !options.include_completed).length,
  });
  const outcomes = await runVideoWatch(client, detail, options, signal, {
    progress: (progress) => emit({
      kind: 'zhs-crawl',
      done: progress.done,
      total: progress.total,
      label: progress.label,
    }),
    outcome: (outcome, index, total) => emit({
      kind: 'zhs-video',
      index: index + 1,
      total,
      label: outcome.label,
      status: outcome.state === 'ok'
        ? 'ok'
        : outcome.state === 'skip'
          ? 'skip'
          : outcome.state === 'dry_run'
            ? 'dry_run'
            : outcome.state === 'circuit_broken'
              ? 'failed'
              : 'failed',
      message: outcome.message,
    }),
  });
  const summary = summarizeVideoOutcomes(outcomes);
  return {
    total: plan.length,
    ok: summary.ok,
    skipped: summary.skipped,
    failed: summary.failed,
    cancelled: summary.cancelled || signal.aborted,
    dryRun: options.dry_run,
    outcomes,
    errors: outcomes.filter((outcome) => outcome.state === 'failed' || outcome.state === 'circuit_broken')
      .map((outcome) => `${outcome.label}：${outcome.message}`),
  };
}

async function meetWatch(request: ZhsMeetWatchRequest, signal: AbortSignal): Promise<ZhsMeetWatchSummary> {
  const course = await selectCourse(request.course, signal);
  const userId = client.userId;
  if (!userId) throw new Error('知到会话缺少 userId，请重新连接知到');
  emit({ kind: 'zhs-crawl', done: 0, total: 1, label: '抓取见面课列表' });
  const all = await client.meetList(course, signal);
  const replayable = all.filter((meet) => meet.live_id !== 0);
  const selected = request.meet
    ? replayable.filter((meet) => meet.meet_course_id === request.meet)
    : replayable;
  const options: ZhsMeetWatchOptions = defaultMeetWatchOptions({
    dry_run: request.dryRun !== false,
    coverage_min: coverage(request.coverageMin, 0.9),
    coverage_max: coverage(request.coverageMax, 1),
    delay_min_ms: Math.max(0, request.delayMinMs ?? 2000),
    delay_max_ms: Math.max(0, request.delayMaxMs ?? 6000),
    circuit_breaker: request.circuitBreaker !== false,
    check_every: Math.max(1, request.checkEvery ?? 10),
  });
  emit({ kind: 'zhs-plan', stage: 'meet', total: selected.length, dryRun: options.dry_run, skipped: all.length - selected.length });

  const summary: ZhsMeetWatchSummary = {
    meets: selected.length,
    submitted: 0,
    skipped: 0,
    failed: 0,
    cancelled: false,
    dryRun: options.dry_run,
    outcomes: [],
    errors: [],
  };
  const indexByMeet = new Map(selected.map((meet, index) => [meet.meet_course_id, index]));

  for (const meet of selected) {
    if (signal.aborted) {
      summary.cancelled = true;
      break;
    }
    const index = indexByMeet.get(meet.meet_course_id) ?? 0;
    emit({
      kind: 'zhs-meet',
      index: index + 1,
      total: selected.length,
      label: meet.name || `见面课 ${meet.live_id}`,
      targetMinutes: 0,
      watchedBefore: 0,
      status: 'running',
      message: '读取进度',
    });
    try {
      const outcome = await runMeetWatch(client, course, meet, options, userId, signal, {
        progress: (progress) => {
          if (progress.stage === 'circuit_check') {
            emit({ kind: 'zhs-circuit', label: progress.label, message: progress.message });
          }
        },
        onMinute: (event) => emit({
          kind: 'zhs-minute',
          index: event.index + 1,
          total: event.total,
          label: meet.name || `见面课 ${meet.live_id}`,
          minute: event.minute,
          status: event.status,
          message: event.message,
        }),
      });
      summary.outcomes.push(outcome);
      if (outcome.state === 'ok') summary.submitted += 1;
      else if (outcome.state === 'skip' || outcome.state === 'dry_run') summary.skipped += 1;
      else if (outcome.state === 'cancelled') summary.cancelled = true;
      else summary.failed += 1;
      if (outcome.state === 'failed' || outcome.state === 'circuit_broken') {
        summary.errors.push(`${outcome.label}：${outcome.message}`);
      }
      emit({
        kind: 'zhs-meet',
        index: index + 1,
        total: selected.length,
        label: outcome.label,
        targetMinutes: outcome.target_minutes,
        watchedBefore: outcome.watched_before,
        status: outcome.state === 'ok'
          ? 'ok'
          : outcome.state === 'skip'
            ? 'skip'
            : outcome.state === 'dry_run'
              ? 'dry_run'
              : 'failed',
        message: outcome.message,
      });
      if (signal.aborted) {
        summary.cancelled = true;
        break;
      }
    } catch (error) {
      if (signal.aborted) {
        summary.cancelled = true;
        break;
      }
      const text = message(error);
      summary.failed += 1;
      summary.errors.push(`${meet.name || meet.live_id}：${text}`);
      emit({
        kind: 'zhs-meet',
        index: index + 1,
        total: selected.length,
        label: meet.name || `见面课 ${meet.live_id}`,
        targetMinutes: 0,
        watchedBefore: 0,
        status: 'failed',
        message: text,
      });
    }
  }
  return summary;
}

/** Browser implementation of the Zhihuishu backend. */
export const zhsBrowserApi: ZhsBackend = {
  async connect(): Promise<ZhsSessionInfo> {
    const identity = await bridge.connect();
    client.setIdentity(identity);
    let user = null;
    try {
      user = await client.loginUser();
    } catch (error) {
      // Course list and course pages still reachable; surfacing the login failure
      // here would block users whose portal page cannot call studyservice-api.
      console.warn('getLoginUserInfo failed', message(error));
    }
    if (user) {
      if (user.is_teacher) {
        bridge.disconnect();
        throw new Error('知到教师账号不支持秒刷；请使用学生账号。');
      }
      client.setUser(user);
    }
    session = {
      user_id: user?.user_id ?? identity.user_id,
      uuid: user?.uuid || identity.uuid,
      real_name: user?.real_name ?? '',
      source: '知到桥接（Cookie 留在知到）',
    };
    demoEmit('zhs-session-changed', session);
    return session;
  },

  async sessionInfo(): Promise<ZhsSessionInfo | null> {
    return session;
  },

  async disconnect(): Promise<void> {
    active?.abort();
    bridge.disconnect();
    client.clearKeys();
    session = null;
    courses = [];
  },

  async listCourses(): Promise<ZhsCourse[]> {
    requireSession();
    courses = await client.listCourses();
    return [...courses];
  },

  async resolveCourse(ref: string): Promise<ZhsCourse> {
    const course = await selectCourse(ref);
    return course;
  },

  async courseDetail(courseRef: string): Promise<ZhsCourseDetail> {
    requireSession();
    const course = await selectCourse(courseRef);
    emit({ kind: 'zhs-crawl', done: 0, total: 1, label: courseLabel(course) });
    const detail = await client.courseDetail(course);
    courses = [...courses.filter((item) => item.recruit_id !== course.recruit_id), detail.course];
    return detail;
  },

  watchVideos(request: ZhsWatchRequest): Promise<ZhsWatchSummary> {
    return job((signal) => watch(request, signal));
  },

  async meetList(courseRef: string): Promise<ZhsMeet[]> {
    requireSession();
    const course = await selectCourse(courseRef);
    return client.meetList(course);
  },

  async meetProgress(courseRef: string, meetId: number): Promise<ZhsMeetProgress> {
    requireSession();
    const userId = client.userId;
    if (!userId) throw new Error('知到会话缺少 userId，请重新连接知到');
    const course = await selectCourse(courseRef);
    const meets = await client.meetList(course);
    const meet = meets.find((item) => item.meet_course_id === meetId);
    if (!meet) throw new Error('没有找到该见面课');
    return client.meetProgress(meet, userId);
  },

  meetWatch(request: ZhsMeetWatchRequest): Promise<ZhsMeetWatchSummary> {
    return job((signal) => meetWatch(request, signal));
  },

  async cancelJob(): Promise<void> {
    active?.abort();
  },
};
