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
  DocumentRequest,
  DocumentSummary,
  Platform,
  Question,
  QuizRequest,
  QuizSummary,
  SessionInfo,
  TaskPoint,
  UlChapter,
  UlCheck,
  UlCourse,
  UlCourseDetail,
  UlOutcome,
  UlPage,
  UlSection,
  UlWatchRequest,
  UlWatchSummary,
  WatchRequest,
  WatchSummary,
  ZhsCourse,
  ZhsCourseDetail,
  ZhsExamList,
  ZhsExamPaper,
  ZhsExamPlan,
  ZhsExamQuestion,
  ZhsExamSummary,
  ZhsExceptionStatus,
  ZhsRedoResult,
  ZhsMeet,
  ZhsMeetOutcome,
  ZhsMeetProgress,
  ZhsMeetWatchRequest,
  ZhsMeetWatchSummary,
  ZhsAiEntry,
  ZhsAnswerResult,
  ZhsBankInfo,
  ZhsRecordAiResult,
  ZhsVideo,
  ZhsVideoOutcome,
  ZhsWatchRequest,
  ZhsWatchSummary,
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
  if (!session) throw new Error("尚未连接账号，请先登录");
  if (session.platform !== "hust") {
    throw new Error("当前连接的是其他平台，请使用对应平台的课程页");
  }
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

// ---- Zhihuishu (知到) demo data -------------------------------------------
// Synthetic shared courses, video trees and meet replays. The demo backend never
// contacts the platform and never reports success it did not observe, so every
// Zhihuishu job below is restricted to dry-run.

const zhsCourses: ZhsCourse[] = [
  {
    recruitId: 463667,
    courseId: 1000011214,
    classId: 3001,
    schoolId: 360,
    name: "军事理论-综合版",
    teacher: "张教授",
    secret: "demo-zhs-secret-1",
    isApply: 1,
    courseType: "share",
    progress: 41,
    studiedLessonCount: 2,
    totalLessonCount: 6,
    status: 1,
  },
  {
    recruitId: 500001,
    courseId: 1000022233,
    classId: 3002,
    schoolId: 360,
    name: "大学生心理健康",
    teacher: "刘老师",
    secret: "demo-zhs-secret-2",
    isApply: 0,
    courseType: "share",
    progress: 0,
    studiedLessonCount: 0,
    totalLessonCount: 3,
    status: 1,
  },
];

function zhsVideo(
  videoId: number,
  lessonVideoId: number,
  videoSec: number,
  studied: boolean,
  name: string,
): ZhsVideo {
  return {
    videoId,
    lessonVideoId,
    videoSec,
    isStudied: studied ? 1 : 0,
    name,
  };
}

function zhsDetailFor(course: ZhsCourse): ZhsCourseDetail {
  if (course.recruitId === 500001) {
    return zhsDetailWithCounts(course, [
      {
        chapterId: 2001,
        name: "第一章 绪论",
        learningLessonStatus: 0,
        isPass: 0,
        limitChecked: null,
        lessons: [
          {
            lessonId: 20010,
            name: "1.1 心理健康概述",
            isStudied: 0,
            videoId: null,
            videoSec: null,
            videos: [
              zhsVideo(780001, 200101, 612, false, "1.1.1 心理健康的标准"),
              zhsVideo(780002, 200102, 534, false, "1.1.2 常见的心理困扰"),
            ],
          },
        ],
      },
    ]);
  }
  return zhsDetailWithCounts(course, [
    {
      chapterId: 1000116293,
      name: "第一章 中国国防",
      learningLessonStatus: 0,
      isPass: 0,
      limitChecked: null,
      lessons: [
        {
          lessonId: 1000337351,
          name: "1.1 国防概述",
          isStudied: 1,
          videoId: null,
          videoSec: null,
          videos: [
            zhsVideo(70622143, 1000244446, 468, true, "1.1.1 国防的含义"),
            zhsVideo(70796671, 1000244447, 491, true, "1.1.2 现代国防的特征"),
          ],
        },
        {
          lessonId: 1000337356,
          name: "1.2 国防历史",
          isStudied: 0,
          videoId: null,
          videoSec: null,
          videos: [
            zhsVideo(71192505, 1000244477, 826, false, "1.2.1 中国古代国防"),
            zhsVideo(74150643, 1000244476, 497, false, "1.2.2 近代国防的屈辱"),
          ],
        },
      ],
    },
    {
      chapterId: 1000116294,
      name: "第二章 国家安全",
      learningLessonStatus: 0,
      isPass: 0,
      limitChecked: false,
      lessons: [
        {
          lessonId: 1000337360,
          name: "2.1 国家安全形势",
          isStudied: 0,
          videoId: null,
          videoSec: null,
          videos: [
            zhsVideo(75000111, 1000245001, 703, false, "2.1.1 当前我国国家安全形势分析"),
          ],
        },
      ],
    },
  ]);
}

/** Wrap a demo tree with the counts the real backend now returns. */
function zhsDetailWithCounts(
  course: ZhsCourse,
  chapters: ZhsCourseDetail["chapters"],
): ZhsCourseDetail {
  let totalVideos = 0;
  let completedVideos = 0;
  for (const chapter of chapters) {
    for (const lesson of chapter.lessons) {
      const videos: ZhsVideo[] =
        lesson.videos.length > 0
          ? lesson.videos
          : lesson.videoId !== null && lesson.videoSec !== null
            ? [
                {
                  videoId: lesson.videoId,
                  lessonVideoId: lesson.lessonId,
                  videoSec: lesson.videoSec,
                  isStudied: lesson.isStudied,
                  name: lesson.name,
                },
              ]
            : [];
      totalVideos += videos.length;
      completedVideos += videos.filter(
        (video) => (video.isStudied ?? 0) !== 0,
      ).length;
    }
  }
  return { course, chapters, totalVideos, completedVideos };
}

const zhsMeets: ZhsMeet[] = [
  {
    meetCourseId: 9001,
    liveId: 66001,
    videoId: 770001,
    recruitId: 463667,
    courseId: 1000011214,
    name: "见面课 1 · 国家安全形势分析",
    teacher: "李教授",
    startTime: "2026-10-12 19:00:00",
    endTime: "2026-10-12 20:30:00",
    replayUrl: "https://lc.zhihuishu.com/live/vod_room.html?liveId=66001",
    examUrl: null,
    durationSecs: 3600,
    status: 1,
  },
  {
    meetCourseId: 9002,
    liveId: 66002,
    videoId: 770002,
    recruitId: 463667,
    courseId: 1000011214,
    name: "见面课 2 · 军事思想",
    teacher: "王教授",
    startTime: "2026-10-26 19:00:00",
    endTime: "2026-10-26 20:30:00",
    replayUrl: "https://lc.zhihuishu.com/live/vod_room.html?liveId=66002",
    examUrl: null,
    durationSecs: 1800,
    status: 1,
  },
  {
    meetCourseId: 9003,
    liveId: 66003,
    videoId: null,
    recruitId: 463667,
    courseId: 1000011214,
    name: "见面课 3 · 现场研讨（仅直播）",
    teacher: "李教授",
    startTime: "2026-11-09 19:00:00",
    endTime: null,
    replayUrl: null,
    examUrl: null,
    durationSecs: null,
    status: 0,
  },
];

const zhsWatched = new Map<number, number[]>([
  [66001, Array.from({ length: 38 }, (_, index) => index + 1)],
  [66002, []],
]);

function requireZhsSession(): void {
  if (session?.platform !== "zhihuishu") {
    throw new Error("尚未连接知到账号，请先在连接页选择知到并登录");
  }
}

function zhsCourse(ref: string): ZhsCourse {
  const match = zhsCourses.find(
    (course) =>
      String(course.courseId) === ref ||
      String(course.recruitId) === ref ||
      course.name === ref,
  );
  if (match) return match;
  const numbers = (ref.match(/\d{4,}/g) ?? []).map(Number);
  const decoded = zhsCourses.find(
    (course) =>
      numbers.includes(course.recruitId) || numbers.includes(course.courseId),
  );
  if (decoded) return decoded;
  throw new Error(
    "演示数据中没有该课程；请从演示课程卡片进入，或粘贴包含演示课程编号的学习页链接。",
  );
}

function zhsWatchLabel(
  course: ZhsCourse,
  chapter: string,
  lesson: string,
  video: ZhsVideo,
): string {
  const parts = [course.name || `课程 ${course.courseId}`, chapter];
  if (lesson) parts.push(lesson);
  if (video.name) parts.push(video.name);
  return parts.join(" / ");
}

// ---- Ulearning (优学院) demo data -----------------------------------------
// Synthetic course trees; the demo backend never claims a real completion.

const ulCourses: UlCourse[] = [
  {
    textbookId: 47353,
    ocId: 165508,
    classId: 1019700,
    name: "军事理论（优学院）",
    author: "张教授",
    remainingSecs: 30 * 86400,
    expired: false,
  },
  {
    textbookId: 48001,
    ocId: 166001,
    classId: 1020001,
    name: "大学生心理健康（优学院）",
    author: "刘老师",
    remainingSecs: 10 * 86400,
    expired: false,
  },
];

function ulPage(
  id: number,
  relationId: number,
  name: string,
  contentType: number,
): UlPage {
  const kind =
    contentType === 6 ? "video" : contentType === 7 ? "practice" : "document";
  return { id, relationId, name, contentType, kind };
}

function ulSection(
  id: number,
  idForClass: number,
  name: string,
  pages: UlPage[],
): UlSection {
  return { id, idForClass, name, hide: null, pages, completed: null };
}

const ulTrees: Record<number, UlChapter[]> = {
  47353: [
    {
      id: 1001,
      idForClass: 2001,
      name: "第一章 中国国防",
      hide: null,
      sections: [
        ulSection(2377981, 3001, "1.1 国防概述", [
          ulPage(4001, 5001, "国防的含义", 6),
          ulPage(4002, 5002, "现代国防的特征", 6),
          ulPage(4003, 5003, "国防概述讲义", 5),
        ]),
        ulSection(2377982, 3002, "1.2 国防历史", [
          ulPage(4004, 5004, "中国古代国防", 6),
          ulPage(4005, 5005, "国防历史练习", 7),
        ]),
      ],
    },
    {
      id: 1002,
      idForClass: 2002,
      name: "第二章 国家安全",
      hide: null,
      sections: [
        ulSection(2377983, 3003, "2.1 国家安全形势", [
          ulPage(4006, 5006, "当前国家安全形势分析", 6),
          ulPage(4007, 5007, "阅读材料", 5),
        ]),
      ],
    },
  ],
  48001: [
    {
      id: 1101,
      idForClass: 2101,
      name: "第一章 绪论",
      hide: null,
      sections: [
        ulSection(2380001, 3101, "1.1 心理健康概述", [
          ulPage(4101, 5101, "心理健康的标准", 6),
        ]),
        ulSection(2380002, 3102, "1.2 常见心理困扰", [
          ulPage(4102, 5102, "常见的心理困扰", 6),
          ulPage(4103, 5103, "章节练习", 7),
        ]),
      ],
    },
  ],
};

/** Section completion demo data (`completion_status == 1`). */
const ulCompletion = new Map<number, boolean>([
  [2377981, true],
  [2377982, false],
  [2377983, true],
  [2380001, true],
  [2380002, false],
]);

function requireUlSession(): void {
  if (session?.platform !== "ulearning") {
    throw new Error("尚未连接优学院账号，请先在连接页选择优学院并登录");
  }
}

function ulCourse(ref: string): UlCourse {
  const match = ulCourses.find(
    (course) =>
      String(course.textbookId) === ref ||
      (course.ocId !== null && String(course.ocId) === ref) ||
      (course.classId !== null && String(course.classId) === ref) ||
      course.name === ref,
  );
  if (match) return match;
  const numbers = (ref.match(/\d{4,}/g) ?? []).map(Number);
  const decoded = ulCourses.find(
    (course) =>
      numbers.includes(course.textbookId) ||
      (course.ocId !== null && numbers.includes(course.ocId)) ||
      (course.classId !== null && numbers.includes(course.classId)),
  );
  if (decoded) return decoded;
  throw new Error(
    "演示数据中没有该课程；请从演示课程卡片进入，或粘贴包含演示课程编号的播放器链接。",
  );
}

function ulChaptersFor(course: UlCourse): UlChapter[] {
  return clone(ulTrees[course.textbookId] ?? []);
}

function ulSectionList(chapters: UlChapter[]): UlSection[] {
  return chapters.flatMap((chapter) => chapter.sections);
}

function ulPageCounts(chapters: UlChapter[]): {
  video: number;
  practice: number;
  document: number;
} {
  const counts = { video: 0, practice: 0, document: 0 };
  for (const section of ulSectionList(chapters)) {
    for (const page of section.pages) counts[page.kind] += 1;
  }
  return counts;
}

function ulCheckFor(course: UlCourse): UlCheck {
  const chapters = ulChaptersFor(course);
  const sections = ulSectionList(chapters);
  for (const section of sections) {
    section.completed = ulCompletion.get(section.id) ?? false;
  }
  const counts = ulPageCounts(chapters);
  return {
    course: clone(course),
    chapters,
    remainingSecs: course.remainingSecs,
    className: `教学班 ${course.classId ?? "未知"}`,
    expired: course.expired,
    sectionCount: sections.length,
    completedSections: sections.filter((section) => section.completed === true)
      .length,
    videoPages: counts.video,
    practicePages: counts.practice,
    documentPages: counts.document,
    cancelled: false,
  };
}

// ---- Zhihuishu homework / exam demo data ----------------------------------
// Synthetic exam data. The demo backend never claims a real submission and the
// final exam is list-only (same as the real backend).

const zhsExamQuestions: ZhsExamQuestion[] = [
  {
    id: "demo-q-1",
    stem: "中国国防的主体是（ ）。",
    kindId: 1,
    kindName: "单选题",
    score: 10,
    multiple: false,
    options: [
      { id: "demo-o-1a", content: "国家" },
      { id: "demo-o-1b", content: "军队" },
      { id: "demo-o-1c", content: "人民" },
      { id: "demo-o-1d", content: "政府" },
    ],
  },
  {
    id: "demo-q-2",
    stem: "现代国防的基本特征包括（ ）。",
    kindId: 2,
    kindName: "多选题",
    score: 10,
    multiple: true,
    options: [
      { id: "demo-o-2a", content: "国防力量的综合性" },
      { id: "demo-o-2b", content: "国防手段的多样性" },
      { id: "demo-o-2c", content: "国防建设的系统性" },
      { id: "demo-o-2d", content: "国防斗争的威慑性" },
    ],
  },
  {
    id: "demo-q-3",
    stem: "国防是国家生存与发展的安全保障。",
    kindId: 3,
    kindName: "判断题",
    score: 10,
    multiple: false,
    options: [
      { id: "demo-o-3a", content: "正确" },
      { id: "demo-o-3b", content: "错误" },
    ],
  },
];

function zhsDemoPaper(examName: string, courseName: string): ZhsExamPaper {
  return {
    examName,
    courseName,
    totalScore: 100,
    problemNum: zhsExamQuestions.length,
    questionCount: zhsExamQuestions.length,
    questions: clone(zhsExamQuestions),
  };
}

function zhsDemoPlan(examName: string): ZhsExamPlan {
  const paper = zhsDemoPaper(examName, "军事理论-综合版");
  const resolved: ZhsExamPlan["questions"] = [
    {
      question: paper.questions[0],
      optionIds: ["demo-o-1a"],
      optionContents: ["国家"],
      source: "submitted",
    },
    {
      question: paper.questions[1],
      optionIds: ["demo-o-2a", "demo-o-2c"],
      optionContents: ["国防力量的综合性", "国防建设的系统性"],
      source: "ai_analysis",
    },
  ];
  return {
    examId: "demo-exam-3",
    examName: paper.examName,
    totalScore: paper.totalScore,
    questionCount: paper.questionCount,
    resolved: resolved.length,
    unresolved: [
      {
        questionId: paper.questions[2].id,
        stem: paper.questions[2].stem,
      },
    ],
    complete: false,
    questions: resolved,
  };
}

const zhsExamUnsubmitted: ZhsExamList = {
  submitted: false,
  homework: [
    {
      stuExamId: "demo-hw-2",
      examId: "demo-exam-2",
      name: "第二章单元测试",
      state: 0,
      achieve: null,
      achieveCount: 0,
      backNum: 2,
      score: null,
      problemNum: 10,
      totalScore: 100,
      meetCourseType: null,
      chapterId: "1000116294",
      isCheckAnswer: 1,
      examUserName: "张教授",
    },
  ],
  finals: [
    {
      stuExamId: "demo-final",
      examId: "demo-final-exam",
      name: "军事理论-综合版教程考试（期末）",
      problemNum: 68,
      totalScore: 100,
      limitTime: 90,
      remainCount: 1,
      finalExam: true,
    },
  ],
  finalsError: null,
};

const zhsExamSubmitted: ZhsExamList = {
  submitted: true,
  homework: [
    {
      stuExamId: "demo-hw-3",
      examId: "demo-exam-3",
      name: "第三章单元测试",
      state: 1,
      achieve: 100,
      achieveCount: 1,
      backNum: 2,
      score: 100,
      problemNum: 10,
      totalScore: 100,
      meetCourseType: null,
      chapterId: "1000116294",
      isCheckAnswer: 1,
      examUserName: "张教授",
    },
    {
      stuExamId: "demo-meet-quiz",
      examId: "demo-exam-meet",
      name: "见面课测验（从白马庙到星辰大海）",
      state: 1,
      achieve: 20,
      achieveCount: 1,
      backNum: 1,
      score: 20,
      problemNum: 5,
      totalScore: 100,
      meetCourseType: 1,
      chapterId: null,
      isCheckAnswer: 1,
      examUserName: "李教授",
    },
  ],
  finals: [],
  finalsError: null,
};

let zhsDemoBankTotal = 3;
let zhsDemoAiEntries = 1;
export const mockApi = {
  async sessionInfo(): Promise<SessionInfo | null> {
    await sleep(120);
    return session;
  },

  async openLoginWindow(platform: Platform): Promise<void> {
    await sleep(250);
    loginGeneration += 1;
    const generation = loginGeneration;
    if (loginTimer !== undefined) window.clearTimeout(loginTimer);
    loginTimer = window.setTimeout(() => {
      loginTimer = undefined;
      if (generation !== loginGeneration) return;
      session =
        platform === "zhihuishu"
          ? {
              platform: "zhihuishu",
              cookieSource: "知到网页登录（演示）",
              cookieCount: 14,
            }
          : platform === "ulearning"
            ? {
                platform: "ulearning",
                cookieSource: "优学院网页登录（演示）",
                cookieCount: 9,
              }
            : {
                platform: "hust",
                cookieSource: "HUST 统一身份认证",
                cookieCount: 18,
              };
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

  async completeDocuments(request: DocumentRequest): Promise<DocumentSummary> {
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
    const dryRun = request.dryRun === true;

    demoEmit("job-progress", { kind: "crawl", done: 0, total: totalLeaves });
    for (let done = 1; done <= totalLeaves; done += 1) {
      await sleep(150);
      if (cancelled) {
        return {
          total: 0,
          completed: 0,
          failed: 0,
          cancelled: true,
          dryRun,
          errors: [],
          documents: [],
        };
      }
      demoEmit("job-progress", { kind: "crawl", done, total: totalLeaves });
    }

    let targets = allTaskPoints(detail.chapters)
      .map(({ chapter, point }) => ({ chapter, point }))
      .filter(({ point }) => point.kind === "document")
      .filter(({ point }) => request.includeCompleted || point.completed !== true)
      .filter(({ point }) => !request.job || point.job_id === request.job);
    if (request.job && targets.length === 0) {
      throw new Error("没有找到该文档任务点");
    }
    if (request.maxDocuments) {
      targets = targets.slice(0, Math.max(1, request.maxDocuments));
    }

    const total = targets.length;
    demoEmit("job-progress", { kind: "documentPlan", total, dryRun });

    const documents: DocumentSummary["documents"] = [];
    let completed = 0;
    let failed = 0;
    const errors: string[] = [];
    let wasCancelled = false;

    for (const [offset, { chapter, point }] of targets.entries()) {
      if (cancelled) {
        wasCancelled = true;
        break;
      }
      const index = offset + 1;
      const jobId = point.job_id ?? "";
      demoEmit("job-progress", {
        kind: "document",
        index,
        total,
        chapter: chapter.title,
        name: point.name,
        jobId,
        status: "running",
        message: null,
      });
      await sleep(420);

      if (dryRun) {
        // The demo is intentionally honest: a dry run never touches the network.
        const message = "演示模式：试运行不会向平台发送任何请求";
        documents.push({
          jobId,
          name: point.name,
          chapter: chapter.title,
          status: "dry_run",
          message,
        });
        demoEmit("job-progress", {
          kind: "document",
          index,
          total,
          chapter: chapter.title,
          name: point.name,
          jobId,
          status: "dry_run",
          message,
        });
        continue;
      }

      // Simulated only; the real backend reports /mooc-ans/job/document and
      // requires the server's `status: true`.
      const message = "演示模式：已模拟完成，未向平台发送请求";
      completed += 1;
      point.completed = true;
      documents.push({
        jobId,
        name: point.name,
        chapter: chapter.title,
        status: "completed",
        message,
      });
      demoEmit("job-progress", {
        kind: "document",
        index,
        total,
        chapter: chapter.title,
        name: point.name,
        jobId,
        status: "completed",
        message,
      });
    }

    return {
      total,
      completed,
      failed,
      cancelled: wasCancelled,
      dryRun,
      errors,
      documents,
    };
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

  // ---- Zhihuishu (知到) demo backend ------------------------------------
  // Every job below is dry-run only: the demo never claims a report the
  // platform did not confirm.
  async zhsListCourses(): Promise<ZhsCourse[]> {
    requireZhsSession();
    await sleep(240);
    return clone(zhsCourses);
  },

  async zhsAddCourse(reference: string): Promise<ZhsCourse> {
    requireZhsSession();
    await sleep(240);
    return clone(zhsCourse(reference.trim()));
  },

  async zhsCourseDetail(courseId: string): Promise<ZhsCourseDetail> {
    requireZhsSession();
    const course = zhsCourse(courseId);
    const detail = zhsDetailFor(course);
    const total = Math.max(1, detail.chapters.reduce(
      (sum, chapter) => sum + chapter.lessons.length,
      0,
    ));
    demoEmit("job-progress", {
      kind: "zhsStage",
      job: "zhs-load",
      stage: "loading",
      done: 0,
      total,
      label: course.name,
      message: "抓取视频树",
    });
    for (let done = 1; done <= total; done += 1) {
      await sleep(160);
      if (cancelled) throw new Error("已取消");
      demoEmit("job-progress", {
        kind: "zhsStage",
        job: "zhs-load",
        stage: "loading",
        done,
        total,
        label: course.name,
        message: "抓取视频树",
      });
    }
    return clone(detail);
  },

  async zhsWatchVideos(request: ZhsWatchRequest): Promise<ZhsWatchSummary> {
    requireZhsSession();
    if (request.dryRun === false) {
      throw new Error("演示模式仅支持试运行；请连接真实知到账号后执行。");
    }
    cancelled = false;
    const course = zhsCourse(request.course);
    const detail = zhsDetailFor(course);
    const all = detail.chapters.flatMap((chapter) =>
      chapter.lessons.flatMap((lesson) =>
        lesson.videos.map((video) => ({
          label: zhsWatchLabel(course, chapter.name, lesson.name, video),
          completed: (video.isStudied ?? 0) !== 0,
        })),
      ),
    );
    let planned = all.filter(
      (target) => request.includeCompleted === true || !target.completed,
    );
    if (request.maxVideos) {
      planned = planned.slice(0, Math.max(1, request.maxVideos));
    }
    demoEmit("job-progress", {
      kind: "zhsPlan",
      job: "zhs-watch",
      stage: "videos",
      total: planned.length,
      dryRun: true,
      // Skipped means "already recorded complete", not "capped by maxVideos".
      skipped: request.includeCompleted
        ? 0
        : all.filter((target) => target.completed).length,
    });
    const outcomes: ZhsVideoOutcome[] = [];
    for (const [offset, target] of planned.entries()) {
      if (cancelled) break;
      const index = offset + 1;
      demoEmit("job-progress", {
        kind: "zhsStage",
        job: "zhs-watch",
        stage: "videos",
        done: offset,
        total: planned.length,
        label: target.label,
        message: "预演：构造上报字段",
      });
      await sleep(260);
      const outcome: ZhsVideoOutcome = {
        label: target.label,
        state: "dry_run",
        watchState: null,
        message: "演示模式：已生成 sdsew/ewssw，未发送",
      };
      outcomes.push(outcome);
      demoEmit("job-progress", {
        kind: "zhsTarget",
        job: "zhs-watch",
        index,
        total: planned.length,
        label: outcome.label,
        status: "dry_run",
        message: outcome.message,
        targetMinutes: null,
        watchedBefore: null,
      });
    }
    if (cancelled) {
      outcomes.push({
        label: course.name,
        state: "cancelled",
        watchState: null,
        message: "已取消",
      });
    }
    return {
      total: planned.length,
      ok: 0,
      skipped: outcomes.filter(
        (outcome) => outcome.state === "skip" || outcome.state === "dry_run",
      ).length,
      failed: 0,
      cancelled,
      dryRun: true,
      outcomes,
      errors: [],
    };
  },

  async zhsMeetList(courseId: string): Promise<ZhsMeet[]> {
    requireZhsSession();
    await sleep(200);
    const course = zhsCourse(courseId);
    return clone(
      zhsMeets.filter((meet) => meet.recruitId === course.recruitId),
    );
  },

  async zhsMeetProgress(
    courseId: string,
    meetId: number,
  ): Promise<ZhsMeetProgress> {
    requireZhsSession();
    await sleep(140);
    const course = zhsCourse(courseId);
    const meet = zhsMeets.find(
      (item) =>
        item.recruitId === course.recruitId && item.meetCourseId === meetId,
    );
    if (!meet) throw new Error("演示数据中没有该见面课");
    const totalMinutes = Math.max(1, Math.ceil((meet.durationSecs ?? 0) / 60));
    const watched = zhsWatched.get(meet.liveId) ?? [];
    return {
      totalMinutes,
      watchedMinutes: [...watched],
      watchedCount: watched.length,
      percent: Math.min(
        100,
        Math.round((watched.length / totalMinutes) * 100),
      ),
    };
  },

  async zhsMeetWatch(
    request: ZhsMeetWatchRequest,
  ): Promise<ZhsMeetWatchSummary> {
    requireZhsSession();
    if (request.dryRun === false) {
      throw new Error("演示模式仅支持试运行；请连接真实知到账号后执行。");
    }
    cancelled = false;
    const course = zhsCourse(request.course);
    const replayable = zhsMeets.filter(
      (meet) =>
        meet.recruitId === course.recruitId &&
        meet.liveId !== 0 &&
        (meet.replayUrl ?? "").trim() !== "",
    );
    const selected = request.meet
      ? replayable.filter((meet) => meet.meetCourseId === request.meet)
      : replayable;
    if (request.meet && selected.length === 0) {
      throw new Error("演示数据中没有该见面课");
    }
    const asFraction = (value: number | undefined, fallback: number): number => {
      const raw = value ?? fallback;
      return Math.min(1, Math.max(0.01, raw > 1 ? raw / 100 : raw));
    };
    const coverageMin = asFraction(request.coverageMin, 0.9);
    const coverageMax = Math.max(
      coverageMin,
      asFraction(request.coverageMax, 1),
    );
    demoEmit("job-progress", {
      kind: "zhsPlan",
      job: "zhs-meet-watch",
      stage: "meet",
      total: selected.length,
      dryRun: true,
      skipped: replayable.length - selected.length,
    });
    const outcomes: ZhsMeetOutcome[] = [];
    for (const [offset, meet] of selected.entries()) {
      if (cancelled) break;
      const index = offset + 1;
      const totalMinutes = Math.max(
        1,
        Math.ceil((meet.durationSecs ?? 0) / 60),
      );
      const watched = zhsWatched.get(meet.liveId) ?? [];
      const coverage = (coverageMin + coverageMax) / 2;
      const target = Math.min(
        totalMinutes,
        Math.max(1, Math.ceil(totalMinutes * coverage)),
      );
      demoEmit("job-progress", {
        kind: "zhsTarget",
        job: "zhs-meet-watch",
        index,
        total: selected.length,
        label: meet.name,
        status: "running",
        message: "读取回放进度与已看分钟",
        targetMinutes: target,
        watchedBefore: watched.length,
      });
      await sleep(320);
      const state = watched.length >= target ? "skip" : "dry_run";
      const message =
        state === "skip"
          ? `已看 ${watched.length} 分钟，已达到目标 ${target} 分钟，跳过`
          : `演示模式：目标 ${target}/${totalMinutes} 分钟（随机 ${Math.round(
              coverageMin * 100,
            )}–${Math.round(
              coverageMax * 100,
            )}%），未上报任何分钟`;
      outcomes.push({
        label: meet.name,
        targetMinutes: target,
        watchedBefore: watched.length,
        submitted: 0,
        skipped: 0,
        failed: 0,
        watchedAfter: null,
        state,
        message,
      });
      demoEmit("job-progress", {
        kind: "zhsTarget",
        job: "zhs-meet-watch",
        index,
        total: selected.length,
        label: meet.name,
        status: state,
        message,
        targetMinutes: target,
        watchedBefore: watched.length,
      });
    }
    if (cancelled) {
      outcomes.push({
        label: course.name,
        targetMinutes: 0,
        watchedBefore: 0,
        submitted: 0,
        skipped: 0,
        failed: 0,
        watchedAfter: null,
        state: "cancelled",
        message: "已取消",
      });
    }
    return {
      meets: selected.length,
      submitted: 0,
      skipped: outcomes.filter(
        (outcome) => outcome.state === "skip" || outcome.state === "dry_run",
      ).length,
      failed: 0,
      cancelled,
      dryRun: true,
      outcomes,
      errors: [],
    };
  },

  async zhsExceptionStatus(): Promise<ZhsExceptionStatus> {
    requireZhsSession();
    await sleep(120);
    return {
      lock: false,
      abnormal: false,
      message: "演示模式：未查询真实风控状态，仅用于界面预览",
    };
  },

  async zhsCancelJob(): Promise<void> {
    cancelled = true;
  },

  // ---- Zhihuishu homework / exam demo backend ---------------------------
  async zhsExamList(
    recruitId: number,
    courseId: number,
    submitted: boolean,
  ): Promise<ZhsExamList> {
    requireZhsSession();
    const course = zhsCourse(String(courseId));
    if (course.recruitId !== recruitId) {
      throw new Error("演示数据中没有该课程");
    }
    await sleep(220);
    return clone(submitted ? zhsExamSubmitted : zhsExamUnsubmitted);
  },

  async zhsExamPaper(
    _recruitId: number,
    _courseId: number,
    _examId: string,
    submitted: boolean,
  ): Promise<ZhsExamPaper> {
    requireZhsSession();
    await sleep(180);
    if (!submitted) {
      throw new Error(
        "未开始的试卷无法只读预览（进入考试会开始计时，已阻止）；演示模式请使用「重做并提交」查看计划。",
      );
    }
    return zhsDemoPaper("第三章单元测试", "军事理论-综合版");
  },

  async zhsExamPlan(
    _recruitId: number,
    _courseId: number,
    examId: string,
  ): Promise<ZhsExamPlan> {
    requireZhsSession();
    await sleep(220);
    if (examId === "demo-final-exam") {
      throw new Error(
        "期末/教程考试只有 1 次机会，GUI 仅支持查看，不生成答题计划、不自动提交",
      );
    }
    return zhsDemoPlan(
      examId === "demo-exam-2" ? "第二章单元测试" : "第三章单元测试",
    );
  },

  async zhsExamAnswer(
    _recruitId: number,
    _courseId: number,
    examId: string,
    dryRun: boolean,
  ): Promise<ZhsAnswerResult> {
    requireZhsSession();
    if (examId === "demo-final-exam") {
      throw new Error(
        "期末/教程考试只有 1 次机会，GUI 不支持自动提交",
      );
    }
    if (dryRun) {
      const plan = zhsDemoPlan("第三章单元测试");
      return {
        dryRun: true,
        plan,
        submitted: false,
        score: null,
        totalScore: plan.totalScore,
        correctCount: 0,
        questionCount: plan.questionCount,
        perQuestion: [],
        message: "试运行：只生成答题计划，没有进入考试、保存或提交。",
        recordedToBank: 0,
      };
    }
    throw new Error(
      "演示模式不会提交真实试卷；请连接真实知到账号并在确认后执行。",
    );
  },

  async zhsExamBankInfo(): Promise<ZhsBankInfo> {
    requireZhsSession();
    await sleep(120);
    return {
      total: zhsDemoBankTotal,
      submittedEntries: 2,
      aiEntries: zhsDemoAiEntries,
      updatedAtUnix: Math.floor(Date.now() / 1000) - 3600,
      path: "（演示）应用数据目录/zhihuishu-answer-bank.json",
    };
  },

  async zhsExamRecordAi(
    _recruitId: number,
    _courseId: number,
    _examId: string,
    entries: ZhsAiEntry[],
  ): Promise<ZhsRecordAiResult> {
    requireZhsSession();
    const usable = entries.filter(
      (entry) => typeof entry.text === "string" && entry.text.trim().length > 0,
    );
    if (usable.length === 0) {
      throw new Error("没有可写入的 AI解析 文本");
    }
    await sleep(200);
    zhsDemoBankTotal += usable.length;
    zhsDemoAiEntries += usable.length;
    const event = {
      recorded: usable.length,
      skipped: entries.length - usable.length,
      bankTotal: zhsDemoBankTotal,
    };
    demoEmit("zhs-exam-ai", event);
    return {
      ...event,
      skippedQuestionIds: [],
      path: "（演示）应用数据目录/zhihuishu-answer-bank.json",
    };
  },

  async zhsExamOpenCheckWindow(): Promise<void> {
    requireZhsSession();
    throw new Error(
      "演示模式不支持打开采集窗口；可用「手动导入」体验答案库写入。",
    );
  },

  async zhsExamOpenAttemptWindow(): Promise<void> {
    requireZhsSession();
    throw new Error(
      "演示模式不支持打开网页作答窗口（滑块验证需要真实知到会话）；可用「看试卷 / 手动导入 / 题库统计」体验只读流程。",
    );
  },
  async zhsExamSummary(): Promise<ZhsExamSummary> {
    requireZhsSession();
    return {
      homeworkTotal: 5,
      homeworkSubmitted: 3,
      averageScore: 87.5,
      finalExamCount: 1,
      finalExamSubmitted: 0,
    };
  },
  async zhsExamRedo(): Promise<ZhsRedoResult> {
    requireZhsSession();
    throw new Error(
      "演示模式不支持申请重做；真实平台参数仍在抓包确认中（applyRedo），接入后会自动刷新并打开作答窗口。",
    );
  },
  // ---- Ulearning (优学院) demo backend ----------------------------------
  // Like the Zhihuishu demo, every job below is dry-run only.
  async ulListCourses(): Promise<UlCourse[]> {
    requireUlSession();
    await sleep(220);
    return clone(ulCourses);
  },

  async ulCourseDetail(courseId: string): Promise<UlCourseDetail> {
    requireUlSession();
    const course = ulCourse(courseId);
    const chapters = ulChaptersFor(course);
    const total = Math.max(1, ulSectionList(chapters).length);
    demoEmit("job-progress", {
      kind: "ulStage",
      job: "ul-load",
      stage: "directory",
      done: 0,
      total,
      label: course.name,
      message: "读取课程目录",
    });
    for (let done = 1; done <= total; done += 1) {
      await sleep(140);
      if (cancelled) throw new Error("已取消");
      demoEmit("job-progress", {
        kind: "ulStage",
        job: "ul-load",
        stage: "directory",
        done,
        total,
        label: course.name,
        message: "读取课程目录",
      });
    }
    return {
      course: clone(course),
      chapters,
      remainingSecs: course.remainingSecs,
      className: `教学班 ${course.classId ?? "未知"}`,
      expired: course.expired,
    };
  },

  async ulCheck(courseId: string): Promise<UlCheck> {
    requireUlSession();
    cancelled = false;
    const check = ulCheckFor(ulCourse(courseId));
    const sections = ulSectionList(check.chapters);
    for (const [index, section] of sections.entries()) {
      if (cancelled) {
        check.cancelled = true;
        break;
      }
      await sleep(160);
      demoEmit("job-progress", {
        kind: "ulStage",
        job: "ul-check",
        stage: "verify",
        done: index + 1,
        total: sections.length,
        label: section.name,
        message: "读取学习记录",
      });
    }
    return check;
  },

  async ulWatch(request: UlWatchRequest): Promise<UlWatchSummary> {
    requireUlSession();
    if (request.dryRun === false) {
      throw new Error("演示模式仅支持试运行；请连接真实优学院账号后执行。");
    }
    cancelled = false;
    const course = ulCourse(request.course);
    const chapters = ulChaptersFor(course);
    const all = ulSectionList(chapters);
    let plans = all.filter(
      (section) =>
        request.includeCompleted === true ||
        ulCompletion.get(section.id) !== true,
    );
    if (request.maxSections) {
      plans = plans.slice(0, Math.max(1, request.maxSections));
    }
    demoEmit("job-progress", {
      kind: "ulPlan",
      job: "ul-watch",
      total: all.length,
      actionable: plans.length,
      skipped: all.length - plans.length,
      dryRun: true,
    });
    const outcomes: UlOutcome[] = [];
    for (const [index, section] of plans.entries()) {
      if (cancelled) break;
      await sleep(180);
      const completed = ulCompletion.get(section.id) === true;
      const action = completed
        ? "skip_done"
        : section.pages.some((page) => page.kind === "practice")
          ? "complete_practice"
          : "complete";
      const state = completed ? "skip" : "dry_run";
      const message = completed
        ? "平台已标记完成，跳过"
        : "演示模式：已生成 sync 计划与 payload 摘要，未发送";
      outcomes.push({
        label: section.name,
        sectionId: section.id,
        action,
        state,
        completionStatus: completed ? 1 : 0,
        message,
      });
      demoEmit("job-progress", {
        kind: "ulTarget",
        job: "ul-watch",
        index: index + 1,
        total: plans.length,
        label: section.name,
        status: state,
        message,
        completionStatus: completed ? 1 : 0,
      });
    }
    if (cancelled) {
      outcomes.push({
        label: course.name,
        sectionId: 0,
        action: "skip_done",
        state: "cancelled",
        completionStatus: null,
        message: "已取消",
      });
    }
    return {
      total: all.length,
      ok: 0,
      skipped: outcomes.filter(
        (outcome) => outcome.state === "skip" || outcome.state === "dry_run",
      ).length,
      failed: 0,
      cancelled,
      dryRun: true,
      outcomes,
      errors: [],
    };
  },

  async ulCancelJob(): Promise<void> {
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