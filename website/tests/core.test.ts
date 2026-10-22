import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { md5 } from '../src/core/md5.ts';
import { allChapters, extractMarg, parseCards, parseChapters, parseCourseList, parsePlayback, parseQuestions, parseTasks } from '../src/core/parse.ts';
import { AnswerBank, encodeAnswer, normalizeStem, type BankData } from '../src/core/answers.ts';
import { allowedRequest, PLATFORM, type HttpRequest, type Transport } from '../src/core/transport.ts';
import { SmartCourseClient, type WorkContext, type WorkPage } from '../src/core/client.ts';
import { prepareSubmission, parseSubmitReply, submitWork } from '../src/core/submit.ts';
import { reportUrl, videoEnc, watchTarget } from '../src/core/playback.ts';
import type { CourseDetail, CourseSummary, Question } from '../src/types.ts';

const browser = new Window();
Object.assign(globalThis, { DOMParser: browser.DOMParser });
const bank = new AnswerBank(JSON.parse(readFileSync(new URL('../public/answer-bank.json', import.meta.url), 'utf8')) as BankData);
const course: CourseSummary = { course_id: '1000', class_id: '2000', cpi: '3000', name: 'Synthetic course', cover_url: null, source: null, kc_enc: null, ck_enc: null, clazz_enc: null,
  detail_url: `${PLATFORM}/fyportal-smartcourse/courselist/opencoursenewfy?courseId=1000` };
const tree = `<ul><li><div class="posCatalog_select" id="400"><span class="posCatalog_name">Unit</span></div><div class="posCatalog_level"><ul><li><div class="posCatalog_select" id="cur4000"><span class="posCatalog_name" title="Lesson">Lesson</span><span class="icon_Uncompleted"></span></div></li></ul></div></li></ul>`;
const videoMarg = { defaults: { userid: '6000', clazzId: '2000', courseid: '1000', fid: '1731', reportUrl: '/mooc-ans/multimedia/log/a/3000' }, attachments: [
  { type: 'video', jobid: '5000', objectId: 'abc123', attDuration: 647, otherInfo: 'nodeId_4000-cpi_3000-enc_synthetic%2526courseId%253D1000', attDurationEnc: 'synthetic', property: { name: 'Lesson.mp4' }, isPassed: false },
] };
const point = parseTasks(videoMarg)[0];
point.video = { duration_secs: 647, size_bytes: null, filename: null, dtoken: 'synthetic-dtoken', screenshot: null, thumbnails: null, download_url: null, stream_url: null, hd_stream_url: null, status: 'success' };
const card = { index: 1, card_id: null, title: 'Card', task_points: [point], playback: parsePlayback(videoMarg) };
const detail: CourseDetail = { ...course, title: course.name, enc: null, old_enc: null, openc: null, final_url: course.detail_url, chapters: [], stats: { chapter_nodes: 0, leaves: 0, cards: 0, task_points: 0, videos: 0, documents: 0, works: 0, questions: 0, errors: [] } };
const q: Question = { id: '676210', question_type: '单选题', stem: 'Question', options: [], my_answer: null, correct_answer: null, score: null };
const workPoint = { ...point, kind: 'work' as const, work_id: 'work-synthetic', job_id: 'work-5000', questions: [q] };
const context: WorkContext = { course, knowledge: '4000', point: workPoint, card };
const workHtml = `<form id="form1" method="post" action="/mooc-ans/work/addStudentWorkNewWeb?token=synthetic%2Btoken&amp;totalQuestionNum=opaque%2fvalue&amp;version=2">
  <input type="hidden" name="workAnswerId" value="synthetic-answer"><input type="hidden" name="enc_work" value="synthetic-enc">
  <input type="hidden" name="answerId" value="synthetic-id"><input type="hidden" name="randomOptions" value="false">
  <input type="hidden" name="totalQuestionNum" value="1"><input type="hidden" id="answertype676210" name="answertype676210" value="0">
  <div class="singleQuesId" id="question676210"><div class="TiMu" data="0"><span class="newZy_TItle">【单选题】</span><div class="qtContent">1 【单选题】Question</div></div></div>
  </form>`;
const workPage: WorkPage = { html: workHtml, url: `${PLATFORM}/mooc-ans/work/doHomeWorkNew`, status: 'in_progress', questions: [q] };

test('MD5 RFC vectors and the Rust verified video signature match byte for byte', () => {
  assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(videoEnc('2000', '6000', '5000', 'abc123', 646, 647, '0_647'), 'a6c82cfd9f0c28fe4849c6021c39229c');
  assert.equal(videoEnc('2000', '6000', '5000', 'abc123', 0, 647, '0_647'), '47c831658ca901455427bf3b630975f9');
});

test('all 541 built-in answers normalize, resolve, and encode', () => {
  assert.equal(bank.size, 541);
  for (const a of Object.values(bank.data.question_index)) {
    assert.ok(bank.data.stem_index[normalizeStem(a.stem)], `missing normalized key ${a.question_id}`);
    const question: Question = { ...q, id: a.question_id, stem: a.stem, question_type: a.question_type, options: a.options };
    assert.equal(bank.lookup(question)?.question_id, a.question_id);
    const fields = encodeAnswer(question, a);
    assert.ok(fields.get(`answertype${a.question_id}`));
    if (a.answer_blanks?.length && ['2', '14'].includes(fields.get(`answertype${a.question_id}`)!)) {
      assert.equal(Number(fields.get(`tiankongsize${a.question_id}`)), a.answer_blanks.length);
      a.answer_blanks.forEach((blank, i) => assert.equal(fields.get(`answerEditor${a.question_id}${i + 1}`), blank.trim()));
    }
  }
});

test('stem fallback and judgment options retain platform semantics', () => {
  const a = bank.data.question_index['676210'];
  assert.equal(bank.lookup({ ...q, id: 'unknown', stem: a.stem.replace(/【单选题】/, '') })?.answer, a.answer);
  const judgment = { ...a, question_type: '判断题', answer: 'B', answer_text: '', answer_labels: ['B'], answer_blanks: [] };
  assert.equal(encodeAnswer({ ...q, question_type: '判断题', options: [{ label: 'B', text: '正确' }] }, judgment).get(`answer${q.id}`), 'true');
});

test('course, chapter, card and mArg parsers reproduce the Rust model', () => {
  const list = parseCourseList('<li class="w_couritem" cid="1000" cname="Test" classid="2000" personId="3000"><h3>Test</h3></li>');
  assert.equal(list[0].cpi, '3000'); assert.match(list[0].detail_url, /opencoursenewfy/);
  assert.throws(() => parseCourseList('<title>用户登录</title>'));
  const chapters = parseChapters(tree);
  assert.equal(allChapters(chapters).length, 2); assert.equal(chapters[0].children[0].completed, false);
  assert.equal(parseCards('<input id="cardcount" value="2">').length, 2);
  const marg = extractMarg('mArg = {}; mArg = {"defaults":{"title":"} \\"x\\""},"attachments":[]}; tail();');
  assert.equal(marg.defaults.title, '} "x"');
  assert.equal(parseTasks(videoMarg)[0].kind, 'video');
  assert.equal(parseTasks({ attachments: [{ type: 'future-kind', property: {} }] })[0].kind, 'other');
});

test('question IDs, multi-select labels and fill-in answer blocks survive HTML variation', () => {
  assert.equal(parseQuestions(workHtml)[0].id, '676210'); assert.equal(parseQuestions(workHtml)[0].stem, 'Question');
  const html = `<div id="question12345"><div class="TiMu" data="3"><span class="newZy_TItle">【判断题】</span><div class="qtContent">1 【判断题】Stem</div>
    <ul class="Zy_ulTop"><li><span class="num_option_dx">A、</span><a>Option</a></li></ul>
    <div class="correctAnswerBx"><div class="correctAnswer">第一空: alpha 第二空： beta</div></div></div></div>`;
  const questions = parseQuestions(html + html);
  assert.equal(questions.length, 1); assert.equal(questions[0].id, '12345');
  assert.equal(questions[0].options[0].label, 'A'); assert.equal(questions[0].correct_answer, 'alpha ；beta');
});

test('fresh form action and hidden fields are retained without changing signed query bytes', () => {
  const request = prepareSubmission(context, workPage, bank);
  assert.match(request.url, /token=synthetic%2Btoken&totalQuestionNum=opaque%2fvalue/);
  assert.equal(new URL(request.url).searchParams.get('version'), '3');
  assert.equal(request.fields.get('answerwqbid'), '676210,');
  assert.equal(request.fields.get('answer676210'), 'B');
  assert.equal(request.fields.get('randomOptions'), 'false');
  assert.equal(request.fields.get('answerId'), 'synthetic-id');
  assert.equal(request.fields.get('userId'), '6000');
});

test('graded, partial, missing-answer and foreign-action works never produce submit payloads', () => {
  assert.throws(() => prepareSubmission(context, { ...workPage, status: 'graded' }, bank));
  assert.throws(() => prepareSubmission(context, { ...workPage, html: workHtml.replace('value="1"', 'value="2"') }, bank));
  assert.throws(() => prepareSubmission(context, { ...workPage, questions: [{ ...q, id: 'unknown' }] }, bank));
  assert.throws(() => prepareSubmission(context, { ...workPage, html: workHtml.replace('/mooc-ans/work/addStudentWorkNewWeb', 'https://evil.example/submit') }, bank));
  assert.equal(parseSubmitReply('{"success":false,"msg":"失败"}').success, false);
  assert.equal(parseSubmitReply('{"success":true,"msg":"成功"}').success, true);
  assert.equal(parseSubmitReply('<html>not a success response</html>').success, false);
});

test('bridge allowlist rejects foreign targets, writes outside submit, and spoofed referrers', () => {
  assert.equal(allowedRequest({ url: `${PLATFORM}/mooc-ans/knowledge/cards?num=0` }), true);
  assert.equal(allowedRequest({ url: `${PLATFORM}/mooc-ans/work/addStudentWorkNewWeb`, method: 'POST' }), true);
  for (const input of [
    { url: 'https://evil.example/mooc-ans/knowledge/cards' },
    { url: `${PLATFORM}/passport` },
    { url: `${PLATFORM}/mooc-ans/knowledge/cards`, method: 'POST' as const },
    { url: `${PLATFORM}/mooc-ans/knowledge/cards`, referrer: 'https://evil.example/' },
    { url: 'https://name:password@smartcourse.hust.edu.cn/mooc-ans/knowledge/cards' },
  ]) assert.equal(allowedRequest(input), false);
});

test('report URL decodes otherInfo, appends cpi once, and omits attachment face token', () => {
  const url = reportUrl({ point, card, chapter: 'Lesson', course: detail }, 646, 4, 123);
  assert.match(url, /\/a\/3000\/synthetic-dtoken\?/);
  assert.match(url, /otherInfo=nodeId_4000-cpi_3000-enc_synthetic&courseId=1000/);
  assert.match(url, /videoFaceCaptureEnc=&/); assert.ok(!url.includes('%26'));
});

test('crawl traverses actual request pipeline, emits progress, and honors cancellation', async () => {
  const paths: string[] = [];
  const transport: Transport = { async request(input, signal) {
    signal?.throwIfAborted(); const url = new URL(input.url); paths.push(url.pathname);
    const body = url.pathname.endsWith('opencoursenewfy') ? '<title>Test course</title>'
      : url.pathname.endsWith('studentstudycourselist') ? tree
      : url.pathname.endsWith('studentstudyAjax') ? '<ul class="prev_ul"><li title="Lesson"></li></ul>'
      : url.pathname.endsWith('/cards') ? `mArg = ${JSON.stringify(videoMarg)};`
      : url.pathname.startsWith('/ananas/status/') ? '{"duration":647,"dtoken":"synthetic-dtoken"}' : '';
    return { body, url: input.url, status: 200 };
  } };
  const progress: number[] = [];
  const client = new SmartCourseClient(transport, (event) => { if (event.kind === 'crawl') progress.push(event.done); });
  const result = await client.fetchCourse(course);
  assert.equal(result.stats.videos, 1); assert.equal(result.stats.errors.length, 0); assert.deepEqual(progress, [0, 1]);
  assert.equal(paths.length, 5);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => client.fetchCourse(course, {}, controller.signal), { name: 'AbortError' });
});

test('watch only succeeds on server isPassed=true and reports the verified heartbeat order', async () => {
  const sequence: string[] = [];
  const client = new SmartCourseClient({ async request(input) {
    sequence.push(new URL(input.url).searchParams.get('isdrag')!);
    return { body: JSON.stringify({ isPassed: sequence.length === 4 }), url: input.url, status: 200 };
  } });
  assert.equal(await watchTarget(client, { point, card, course: detail, chapter: 'Lesson' }, 0, 0, new AbortController().signal), true);
  assert.deepEqual(sequence, ['4', '3', '4', '2']);
});

test('quiz dry run does not POST; real submit refreshes page, validates then POSTs', async () => {
  const calls: HttpRequest[] = [];
  const client = new SmartCourseClient({ async request(input) {
    calls.push(input);
    return { body: input.method === 'POST' ? '{"success":true,"msg":"成功"}' : input.url.includes('/validate') ? '{"status":3}' : workHtml,
      url: input.url.includes('/api/work') ? workPage.url : input.url, status: 200 };
  } });
  const signal = new AbortController().signal;
  await submitWork(client, context, bank, signal, true);
  assert.equal(calls.length, 1); assert.ok(calls.every((r) => r.method !== 'POST'));
  calls.length = 0;
  await submitWork(client, context, bank, signal, false);
  assert.equal(calls.length, 3); assert.match(calls[0].url, /\/api\/work/); assert.match(calls[1].url, /\/validate/); assert.equal(calls[2].method, 'POST');
});
