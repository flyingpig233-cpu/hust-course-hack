// Demo backend used when the UI runs outside Tauri (plain browser preview).
// It never touches the network and exists so the interface can be developed
// and reviewed without a real student session.
import { demoEmit } from "./bus";
import type {
  AnswerBankInfo,
  Card,
  Chapter,
  CourseDetail,
  CourseStats,
  CourseSummary,
  CrawlOptions,
  Question,
  QuizRequest,
  QuizSummary,
  SessionInfo,
  TaskPoint,
  WatchRequest,
  WatchSummary,
} from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const summaries: CourseSummary[] = [
  {
    course_id: "17310000026063",
    class_id: "17310000023403",
    cpi: "17310000196268",
    name: "大学英语词汇解析(一)",
    cover_url: null,
    source: "mooc",
    kc_enc: "demo-kc-1",
    ck_enc: "demo-ck-1",
    clazz_enc: "demo-clazz-1",
    detail_url:
      "https://smartcourse.hust.edu.cn/fyportal-smartcourse/courselist/opencoursenewfy?courseId=17310000026063",
  },
  {
    course_id: "17310000026101",
    class_id: "17310000023488",
    cpi: "17310000196268",
    name: "计算机网络",
    cover_url: null,
    source: "mooc",
    kc_enc: "demo-kc-2",
    ck_enc: "demo-ck-2",
    clazz_enc: "demo-clazz-2",
    detail_url:
      "https://smartcourse.hust.edu.cn/fyportal-smartcourse/courselist/opencoursenewfy?courseId=17310000026101",
  },
  {
    course_id: "17310000025200",
    class_id: "17310000022117",
    cpi: "17310000196268",
    name: "军事理论",
    cover_url: null,
    source: "mooc",
    kc_enc: "demo-kc-3",
    ck_enc: "demo-ck-3",
    clazz_enc: "demo-clazz-3",
    detail_url:
      "https://smartcourse.hust.edu.cn/fyportal-smartcourse/courselist/opencoursenewfy?courseId=17310000025200",
  },
];

let session: SessionInfo | null = null;
let cancelled = false;
let loginTimer: number | undefined;
let loginGeneration = 0;

function requireSession(): void {
  if (!session) throw new Error("尚未连接账号，请先导入 Cookie");
}

function question(
  id: string,
  questionType: string,
  stem: string,
  options: Array<[string, string]>,
  myAnswer: string | null,
  correctAnswer: string | null,
  score: string | null,
): Question {
  return {
    id,
    question_type: questionType,
    stem,
    options: options.map(([label, text]) => ({ label, text })),
    my_answer: myAnswer,
    correct_answer: correctAnswer,
    score,
  };
}

function videoPoint(
  name: string,
  jobId: string,
  objectId: string,
  durationSecs: number,
  completed: boolean,
  playedMs: number,
): TaskPoint {
  return {
    kind: "video",
    source_type: "video",
    name,
    job_id: jobId,
    object_id: objectId,
    mid: null,
    size_bytes: durationSecs * 297_000,
    content_ext: ".mp4",
    completed,
    played_ms: playedMs,
    duration_secs: durationSecs,
    work_id: null,
    work_type: null,
    enc: "demo-enc",
    other_info: `nodeId_demo-cpi_17310000196268-${jobId}`,
    att_duration_enc: "demo-att-duration-enc",
    rt: "1",
    video: {
      duration_secs: durationSecs,
      size_bytes: durationSecs * 297_000,
      filename: name,
      dtoken: "demo-dtoken",
      screenshot: null,
      thumbnails: null,
      download_url: "https://example.invalid/demo.mp4",
      stream_url: "https://example.invalid/demo.m3u8",
      hd_stream_url: null,
      status: "success",
    },
    questions: [],
    raw: {},
  };
}

function documentPoint(
  name: string,
  jobId: string,
  objectId: string,
  sizeBytes: number,
): TaskPoint {
  return {
    kind: "document",
    source_type: "document",
    name,
    job_id: jobId,
    object_id: objectId,
    mid: null,
    size_bytes: sizeBytes,
    content_ext: ".pdf",
    completed: false,
    played_ms: null,
    duration_secs: null,
    work_id: null,
    work_type: null,
    enc: null,
    questions: [],
    raw: {},
  };
}

function workPoint(
  name: string,
  jobId: string,
  workId: string,
  status: string,
  questions: Question[],
): TaskPoint {
  return {
    kind: "work",
    source_type: "work",
    name,
    job_id: jobId,
    object_id: null,
    mid: null,
    size_bytes: null,
    content_ext: null,
    completed: status === "graded",
    played_ms: null,
    duration_secs: null,
    work_id: workId,
    work_type: "work",
    work_status: status,
    enc: "demo-work-enc",
    questions,
    raw: {},
  };
}

function card(index: number, title: string, taskPoints: TaskPoint[]): Card {
  return {
    index,
    card_id: `demo-card-${index}`,
    title,
    task_points: taskPoints,
    playback: {
      user_id: "17310000196268",
      clazz_id: "17310000023403",
      course_id: "17310000026063",
      fid: "1731",
      report_url: "/mooc-ans/multimedia/log/a/17310000196268",
      report_interval_secs: 60,
      ktoken: "demo-ktoken",
    },
  };
}

function englishChapters(): Chapter[] {
  const gradedQuestions = [
    question(
      "q-1",
      "单选题",
      "「abandon」最接近下面哪个意思？",
      [
        ["A", "放弃；抛弃"],
        ["B", "获得；取得"],
        ["C", "建立；创立"],
        ["D", "比较；对比"],
      ],
      "A",
      "A",
      "2.0",
    ),
    question(
      "q-2",
      "多选题",
      "下列哪些词含有「扩大、增加」的含义？",
      [
        ["A", "increase"],
        ["B", "expand"],
        ["C", "reduce"],
        ["D", "enlarge"],
      ],
      "A,B",
      "A,B,D",
      "1.0",
    ),
    question(
      "q-3",
      "判断题",
      "「ambiguous」表示“清晰明确的”。",
      [
        ["A", "正确"],
        ["B", "错误"],
      ],
      "B",
      "B",
      "2.0",
    ),
  ];

  return [
    {
      id: "582259",
      title: "Unit 1 Word power",
      number: "1",
      level: 1,
      is_leaf: false,
      completed: false,
      children: [
        {
          id: "582263",
          title: "Introduction: 课程导入 —— 词汇学习策略",
          number: "1.1",
          level: 2,
          is_leaf: true,
          completed: true,
          children: [],
          cards: [
            card(1, "学习材料", [
              videoPoint("0.01 课程导入.mp4", "job-1001", "obj-1001", 821, true, 820000),
              documentPoint("词汇学习策略讲义.pdf", "job-1002", "obj-1002", 1_204_000),
            ]),
          ],
        },
        {
          id: "582264",
          title: "Word formation: 构词法",
          number: "1.2",
          level: 2,
          is_leaf: true,
          completed: false,
          children: [],
          cards: [
            card(1, "学习材料", [
              videoPoint("0.02 构词法.mp4", "job-1003", "obj-1003", 647, false, 0),
            ]),
            card(2, "章节测验", [
              workPoint("Unit 1 词汇测验", "job-1004", "work-1004", "graded", gradedQuestions),
            ]),
          ],
        },
      ],
    },
    {
      id: "582260",
      title: "Unit 2 Listening",
      number: "2",
      level: 1,
      is_leaf: false,
      completed: false,
      children: [
        {
          id: "582270",
          title: "Listening practice: 听力训练",
          number: "2.1",
          level: 2,
          is_leaf: true,
          completed: false,
          children: [],
          cards: [
            card(1, "学习材料", [
              videoPoint("0.03 听力训练.mp4", "job-1005", "obj-1005", 932, false, 120000),
              documentPoint("听力原文.pdf", "job-1006", "obj-1006", 856_000),
            ]),
          ],
        },
        {
          id: "582271",
          title: "Unit 2 quiz",
          number: "2.2",
          level: 2,
          is_leaf: true,
          completed: false,
          children: [],
          cards: [
            card(1, "章节测验", [
              workPoint("Unit 2 词汇测验", "job-1007", "work-1007", "in_progress", [
                question(
                  "q-4",
                  "填空题",
                  "The word “inevitable” means “____”.",
                  [],
                  null,
                  null,
                  null,
                ),
              ]),
            ]),
          ],
        },
      ],
    },
  ];
}

function computerChapters(): Chapter[] {
  return [
    {
      id: "610001",
      title: "第 1 章 概述",
      number: "1",
      level: 1,
      is_leaf: false,
      completed: false,
      children: [
        {
          id: "610010",
          title: "1.1 计算机网络的发展",
          number: "1.1",
          level: 2,
          is_leaf: true,
          completed: false,
          children: [],
          cards: [
            card(1, "学习材料", [
              videoPoint("第1讲 网络发展史.mp4", "job-2001", "obj-2001", 1380, false, 0),
            ]),
          ],
        },
      ],
    },
  ];
}

function computeStats(chapters: Chapter[]): CourseStats {
  const stats: CourseStats = {
    chapter_nodes: 0,
    leaves: 0,
    cards: 0,
    task_points: 0,
    videos: 0,
    documents: 0,
    works: 0,
    questions: 0,
    errors: [],
  };
  const walk = (nodes: Chapter[]) => {
    for (const node of nodes) {
      stats.chapter_nodes += 1;
      if (node.is_leaf) stats.leaves += 1;
      for (const card of node.cards ?? []) {
        stats.cards += 1;
        for (const point of card.task_points) {
          stats.task_points += 1;
          if (point.kind === "video") stats.videos += 1;
          if (point.kind === "document") stats.documents += 1;
          if (point.kind === "work") stats.works += 1;
          stats.questions += point.questions.length;
        }
      }
      walk(node.children);
    }
  };
  walk(chapters);
  return stats;
}

function detailFor(summary: CourseSummary): CourseDetail {
  let chapters: Chapter[] = [];
  if (summary.course_id === "17310000026063") chapters = englishChapters();
  if (summary.course_id === "17310000026101") chapters = computerChapters();

  const walk = (nodes: Chapter[]) => {
    for (const node of nodes) {
      if (node.cards) {
        node.cards = node.cards.map((item) => ({
          ...item,
          playback: item.playback
            ? {
                ...item.playback,
                clazz_id: summary.class_id,
                course_id: summary.course_id,
              }
            : undefined,
        }));
      }
      walk(node.children);
    }
  };
  walk(chapters);

  return {
    ...summary,
    title: summary.name,
    enc: "demo-enc",
    old_enc: "demo-old-enc",
    openc: "demo-openc",
    final_url: summary.detail_url,
    chapters,
    stats: computeStats(chapters),
  };
}

function countLeaves(chapters: Chapter[]): number {
  return chapters.reduce(
    (total, chapter) =>
      total + (chapter.is_leaf ? 1 : 0) + countLeaves(chapter.children),
    0,
  );
}

function allTaskPoints(chapters: Chapter[]): Array<{ chapter: Chapter; point: TaskPoint }> {
  const out: Array<{ chapter: Chapter; point: TaskPoint }> = [];
  const walk = (nodes: Chapter[]) => {
    for (const node of nodes) {
      for (const card of node.cards ?? []) {
        for (const point of card.task_points) out.push({ chapter: node, point });
      }
      walk(node.children);
    }
  };
  walk(chapters);
  return out;
}

function summarize(
  total: number,
  passed: number,
  failed: number,
  errors: string[],
  wasCancelled: boolean,
): WatchSummary {
  return { total, passed, failed, errors, cancelled: wasCancelled };
}

export const mockApi = {
  async sessionInfo(): Promise<SessionInfo | null> {
    await sleep(120);
    return session;
  },

  async openLoginWindow(): Promise<void> {
    await sleep(250);
    loginGeneration += 1;
    const generation = loginGeneration;
    if (loginTimer !== undefined) window.clearTimeout(loginTimer);
    loginTimer = window.setTimeout(() => {
      loginTimer = undefined;
      if (generation !== loginGeneration) return;
      session = { cookieSource: "HUST 统一身份认证", cookieCount: 18 };
      demoEmit("session-changed", session);
    }, 900);
  },

  async disconnect(): Promise<void> {
    loginGeneration += 1;
    if (loginTimer !== undefined) {
      window.clearTimeout(loginTimer);
      loginTimer = undefined;
    }
    session = null;
  },

  async listCourses(): Promise<CourseSummary[]> {
    requireSession();
    await sleep(260);
    return clone(summaries);
  },

  async fetchCourse(courseId: string, options: CrawlOptions): Promise<CourseDetail> {
    requireSession();
    const summary = summaries.find(
      (course) => course.course_id === courseId || course.class_id === courseId,
    );
    if (!summary) throw new Error("找不到该课程");
    const detail = detailFor(summary);
    const total = countLeaves(detail.chapters);

    demoEmit("job-progress", { kind: "crawl", done: 0, total });
    for (let done = 1; done <= total; done += 1) {
      await sleep(180);
      if (cancelled) throw new Error("已取消");
      demoEmit("job-progress", { kind: "crawl", done, total });
    }

    if (options.includeQuestions === false) {
      for (const { point } of allTaskPoints(detail.chapters)) {
        point.questions = [];
        delete point.work_status;
      }
    }
    if (options.includeVideoInfo === false) {
      for (const { point } of allTaskPoints(detail.chapters)) delete point.video;
    }
    detail.stats = computeStats(detail.chapters);
    return clone(detail);
  },

  async watchCourse(request: WatchRequest): Promise<WatchSummary> {
    requireSession();
    cancelled = false;
    const summary = summaries.find(
      (course) =>
        course.course_id === request.course ||
        course.class_id === request.course ||
        course.name === request.course,
    );
    if (!summary) throw new Error("找不到该课程");
    const detail = detailFor(summary);
    const totalLeaves = countLeaves(detail.chapters);

    demoEmit("job-progress", { kind: "crawl", done: 0, total: totalLeaves });
    for (let done = 1; done <= totalLeaves; done += 1) {
      await sleep(150);
      if (cancelled) return summarize(0, 0, 0, [], true);
      demoEmit("job-progress", { kind: "crawl", done, total: totalLeaves });
    }

    const targets = allTaskPoints(detail.chapters)
      .map(({ chapter, point }) => ({ chapter, point }))
      .filter(({ point }) => point.kind === "video")
      .filter(({ point }) => request.includeCompleted || point.completed !== true)
      .filter(({ point }) => !request.job || point.job_id === request.job)
      .slice(0, request.maxVideos ?? undefined);

    demoEmit("job-progress", {
      kind: "watchPlan",
      total: targets.length,
      dryRun: request.dryRun === true,
    });

    let passed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const [offset, { chapter, point }] of targets.entries()) {
      if (cancelled) {
        return summarize(targets.length, passed, failed, errors, true);
      }
      const index = offset + 1;
      const jobId = point.job_id ?? "";
      const label = `${chapter.title} / ${point.name} / ${jobId}`;
      demoEmit("job-progress", { kind: "watch", index, total: targets.length, label, jobId, status: "running", message: null });
      await sleep(420);

      if (request.dryRun) {
        demoEmit("job-progress", {
          kind: "watch",
          index,
          total: targets.length,
          label,
          jobId,
          status: "dry_run",
          message:
            "start: https://smartcourse.hust.edu.cn/mooc-ans/multimedia/log/a/…/demo-dtoken?playingTime=0&isdrag=4\n" +
            "end: https://smartcourse.hust.edu.cn/mooc-ans/multimedia/log/a/…/demo-dtoken?playingTime=820&isdrag=4",
        });
        continue;
      }

      // The demo deliberately passes every video; the real backend decides
      // success from the server's `isPassed` field.
      passed += 1;
      point.completed = true;
      point.played_ms = (point.duration_secs ?? 1) * 1000;
      demoEmit("job-progress", { kind: "watch", index, total: targets.length, label, jobId, status: "passed", message: null });
    }

    return summarize(targets.length, passed, failed, errors, cancelled);
  },

  async completeQuizzes(request: QuizRequest): Promise<QuizSummary> {
    requireSession();
    cancelled = false;
    const summary = summaries.find(
      (course) =>
        course.course_id === request.course ||
        course.class_id === request.course ||
        course.name === request.course,
    );
    if (!summary) throw new Error("找不到该课程");
    const detail = detailFor(summary);
    const points = allTaskPoints(detail.chapters);

    const gradedCount = points.filter(
      ({ point }) => point.kind === "work" && point.work_status === "graded",
    ).length;
    let works = points.filter(
      ({ point }) => point.kind === "work" && point.work_status !== "graded",
    );
    if (request.work) {
      works = works.filter(
        ({ point }) =>
          point.work_id === request.work || point.job_id === request.work,
      );
      if (works.length === 0) throw new Error("没有找到该作业");
    }
    if (request.maxWorks) works = works.slice(0, Math.max(1, request.maxWorks));

    const total = works.length;
    const incomplete = works.filter(({ point }) => point.questions.length === 0).length;
    demoEmit("job-progress", {
      kind: "quizPlan",
      total,
      skippedGraded: gradedCount,
      incomplete,
      dryRun: request.dryRun === true,
      bankQuestions: 541,
    });

    const results: QuizSummary["works"] = [];
    let skipped = 0;
    for (const [offset, { chapter, point }] of works.entries()) {
      if (cancelled) break;
      const index = offset + 1;
      const questionCount = point.questions.length;
      if (questionCount === 0) {
        skipped += 1;
        const message = "演示数据缺少题目，未提交";
        results.push({
          workId: point.work_id ?? "",
          workName: point.name,
          chapter: chapter.title,
          questionCount,
          status: "skipped",
          message,
        });
        demoEmit("job-progress", {
          kind: "quiz",
          index,
          total,
          workId: point.work_id ?? "",
          workName: point.name,
          chapter: chapter.title,
          questionCount,
          status: "skipped",
          message,
        });
        continue;
      }
      demoEmit("job-progress", {
        kind: "quiz",
        index,
        total,
        workId: point.work_id ?? "",
        workName: point.name,
        chapter: chapter.title,
        questionCount,
        status: "running",
        message: null,
      });
      await sleep(450);
      // The demo is intentionally honest: it never claims a real submission.
      const message = "演示模式：只生成计划，未向平台提交";
      results.push({
        workId: point.work_id ?? "",
        workName: point.name,
        chapter: chapter.title,
        questionCount,
        status: "dry_run",
        message,
      });
      demoEmit("job-progress", {
        kind: "quiz",
        index,
        total,
        workId: point.work_id ?? "",
        workName: point.name,
        chapter: chapter.title,
        questionCount,
        status: "dry_run",
        message,
      });
    }

    return {
      total,
      submitted: 0,
      failed: 0,
      skipped,
      cancelled,
      dryRun: true,
      skippedGraded: gradedCount,
      bankQuestions: 541,
      planErrors: [],
      errors: [],
      works: results,
    };
  },

  async answerBankInfo(): Promise<AnswerBankInfo> {
    await sleep(60);
    return { questions: 541, version: 1 };
  },

  async cancelJob(): Promise<void> {
    cancelled = true;
  },

  async helperScript(): Promise<string> {
    return [
      "// ==UserScript==",
      "// @name         HUST Course Video Helper (演示)",
      "// ==/UserScript==",
      "",
      "// 当前运行在浏览器演示模式，没有连接 Rust 后端。",
      "// 在 Tauri 桌面应用中这里会显示完整的 Tampermonkey 脚本。",
    ].join("\n");
  },

  async saveTextFile(path: string, contents: string): Promise<void> {
    const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = path.split(/[\\/]/).pop() || "download.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
};
