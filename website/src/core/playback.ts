import type { Card, CourseDetail, TaskPoint } from '../types.ts';
import { allChapters, type Json } from './parse.ts';
import { SmartCourseClient } from './client.ts';
import { md5 } from './md5.ts';
import { PLATFORM } from './transport.ts';

export function videoEnc(clazz: string, user: string, job: string, object: string, playing: number, duration: number, clip: string): string {
  return md5(`[${clazz}][${user}][${job}][${object}][${playing * 1000}][d_yHJ!$pdA~5][${duration * 1000}][${clip}]`);
}
export interface WatchTarget { point: TaskPoint; card: Card; chapter: string; course: CourseDetail }
export function videoTargets(course: CourseDetail, job?: string | null, includeCompleted = false): WatchTarget[] {
  return allChapters(course.chapters).flatMap((ch) => (ch.cards ?? []).flatMap((card) => card.task_points
    .filter((p) => p.kind === 'video' && (includeCompleted || !p.completed) && (!job || p.job_id === job))
    .map((point) => ({ point, card, chapter: ch.title, course }))));
}
export function reportUrl(target: WatchTarget, playing: number, isdrag: number, now = Date.now()): string {
  const { point: p, card, course } = target, env = card.playback;
  const duration = p.duration_secs ?? p.video?.duration_secs;
  if (!p.job_id || !p.object_id || !duration || duration <= 0 || !p.video?.dtoken || !p.other_info || !env?.user_id) throw new Error('视频缺少新鲜的签名/时长/用户数据，请刷新课程');
  const clazz = env.clazz_id || course.class_id, user = env.user_id;
  const raw = (p.raw ?? {}) as Json;
  const clip = `${raw.startTime ?? 0}_${raw.endTime ?? duration}`;
  const url = new URL(env.report_url || '/mooc-ans/multimedia/log/a', PLATFORM);
  if (url.origin !== PLATFORM) throw new Error('视频上报地址不是学校域名');
  if (!url.pathname.endsWith(`/${course.cpi}`)) url.pathname = url.pathname.replace(/\/$/, '') + '/' + encodeURIComponent(course.cpi);
  url.pathname += '/' + encodeURIComponent(p.video.dtoken);
  let other = p.other_info;
  for (let i = 0; i < 3; i++) { try { const next = decodeURIComponent(other); if (other === next) break; other = next; } catch { break; } }
  other = other.split('&')[0];
  url.search = `clazzId=${clazz}&playingTime=${playing}&duration=${duration}&clipTime=${clip}&objectId=${p.object_id}&otherInfo=${other}&courseId=${env.course_id || course.course_id}&jobid=${p.job_id}&userid=${user}&isdrag=${isdrag}&view=pc&enc=${videoEnc(clazz, user, p.job_id, p.object_id, playing, duration, clip)}&rt=${p.rt || '1'}&videoFaceCaptureEnc=&dtype=Video&_t=${now}&attDuration=${duration}&attDurationEnc=${p.att_duration_enc || ''}&courseEngineInfo=false`;
  return url.href;
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('任务已取消', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function watchTarget(client: SmartCourseClient, target: WatchTarget, step: number, delay: number, signal: AbortSignal): Promise<boolean> {
  const duration = target.point.duration_secs ?? target.point.video?.duration_secs ?? 0;
  const start = Math.min(Math.floor((target.point.played_ms ?? 0) / 1000), duration);
  const report = async (playing: number, isdrag: number) => {
    const response = JSON.parse((await client.text(reportUrl(target, playing, isdrag), signal,
      `${PLATFORM}/ananas/modules/video/index.html?v=2026-0710-1025`)).body);
    if (response.success === false) throw new Error('平台拒绝视频上报');
    return response.isPassed === true;
  };
  if (await report(start, 4) || await report(start, 3)) return true;
  for (let position = start; position < duration;) {
    await pause(delay, signal);
    position = step > 0 ? Math.min(position + step, duration) : duration;
    if (await report(position, 4)) return true;
  }
  await pause(delay, signal);
  return report(duration, 2);
}
