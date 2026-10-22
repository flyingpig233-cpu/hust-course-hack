import type { Card, CourseDetail, CourseSummary, CrawlOptions, JobProgress, TaskPoint } from '../types.ts';
import { allChapters, documentOf, extractMarg, hidden, parseCards, parseChapters, parseCourseList, parsePlayback, parseQuestions, parseTasks, parseVideo } from './parse.ts';
import { PLATFORM, type Transport } from './transport.ts';

export const endpoint = (path: string, params: Record<string, string | number> = {}): string => {
  const url = new URL(path, PLATFORM);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.href;
};
export interface WorkContext { course: CourseSummary; knowledge: string; point: TaskPoint; card: Card }
export interface WorkPage { html: string; url: string; status: string; questions: ReturnType<typeof parseQuestions> }

export class SmartCourseClient {
  private transport: Transport;
  private progress: (event: JobProgress) => void;
  constructor(transport: Transport, progress: (event: JobProgress) => void = () => {}) {
    this.transport = transport; this.progress = progress;
  }

  async text(url: string, signal?: AbortSignal, referrer?: string): Promise<{ body: string; url: string }> {
    const response = await this.transport.request({ url, referrer }, signal);
    if (response.status < 200 || response.status >= 300) throw new Error(`学校接口返回 HTTP ${response.status}`);
    if (new URL(response.url).origin !== PLATFORM || /\/(passport|cas\/login)(?:[/?]|$)/.test(response.url)
      || /请先登录|用户登录|<title>[^<]*登录|没有此页面访问权限|您长时间没有操作/.test(response.body)) throw new Error('登录已失效或页面拒绝访问，请在学校窗口重新登录。');
    if (response.body.includes('<title>404</title>') || response.body.includes('error-page/images/bg404.gif')) throw new Error('课程接口返回 404 页面');
    return response;
  }

  async listCourses(signal?: AbortSignal): Promise<CourseSummary[]> {
    const { body, url } = await this.text(endpoint('/fyportal-smartcourse/fyportal/wfw/courselist/getStudyCourse', { sectionId: 0 }), signal,
      `${PLATFORM}/fyportal-smartcourse/wfw/courselist/course3`);
    if (!new URL(url).pathname.endsWith('/getStudyCourse')) throw new Error('请在学校窗口完成登录后重新连接');
    return parseCourseList(body);
  }

  async workPage(ctx: WorkContext, signal?: AbortSignal): Promise<WorkPage> {
    const { course: c, knowledge, point: p, card } = ctx;
    const { body, url } = await this.text(endpoint('/mooc-ans/api/work', {
      api: 1, workId: p.work_id ?? '', jobid: p.job_id ?? `work-${p.work_id}`, originJobId: p.job_id ?? `work-${p.work_id}`,
      needRedirect: 'true', skipHeader: 'true', knowledgeid: knowledge, ktoken: card.playback?.ktoken ?? '',
      cpi: c.cpi, ut: 's', clazzId: c.class_id, type: p.work_type === 'workB' ? 'b' : '', enc: p.enc ?? '', mooc2: 1, courseid: c.course_id,
    }), signal, `${PLATFORM}/mooc-ans/knowledge/cards`);
    return {
      html: body, url, questions: parseQuestions(body),
      status: url.includes('selectWorkQuestionYiPiYue') || body.includes('查看已批改') ? 'graded'
        : url.includes('doHomeWorkNew') || body.includes('doHomeWorkNew') ? 'in_progress' : 'unknown',
    };
  }

  async fetchCourse(summary: CourseSummary, options: CrawlOptions = {}, signal?: AbortSignal): Promise<CourseDetail> {
    const home = await this.text(summary.detail_url, signal, `${PLATFORM}/fyportal-smartcourse/wfw/courselist/course3`);
    const doc = documentOf(home.body);
    const c = { ...summary, course_id: summary.course_id || hidden(doc, 'courseid') || '', class_id: summary.class_id || hidden(doc, 'clazzid') || '', cpi: summary.cpi || hidden(doc, 'cpi') || '' };
    const tree = await this.text(endpoint('/mooc-ans/mycourse/studentstudycourselist', { courseId: c.course_id, chapterId: 0, clazzid: c.class_id, cpi: c.cpi, mooc2: 1 }), signal, home.url);
    const chapters = parseChapters(tree.body), nodes = allChapters(chapters), leaves = nodes.filter((n) => n.is_leaf);
    const stats = { chapter_nodes: nodes.length, leaves: leaves.length, cards: 0, task_points: 0, videos: 0, documents: 0, works: 0, questions: 0, errors: [] as string[] };
    let next = 0, done = 0;
    this.progress({ kind: 'crawl', done, total: leaves.length });
    const worker = async () => {
      while (next < leaves.length) {
        signal?.throwIfAborted();
        const leaf = leaves[next++];
        try {
          const ajax = endpoint('/mooc-ans/mycourse/studentstudyAjax', {
            courseId: c.course_id, clazzid: c.class_id, chapterId: leaf.id, cpi: c.cpi, verificationcode: '', mooc2: 1,
            toComputer: 'false', microTopicId: 0, editorPreview: 0, isPreviewVideo: 'false', videoWidth: 0, videoHeight: 0, targetVideoJobId: '', cardIndex: 0, ut: 's',
          });
          leaf.cards = parseCards((await this.text(ajax, signal, `${PLATFORM}/mooc-ans/mycourse/studentstudy`)).body);
          for (const card of leaf.cards) {
            signal?.throwIfAborted();
            try {
              const url = endpoint('/mooc-ans/knowledge/cards', {
                clazzid: c.class_id, courseid: c.course_id, knowledgeid: leaf.id, num: card.index - 1, ut: 's', cpi: c.cpi,
                v: '2025-0424-1038-4', mooc2: 1, isMicroCourse: 'false', editorPreview: 0, crossId: '',
              });
              const marg = extractMarg((await this.text(url, signal, ajax)).body);
              card.task_points = parseTasks(marg); card.playback = parsePlayback(marg);
              for (const point of card.task_points) {
                try {
                  if (point.kind === 'video' && point.object_id && options.includeVideoInfo !== false) {
                    const status = await this.text(endpoint(`/ananas/status/${encodeURIComponent(point.object_id)}`, { k: card.playback?.fid ?? '1731', flag: 'normal' }), signal, url);
                    point.video = parseVideo(JSON.parse(status.body));
                  } else if (point.kind === 'work' && point.work_id && options.includeQuestions !== false) {
                    const page = await this.workPage({ course: c, knowledge: leaf.id, point, card }, signal);
                    point.questions = page.questions; point.work_status = page.status;
                  }
                } catch (error) {
                  signal?.throwIfAborted(); stats.errors.push(`knowledge ${leaf.id} card ${card.index} ${point.kind}: ${error instanceof Error ? error.message : '请求失败'}`);
                }
              }
            } catch (error) {
              signal?.throwIfAborted(); stats.errors.push(`knowledge ${leaf.id} card ${card.index}: ${error instanceof Error ? error.message : '请求失败'}`);
            }
          }
        } catch (error) {
          signal?.throwIfAborted(); stats.errors.push(`knowledge ${leaf.id}: ${error instanceof Error ? error.message : '请求失败'}`);
        }
        this.progress({ kind: 'crawl', done: ++done, total: leaves.length });
      }
    };
    // Abort all workers at the backend boundary if one fails. A cancelled crawl never becomes a partial success.
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, options.concurrency ?? 4), leaves.length) }, worker));
    signal?.throwIfAborted();
    for (const node of nodes) for (const card of node.cards ?? []) {
      stats.cards++;
      for (const point of card.task_points) {
        stats.task_points++; stats.questions += point.questions.length;
        if (point.kind === 'video') stats.videos++;
        if (point.kind === 'document') stats.documents++;
        if (point.kind === 'work') stats.works++;
      }
    }
    return { ...c, title: doc.title.trim() || c.name, enc: hidden(doc, 'enc'), old_enc: hidden(doc, 'oldenc'), openc: hidden(doc, 'openc'), final_url: home.url, chapters, stats };
  }

  async post(url: string, body: URLSearchParams, referrer: string, signal?: AbortSignal): Promise<string> {
    const response = await this.transport.request({ url, method: 'POST', body: body.toString(), referrer }, signal);
    if (response.status < 200 || response.status >= 300) throw new Error(`提交接口返回 HTTP ${response.status}`);
    return response.body;
  }
}
