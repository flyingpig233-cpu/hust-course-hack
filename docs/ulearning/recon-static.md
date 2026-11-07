# 优学院（ulearning.cn）学生网页端 · 静态资源侦察报告

- 侦察方式：仅公开静态资源（无 cookie、无登录、未使用浏览器工具）。
- 关键约束：本会话的 `web_fetch` **拒绝 `application/javascript`**，且 `umooc/www` 强制 301 到 HTTPS、沙箱直连 TLS 失败；只有 `courseweb.ulearning.cn` 同时支持明文 HTTP，因此学生端 JS 全部用 `curl http://…` 抓取。
- HTTPS 页面（登录页、测验页）改用 `api.microlink.io` 代理取原始 HTML（返回 JSON 中的 HTML 字符串）。
- 学生端构建版本：`version=1.4.48`（`init.js?version=1.4.48`），HTML `Last-Modified: 2026-11-04`。

## 站点与域名

| 域名 / 前缀 | 职责 | 证据与置信度 |
| --- | --- | --- |
| `courseweb.ulearning.cn/ulearning/index.html` | **学生网页端主 SPA**（Knockout + RequireJS，hash 路由） | 直接抓取 HTTP 200、10655 字节；`<title>Ulearning</title>`（高） |
| `courseapi.ulearning.cn`（`API_SERVER_HOST`） | 课程/单元/作业/考试/公告等主 REST API | `config.js`：`var API_SERVER_HOST = protocol + "courseapi" + hostDomain;`（高） |
| `umooc.ulearning.cn`（`UMOOC_WEB_HOST`） | Vue 登录页 `pc.html#/login`，以及课程首页/课件页（`courseHome`、`courseFile`、`coursePage` chunk） | `https://umooc.ulearning.cn/pc.html` HTML 中 preload 了 `js/pc.58db394f.js`、`js/login.281cfe5c.js` 等（高） |
| `www.ulearning.cn`（`UMOOC_SERVER_HOST`） | 门户、旧版 Struts 端点（`/umooc/...`）、作业/测验/小组作业子应用宿主 | `config.js`：`UMOOC_SERVER_HOST = protocol + "www" + hostDomain`；`http://www.ulearning.cn/quiz/pc.html` 301→https（高） |
| `www.ulearning.cn/selfwork`（`SELFWORK_WEB_HOST`） | 个人作业（写作业 / 看批阅）Vue 子应用 | `SELFWORK_WEB_HOST + "/#/stuWriting/" + userId + "/" + homework.id`（高） |
| `www.ulearning.cn/quiz`（`QUIZ_WEB_HOST`） | 测验型作业（`#/stuGuide`、`#/analysis`） | `QUIZ_WEB_HOST + "/pc.html#/stuGuide?ocId="`（高） |
| `www.ulearning.cn/groupwork`（`GROUPWORK_WEB_HOST`） | 小组作业 | `GROUPWORK_WEB_HOST + "/pc.html#/doHomework/"`（高） |
| `utest.ulearning.cn`（`UTEST_WEB_HOST`） | 新版考试系统（`/ulearning/index.html#/exam/...`、`examBank.html`） | `examController.js`：`UTEST_WEB_HOST + "/ulearning/index.html#/help/env"`（高） |
| `classroomapi` / `classroom` / `smartclassroom` / `democlassroomapi` | 智慧课堂、录播、课堂报告 | `config.js` 中同名变量（高） |
| `homeworkapi` | 独立作业 API 域（当前构建里未见实际调用） | `var HOMEWORK_API_HOST = protocol + "homeworkapi" + hostDomain;`（中，仅定义） |
| `knowledgeapi` / `kg` | 知识图谱 | `KG_API_HOST` + `/knowledgeGraph/ocRelation?ocId=`（高） |
| `eportfolio` | 学业档案 | `EPORTFOLIO_API_HOST + "/eportfolio/eportfolio/pageMyEportfolio"`（高） |
| `ua` / `rsglapi` / `servermonitorapi` / `cloudsearchapi` | 用户中心、资源管理、监控、AI 检索 | `config.js` 变量定义（中） |
| `static.ulearning.cn/static/course_web` | 课程静态资源 CDN | `STATIC_SERVER_HOST = "https://static.ulearning.cn/static/course_web"`（高） |
| `docs.ulearning.cn` / `convert` / `download` / `up.qbox.me` | 文档预览、转换、下载、七牛上传 | `config.js`（高） |
| `saml.ulearning.asia`、`auth.dgut.edu.cn`（CAS） | SAML / 东莞理工 CAS 单点登录与注销 | `User.js`：`https://auth.dgut.edu.cn/authserver/logout?service=…`（高） |
| `.tongshike.cn`、`.ulearning.app`、`zambialearning.net` | 测试/海外部署域名分支 | `config.js`：`isTest = hostDomain === ".tongshike.cn"`（高） |

## 前端技术栈

学生端（`courseweb` 的 `/ulearning/`）**不是** Vue/Vite，而是「jQuery + Knockout + RequireJS」的传统 AMD 多页内嵌 SPA：

- 框架：**Knockout 3.4.2**（`ko.applyBindings(new mainController())`、`ko.components.register`）；jQuery 3.4.1 + 1.12.4 双载；Bootstrap 3.3.7。
- 打包/加载：**RequireJS 2.3.5**，`<script data-main="./init.js?version=1.4.48" src="../common/vendor/require.js-2.3.5/require.min.js">`；无 webpack/vite 产物，模块按文件加载（`urlArgs: "version=1.4.48"`）。
- 路由：hash 路由，路由表是普通对象（`"/course/announcement": { rule: { template, viewModel }, title, params }`），非 vue-router；`director 1.2.8` 被声明为模块但主流程用自研路由表。
- 其他库：Tolgee（i18n）、fullcalendar 4.4.0、jwplayer / mediaelement（视频）、highcharts/echarts、pdf.js、ckeditor、plupload、qiniu/华为 OBS、jsSHA、DOMPurify、vConsole。
- 登录页/测验页是 **Vue CLI 4/5（webpack）** 产物：`chunk-vendors`、`chunk-common`、按路由拆分的 `login.*.js`、`courseHome.*.js`、`quiz/static/js/pc.*.js`（文件名带 contenthash）。
- 遗留调试痕迹：HTML 里残留 weinre 脚本 `src="http://192.168.1.98:7700/target/target-script-min.js#anonymous"` 与 `vconsole.min.js`（生产包内，属信息泄露，低风险）。

## 路由清单

学生端 hash 路由（`#/...`）。顶层路由来自 `mainController.js`，课程内路由来自 `module/course/courseController.js`。

| hash 路由 | 推测页面 | 证据（controller / 标题） |
| --- | --- | --- |
| `#/index`（默认 `#/index/portal`） | 首页/门户 | `mainController.js`：`window.location.hash = "#/index/portal"`；`module/index/indexController` |
| `#/course` | 课程外壳 | `module/course/courseController`，标题"优学院" |
| `#/course/content` | 课程内容（目录） | `module/course/courseContent/courseContentController` |
| `#/course/units` | 单元/章节 | `module/course/courseUnits/courseUnitsController` |
| `#/course/announcement` | 课程公告 | `module/course/courseAnnouncement/courseAnnouncementController` |
| `#/course/textbook` | 课件 | `module/course/textbook/courseTextbookController` |
| `#/course/homework` | 作业列表 | `module/course/courseHomework/courseHomeworkController` |
| `#/course/exam` | 考试列表 | `module/course/exam/examController` |
| `#/course/discussion`、`#/dataCenter/discussion` | 课程讨论 | `module/course/courseDiscussion/courseDiscussionController` |
| `#/course/knowledgeGraph` | 知识图谱 | `module/course/knowledgeGraph/knowledgeGraphController` |
| `#/course/resource` | 课程资源 | `module/course/courseResource/courseResourceController` |
| `#/course/analysis` | 课程分析 | `module/course/courseAnalysis/courseAnalysisController` |
| `#/course/assessment`、`#/dataCenter/assessment` | 课程考核 | 同上 controller，标题"课程考核" |
| `#/course/member`、`#/course/memberSpoc` | 课程成员 | `module/course/courseMember/courseMemberController` |
| `#/course/classroom` | 课堂（智慧教室） | `module/course/courseClassroom/courseClassroomController` |
| `#/course/live`、`#/course/liveAnalysis` | 直播/直播分析 | `module/course/courseLive/courseLiveController` |
| `#/course/virtual` | 实验 | `module/course/virtual/virtualController` |
| `#/course/settings` | 课程设置 | `module/course/courseSettings/courseSettingsController` |
| `#/course/lti` | LTI 工具 | `module/course/lti/ltiController` |
| `#/course/workbench` | AI 工作台 | `module/course/workbench/workbenchController` |
| `#/exam`、`#/exam/detail`、`#/exam/grade` | 考试/试卷详情/成绩 | `module/course/exam/wrapper/wrapperController`（标题"考试"） |
| `#/exam/statistic`、`#/exam/analysis` | 成绩统计/试题分析 | `module/course/exam/statistic/statisticController` |
| `#/exam/testAnalysis`、`#/exam/batchRemark` | 试题分析/批量批阅 | `module/course/exam/testAnalysis/testAnalysisController` |
| `#/exam/randomQuestions`、`#/exam/autoPaper`、`#/exam/paperLibrary` | 随机组卷/自动组卷/试卷库 | `mainController.js` 路由表 |
| `#/textbook/myTextbook`、`#/textbook/learningProgress`、`#/textbook/teachingPlan` | 我的教材/学习进度/学习计划 | `module/course/textbook/myTextbook/myTextbookController` |
| `#/textbookContent` | 课件内容 | `module/course/textbook/courseTextbookController` |
| `#/iCourse/stat` | 课件统计 | `module/course/textbook/iCourseStat/iCourseStatController` |
| `#/announcement`、`#/calendar` | 公告中心/活动日历 | `module/announcement/announcementController`、`module/calendar/calendarController` |
| `#/learning`、`#/user`、`#/eportfolio`、`#/order` | 优学院学习页/个人资料/学业档案/订单 | `mainController.js` 路由表 |
| `#/live/playback`、`#/live/setting`、`#/live/admin` | 直播回看/直播设置/直播管理 | `module/course/courseLive/*` |
| `#/help/env` | 考试环境检测 | `module/help/env/examEnvController`（另有 `utest/ulearning/index.html#/help/env`） |
| `#/certificate`、`#/setCertificate`、`#/selectCertificate` | 证书管理/设置/模板 | `module/course/certificate/*` |

路由参数约定（重要）：`courseId` 就是课程 `ocId`——`var courseId = getHashParam("courseId"); self.course = new Course(courseId);`，随后请求用 `ocId=` 传同名值。

## API 端点清单

基址：`API_SERVER_HOST = https://courseapi.ulearning.cn`（除非另注）。方法为 `?` 表示静态文本中看不出 HTTP 动词。

### 登录与会话

| 方法 | 路径 | 推测用途 | 证据/置信度 |
| --- | --- | --- | --- |
| POST | `/users/login` | 账号密码登录，body `{loginName, password}`，返回 `authorization` | `model/User.js` 完整 ajax 块（高） |
| GET | `/users/isValidToken/{token}` | 校验 token 是否有效 | `User.js`：`url: API_SERVER_HOST + '/users/isValidToken/' + Authorization`（高） |
| POST | `/users/logout` | 注销 | `User.js` + `tip/timeout.html`（高） |
| POST | `/users/switchService` | 切换子系统身份（带 `?Authorization=`） | `courseController.js`（中） |
| GET | `/captcha` | 图形验证码 | `User.js`（中） |
| POST | `/login/checkcode` | 登录前手机号校验/验证码 | `User.js`（中） |
| POST | `/login/sendsms`、`/sms/sendcode`、`/sms/verifycode`、`/sms/securitycode` | 短信验证码发送/校验 | `User.js` 字符串（中） |
| POST | `/users/resetpsd`、`/student/reset/{userId}/password` | 找回/重置密码 | `User.js`（中） |
| GET | `/users/menu/userMenuList` | 用户菜单 | `User.js`（中） |
| ? | `/dgut/logoutCas` | 东莞理工 CAS 注销回调 | `User.js`：`auth.dgut.edu.cn/authserver/logout?service=…/dgut/logoutCas`（高） |

### 课程 / 单元 / 公告 / 讨论

| 方法 | 路径 | 推测用途 | 证据/置信度 |
| --- | --- | --- | --- |
| GET | `/course/content?ocId=` | 课程内容目录（旧版） | `model/Course.js`（高） |
| GET | `/course/student/content/v2?ocId=` | 学生视角课程目录 v2 | `Course.js`（高） |
| GET | `/classes?ocId=`、`/classes/course/teachers?ocId=` | 班级/授课教师 | `Course.js`（中） |
| GET | `/units/stu/`、`/units/stu/activity/`、`/units/activities` | 学生单元与活动 | `model/Units.js`（中） |
| GET | `/textbook/student/information?currentPlatformType=1&ocId=` | 学生教材信息 | `Units.js`（中） |
| GET | `/announcements`、`/newestnotice?orgId=`、`/announcement/read/detail?announcementId=` | 公告列表/最新/已读回执 | `model/Announcement.js`（高） |
| GET | `/forum/`、`/forum/topping?ocId=` | 讨论区帖子/置顶 | `model/Discussion.js`（中） |
| GET | `/courseanalysis/general/`、`/courseanalysis/getCourseVisitInfo/` | 课程分析统计 | `Course.js`（中） |
| GET | `/knowledgeGraph/ocRelation?ocId=`、`/knowledgeGraph/ocRelation/studentKnowledgeStatistic` | 知识图谱掌握度 | `model/Knowledge.js`（高） |

### 学习记录与视频

| 方法 | 路径 | 推测用途 | 证据/置信度 |
| --- | --- | --- | --- |
| **POST** | `/courses/studyrecords` | **上报学习时长 + 视频进度** | `StudyRecord.js` 完整 save()（高） |
| GET | `/courses/studyrecords?activityId=` | 取某活动学习记录 | `StudyRecord.js`（高） |
| GET | `/icourse/studyRecord/stu?textbookId=` | 教材学习记录（学生） | `model/Textbook.js`（中） |
| GET | `/course/content/studyrecord`、`/course/content/study/record/` | 课件学习记录 | `model/SPOCResource.js`（中） |
| GET | `/progress/chapter?classId=`、`/progress/cheatStatus?textbookId=` | 章节进度/防作弊状态 | `Textbook.js`（中） |
| GET | `/icourse/url?textbookId=` | 取教材播放/预览地址 | `Textbook.js`（中） |
| POST | `/progress/redo` | 重置学习进度 | `Textbook.js`（中） |

`POST /courses/studyrecords` 请求体结构（`StudyRecord.js` 直接可见，高置信度）：

```
{courseId, activityId, studyTime, score, complete, unitId,
 videoRecordDTO: {currentTime, recordTime, complete}}   // currentTime/recordTime 为 toFixed(1) 秒
```

### 作业

| 方法 | 路径 | 推测用途 | 证据/置信度 |
| --- | --- | --- | --- |
| GET | `/homeworks/copyQuiz/{id}` | 复制作业/测验 | `model/Homework.js`（高） |
| DELETE | `/homeworks/{id}?ocId=` | 删除作业 | `Homework.js`（高） |
| ? | `/exams/haspaper/{id}`、`/papers?orgId=`、`/papers/folder?paperId=` | 试卷库相关 | `model/Paper.js`（中） |
| ? | `/teaHomework/exportHomeworkGrade`、`/exams/export/exportExamGrade` | 成绩导出 | `newCreateController.js`（中，导出链接） |

学生实际"写作业"不在 `courseapi`，而是跳到三个子应用（见下节）。

### 考试

| 方法 | 路径 | 推测用途 | 证据/置信度 |
| --- | --- | --- | --- |
| GET | `/exams?ocId=`、`/exams/{id}` | 考试列表/详情 | `model/Exam.js`（高） |
| GET | `/exams/getExamStatus`、`/exams/student` | 考试状态/考生信息 | `Exam.js`（中，方法由 ajax type 就近推断） |
| GET | `/exams/questionList`、`/exams/getStuQuestionAnswers` | 题目列表/学生作答 | `Exam.js`（中） |
| GET | `/exam/answers`、`/exam/instructions`、`/examPaper?examId=` | 标准答案/考试说明/试卷 | `Exam.js`（中） |
| GET | `/exams/analysis/basicInfo`、`/exams/analysis/gradeInfo`、`/exams/analysis/questionInfo` | 考试分析 | `Exam.js`（中） |
| GET | `/exams/getBehaviorTraces`、`/exams/getPoseBehaviorTrace/`、`/exams/getUserbehaviorList/` | 行为/姿态轨迹（防作弊） | `Exam.js`（中） |
| GET | `/exams/isAnonymous`、`/exams/orgExamConfig/` | 匿名阅卷/机构考试配置 | `Exam.js`（中） |
| POST | `/face/check`、`/face/snap`、`/exams/faceCheckInfoList` | 人脸核验（考试前/中） | `Exam.js`（中） |
| GET | `/exams/export/answer`、`/exams/export/answer/progress` | 答卷导出 | `Exam.js`（中） |

### 其他（非学生主流程，供交叉验证）

`/livevideos?`、`/livevideos/stu`、`/livevideos/tea`、`/livevideos/roomId/`、`/strategys/student?ocId=`、`/strategys/calculateStrategys?ocId=`、`/certificatetemplate/page`、`/obe/paperOutcome?examId=`、`/eportfolio/eportfolio/pageMyEportfolio`、`/miniCourses`、`/classgroup/getGroupMembers/`。

## 登录与会话机制

- **登录请求**（`model/User.js`）：
  ```
  url: API_SERVER_HOST + '/users/login', type: 'POST',
  data: JSON.stringify({loginName: …, password: …})   // contentType: 'text/plain'
  ```
  成功后 `setCookie('AUTHORIZATION', result.authorization, null, '/', UMOOC_COOKIE_DOMAIN)`，同时写 `USER_INFO`（整个用户对象的 JSON）。
- **凭证载体是 Cookie `AUTHORIZATION`，随后被复制成请求头**：`init.js` 里 `window.Authorization = getCookie("AUTHORIZATION")`，`$.ajaxSetup` 的 `beforeSend` 统一加 `xhr.setRequestHeader("Authorization", Authorization)` 与 `xhr.setRequestHeader("version", 1)`，并给所有 GET 追加 `?lang=<locale>`。
- 另一端：`UA_API_HOST` 相关请求额外带 `UA-AUTHORIZATION`（取 cookie `token`）；`?token=` 出现在 hash 中时会写入 `AUTHORIZATION` cookie。
- **会话失效**：HTTP 401 且响应 `code` ∈ {2001, 2101, 2201} → 记 `loginRedirectUrl` 并跳 `/ulearning/tip/timeout.html`；该页调用 `/users/logout`、清 cookie 后回首页。
- **SSO/定制登录迹象**（高）：`casAuth` cookie、`https://auth.dgut.edu.cn/authserver/logout?service=…/dgut/logoutCas`（东莞理工 CAS）、`https://saml.ulearning.asia/saml/logout`（SAML）。
- **登录页 SPA（`umooc/pc.html#/login`，Vue）**四种模式：账号密码（`mode=1`）、短信验证码（`mode=2`，先图形码 `mode=3`）、机构账号（`mode=4`，需要 `orgId` + `loginName`/`password`）、微信扫码；登录接口分 `loginV1()` / `loginV2()`（`getLoginVersion()` 决定版本），还调用 `checkLoginName()`（返回 `result`：1 正常、2 需二次验证码、3 锁定、16 需人工处理）与 `getCheatInfo()`（违纪提示）。
- localStorage 里存 `ulearning-orgId`（机构登录记忆）。
- 未在静态资源中发现 CSRF token；请求签名机制见下节说明。

## 视频与进度上报

- 播放器：jwplayer（`jwplayer-latest.js`、`jwplayerl.html5.js`）+ mediaelement 双套；`courseUnitsController.js` 里 `jwplayer("jwplayer-videos").setup({file: videoUrl …})`。
- **进度上报端点就是学习记录接口**：`POST /courses/studyrecords`，把播放进度塞进 `videoRecordDTO{currentTime, recordTime, complete}`，同时上报 `studyTime`、`score`、`complete`、`unitId`。对应读取用 `GET /courses/studyrecords?activityId=`。（高，`StudyRecord.js` 完整代码）
- 教材/课件维度另有 `/icourse/studyRecord/stu?textbookId=`、`/course/content/studyrecord`、`/course/content/study/record/`；防作弊状态 `/progress/cheatStatus?textbookId=`。（中）
- 旧版入口（仍被新前端拼 URL 使用）：`/umooc/learner/study.do?operation=startStudy&nodeID=`、`operation=previewCourse&nodeID=`、`operation=courseStudyReport&paperID=`；考试侧 `/umooc/user/study.do?operation=examReport&examid=`、`operation=openPaperFromOrg&fw=org&examID=`。
- 观察：本产品**未见** smartcourse 那种 `md5([clazzId][userid][jobid]…)` 式签名参数；学习记录只依赖 `Authorization` 头 + `version` 头。（中，基于已抓到的 8 个相关文件；未覆盖全部 200+ 模块）

## 作业/考试提交

- 写作业是**跨子应用跳转**，不是 courseapi 调用（`courseHomeworkController.js`，高置信度）：
  - 个人作业（`type == 9`）：`https://www.ulearning.cn/selfwork/#/stuWriting/{userId}/{homeworkId}?VNK=a772bbdf&ub2=1&ocId={ocId}`；已提交看批阅走 `#/stuDetail/{userId}/{homeworkId}`。
  - 测验型（`type == 3`）：`https://www.ulearning.cn/quiz/pc.html#/stuGuide?ocId={ocId}&homeworkId={id}`，成绩分析 `#/analysis/{id}`。
  - 小组作业（其余）：`https://www.ulearning.cn/groupwork/pc.html#/doHomework/{id}?ocId={ocId}`。
  - 三个子应用都是独立 Vue 包（`quiz/static/js/pc.*.js` 等），其内部 API 本次未抓取（HTTPS + 大 bundle，见"未能确认"）。
- 考试子应用同理：`utest.ulearning.cn/ulearning/index.html#/exam/detail?courseId=&examId=`、`#/exam/grade?courseId=&examId=`、`#/exam/analysis?examId=`、`examBank.html#/banks/paper`（`examController.js`，高）。
- 试卷"封存密码"存在独立接口：`/users/checkSealPassword?sealPassword=`、`/users/setSealPassword`（`User.js`，中）。
- 作业/考试数据侧的 REST 端点见上表 `/homeworks/*`、`/exams/*`。

## 未能确认的部分

1. **`quiz` / `selfwork` / `groupwork` / `utest` 子应用的内部 API**：它们只提供 HTTPS（301 强跳），本会话 TLS 直连不可用，`web_fetch` 又拒收 JS MIME；因此"提交作业/交卷"的确切接口、请求体、判分回包**均未验证**。已有信息只到"跳转 URL + hash 路由"级别。
2. **视频进度是否可以伪造**：`/courses/studyrecords` 的字段已知，但服务端是否校验播放时长上限、是否接受任意 `currentTime`/`complete=1`、是否有隐藏 token，需要真实会话实测，静态资源无法判断。
3. **是否存在请求签名**：仅确认了 `Authorization`、`version: 1`、`lang`、`timestamp`（仅 IE8/9 分支与 LTI 链接用到 `timestamp`），未见 `sign`/`nonce`/`md5` 组合；`jsSHA` 被加载但未定位到使用点（可能用于旧版第三方登录）。
4. **token 生命周期/刷新**：只见到 `isValidToken` 与 401 处理，未见 refresh 流程。
5. **路由全量**：`mainController.js` 抽到 74 条顶层路由、`courseController.js` 20 条课程路由；教师端/资源库/证书等还有约 30 个模块未逐一展开，可能存在遗漏。
6. **`192.168.1.98:7700` 内网调试地址**、`vconsole` 只说明构建不够干净，不构成可利用面。
7. 部分模型/controller 文件在第二次抓取时返回 154 字节（疑似限流），相关端点以首次抓取结果为准，未逐条复核。

> 说明：本文所有路径均来自上述 JS 文件中的字符串字面量或 URL 拼接；没有推断出的新端点被写成确定事实，置信度已逐条标注。
