// Ulearning completion planner/executor (`docs/ulearning/miaoshua-plan.md` §2.4–2.5).
//
// The page decides completion on the client and posts a DES-encrypted record;
// the service accepts it and answers `1` (stored) or `2` (anti-cheat stop).
// The executor keeps dry-run default, paces reports, stops on `2`/first failure
// and verifies the section record afterwards.
import { RateLimiter } from './client.ts';
import type {
  UlCourseDetail,
  UlPage,
  UlPagePlan,
  UlProgress,
  UlQuestion,
  UlSection,
  UlSectionOutcome,
  UlSectionPlan,
  UlVideo,
  UlWatchOptions,
} from './types.ts';
import { summarizeUlOutcomes } from './types.ts';

/** Retries after the first failed sync (page retries with `autoSave=5`). */
export const UL_SYNC_RETRIES = 2;
/** Consecutive failed sections that abort the batch. */
export const UL_FAILURE_LIMIT = 3;

/** Minimal client surface used by the planner/executor; keeps tests offline. */
export interface UlWatchClient {
  wholepageItem(sectionId: number, signal?: AbortSignal): Promise<UlPage[]>;
  pageContent(pageId: number, signal?: AbortSignal): Promise<{
    content_type: number;
    coursepage_id: number | null;
    videos: UlVideo[];
    questions: UlQuestion[];
  }>;
  questionAnswer(questionId: number, pageId: number, signal?: AbortSignal): Promise<string[]>;
  initialize(sectionId: number, signal?: AbortSignal): Promise<number>;
  sync(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ response: number | null; text: string }>;
  sectionRecord(sectionId: number, signal?: AbortSignal): Promise<{ completion_status: number | null }>;
}

export interface UlPlanHooks {
  progress?: (progress: UlProgress) => void;
}

function sectionLabel(section: UlSection): string {
  return section.chapter_name ? `${section.chapter_name} / ${section.name}` : section.name;
}

/**
 * Build the complete plan. Sections already finished, expired courses, sections
 * with exercises (unless explicitly included) and unsupported pages are marked
 * as skipped instead of being reported.
 */
export async function planSections(
  client: Pick<UlWatchClient, 'wholepageItem' | 'pageContent' | 'questionAnswer'>,
  detail: UlCourseDetail,
  options: UlWatchOptions,
  signal: AbortSignal,
  hooks: UlPlanHooks = {},
): Promise<UlSectionPlan[]> {
  const emit = hooks.progress ?? (() => undefined);
  const allSections = detail.chapters.flatMap((chapter) => chapter.sections);
  const plans: UlSectionPlan[] = [];
  let completed = 0;
  let processed = 0;

  for (const chapter of detail.chapters) {
    for (const section of chapter.sections) {
      if (signal.aborted) return plans;
      if (options.max_sections !== null && completed >= options.max_sections) return plans;
      processed += 1;
      emit({
        stage: 'sections',
        done: processed,
        total: allSections.length,
        label: sectionLabel(section),
        message: '解析节计划',
      });
      const base: UlSectionPlan = {
        section_id: section.section_id,
        section_name: section.name,
        chapter_id: section.chapter_id,
        chapter_name: section.chapter_name,
        pages: [],
        action: 'complete',
        reason: null,
      };
      if (detail.course.expired === true) {
        plans.push({ ...base, action: 'skip_expired', reason: '课程已过期，无法上报' });
        continue;
      }
      if (section.completion_status === 1) {
        plans.push({ ...base, action: 'skip_done', reason: '已标记完成' });
        continue;
      }
      let pages = section.pages;
      if (pages.length === 0) {
        try {
          pages = await client.wholepageItem(section.section_id, signal);
        } catch (error) {
          signal.throwIfAborted();
          plans.push({ ...base, action: 'skip_invalid', reason: `读取节页面失败：${error instanceof Error ? error.message : '请求失败'}` });
          continue;
        }
      }
      if (pages.length === 0) {
        plans.push({ ...base, action: 'skip_invalid', reason: '该节没有可上报的页面' });
        continue;
      }

      const pagePlans: UlPagePlan[] = [];
      let failure: string | null = null;
      let hasQuiz = false;
      for (const page of pages) {
        if (signal.aborted) return plans;
        let content;
        try {
          content = await client.pageContent(page.page_id, signal);
        } catch (error) {
          signal.throwIfAborted();
          failure = `读取页面内容失败：${error instanceof Error ? error.message : '请求失败'}`;
          break;
        }
        const contentType = content.content_type || page.content_type;
        if (content.questions.length > 0 || contentType === 7) {
          hasQuiz = true;
          if (!options.include_quizzes) {
            failure = '含章节练习，默认跳过';
            break;
          }
          const questions: UlQuestion[] = [];
          let answerFailure = false;
          for (const question of content.questions) {
            const answers = await client.questionAnswer(question.question_id, page.page_id, signal).catch(() => []);
            if (answers.length === 0) {
              answerFailure = true;
              break;
            }
            questions.push({ ...question, answers });
          }
          if (answerFailure) {
            failure = '练习答案缺失，未提交';
            break;
          }
          pagePlans.push({
            page_id: page.page_id,
            relation_id: page.relation_id,
            content_type: contentType,
            coursepage_id: content.coursepage_id,
            videos: [],
            questions,
          });
          continue;
        }
        if (content.videos.length > 0) {
          const invalid = content.videos.some((video) => !video.video_id || video.duration_secs <= 0);
          if (invalid) {
            failure = '视频 id/时长缺失，未提交';
            break;
          }
          pagePlans.push({
            page_id: page.page_id,
            relation_id: page.relation_id,
            content_type: contentType,
            coursepage_id: content.coursepage_id,
            videos: content.videos,
            questions: [],
          });
          continue;
        }
        // Text pages (图文) can be marked complete without a video record.
        if (contentType === 5 || contentType === 0) {
          pagePlans.push({
            page_id: page.page_id,
            relation_id: page.relation_id,
            content_type: contentType,
            coursepage_id: content.coursepage_id,
            videos: [],
            questions: [],
          });
          continue;
        }
        failure = `不支持的页面类型 ${contentType}`;
        break;
      }

      if (failure !== null) {
        plans.push({
          ...base,
          action: hasQuiz && !options.include_quizzes ? 'skip_quiz' : 'skip_invalid',
          reason: failure,
        });
        continue;
      }
      plans.push({ ...base, pages: pagePlans, action: 'complete' });
      completed += 1;
    }
  }
  return plans;
}

/**
 * Build the exact `ItemStudyRecordUpdateDTO` payload. Field order matches the
 * live-verified example so the golden test can compare JSON byte for byte.
 */
export function buildSectionPayload(plan: UlSectionPlan, studyStartTime: number): Record<string, unknown> {
  return {
    itemid: plan.section_id,
    autoSave: 1,
    withoutOld: null,
    complete: 1,
    studyStartTime,
    score: 100,
    pageStudyRecordDTOList: plan.pages.map((page) => {
      const record: Record<string, unknown> = {
        pageid: page.relation_id,
        complete: 1,
        studyTime: 1000,
        score: 100,
        answerTime: 1,
        submitTimes: page.questions.length > 0 ? 1 : 0,
      };
      if (page.coursepage_id !== null) record.coursepageId = page.coursepage_id;
      record.questions = page.questions.map((question) => ({
        questionid: question.question_id,
        answerList: question.answers,
        score: question.score,
      }));
      record.videos = page.videos.map((video) => ({
        videoid: video.video_id,
        current: video.duration_secs,
        status: 1,
        recordTime: video.duration_secs,
        time: video.duration_secs,
        startEndTimeList: [{ startTime: 0, endTime: video.duration_secs }],
      }));
      record.speaks = [];
      return record;
    }),
  };
}

/** Minimal pacing surface; `RateLimiter` satisfies it and tests can stub it. */
export interface UlPacer {
  wait(signal?: AbortSignal): Promise<number>;
}

export interface UlWatchHooks {
  progress?: (progress: UlProgress) => void;
  /** Called as each section reaches a terminal state (live UI rows). */
  outcome?: (outcome: UlSectionOutcome, index: number, total: number) => void;
  limiter?: UlPacer;
}

/** Execute one planned batch; returns one outcome per plan (plus early stop). */
export async function runSectionWatch(
  client: UlWatchClient,
  plans: UlSectionPlan[],
  options: UlWatchOptions,
  signal: AbortSignal,
  hooks: UlWatchHooks = {},
): Promise<UlSectionOutcome[]> {
  const limiter = hooks.limiter ?? new RateLimiter(options.delay_min_ms, options.delay_max_ms);
  const emit = hooks.progress ?? (() => undefined);
  const emitOutcome = hooks.outcome ?? (() => undefined);
  const outcomes: UlSectionOutcome[] = [];
  const total = plans.length;
  const record = (outcome: UlSectionOutcome, index: number): void => {
    outcomes.push(outcome);
    emitOutcome(outcome, index, total);
  };
  let consecutiveFailures = 0;

  for (let index = 0; index < plans.length; index += 1) {
    if (signal.aborted) {
      record({ label: plans[index].section_name, state: 'cancelled', pages: 0, response: null, message: '已取消' }, index);
      return outcomes;
    }
    const plan = plans[index];
    const label = plan.chapter_name ? `${plan.chapter_name} / ${plan.section_name}` : plan.section_name;
    emit({ stage: 'sync', done: index, total, label, message: '处理中' });
    if (plan.action !== 'complete') {
      record(
        { label, state: 'skip', pages: plan.pages.length, response: null, message: plan.reason ?? '跳过' },
        index,
      );
      emit({ stage: 'sync', done: index + 1, total, label, message: plan.reason ?? '跳过' });
      continue;
    }

    if (options.dry_run) {
      const payload = buildSectionPayload(plan, Math.floor(Date.now() / 1000));
      const videos = plan.pages.reduce((sum, page) => sum + page.videos.length, 0);
      const questions = plan.pages.reduce((sum, page) => sum + page.questions.length, 0);
      record({
        label,
        state: 'dry_run',
        pages: plan.pages.length,
        response: null,
        message: `预演：${plan.pages.length} 页 / ${videos} 个视频 / ${questions} 道题，未发送（${JSON.stringify(payload).length} 字节明文）`,
      }, index);
      emit({ stage: 'sync', done: index + 1, total, label, message: '预演：未发送' });
      continue;
    }

    let studyStartTime: number;
    try {
      studyStartTime = await client.initialize(plan.section_id, signal);
    } catch (error) {
      if (signal.aborted) {
        record({ label, state: 'cancelled', pages: plan.pages.length, response: null, message: '已取消' }, index);
        return outcomes;
      }
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : '获取学习起始时间失败';
      record({ label, state: 'failed', pages: plan.pages.length, response: null, message }, index);
      emit({ stage: 'sync', done: index + 1, total, label, message });
      if (options.stop_on_error) return outcomes;
      if (consecutiveFailures >= UL_FAILURE_LIMIT) {
        const last = outcomes.at(-1);
        if (last) {
          last.state = 'circuit_broken';
          last.message = `${last.message}；连续失败过多，已中止`;
        }
        return outcomes;
      }
      continue;
    }

    const payload = buildSectionPayload(plan, studyStartTime);
    let result: { response: number | null; text: string } | null = null;
    let failure: string | null = null;
    for (let attempt = 0; attempt <= UL_SYNC_RETRIES; attempt += 1) {
      // Pace *every* attempt, including retries: the platform measured a 502 ms
      // gap when retries bypassed the limiter, violating the 3–5 s rule.
      try {
        await limiter.wait(signal);
      } catch {
        record({ label, state: 'cancelled', pages: plan.pages.length, response: null, message: '已取消' }, index);
        return outcomes;
      }
      try {
        result = await client.sync(payload, signal);
        if (result.response === 1) break;
        if (result.response === 2) break;
        failure = `服务端返回 ${result.response ?? `非数字：${result.text}`}`;
      } catch (error) {
        if (signal.aborted) {
          record({ label, state: 'cancelled', pages: plan.pages.length, response: null, message: '已取消' }, index);
          return outcomes;
        }
        failure = error instanceof Error ? error.message : '上报请求失败';
        result = null;
      }
    }

    if (result?.response === 2) {
      record({
        label,
        state: 'circuit_broken',
        pages: plan.pages.length,
        response: 2,
        message: '服务端判定刷分（返回 2），已立即停止整批',
      }, index);
      emit({ stage: 'circuit', done: index + 1, total, label, message: '服务端返回 2，已停止' });
      return outcomes;
    }
    if (result?.response !== 1) {
      consecutiveFailures += 1;
      const message = failure ?? '服务端未确认本次上报';
      record({ label, state: 'failed', pages: plan.pages.length, response: result?.response ?? null, message }, index);
      emit({ stage: 'sync', done: index + 1, total, label, message });
      if (options.stop_on_error) return outcomes;
      if (consecutiveFailures >= UL_FAILURE_LIMIT) {
        const last = outcomes.at(-1);
        if (last) {
          last.state = 'circuit_broken';
          last.message = `${last.message}；连续失败过多，已中止`;
        }
        return outcomes;
      }
      continue;
    }

    consecutiveFailures = 0;
    let message = '服务端确认提交（返回 1）';
    if (options.verify) {
      try {
        const recordAfter = await client.sectionRecord(plan.section_id, signal);
        if (recordAfter.completion_status === 1) {
          message = '服务端确认提交，复核 completion_status=1';
        } else {
          record({
            label,
            state: 'failed',
            pages: plan.pages.length,
            response: 1,
            message: `上报已提交，但复核 completion_status=${recordAfter.completion_status ?? '未知'}`,
          }, index);
          emit({ stage: 'verify', done: index + 1, total, label, message: '复核未通过' });
          if (options.stop_on_error) return outcomes;
          continue;
        }
      } catch (error) {
        if (signal.aborted) {
          record({ label, state: 'cancelled', pages: plan.pages.length, response: null, message: '已取消' }, index);
          return outcomes;
        }
        // A failed verification is a failed section (e.g. a 401 on the read
        // back); do not record it as ok and keep going by default.
        const verifyMessage = `上报已提交，但复核失败：${error instanceof Error ? error.message : '请求失败'}`;
        record({
          label,
          state: 'failed',
          pages: plan.pages.length,
          response: 1,
          message: verifyMessage,
        }, index);
        emit({ stage: 'verify', done: index + 1, total, label, message: verifyMessage });
        if (options.stop_on_error) return outcomes;
        continue;
      }
    }
    record({ label, state: 'ok', pages: plan.pages.length, response: 1, message }, index);
    emit({ stage: 'verify', done: index + 1, total, label, message });
  }
  return outcomes;
}

/** Compact counters for the backend summary. */
export { summarizeUlOutcomes };
