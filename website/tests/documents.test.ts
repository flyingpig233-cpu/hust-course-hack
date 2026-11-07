import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartCourseClient } from '../src/core/client.ts';
import { attachmentJToken, collectDocumentTargets, parseAttachmentSetting } from '../src/core/documents.ts';
import { allowedRequest, PLATFORM, type HttpRequest } from '../src/core/transport.ts';
import type { Chapter, CourseDetail, CourseSummary, DocumentTarget, TaskPoint } from '../src/types.ts';

const summary: CourseSummary = {
  course_id: '1000', class_id: '2000', cpi: '3000', name: 'Synthetic course', cover_url: null, source: null,
  kc_enc: null, ck_enc: null, clazz_enc: null, detail_url: `${PLATFORM}/fyportal-smartcourse/courselist/opencoursenewfy?courseId=1000`,
};

function documentPoint(name: string, jobId: string | null, objectId: string | null = 'obj-1', completed: boolean | null = null): TaskPoint {
  return {
    kind: 'document', source_type: 'document', name, job_id: jobId, object_id: objectId, mid: null,
    size_bytes: 2048, content_ext: '.pdf', completed, played_ms: null, duration_secs: null,
    work_id: null, work_type: null, enc: null, questions: [], raw: {},
  };
}

const videoPoint: TaskPoint = {
  ...documentPoint('lesson.mp4', 'job-video'), kind: 'video', source_type: 'video', content_ext: '.mp4',
};

function detail(chapters: Chapter[]): CourseDetail {
  return {
    ...summary, title: summary.name, enc: null, old_enc: null, openc: null, final_url: summary.detail_url,
    chapters,
    stats: { chapter_nodes: 0, leaves: 0, cards: 0, task_points: 0, videos: 0, documents: 0, works: 0, questions: 0, errors: [] },
  };
}

const chapters: Chapter[] = [{
  id: 'k1', title: 'Chapter 1', number: '1', level: 1, is_leaf: false, completed: false, children: [{
    id: 'k11', title: 'Lesson 1', number: '1.1', level: 2, is_leaf: true, completed: false, children: [], cards: [
      { index: 1, card_id: 'card-1', title: 'Card 1', task_points: [
        documentPoint('doc-a.pdf', 'job-a'),
        documentPoint('doc-done.pdf', 'job-done', 'obj-done', true),
        videoPoint,
        documentPoint('doc-no-job.pdf', null),
      ] },
      { index: 2, card_id: null, title: 'Card without id', task_points: [documentPoint('doc-broken.pdf', 'job-broken')] },
      { index: 3, card_id: 'card-3', title: 'Duplicate document', task_points: [documentPoint('doc-a-again.pdf', 'job-a')] },
    ],
  }],
}];
const target: DocumentTarget = {
  course_id: '1000', class_id: '2000', cpi: '3000', knowledge_id: 'k11', knowledge_title: 'Lesson 1',
  card_id: 'card-1', job_id: 'job-a', object_id: 'obj-1', name: 'doc-a.pdf', size_bytes: 2048,
  content_ext: '.pdf', completed: null,
};

test('AttachmentSetting parses through strings containing braces, quotes and semicolons', () => {
  const html = `<html><body><script>
  window.AttachmentSetting = {"attachments":[
    {"type":"document","jobid":"job-1","jtoken":"tok;1}\\"q","property":{"objectid":"obj-1","name":"a.pdf"}},
    {"type":"video","jobid":"v-1","jtoken":"tok-v","property":{"objectid":"obj-v"}}
  ],"note":"}; not the end"};
</script></body></html>`;
  const setting = parseAttachmentSetting(html);
  assert.ok(setting);
  assert.equal((setting.attachments as unknown[]).length, 2);
  assert.equal(setting.attachments[0].jobid, 'job-1');
  assert.equal(attachmentJToken(setting, 'job-1', 'obj-1'), 'tok;1}"q');
  assert.equal(attachmentJToken(setting, 'v-1'), 'tok-v');
  // The object id is only a fallback when the job id does not match.
  assert.equal(attachmentJToken(setting, 'missing', 'obj-v'), 'tok-v');
  assert.equal(attachmentJToken(setting, 'missing'), null);
  assert.equal(attachmentJToken(setting, 'job-1', 'wrong-object'), 'tok;1}"q');
  assert.equal(attachmentJToken(null, 'job-1'), null);
});

test('wxcard parser tolerates a plain JSON body and rejects pages without attachments', () => {
  const direct = parseAttachmentSetting('{"attachments":[{"jobid":"j1","jtoken":"t1"}]}');
  assert.equal(attachmentJToken(direct, 'j1'), 't1');
  assert.equal(parseAttachmentSetting('<html><body>no settings here</body></html>'), null);
  assert.equal(parseAttachmentSetting(''), null);
  assert.equal(parseAttachmentSetting('window.AttachmentSetting = null; <script>var x = {"a":1};</script>'), null);
  assert.equal(parseAttachmentSetting('window.AttachmentSetting = {"attachments":[invalid]};'), null);
});

test('document plan uses job id and card id, skips completed docs and explains missing ids', () => {
  const plan = collectDocumentTargets(detail(chapters));
  assert.equal(plan.targets.length, 1);
  assert.deepEqual(plan.targets[0], target);
  assert.equal(plan.errors.length, 2);
  assert.match(plan.errors[0], /缺少 job id/);
  assert.match(plan.errors[1], /缺少 card id/);

  const all = collectDocumentTargets(detail(chapters), true);
  assert.deepEqual(all.targets.map((item) => item.job_id), ['job-a', 'job-done']);
  assert.equal(all.targets.length, 2);
});

test('client fetches wxcard attachments and only accepts status true from job/document', async () => {
  const calls: HttpRequest[] = [];
  const settingBody = 'window.AttachmentSetting = {"attachments":[{"jobid":"job-a","jtoken":"tok-a","type":"document","property":{"objectid":"obj-1"}}]};';
  const client = new SmartCourseClient({ async request(input) {
    calls.push(input);
    const path = new URL(input.url).pathname;
    if (path === '/mooc-ans/phone/wxcard') return { body: settingBody, url: input.url, status: 200 };
    if (path === '/mooc-ans/job/document') return { body: '{"status":true}', url: input.url, status: 200 };
    return { body: '{}', url: input.url, status: 200 };
  } });
  const setting = await client.fetchDocumentSetting(summary, 'k11', 'card-1');
  assert.equal(attachmentJToken(setting, 'job-a', 'obj-1'), 'tok-a');
  assert.equal(calls[0].method, undefined);
  assert.equal(calls[0].referrer, `${PLATFORM}/mooc-ans/mycourse/studentstudy`);
  const wxcard = new URL(calls[0].url);
  assert.equal(wxcard.pathname, '/mooc-ans/phone/wxcard');
  for (const [key, value] of Object.entries({ cardid: 'card-1', courseid: '1000', knowledgeid: 'k11', clazzid: '2000', cpi: '3000', ut: 's', isMicroCourse: 'false' })) {
    assert.equal(wxcard.searchParams.get(key), value, `wxcard ${key}`);
  }

  await client.completeDocument(target, 'tok-a');
  const report = new URL(calls[1].url);
  assert.equal(report.pathname, '/mooc-ans/job/document');
  for (const [key, value] of Object.entries({
    jobid: 'job-a', knowledgeid: 'k11', courseid: '1000', clazzid: '2000', jtoken: 'tok-a',
    checkMicroTopic: 'true', microTopicId: 'undefined', courseEngineInfo: 'false',
  })) {
    assert.equal(report.searchParams.get(key), value, `job/document ${key}`);
  }

  // A raw JSON wxcard body (some deployments answer with JSON) is accepted too.
  const jsonClient = new SmartCourseClient({ async request(input) {
    return { body: '{"attachments":[{"jobid":"job-a","jtoken":"tok-json"}]}', url: input.url, status: 200 };
  } });
  assert.equal(attachmentJToken(await jsonClient.fetchDocumentSetting(summary, 'k11', 'card-1'), 'job-a'), 'tok-json');

  const rejected = new SmartCourseClient({ async request(input) {
    return { body: '{"status":false,"msg":"job not found"}', url: input.url, status: 200 };
  } });
  await assert.rejects(() => rejected.completeDocument(target, 'tok-a'), /job not found/);
  // The official client treats only the boolean true as accepted.
  const stringStatus = new SmartCourseClient({ async request(input) {
    return { body: '{"status":"true"}', url: input.url, status: 200 };
  } });
  await assert.rejects(() => stringStatus.completeDocument(target, 'tok-a'), /status 不为 true/);
  const nonJson = new SmartCourseClient({ async request(input) {
    return { body: '<html>login</html>', url: input.url, status: 200 };
  } });
  await assert.rejects(() => nonJson.completeDocument(target, 'tok-a'), /非 JSON/);
});

test('bridge allowlist admits only the two document GETs', () => {
  assert.equal(allowedRequest({ url: `${PLATFORM}/mooc-ans/phone/wxcard?cardid=card-1&courseid=1000` }), true);
  assert.equal(allowedRequest({ url: `${PLATFORM}/mooc-ans/job/document?jobid=job-a&jtoken=tok-a` }), true);
  assert.equal(allowedRequest({ url: `${PLATFORM}/mooc-ans/phone/wxcard`, method: 'POST' }), false);
  assert.equal(allowedRequest({ url: `${PLATFORM}/mooc-ans/job/document`, referrer: 'https://evil.example/' }), false);
  assert.equal(allowedRequest({ url: 'https://evil.example/mooc-ans/job/document' }), false);
  assert.equal(allowedRequest({ url: `${PLATFORM}/mooc-ans/phone/wxcardx` }), false);
});
