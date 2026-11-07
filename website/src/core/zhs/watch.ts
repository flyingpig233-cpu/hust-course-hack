// Video-course completion executor, aligned with `src/zhihuishu/watch.rs`.
//
// A target is planned from the chapter tree, then executed as:
// `prelearningNote` -> `saveDatabaseIntervalTimeV2` -> optional `queryStuyInfo`
// verification. A dry run never touches the network; repeated failures or a
// locked anti-cheat status stop the batch.
import { RateLimiter, buildVideoReport, sleep, type ZhsPrelearningNote, type ZhsStuyInfoEntry } from './client.ts';
import type {
  ZhsCourse,
  ZhsCourseDetail,
  ZhsExceptionStatus,
  ZhsProgress,
  ZhsVideoTarget,
  ZhsWatchOptions,
  ZhsWatchOutcome,
} from './types.ts';
import { lessonVideos } from './types.ts';

/** Maximum consecutive failures before the batch is aborted. */
export const VIDEO_FAILURE_LIMIT = 3;

/** Minimal client surface used by the executor; keeps the tests offline. */
export interface VideoWatchClient {
  readonly uuid: string;
  prelearningNote(course: ZhsCourse, target: ZhsVideoTarget, signal?: AbortSignal): Promise<ZhsPrelearningNote>;
  reportVideo(course: ZhsCourse, target: ZhsVideoTarget, noteId: number, signal?: AbortSignal): Promise<{ submit_success: boolean }>;
  queryStuyInfo(course: ZhsCourse, targets: ZhsVideoTarget[], signal?: AbortSignal): Promise<Map<number, ZhsStuyInfoEntry>>;
  exceptionStatus(course: ZhsCourse, signal?: AbortSignal): Promise<ZhsExceptionStatus>;
}

/** Flatten the chapter tree into playable video targets. */
export function planVideoTargets(detail: ZhsCourseDetail, options: ZhsWatchOptions): ZhsVideoTarget[] {
  const targets: ZhsVideoTarget[] = [];
  for (const chapter of detail.chapters) {
    for (const lesson of chapter.lessons) {
      for (const video of lessonVideos(lesson)) {
        targets.push({
          recruit_id: detail.course.recruit_id,
          course_id: detail.course.course_id,
          chapter_id: chapter.chapter_id ?? 0,
          lesson_id: lesson.lesson_id,
          lesson_video_id: video.lesson_video_id,
          video_id: video.video_id,
          video_sec: video.video_sec,
          label: `${detail.course.name || detail.course.course_id} / ${chapter.name} / ${lesson.name}`,
          completed: (video.is_studied ?? 0) !== 0,
        });
      }
    }
  }
  const limit = options.max_videos === null ? targets.length : Math.max(0, options.max_videos);
  return targets.slice(0, limit);
}

/** Reason a planned target is skipped, or `null` when it can run. */
export function videoSkipReason(target: ZhsVideoTarget, options: ZhsWatchOptions): string | null {
  if (!target.video_id || !target.lesson_video_id || !target.video_sec) return '视频信息不完整，跳过';
  if (target.completed && !options.include_completed) return '平台已标记完成，跳过';
  return null;
}

export interface VideoWatchHooks {
  progress?: (progress: ZhsProgress) => void;
  /** Called as each target reaches a terminal state, for live interface rows. */
  outcome?: (outcome: ZhsWatchOutcome, index: number, total: number) => void;
  limiter?: RateLimiter;
  /** Delay before the `queryStuyInfo` verification (800 ms in the Rust core). */
  verifyDelayMs?: number;
}

/**
 * Execute one batch of video targets. Returns one outcome per target plus a
 * synthetic `circuit_broken`/`cancelled` outcome when the batch stops early.
 */
export async function runVideoWatch(
  client: VideoWatchClient,
  detail: ZhsCourseDetail,
  options: ZhsWatchOptions,
  signal: AbortSignal,
  hooks: VideoWatchHooks = {},
): Promise<ZhsWatchOutcome[]> {
  const course = detail.course;
  const targets = planVideoTargets(detail, options);
  const limiter = hooks.limiter ?? new RateLimiter(800, 1800);
  const verifyDelayMs = hooks.verifyDelayMs ?? 800;
  const emit = hooks.progress ?? (() => undefined);
  const emitOutcome = hooks.outcome ?? (() => undefined);
  const outcomes: ZhsWatchOutcome[] = [];
  const total = targets.length;
  emit({
    stage: 'videos',
    done: 0,
    total,
    label: course.name,
    message: options.dry_run ? `试运行：将为 ${total} 个视频生成上报字段` : `准备上报 ${total} 个视频`,
  });

  let consecutiveFailures = 0;
  const record = (outcome: ZhsWatchOutcome, index: number): void => {
    outcomes.push(outcome);
    emitOutcome(outcome, index, total);
  };

  for (let index = 0; index < targets.length; index += 1) {
    if (signal.aborted) {
      record({ label: course.name, state: 'cancelled', watch_state: null, message: '已取消' }, index);
      return outcomes;
    }
    const target = targets[index];
    emit({ stage: 'videos', done: index, total, label: target.label, message: '处理中' });
    const skip = videoSkipReason(target, options);
    if (skip) {
      record({ label: target.label, state: 'skip', watch_state: null, message: skip }, index);
      emit({ stage: 'videos', done: index + 1, total, label: target.label, message: skip });
      continue;
    }

    try {
      if (options.dry_run) {
        const preview = buildVideoReport(course, target, 0, client.uuid);
        record({
          label: target.label,
          state: 'dry_run',
          watch_state: null,
          message: `预演：将上报 ${target.video_sec} 秒视频（${preview.ewssw.split(',').length} 个观看点），未发送任何请求`,
        }, index);
        emit({ stage: 'videos', done: index + 1, total, label: target.label, message: '已生成上报字段（未发送）' });
        continue;
      }

      const note = await client.prelearningNote(course, target, signal);
      if (note.watch_state === 1 && !options.include_completed) {
        consecutiveFailures = 0;
        record({ label: target.label, state: 'skip', watch_state: note.watch_state, message: '平台已标记完成，跳过' }, index);
        emit({ stage: 'videos', done: index + 1, total, label: target.label, message: '平台已标记完成，跳过' });
        continue;
      }
      const report = await client.reportVideo(course, target, note.note_id, signal);
      if (!report.submit_success) {
        consecutiveFailures += 1;
        record({ label: target.label, state: 'failed', watch_state: null, message: '服务端未返回 submitSuccess=true' }, index);
        emit({ stage: 'videos', done: index + 1, total, label: target.label, message: '服务端未确认完成' });
      } else {
        let watchState: number | null = note.watch_state;
        let passed = true;
        if (options.verify) {
          if (verifyDelayMs > 0) await sleep(verifyDelayMs, signal);
          emit({ stage: 'verify', done: index + 1, total, label: target.label, message: '复核 watchState' });
          const info = await client.queryStuyInfo(course, [target], signal);
          watchState = info.get(target.lesson_video_id)?.watch_state ?? null;
          passed = watchState === 1;
        }
        consecutiveFailures = passed ? 0 : consecutiveFailures + 1;
        record({
          label: target.label,
          state: passed ? 'ok' : 'failed',
          watch_state: watchState,
          message: passed ? '服务端 watchState=1' : `复核未通过（watchState=${watchState ?? '未知'}）`,
        }, index);
        emit({
          stage: 'videos',
          done: index + 1,
          total,
          label: target.label,
          message: passed ? '服务端确认完成' : '复核未通过',
        });
      }
    } catch (error) {
      if (signal.aborted) {
        record({ label: target.label, state: 'cancelled', watch_state: null, message: '已取消' }, index);
        return outcomes;
      }
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : '请求失败';
      record({ label: target.label, state: 'failed', watch_state: null, message }, index);
      emit({ stage: 'videos', done: index + 1, total, label: target.label, message });
    }

    if (!options.dry_run) {
      let status: ZhsExceptionStatus = { lock: false, abnormal: false, message: '' };
      try {
        status = await client.exceptionStatus(course, signal);
      } catch (error) {
        if (signal.aborted) {
          record({ label: target.label, state: 'cancelled', watch_state: null, message: '用户取消' }, index);
          return outcomes;
        }
      }
      emit({ stage: 'circuit_check', done: index + 1, total, label: target.label, message: status.message || '检查风控状态' });
      if (status.lock || status.abnormal) {
        const last = outcomes.at(-1);
        if (last) {
          last.state = 'circuit_broken';
          last.message = `${last.message}；检测到风控异常，已中止整批：${status.message || '账号被限制'}`;
        }
        return outcomes;
      }
    }

    if (consecutiveFailures >= VIDEO_FAILURE_LIMIT) {
      const last = outcomes.at(-1);
      if (last) {
        last.state = 'circuit_broken';
        last.message = `${last.message}；连续失败过多，已中止整批`;
      }
      return outcomes;
    }
    if (index + 1 < targets.length) {
      try {
        await limiter.wait(signal);
      } catch {
        record({ label: course.name, state: 'cancelled', watch_state: null, message: '已取消' }, index);
        return outcomes;
      }
    }
  }

  return outcomes;
}

/** Map an outcome list to the compact summary counters used by the interface. */
export function summarizeVideoOutcomes(outcomes: ZhsWatchOutcome[]): {
  ok: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  circuitBroken: boolean;
} {
  return {
    ok: outcomes.filter((outcome) => outcome.state === 'ok').length,
    skipped: outcomes.filter((outcome) => outcome.state === 'skip' || outcome.state === 'dry_run').length,
    failed: outcomes.filter((outcome) => outcome.state === 'failed').length,
    cancelled: outcomes.some((outcome) => outcome.state === 'cancelled'),
    circuitBroken: outcomes.some((outcome) => outcome.state === 'circuit_broken'),
  };
}
