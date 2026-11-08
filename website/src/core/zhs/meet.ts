// Meet-course replay attendance executor, aligned with `src/zhihuishu/meet.rs`.
//
// Target coverage is randomized inside [coverage_min, coverage_max], minutes are
// reported from the first gap in ascending order with random pacing, and every
// `check_every` reports the anti-cheat endpoint. A locked/abnormal status or
// three consecutive failures trips the circuit breaker.
import { RateLimiter, randomInt, sleep } from './client.ts';
import type {
  ZhsCourse,
  ZhsExceptionStatus,
  ZhsMeet,
  ZhsMeetOutcome,
  ZhsMeetProgress,
  ZhsMeetWatchOptions,
  ZhsProgress,
  ZhsWatchState,
} from './types.ts';

/** Consecutive failed minutes before the run is aborted. */
export const MEET_FAILURE_LIMIT = 3;
/** Per-minute retries (in addition to the first attempt). */
export const MEET_RETRY_LIMIT = 2;

/** Minimal client surface used by the executor; keeps the tests offline. */
export interface MeetWatchClient {
  readonly uuid: string;
  meetProgress(meet: ZhsMeet, userId: number, signal?: AbortSignal): Promise<ZhsMeetProgress>;
  reportMeetMinute(
    course: ZhsCourse,
    meet: ZhsMeet,
    minute: number,
    userId: number,
    videoId: number,
    signal?: AbortSignal,
  ): Promise<number | null>;
  meetExceptionStatus(course: ZhsCourse, uuid: string, signal?: AbortSignal): Promise<ZhsExceptionStatus>;
  meetVideoId(meet: ZhsMeet, signal?: AbortSignal): Promise<number>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Randomized coverage target in minutes, clamped to `1..=total` like Rust. */
export function coverageTarget(
  totalMinutes: number,
  coverageMin: number,
  coverageMax: number,
  random: () => number = Math.random,
): number {
  if (totalMinutes <= 0) return 0;
  const low = clamp(coverageMin, 0, 1);
  const high = clamp(coverageMax, low, 1);
  const coverage = high > low ? low + random() * (high - low) : low;
  return Math.min(totalMinutes, Math.max(1, Math.ceil(totalMinutes * coverage)));
}

/** Validate and normalize wait options; invalid windows are rejected. */
export function normalizeMeetWatchOptions(options: ZhsMeetWatchOptions): ZhsMeetWatchOptions {
  if (options.coverage_min < 0 || options.coverage_min > 1 || options.coverage_max < 0 || options.coverage_max > 1) {
    throw new Error('覆盖率必须在 0 到 1 之间（例如 0.90-1.00）');
  }
  if (options.coverage_min > options.coverage_max) throw new Error('覆盖率下限不能大于上限');
  if (options.delay_min_ms > options.delay_max_ms) throw new Error('最小间隔不能大于最大间隔');
  if (options.check_every <= 0) throw new Error('风控检查间隔必须大于 0');
  const coverageMin = Math.max(0.01, options.coverage_min);
  return {
    ...options,
    coverage_min: coverageMin,
    coverage_max: Math.max(options.coverage_max, coverageMin),
  };
}

export interface MeetMinutePlan {
  /** Target number of watched minutes after this run. */
  target: number;
  /** Minutes to report, ascending, excluding already-watched slots. */
  minutes: number[];
  watchedBefore: number;
}

/**
 * Compute which minutes to report. Already-watched minutes are kept, and the
 * remaining gap is filled from the first unwatched minute in order so the final
 * history looks like a continuous replay instead of random jumps.
 */
export function planMeetMinutes(
  progress: ZhsMeetProgress,
  options: Pick<ZhsMeetWatchOptions, 'coverage_min' | 'coverage_max'>,
  random: () => number = Math.random,
): MeetMinutePlan {
  const total = progress.total_minutes;
  const watched = new Set(progress.watched_minutes.filter((minute) => minute >= 1 && minute <= total));
  const target = coverageTarget(total, options.coverage_min, options.coverage_max, random);
  const need = Math.max(0, target - watched.size);
  if (need === 0) return { target, minutes: [], watchedBefore: progress.watched_count };

  const candidates: number[] = [];
  for (let minute = 1; minute <= total; minute += 1) {
    if (!watched.has(minute)) candidates.push(minute);
  }
  if (candidates.length === 0) return { target, minutes: [], watchedBefore: progress.watched_count };

  const selected = candidates.slice(0, Math.min(need, candidates.length));
  const tail = candidates.slice(selected.length);
  // Drop at most ~5% (and never more than half) so the coverage stays random,
  // then refill from the tail — mirrors `plan_meet_minutes` in meet.rs.
  const maxDrop = Math.min(Math.max(1, Math.floor(need / 20)), Math.floor(need / 2));
  if (selected.length > 1 && maxDrop > 0) {
    const dropCount = randomInt(0, maxDrop, random);
    for (let dropped = 0; dropped < dropCount && selected.length > 1; dropped += 1) {
      const index = randomInt(0, selected.length - 1, random);
      selected.splice(index, 1);
    }
  }
  const chosen = new Set(selected);
  for (const minute of tail) {
    if (selected.length >= need) break;
    if (!chosen.has(minute)) {
      selected.push(minute);
      chosen.add(minute);
    }
  }
  selected.sort((left, right) => left - right);
  return { target, minutes: selected, watchedBefore: progress.watched_count };
}

/** Live per-minute event forwarded to the interface log. */
export interface MeetMinuteEvent {
  index: number;
  total: number;
  minute: number;
  status: 'running' | 'ok' | 'failed';
  message: string;
}

export interface MeetWatchHooks {
  progress?: (progress: ZhsProgress) => void;
  /** Called for every minute attempt so the modal can stream rows. */
  onMinute?: (event: MeetMinuteEvent) => void;
  limiter?: RateLimiter;
  random?: () => number;
}

interface OutcomeExtras {
  submitted?: number;
  failed?: number;
  skipped?: number;
  watchedAfter?: number | null;
}

function meetOutcome(
  meet: ZhsMeet,
  plan: MeetMinutePlan,
  state: ZhsWatchState,
  message: string,
  extras: OutcomeExtras = {},
): ZhsMeetOutcome {
  return {
    label: meet.name || `见面课 ${meet.live_id}`,
    target_minutes: plan.target,
    watched_before: plan.watchedBefore,
    submitted: extras.submitted ?? 0,
    skipped: extras.skipped ?? 0,
    failed: extras.failed ?? 0,
    watched_after: extras.watchedAfter ?? null,
    state,
    message,
  };
}

/** Execute one meet replay completion run. */
export async function runMeetWatch(
  client: MeetWatchClient,
  course: ZhsCourse,
  meet: ZhsMeet,
  options: ZhsMeetWatchOptions,
  userId: number,
  signal: AbortSignal,
  hooks: MeetWatchHooks = {},
): Promise<ZhsMeetOutcome> {
  const normalized = normalizeMeetWatchOptions(options);
  const emit = hooks.progress ?? (() => undefined);
  const onMinute = hooks.onMinute ?? (() => undefined);
  const limiter = hooks.limiter ?? new RateLimiter(normalized.delay_min_ms, normalized.delay_max_ms);
  const random = hooks.random ?? Math.random;
  const label = meet.name || `见面课 ${meet.live_id}`;
  const emptyPlan: MeetMinutePlan = { target: 0, minutes: [], watchedBefore: 0 };

  emit({ stage: 'meet_minutes', done: 0, total: 0, label, message: '读取回放进度' });
  let progress: ZhsMeetProgress;
  try {
    progress = await client.meetProgress(meet, userId, signal);
  } catch (error) {
    if (signal.aborted) return meetOutcome(meet, emptyPlan, 'cancelled', '已取消');
    return meetOutcome(meet, emptyPlan, 'failed', error instanceof Error ? error.message : '读取回放进度失败');
  }

  const plan = planMeetMinutes(progress, normalized, random);
  if (plan.minutes.length === 0) {
    const message = `已看 ${plan.watchedBefore}/${progress.total_minutes} 分钟，达到目标 ${plan.target} 分钟，跳过`;
    emit({ stage: 'meet_minutes', done: 0, total: 0, label, message });
    return meetOutcome(meet, plan, 'skip', message, { watchedAfter: plan.watchedBefore });
  }

  emit({
    stage: 'meet_minutes',
    done: 0,
    total: plan.minutes.length,
    label,
    message: `目标 ${plan.target}/${progress.total_minutes} 分钟（${Math.round((plan.target / progress.total_minutes) * 100)}%）`,
  });

  if (normalized.dry_run) {
    return meetOutcome(
      meet,
      plan,
      'dry_run',
      `预演：已看 ${plan.watchedBefore} 分钟，目标 ${plan.target} 分钟，将补报 ${plan.minutes.length} 分钟（未发送请求）`,
    );
  }

  let videoId: number;
  try {
    videoId = await client.meetVideoId(meet, signal);
  } catch (error) {
    if (signal.aborted) return meetOutcome(meet, plan, 'cancelled', '已取消');
    return meetOutcome(meet, plan, 'failed', error instanceof Error ? error.message : '缺少回放 videoId');
  }

  let submitted = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  for (let index = 0; index < plan.minutes.length; index += 1) {
    if (signal.aborted) {
      return meetOutcome(meet, plan, 'cancelled', `已取消：本次成功 ${submitted} 条`, { submitted, failed });
    }
    const minute = plan.minutes[index];
    emit({ stage: 'meet_minutes', done: index, total: plan.minutes.length, label, message: `上报第 ${minute} 分钟` });
    onMinute({ index, total: plan.minutes.length, minute, status: 'running', message: '上报中' });

    let reported = false;
    for (let attempt = 0; attempt <= MEET_RETRY_LIMIT; attempt += 1) {
      try {
        await client.reportMeetMinute(course, meet, minute, userId, videoId, signal);
        reported = true;
        break;
      } catch (error) {
        if (signal.aborted) {
          return meetOutcome(meet, plan, 'cancelled', `已取消：本次成功 ${submitted} 条`, { submitted, failed });
        }
        if (attempt < MEET_RETRY_LIMIT) {
          await sleep(300 * 2 ** attempt, signal).catch(() => undefined);
          continue;
        }
        emit({
          stage: 'meet_minutes',
          done: index + 1,
          total: plan.minutes.length,
          label,
          message: `第 ${minute} 分钟上报失败：${error instanceof Error ? error.message : '请求失败'}`,
        });
      }
    }

    if (reported) {
      submitted += 1;
      consecutiveFailures = 0;
    } else {
      failed += 1;
      consecutiveFailures += 1;
    }
    emit({
      stage: 'meet_minutes',
      done: index + 1,
      total: plan.minutes.length,
      label,
      message: reported ? `第 ${minute} 分钟已上报` : `第 ${minute} 分钟失败`,
    });
    onMinute({
      index,
      total: plan.minutes.length,
      minute,
      status: reported ? 'ok' : 'failed',
      message: reported ? '已上报' : '上报失败',
    });

    if (consecutiveFailures >= MEET_FAILURE_LIMIT) {
      return meetOutcome(meet, plan, 'circuit_broken', `连续失败 ${consecutiveFailures} 次，已中止本场回放`, { submitted, failed });
    }

    if (normalized.circuit_breaker && (index + 1) % normalized.check_every === 0) {
      let status: ZhsExceptionStatus = { lock: false, abnormal: false, message: '' };
      try {
        status = await client.meetExceptionStatus(course, client.uuid, signal);
      } catch (error) {
        if (signal.aborted) {
          return meetOutcome(meet, plan, 'cancelled', `已取消：本次成功 ${submitted} 条`, { submitted, failed });
        }
        status = { lock: false, abnormal: false, message: error instanceof Error ? error.message : '风控检查失败' };
      }
      emit({ stage: 'circuit_check', done: index + 1, total: plan.minutes.length, label, message: '检查风控状态' });
      if (status.lock || status.abnormal) {
        const message = status.message || (status.lock ? '账号被限制学习' : '检测到异常学习记录');
        return meetOutcome(meet, plan, 'circuit_broken', `风控熔断：${message}`, { submitted, failed });
      }
    }

    if (index + 1 < plan.minutes.length) {
      try {
        await limiter.wait(signal);
      } catch {
        return meetOutcome(meet, plan, 'cancelled', `已取消：本次成功 ${submitted} 条`, { submitted, failed });
      }
    }
  }

  let watchedAfter: number | null = null;
  try {
    const verified = await client.meetProgress(meet, userId, signal);
    watchedAfter = verified.watched_count;
  } catch {
    watchedAfter = null;
  }
  const state = failed > 0 ? 'failed' : 'ok';
  const reached = watchedAfter === null || watchedAfter >= plan.target;
  const message = failed > 0
    ? `部分分钟上报失败（成功 ${submitted}，失败 ${failed}）`
    : `完成：本次上报 ${submitted} 分钟`;
  return meetOutcome(
    meet,
    plan,
    state,
    `${message}；已看 ${plan.watchedBefore} → ${watchedAfter ?? '未知'}，目标 ${plan.target} 分钟${reached ? '' : '（未达标）'}`,
    { submitted, failed, watchedAfter },
  );
}
