# 三平台爬取逻辑与 GUI / 网站课程显示交互统一分析

> 任务：task-9（负责人 ui-analyst）· 只读分析，仅新增本文件，未改源码、未 commit。
>
> 快照：`2026-11-08T00:15–01:05 +08:00`。工作目录
> `E:\Workspace\HUST_Course_Hack\.agents\worktrees\feat-zhihuishu-miaoshua`
> （HEAD `0e2b84b`：知到提交 `6eeac65` + main 的文档/侦察提交 `0b52486`）。
> 另一源码位置 `E:\Workspace\HUST_Course_Hack`（main 分支 + 未提交 WIP，只读）。
>
> 说明：分析期间 Lead 正在该 worktree 内执行合并（先 `git merge 0b52486`，再把 main 工作区
> 的 documents / ulearning WIP 以 patch 形式落到索引）。因此文中同时给出「两分支原始状态」与
> 「合并后现状」，冲突清单以观测到的事实为准（见 §6）。`src/icourse163/**` 目前**尚未**
> 进入 worktree，也尚未在任一分支接线。

---

## 0. 结论速览

1. **协议层不可统一，抽象层可以统一。** 三个平台的登录、签名、进度上报协议完全不同
   （SmartCourse 是 HTML/mArg + `enc`/`dtoken` 心跳；知到是 AES `secretStr` + 模块密钥握手 +
   `saveDatabaseIntervalTimeV2`；icourse163 是带 `Auth-Signature` 的 JSON-RPC +
   一次 `saveMocContentLearn(finished:true)`）。但**课程树形状**（章→节/知识点→任务点）、
   **任务类型**（视频/文档/测验）、**完成状态**（未知/未完成/进行中/已完成）三件事可以统一。
2. **GUI 目前是「按平台平行复制」的实现。** `ui/src/main.ts` 里 `store.hust` 与 `store.zhs`
   两套子状态、两套加载函数、两套视图文件（`views/course.ts` vs `views/zhs-course.ts`），
   website 再各复制一份。继续加平台（icourse163 / 优学院）会线性膨胀。
3. **建议引入「核心模型 → 统一 DTO → 前端课程壳（course shell）」三层**：
   Rust core 增加 `Platform` 枚举与 `CourseSummaryDto/CourseDetailDto/ChapterDto/TaskPointDto`，
   平台差异通过 **tagged enum（`CourseRef`/`TaskRef`）+ `extra` 透传字段**表达；Tauri 命令保持薄；
   前端只保留一个课程页布局（header / stat / tabs / task table / tree），平台特有操作以
   「动作槽位（action slot）」挂载；知到见面课这类平台专属视图作为额外 tab/面板挂载。
4. **CLI 建议统一成 `hust | zhs | icourse | doc` 四个子命令组**（`hust` 为现行 `list/dump/tree/watch/doc`
   的别名组，保留向后兼容），避免 `zhs` 与 `doc`、`icourse` 命名风格漂移。
5. **合并顺序**：先把 documents/icourse163 的 WIP 落库（可复现的 commit）→ 再平台抽象重构 →
   再接 GUI → 最后 website parity 与 ulearning。两分支共有 **19 个双改文件**，实测合并时
   **6 个出现文本冲突**；`src/main.rs`、`ui/src/mock.ts`、`website/src/main.ts`、
   `src-tauri/src/events.rs` 是长期冲突热点（详见 §6）。

---

## 1. 三平台爬取流程对比

### 1.1 总表

| 维度 | 学在华科大 SmartCourse | 知到 Zhihuishu | icourse163（中国大学 MOOC / SPOC） |
| --- | --- | --- | --- |
| 代码位置 | `src/client.rs`、`src/parse.rs`、`src/playback.rs`、`src/submit.rs`、`src/documents.rs` | `src/zhihuishu/{api,crypto,watch,meet,models,mod}.rs` | **只读主目录** `src/icourse163/{client,course,crypto,video,models,mod}.rs`（尚未 `pub mod`） |
| 会话来源 | cookie jar：CLI `--cookies`（`src/client.rs:91`），GUI 登录窗口 `cookies_for_url`（`src-tauri/src/login.rs:227`） | 同上 + 登录窗口校验（`login.rs:303` `finish_zhs_login`） | cookie 文件/header（`client.rs:112/118`）；GUI 登录窗口**未实现** |
| 登录验活 | `list_courses_with_url`（`src/client.rs:127`）→ `getStudyCourse` 的 final URL / 课程非空（`login.rs:271-279`） | `login_user()`（`src/zhihuishu/api.rs:827`）`getLoginUserInfo`；教师账号拒绝（`login.rs:325`） | `resolve_spoc_course`（`src/icourse163/course.rs:144`）解析 SPOC 页 `window.courseDto/termDto`（非专门验活） |
| 课程列表 | `client.rs:118 list_courses` → `parse.rs:76 parse_course_list` → `Vec<CourseSummary>` | `api.rs:872 list_courses` → `queryShareCourseInfo`；失败时 `api.rs:925 resolve_course` 用学习页 URL/`secret` 兜底（`login.rs:331-337` 容错） | **无列表接口**：由用户给 SPOC id/URL → `course.rs:144 resolve_spoc_course` → `SpocCourse`（`course.rs:26`） |
| 目录树入口 | `client.rs:151 fetch_course_with_progress`：course home → `parse_course_page`(`parse.rs:154`) → `studentstudycourselist` → `parse_chapter_tree`(`parse.rs:177`) → `knowledge/cards` → `parse_card_list`(`parse.rs:303`) → `extract_marg`(`parse.rs:340`) → `parse_card_content`(`parse.rs:367`) | `api.rs:954 course_detail` → `videolist` → `ZhsCourseDetail`（`models.rs:167`）：chapters→lessons→videos，**固定 3 层** | `course.rs:40 fetch_course_tree`（`getLastLearnedMocTermDto`）→ `IcourseTerm`（`models.rs:14`）：chapters→lessons→units，**固定 3 层** |
| 任务点模型 | `TaskPoint`（`src/models.rs:111`）+ `TaskKind`（`models.rs:156`）：video/document/work/audio/live/other；`job_id`/`object_id`/`work_id`/`raw` | **没有 TaskPoint**：`ZhsVideo`（`models.rs:152`）即最小学习单元；见面课（`ZhsMeet`，`models.rs:209`）独立 | `Unit`（`models.rs:81`）：`content_type`/`content_id`/`duration_in_seconds`/`view_status`/`complete_percent` |
| 视频进度上报 | `playback.rs:207 collect_targets` → `playback.rs:342 watch_target` → `client.rs:465 report_video_progress`（`enc` + `dtoken` + `isdrag` 心跳），判定 `ReportReply.is_passed`（`playback.rs:156`） | `watch.rs:40 plan_videos` → `watch.rs:132 run_video_watch`；`api.rs:1040 prelearning_note`/`api.rs:1079 query_stuy_info` 取进度，`api.rs:1121 save_interval`（`saveDatabaseIntervalTimeV2`）上报；判定 `watchState==1`（`models.rs:489/500 ZhsVideoStudy::completed`） | `video.rs:96 plan_videos` → `video.rs:188 complete_videos`：对每个单元发一次 `saveMocContentLearn`（`LearnLogDto` `video.rs:50`，`finished:true`），再重拉树复核 `complete_percent>=1`（`video.rs:248-270`） |
| 测验 | `submit.rs:1100 plan_course` → `src/client.rs:724 submit_planned_work`；解析 `submit.rs:220 parse_work_form`、答案编码 `submit.rs:611 build_submission_fields`；题目 `parse.rs:547 parse_questions` | **未实现** | **未实现 HTTP API**；侦察结论走 WebView DOM 自动化（`docs/icourse163/recon-feasibility.md` §5.2，L209-L220） |
| 文档 | `src/documents.rs:64 collect_document_targets` + `src/client.rs:969 complete_document`（`phone/wxcard` 取 `jtoken` → `job/document`，仅 `status:true`，`documents.rs:202`） | 无 | 本课无文档任务；侦察标注资源族不同（`recon-feasibility.md` L18） |
| 取消 | `fetch_course_with_progress` 回调返回 `false` 即取消（`client.rs:151-156`）；`AppState::is_cancelled`（`src-tauri/src/state.rs:218`） | `run_video_watch`/`run_meet_watch` 接受 cancel 回调（`src/zhihuishu/watch.rs:132`、`meet.rs:248`） | `complete_videos` **没有 cancel 参数**（`video.rs:188-194`），CLI 外层可中断、GUI 需补 |
| 限速/风控 | 视频心跳 `step/delay`（`playback.rs:167 WatchOptions`）；提交无额外限速 | 见面课 2–6s 随机 + 90–100% 覆盖 + 熔断（`docs/zhihuishu-miaoshua-plan.md`，`meet.rs:108/248`） | 每节 1.2s + 失败重试 1 次（`video.rs:31-33`） |
| 风险等级 | 中（视频心跳/测验提交） | **高**（秒刷 + 回放考勤） | 高（秒刷；测验建卷即计时，`recon-feasibility.md` L132-L137、L184-L185） |

### 1.2 学在华科大（SmartCourse）爬取链路

1. **会话**：`SmartCourseClient`（`src/client.rs:58`）持有 `reqwest` cookie jar。CLI 走
   `from_cookie_file`（`src/client.rs:91`），GUI 走登录窗口读 cookie 后
   `jar_from_records`（`src-tauri/src/login.rs:269`）。
2. **课程列表**：`list_courses`（`src/client.rs:118`）→ `fyportal-smartcourse/.../getStudyCourse`
   → `parse_course_list`（`src/parse.rs:76`）产出 `Vec<CourseSummary>`（`src/models.rs:11`：
   `course_id/class_id/cpi/name/cover_url/source/kc_enc/ck_enc/clazz_enc/detail_url`）。
3. **课程详情/目录树**：`fetch_course_with_progress`（`src/client.rs:151`）：
   - 打开 `detail_url`（`opencoursenewfy`）→ `parse_course_page`（`src/parse.rs:154`）取标题/ids；
   - 拉 `mooc-ans/mycourse/studentstudycourselist` → `parse_chapter_tree`（`src/parse.rs:177`）
     得到递归 `Chapter`（`src/models.rs:64`，含 `number/level/is_leaf/completed/children/cards`）；
   - 对叶子知识点并发拉 `knowledge/cards` → `parse_card_list`（`src/parse.rs:303`）→ 每张卡
     `extract_marg`（`src/parse.rs:340`）→ `parse_card_content`（`src/parse.rs:367`）→
     `parse_task_point`（`src/parse.rs:414`）→ `TaskPoint`（`src/models.rs:111`）；
     `parse_playback_env`（`src/parse.rs:389`）取 `mArg.defaults` 的播放环境。
4. **视频进度**：`collect_targets`（`src/playback.rs:207`）筛选任务点 → `watch_target`
   （`src/playback.rs:342`）每次重新取 `dtoken`/`otherInfo`/`attDurationEnc` 后按播放器心跳
   上报（`client.rs:465 report_video_progress`），以服务端 `isPassed` 判定。
5. **测验**：`plan_course`（`src/submit.rs:1100`）用内置题库匹配 → `prepare_submission`
   （`src/submit.rs:908`）复用 `form#form1` action/hidden 字段 → `client.rs:724
   submit_planned_work`；作业状态 `graded`/`in_progress` 来自任务点 `work_status`
   （`src/models.rs:130-133`）。
6. **文档**（main 分支新增，已合入 worktree）：`src/documents.rs:64 collect_document_targets`
   收集 `DocumentTarget`（`documents.rs:23`：`course_id/class_id/cpi/knowledge_id/card_id/job_id/
   object_id`）→ `client.rs:969 complete_document`：`fetch_document_attachment_setting`
   （`client.rs:906`，`phone/wxcard`）→ `attachment_jtoken`（`documents.rs:168`）→
   `report_document_read`（`client.rs:942`，`job/document`）→ `parse_document_report`
   （`documents.rs:202`，仅 `status:true`）。
7. **进度状态表示**：`TaskPoint.completed: Option<bool>`（`null`=平台未给出状态）、
   `played_ms`/`duration_secs` 算百分比（`ui/src/views/course.ts:376-382`）；
   `CourseStats`（`models.rs:45`）汇总计数与 `errors`。

### 1.3 知到（Zhihuishu）爬取链路

1. **会话/加密**：`ZhsClient`（`src/zhihuishu/api.rs:670`），`from_cookie_file`（`api.rs:726`）/
   `from_cookie_header`（`api.rs:750`）供 CLI/GUI 使用；`crypto.rs` 实现 `secretStr`
   AES-128-CBC（`crypto.rs:132/156`）、XOR 编码（`crypto.rs:202`）、观看点序列（`crypto.rs:250`）、
   模块密钥 RSA 握手（`crypto.rs:288/335`）。协议常量在 `src/zhihuishu/mod.rs:45-145`。
2. **登录验活**：`login_user`（`api.rs:827`）→ `getLoginUserInfo`（`mod.rs:116`），
   GUI 在 `finish_zhs_login`（`login.rs:303`）里要求 `CASLOGC` cookie 存在并拒绝教师账号。
3. **课程列表**：`list_courses`（`api.rs:872`）→ `queryShareCourseInfo`（`mod.rs:141`）；
   接口不可用时 `resolve_course`（`api.rs:925`）从学习页 URL 的 `recruitAndCourseId`/`secret`
   反推，GUI 侧保留了「粘贴学习页链接手动添加」入口（`ui/src/views/zhs-course.ts:47-150`
   `renderZhsHome`，`ui/src/main.ts:484 addZhsCourse`）。
4. **目录树**：`course_detail`（`api.rs:954`）→ `videolist`（`mod.rs:118`）→
   `ZhsCourseDetail`（`models.rs:167`）：
   `ZhsChapter`（`models.rs:98`）→ `ZhsLesson`（`models.rs:115`）→ `ZhsVideo`（`models.rs:152`）。
   完成状态：`is_studied: Option<i64>`、`is_pass`、`learning_lesson_status`、课程级
   `progress/studied_lesson_count/total_lesson_count`（`models.rs:29 ZhsCourse`）。
5. **视频进度**：`watch.rs:40 plan_videos` 生成 `ZhsVideoTarget`（`models.rs:429`）→
   `watch.rs:132 run_video_watch`；上报前后用 `prelearning_note`（`api.rs:1040`）/
   `query_stuy_info`（`api.rs:1079`）/`save_interval`（`api.rs:1121`）核对，`watchState==1` 判完成
   （`models.rs:489/500`）。
6. **见面课回放**：`meet_list`（`api.rs:1182`）、`meet_progress`（`api.rs:1312`，
   `getWatchHistory`）、`meet_watch`（`api.rs:1399`）/`meet.rs:248 run_meet_watch`
   （随机覆盖 `meet.rs:108 plan_meet_minutes`、2–6s 限速、熔断
   `api.rs:1386 meet_exception_status`）。
7. **测验/文档**：无实现。

### 1.4 icourse163（主目录 `src/icourse163/**`，只读）

> 事实状态：**该模块尚未接线**。主目录 `src/lib.rs` 只有 `answers/client/cookie/documents/
> models/parse/playback/submit`，没有 `pub mod icourse163`；`src/main.rs` 没有 `icourse` 子命令；
> `src-tauri`/`ui`/`website` 无任何引用（全仓 grep `icourse` 只命中 `src/icourse163/**`、
> `docs/icourse163/**`、`tests/icourse_http.rs`）。测试与测试数据存在：
> `tests/icourse_http.rs`、`test-data/icourse-term.json`。

1. **会话/签名**：`IcourseClient`（`client.rs:72`）`with_cookie_jar_and_base`（`client.rs:85`）/
   `from_cookie_file`（`client.rs:112`）；`csrf_key`（`client.rs:138`）取 cookie
   `NTESSTUDYSI`（`mod.rs:32`）；需要鉴权的 RPC 用 `AuthSignature`（`crypto.rs:31`，
   `md5(body+nonce+timestamp+salt)`，盐 `mod.rs:26`）加 `Timestamp/Nonce/System/
   Auth-Signature`（`crypto.rs:45`）。
2. **课程定位**：无课程列表；`resolve_spoc_course`（`course.rs:144`）打开
   `/spoc/course/HUST-<id>`，`parse_spoc_course_page`（`course.rs:85`）解析
   `window.courseDto/termDto/moocCourseCardDto` → `SpocCourse`（`course.rs:26`：
   `course_id/term_id/source_term_id/source_course_id/name`）。SPOC 学期可能无章节，内容在源学期
   （`recon-feasibility.md` L22-L25）。
3. **目录树**：`fetch_course_tree`（`course.rs:40`）→
   `courseBean.getLastLearnedMocTermDto`（`mod.rs:47`）→ `parse_term_reply`（`course.rs:54`）→
   `IcourseTerm`（`models.rs:14`）→ `Chapter`（`models.rs:57`）→ `Lesson`（`models.rs:69`）→
   `Unit`（`models.rs:81`：`content_id/content_type/duration_in_seconds/view_status/
   learn_time/complete_percent`）。
4. **视频进度**：`plan_videos`（`video.rs:96`）过滤 `contentType==1 && complete_percent<1` →
   `complete_videos`（`video.rs:188`）构造 `LearnLogDto::completed`（`video.rs:68`，
   `finished:true/videoTime=时长/learnedVideoTimeCount=时长`）→
   `courseRpcBean.saveMocContentLearn`（`mod.rs:50`）→ 重拉课程树复核。实测一次请求 0%→100%
   （`recon-feasibility.md` L158-L178）。
5. **测验/考试**：仅侦察；结论是走真实页面 DOM（`.u-questionItem`、`.j-submitBtn`、
   `.m-dialog .j-left`，`recon-feasibility.md` L139-L145、L209-L220），且「点开始测验就建草稿并
   30 分钟倒计时，不提交会超时 0 分」——必须二次确认（L184-L185）。
6. **文档**：本课无；侦察标注未来若需走 `MocResourceBean.saveContentForResource`（L18）。

### 1.5 补充：优学院（Ulearning / 文档里的「U学」）——第四平台，正在落地

分析期间 worktree 里新出现 `src/ulearning/mod.rs`（尚未提交，且 `src/lib.rs` 已 `pub mod ulearning`），
指向 `docs/ulearning/{recon-static,web-analysis,miaoshua-plan}.md` 与
`test-data/ulearning-answer-bank.json`（`0b52486`）。要点（`docs/ulearning/miaoshua-plan.md`）：

- 入口 `https://ua.ulearning.cn/learnCourse/...`，记录 API `https://api.ulearning.cn`，
  鉴权 header `Authorization`/`UA-AUTHORIZATION`，token 来自 cookie `AUTHORIZATION`
  （`src/ulearning/mod.rs:27-29`）；
- 课程树 `GET /course/stu/{textbookId}/directory?classId`，章→节→页；
- 完成上报 `POST /yws/api/personal/sync`，body 为 **DES-ECB(PKCS7, key=12345678)** 的 JSON，
  payload 含 `itemid/autoSave/...`（`docs/ulearning/miaoshua-plan.md` §2.4）。

> 命名歧义提醒：任务描述里的「U学/icourse163」对应的文件是主目录 `src/icourse163/**` 与
> `docs/icourse163/recon-feasibility.md`；但仓库里另有「优学院（Ulearning）」这条第四平台线。
> 建议统一 DTO 时**直接预留 `Platform::Ulearning`**，避免抽象做完再返工。

---

## 2. 数据结构差异与可统一字段

### 2.1 三平台模型对照

| 概念 | SmartCourse | Zhihuishu | icourse163 | 统一建议 |
| --- | --- | --- | --- | --- |
| 课程摘要 | `CourseSummary`（`src/models.rs:11`）：`course_id/class_id/cpi/name/cover_url/source/kc_enc/ck_enc/clazz_enc/detail_url` | `ZhsCourse`（`zhihuishu/models.rs:29`）：`recruit_id/course_id/class_id/school_id/name/teacher/secret/is_apply/course_type/progress/studied_lesson_count/total_lesson_count/status` | `SpocCourse`（`icourse163/course.rs:26`）：`course_id/term_id/source_term_id/source_course_id/name`（无教师/封面） | `CourseSummaryDto { platform, course_id, name, teacher?, class_id?, cover_url?, progress: CourseProgressDto, ref: CourseRef }` |
| 课程详情 | `CourseDetail`（`models.rs:30`，`#[serde(flatten)] course`）`+ title/enc/old_enc/openc/final_url/chapters/stats` | `ZhsCourseDetail`（`models.rs:167`）：`{course, chapters}` | `IcourseTerm`（`models.rs:14`）：`id/course_id/course_name/school_id/chapters` + 外置 `SpocCourse` | `CourseDetailDto { summary, title, chapters: Vec<ChapterDto>, stats: CourseStatsDto }` |
| 目录节点 | `Chapter`（`models.rs:64`）递归：`id/title/number/level/is_leaf/completed/children/cards` | `ZhsChapter`→`ZhsLesson`→`ZhsVideo`（固定 3 层，`models.rs:98/115/152`） | `Chapter`→`Lesson`→`Unit`（固定 3 层，`models.rs:57/69/81`） | `ChapterDto { id, title, number?, level, completed: ProgressState, children, task_points, extra }`；固定 3 层平台由 adapter 展开 |
| 任务点 | `TaskPoint`（`models.rs:111`）`+ TaskKind`（`models.rs:156`），字段 25+，含 `raw: Value` | `ZhsVideo`（`models.rs:152`）：`video_id/lesson_video_id/video_sec/is_studied/name` | `Unit`（`models.rs:81`）：`id/content_id/content_type/duration_in_seconds/view_status/learn_time/complete_percent` | `TaskPointDto { id, kind: TaskKind, name, duration_secs?, progress: ProgressState, ref: TaskRef, extra }` |
| 进度状态 | `completed: Option<bool>`、`played_ms`、`duration_secs` | `is_studied: Option<i64>`（0/1）、`is_pass`、`learning_lesson_status`、课程 `progress` | `complete_percent: Option<f64>`（0..1，未开始为 `null`）、`view_status` 0/1、`learn_time` 分钟 | `ProgressState { Unknown, Todo, InProgress{percent}, Done }` + `playhead_secs/duration_secs` |
| 测验题 | `Question`（`models.rs:189`）`+ QuestionOption`；`work_status: graded/in_progress` | 无 | 无 HTTP 模型（DOM 自动化） | 暂不统一，保留在 `extra`/平台专属 DTO |
| 文档 | `TaskPoint{kind:document}` + `DocumentTarget`（`src/documents.rs:23`） | 无 | 无（未来资源族） | 复用 `TaskPoint{kind:document}` + `TaskRef` |
| 平台特有凭证 | `enc/other_info/att_duration_enc/rt/video_face_capture_enc/dtoken/ktoken` | `secret/watchState/sdsew/paramSecret/cKey` | `term_id/source_term_id`、`Auth-Signature`、`paperDto` | 一律放在 `extra: serde_json::Value`（Rust）或 `extra?: Record<string, unknown>`（TS），**不进入公共字段** |

### 2.2 建议的统一 DTO（Rust core）

新增 `src/dto.rs`（或 `src/platform/mod.rs`），不改变现有平台模型的存储形态，只在出口做
adapter。推荐骨架：

```rust
/// 平台枚举（core 层，供 CLI/Tauri/website 共用；现在只在 src-tauri 里）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform { Hust, Zhihuishu, Icourse163, Ulearning }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSummaryDto {
    pub platform: Platform,
    pub course_id: String,     // 平台内唯一、用于选择/去重的 id
    pub name: String,
    pub teacher: Option<String>,
    pub class_id: Option<String>,
    pub cover_url: Option<String>,
    pub progress: CourseProgressDto, // videos_total/videos_done/percent
    pub r#ref: CourseRef,            // 平台特有句柄，动作命令用
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "platform", rename_all = "snake_case")]
pub enum CourseRef {
    Hust { class_id: String, cpi: String, detail_url: String },
    Zhihuishu { recruit_id: u64, secret: Option<String>, class_id: Option<u64>, school_id: Option<u64> },
    Icourse163 { spoc_course_id: i64, term_id: Option<i64>, source_term_id: Option<i64>, source_course_id: Option<i64> },
    Ulearning { textbook_id: i64, class_id: i64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseDetailDto {
    pub summary: CourseSummaryDto,
    pub title: String,
    pub chapters: Vec<ChapterDto>,
    pub stats: CourseStatsDto,
    pub extra: serde_json::Value, // 原始诊断信息（enc/final_url/term 等）
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterDto {
    pub id: String,
    pub title: String,
    pub number: Option<String>,
    pub level: u32,
    pub completed: ProgressState,
    pub children: Vec<ChapterDto>,
    pub task_points: Vec<TaskPointDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPointDto {
    pub id: String,            // 平台任务 id（Hust job_id / Zhs video_id / Icourse unit_id）
    pub kind: TaskKind,        // 复用 src/models.rs:156 的 TaskKind
    pub name: String,
    pub duration_secs: Option<u64>,
    pub progress: ProgressState,
    pub r#ref: TaskRef,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ProgressState {
    Unknown,
    Todo,
    InProgress { percent: f32 },
    Done,
}
```

映射规则（现有字段 → `ProgressState`）：

| 平台 | 已完成 | 进行中 | 未知/未开始 |
| --- | --- | --- | --- |
| Hust | `completed == Some(true)` | `completed == Some(false) && played_ms > 0`，`percent = played_ms/(duration*1000)` | `completed == None` |
| Zhihuishu | `is_studied != Some(0)` / `watchState == 1` / 见面课 `watchedCount>0` | 见面课 `0 < watchedCount < totalMinutes`（percent 已有） | `is_studied == None` |
| icourse163 | `complete_percent >= 1.0` | `0 < complete_percent < 1.0` | `complete_percent == None` |
| Ulearning | `section.complete == 1` / `video.status == 1` | —（平台不给中间态） | — |

**不建议**把三平台模型硬合成一个 Rust struct：`TaskPoint` 已有 25+ 字段、各平台语义不同；
统一 DTO 只做「展示/交互所需的交集」，平台专属字段透传 `extra`，协议代码仍留在各平台模块内。

### 2.3 前端类型建议

`ui/src/types.ts` 与 `website/src/types.ts` 目前是两套 hand-written 类型（注释
`ui/src/types.ts:1-2` 明确「mirror Rust models」）。建议：

- SmartCourse 的 snake_case 模型保持原样（`CourseSummary`/`CourseDetail`…），作为「原始模型」；
- 新增 `CourseView`（前端渲染模型，`platform/chapters/taskPoints/stats/actions` 均 camelCase），
  由 `ui/src/viewmodel.ts` 的 `toCourseView(platform, detail)` 生成；
- 平台专属操作通过 `actions: CourseAction[]` 声明（见 §5.4），渲染层不感知平台。

---

## 3. GUI 课程显示与交互现状（逐文件）

### 3.1 总体架构

- Vite + 原生 TypeScript，无框架、无 URL 路由。页面用 `innerHTML` 整体重渲染，交互靠
  `main.onclick`/`main.onchange` 事件委托（如 `ui/src/views/course.ts:431-518`、
  `ui/src/views/connect.ts:263-275`）。
- 全局状态集中在 `ui/src/main.ts:74-100`：
  ```ts
  store = {
    platform: "hust" | "zhihuishu",   // 连接页选择 + 当前会话平台
    session, loginStatus, loginError, busy,
    hust: { courses, selectedId, details: Map, options, bankQuestions },
    zhs:  { courses, selectedId, detail, meets, meetProgress, view }
  }
  ```
- 路由函数：`showConnect`（`ui/src/main.ts:165`）、`showHome`（`:142`）、
  `activateSession`（`:187`，按 `info.platform` 分支）、`selectCourse`（`:272`，知到转
  `selectZhsCourse`）、HUST 详情（`:348 showHustDetail`）、知到详情
  （`:569 showZhsCourseView`）、见面课（`:644 showZhsMeetView`）、`disconnect`（`:750`）、
  `boot`（`:777`）。
- 事件：Rust 侧统一发 `job-progress`（`src-tauri/src/commands.rs:781`、`zhihuishu.rs:874`）；
  登录发 `session-changed`/`login-closed`（`src-tauri/src/login.rs:298/362/152`）。前端
  `ui/src/api.ts:75-94` 包装 `listen`，非 Tauri 时走 `demoOn` 本地总线。
- 取消：所有长任务都走 `AppState::begin_job`（`src-tauri/src/state.rs:206`，单任务闸门），
  `cancel_job`（`commands.rs:767`）与 `zhs_cancel_job`（`zhihuishu.rs:774`）置位
  `AtomicBool`；前端按钮 `data-cancel`（`views/course.ts:467-470`）、`#watch-stop`、
  `#zhs-watch-stop`、`#zhs-meet-stop`。

### 3.2 文件级清单

| 文件 | 职责 | 关键证据 |
| --- | --- | --- |
| `ui/src/main.ts` | 全局 store、平台会话、HUST/知到两套加载与详情流程、导出、断开 | `:74` store；`:187` activateSession；`:298` loadHustCourse；`:520` loadZhsDetail；`:716` refreshCourses；`:750` disconnect |
| `ui/src/views/connect.ts` | 连接页：平台切换（HUST/知到）、登录按钮状态机、演示模式提示 | `:17-25` 平台 label/mark；`:27` renderConnect；`:50-62` 平台按钮；`:100-113` 登录按钮/错误；`:83-86` demo notice |
| `ui/src/views/course.ts` | HUST 课程页：header 动作（打开/导出/刷新/抓取设置/完成题目/完成文档/完成视频）、统计条、四 tab（目录/任务点/测验/诊断）、任务表筛选、行内动作 | `:24-35` CourseHandlers；`:241` renderCourse；`:263-301` header 动作；`:299` 完成文档按钮；`:334-340` tabs；`:351-418` 任务表；`:431-518` 事件委托；`:200` markDocumentCompleted |
| `ui/src/views/watch.ts` | 视频上报弹窗：心跳参数、include-completed、dry-run、进度日志、停止 | `:79` dry-run checkbox（**默认未勾选**）；`:96` 开始按钮；`:303` 请求体 |
| `ui/src/views/quiz.ts` | 一键测验弹窗：dry-run **默认勾选**、风险确认 checkbox、maxWorks、进度日志 | `:81` `checked`；`:85` 确认；`:149/:160-166` 启用逻辑 |
| `ui/src/views/document.ts` | 文档任务弹窗：dry-run 默认勾选、include-completed、逐条状态 | `:75` `checked`；`:111` 单 job 时强制 includeCompleted；`:16-28` 状态文案/色调 |
| `ui/src/views/zhs-course.ts` | 知到首页（手动添加课程）、课程视频树（章/节/小节）、秒刷弹窗、风控检查 | `:47` renderZhsHome；`:243` renderZhsCourse；`:269-275` header（返回/刷新/检查/见面课/秒刷）；`:409` openZhsWatchModal；`:428` 风险提示；`:445/449` dry-run+confirm；`:465` 复制结果 |
| `ui/src/views/zhs-meet.ts` | 见面课列表：回放进度、单场/全部秒刷、覆盖率/限速/熔断/确认 | `:57` renderZhsMeet；`:92-94` 风险提示；`:198` openZhsMeetWatchModal；`:246-255` 参数与确认；`:270` 复制结果 |
| `ui/src/views/sidebar.ts` | 平台无关侧栏：brand 随平台切换、搜索、课程列表、刷新/断开/助手 | `:7-11` SidebarItem；`:43` createSidebar；`:57-63` 平台文案；`:70` “共享课/我的课程” |
| `ui/src/types.ts` | 全部 IPC 类型：`Platform`（`:130`）、`SessionInfo`（`:132`）、`JobProgress`（`:223`）、文档（`:162-186`）、知到 DTO（`:305-444`） | 平台命名 `"hust" \| "zhihuishu"` |
| `ui/src/api.ts` | Tauri 命令封装 + 事件订阅；非 Tauri 切 `mockApi` | `:29-68` tauriApi（含 `completeDocuments:41`、`zhs*`）；`:72` api 选择；`:75-94` onJobProgress/onSessionChanged/onLoginClosed |
| `ui/src/mock.ts` | 演示后端（HUST 示例课程 + 知到示例；知到任务只允许 dry-run） | `:502` 注释；`:728` mockApi；`:1183`/`:1304` 拒绝真实执行 |
| `src-tauri/src/state.rs` | 单会话状态机：`Platform`（`:24`）、`SessionClient`（`:66`）、`Session`（`:72`）、`AppState`（`:84`）、单任务闸门（`:206`）、HUST/知到客户端访问器（`:123/131`） | 只允许一个平台会话 |
| `src-tauri/src/events.rs` | `JobProgress` tagged enum：Crawl/WatchPlan/Watch/DocumentPlan/Document/QuizPlan/Quiz/ZhsPlan/ZhsStage/ZhsTarget | `:15`；`:32/34` Document；`:69-91` Zhs |
| `src-tauri/src/commands.rs` | HUST 命令：登录、会话、列表、抓取、视频、文档、测验、题库、取消、助手脚本、保存文件 | `:178 fetch_course`、`:207 watch_course`、`:370 complete_documents`、`:513 complete_quizzes`、`:767 cancel_job` |
| `src-tauri/src/zhihuishu.rs` | 知到命令与 DTO：列表/解析课程/详情/视频秒刷/见面课列表+进度+秒刷/风控/取消 | `:414-774`；DTO `:126-411`；事件 `:474-719` |
| `src-tauri/src/login.rs` | 平台登录窗口：配置表（`:53-72`）、`is_platform_page`（`:167`）、cookie 读取（`:227`）、HUST 验活（`:263`）、知到验活（`:303`）、临时 profile 清理（`:386/399`） | 登录窗口按平台分支 |

### 3.3 HUST 课程页交互细节

- header：打开课程页/导出 JSON/刷新/“抓取设置” popover（题目、视频签名、并发数，
  `views/course.ts:276-297`）、“完成题目”（`:298`）、“完成文档”（`:299`）、“完成视频”（`:300`）。
- 统计条：视频完成度百分比 + 知识点/任务点/测验/警告（`:318-332`）。
- 任务点 tab：类型 chip 过滤 + “只看未完成”（`:351-418`、`:553-593`），行内动作按
  `point.kind` 分派（见 `renderTaskRow` `:662`）：video→`data-watch-job`，document→`data-doc-job`，
  work→`data-work-id`（跳测验 tab 并滚动）。
- 测验 tab：题库 banner + 每作业“提交本题”（`renderQuiz` `:706` 起，事件 `:438-442`）。
- 诊断 tab：`stats.errors` + 原始统计（`:879` 起）。
- 刷新期间显示 crawl banner + 取消按钮（`:305-316`），进度来自 `crawl` 事件
  （`ui/src/main.ts:308-312`）。

### 3.4 知到课程页与见面课

- 知到首页：课程卡片列表 + “粘贴学习页链接手动添加”输入（`views/zhs-course.ts:47-150`），
  因为共享课列表接口可能不可用（`main.ts:460-478 loadZhsCourseList` 的 toast 文案）。
- 课程页：header 返回/刷新/风控检查/见面课/“秒刷本课视频”；统计条（视频完成度/章节/视频/
  已完成）；三级树 details（章→节→小节），小节行显示 `is_studied` 徽标
  （`views/zhs-course.ts:302-397`）。
- 秒刷弹窗：默认 dry-run + 风险确认 + include-completed + verify + 数量上限 + 进度日志 +
  复制结果（`:409-737`）。
- 见面课页：列表卡片显示回放/进度，单场/全部秒刷；弹窗默认 dry-run + 风险确认 +
  覆盖率 min/max + 延迟 min/max + 熔断 + 每 N 次检查 + 复制结果（`views/zhs-meet.ts:198-599`）。

### 3.5 弹窗族与「dry-run / 风险确认 / 取消」一致性现状（重要差异）

| 操作 | 默认 dry-run | 风险确认 checkbox | 取消 | 证据 |
| --- | --- | --- | --- | --- |
| HUST 视频上报 | **否**（checkbox 未勾选） | 无（仅黄色提示） | 有 | `views/watch.ts:56/79/96` |
| HUST 测验提交 | 是（`checked`） | 有（关闭 dry-run 后必须勾选） | 有 | `views/quiz.ts:81/85/149` |
| HUST 文档完成 | 是（`checked`） | 无（dry-run 本身即闸门） | 有 | `views/document.ts:75/62/90` |
| 知到视频秒刷 | 是 | 有 | 有 | `views/zhs-course.ts:445/449` |
| 知到见面课 | 是 | 有 | 有 | `views/zhs-meet.ts:250/254` |

结论：HUST 视频弹窗是唯一「默认真实发送」的写操作，与 AGENTS「高风险默认 dry-run」不一致；
统一壳层应把「dry-run 默认 + 显式风险确认」做成公共 `ConfirmGate` 组件，所有写操作复用。

### 3.6 事件与状态机现状

- 事件通道：单一 `job-progress`，`kind` 区分 `crawl/watchPlan/watch/quizPlan/quiz/
  documentPlan/document/zhsPlan/zhsStage/zhsTarget`（`src-tauri/src/events.rs:15`）。
- 知到事件带 `job`（`zhs-watch`/`zhs-meet-watch`）与 `stage`
  （`loading/videos/meet_list/meet_minutes/verify/circuit_check`，`events.rs:69-91`），
  比 HUST 的 `watch/quiz` 事件更通用，**建议以知到这套 `plan/stage/target` 为统一事件骨架**。
- 状态词汇不统一：HUST 用 `passed/failed/dry_run`，测验用 `submitted/skipped`，
  知到用 `ok/skip/dry_run/failed/cancelled/circuit_broken`。建议收敛为
  `running | ok | skip | dry_run | failed | cancelled | circuit_broken`。

---

## 4. website 对应实现与 GUI 差异

### 4.1 架构差异（bridge / CORS / demo）

| 维度 | GUI（Tauri） | website（静态站） |
| --- | --- | --- |
| 网络出口 | Rust `reqwest` + cookie jar，进程内发请求 | 浏览器跨域 → **Tampermonkey 桥接脚本**在平台页面内代发，postMessage 回传 |
| 认证 | 登录窗口 + `cookies_for_url`（HttpOnly 也可读），Cookie 不过 IPC | 弹窗打开平台页 + 桥接脚本 `ready` 握手，Cookie 留在平台域，静态站永远看不到 |
| 桥接安全 | 无（进程内） | 双端白名单 + channel + nonce + `event.origin`/`event.source` 校验：SmartCourse 在 `website/src/core/transport.ts:14-35`（白名单）、`:44-53`（消息校验）；知到在 `website/src/core/zhs/transport.ts:57-88`（路由白名单）、`:116-252`（`ZhsBridgeTransport`） |
| 演示模式 | 非 Tauri 即 mock（`ui/src/env.ts` `isTauri`；`ui/src/api.ts:72`） | `?demo=1` 显式开启（`website/src/env.ts:1`；`website/src/api.ts:23-25`）；`?platform=zhs` 选平台（`website/src/main.ts:43/56`） |
| 平台实现位置 | Rust `src/` + `src-tauri` DTO | TypeScript 重写：`website/src/core/{client,parse,playback,submit,answers}.ts`、`website/src/core/zhs/{client,watch,meet,crypto,transport}.ts` |
| 文档完成 | Rust `src/documents.rs` + `client.rs:969` | TS `website/src/core/documents.ts`（`:55 parseAttachmentSetting`、`:110 attachmentJToken`、`:129 collectDocumentTargets`）+ `core/client.ts` 的 `fetchDocumentSetting`/`completeDocument`；transport 白名单 `core/transport.ts:29-31` 新增 `phone/wxcard`、`job/document` |

### 4.2 路由与交互对照

| 能力 | GUI | website | 差异 |
| --- | --- | --- | --- |
| 顶层路由 | `showConnect/showHome/course/zhs-course/zhs-meet`（`ui/src/main.ts:142-165/569/644`） | 同结构（`website/src/main.ts:127-157/447/536`） | website 用 `store.platform` + 双 session（`:55-79`），ZHS 课程转 `CourseSummary` 塞侧栏（`:88-101 toSidebarCourse`） |
| 平台命名 | `"hust" \| "zhihuishu"`（`ui/src/types.ts:130`） | `"hust" \| "zhs"`（`website/src/views/connect.ts:7`） | **不一致**，web 侧还有 `?platform=zhs` |
| 事件通道 | 单 `job-progress` + camelCase kind | 双通道：`job-progress` + `zhs-progress`（`website/src/api.ts:26-29`），知到 kind 为 `zhs-plan/zhs-crawl/zhs-video`（`core/zhs/backend.ts:85-120`） | **不一致** |
| 知到 DTO | camelCase（Rust `#[serde(rename_all="camelCase")]`，`src-tauri/src/zhihuishu.rs:126+`；TS `ui/src/types.ts:308+`） | snake_case（`website/src/core/zhs/types.ts:1-3`，镜像 Rust core） | **不一致**，同一协议两套字段名 |
| 知到风控检查 | header “检查风控状态”（`views/zhs-course.ts:269-275`、`zhs-meet.ts:76-83`） | **缺失**（website zhs-course/zhs-meet 无 `data-action='check'`） | website 功能缺口 |
| 知到结果复制 | `#zhs-watch-copy`/`#zhs-meet-copy`（`views/zhs-course.ts:465`、`zhs-meet.ts:270`） | **缺失** | website 功能缺口 |
| 文档按钮命名 | `onDocuments`/`data-action="documents"`/`data-doc-job`（`ui/src/views/course.ts:31/299/478`） | `onDocument`/`data-action="document"`/`data-document-job`（`website/src/views/course.ts:32/299/478`；`website/src/main.ts:345`） | **不一致**，合并时易漏 |
| 视图文件 | `ui/src/views/*.ts` | `website/src/views/*.ts`（同源复制，合并前 `views/course.ts` 两边均 33672 字节；quiz.ts 13232 vs 13279） | 双份维护，已出现漂移 |
| 演示数据 | `ui/src/mock.ts`（`mockApi:728`，知到只 dry-run `:1183/1304`） | `website/src/mock.ts`（`mockApi:500`、`zhsMockApi:1049`，`:1107/1182` 拒绝真实执行） | 两套 mock 数据，字段命名不同 |

### 4.3 website 的额外风险

- website 的 SmartCourse 请求白名单只有 9 条路径 + 2 条正则（`core/transport.ts:21-33`）；
  新增平台（icourse163）必须新增**桥接脚本 + origin 白名单**，否则静态站无法工作。
- 知到桥接脚本依赖 `lc.zhihuishu.com` 页面会替换全局 `Map`（AGENTS 提醒），website 侧
  `core/zhs/*` 需要保持该兼容处理。
- website 的 `onJobProgress` 只是本地 `demoOn`（`website/src/api.ts:26-29`），真实进度由
  `browserApi`/`zhsBrowserApi` 直接 `demoEmit` 回调，**没有 Tauri 事件层**——统一事件命名时
  website 是「自己 emit 自己监听」，改造成本低于 GUI。

---

## 5. 统一方案建议

### 5.1 目标分层

```
src/
  platform.rs            Platform 枚举（core 层，CLI/Tauri/website 共用语义）
  dto.rs                 统一 DTO + adapter（Hust/Zhs/Icourse/Ulearning -> CourseDetailDto）
  models.rs              现有 SmartCourse 原始模型（不动）
  icourse163/**          平台原始实现（从主目录迁入并 pub mod）
  ulearning/**           平台原始实现（在飞）
src-tauri/
  state.rs               SessionClient 增 Icourse163/Ulearning 变体
  events.rs              plan/stage/target 统一事件
  commands.rs            HUST 薄封装（返回统一 DTO）
  zhihuishu.rs           知到薄封装（复用统一事件）
  login.rs               平台登录配置表
ui/src/
  viewmodel.ts           原始模型 -> CourseView（camelCase、actions 槽位）
  views/course-shell.ts  唯一课程页布局（header/stat/tabs/tree/task table/modal hosts）
  views/adapters/{hust,zhs,icourse}.ts   数据 + 动作槽位 + 平台专属 tab
  views/{watch,quiz,document,zhs-meet}.ts   复用弹窗
website/src/             同一套视图文件 + bridge 变体（尽量与 ui/src 共享）
```

### 5.2 Platform 枚举与会话

- 把 `Platform` 从 `src-tauri/src/state.rs:24` 移到 `src/platform.rs`，变体
  `Hust | Zhihuishu | Icourse163 | Ulearning`；`label()` 保留中文名。
- `SessionInfo`（`state.rs:47`）继续只暴露 `{platform, cookieSource, cookieCount}`，不跨 IPC
  传 cookie；website 侧 `SessionInfo` 增加 `platform` 以便统一侧栏/连接页（当前 website
  `SessionInfo` 没有 `platform`，`website/src/types.ts:129-132`）。
- `SessionClient`（`state.rs:66`）扩为：
  ```rust
  pub enum SessionClient {
      Hust(HustSession), Zhihuishu(ZhsSession),
      Icourse163(IcourseSession), Ulearning(UlearningSession),
  }
  ```
  `AppState::client()/zhs_client()` 改为 `for_platform()` 或新增 `icourse_client()` 等，
  避免 `Option<T>` 组合爆炸；命令侧统一 `state.require(Platform::X)`。
- 登录：`login_config`（`login.rs:59`）加 `Icourse163 { entry: "https://www.icourse163.org/",
  cookie_urls: &["https://www.icourse163.org/", "https://www.icourse163.com/"] }`（验活用
  `resolve_spoc_course` 或 `getLastLearnedMocTermDto`）；`is_platform_page`（`:167`）加
  `host.ends_with("icourse163.org")`；Ulearning 走 `umooc.ulearning.cn` CAS（`LOGIN_URL`）。
- 注意 `open_login_window` 是 async 且窗口 label 固定 `login`（`login.rs:36/75-93`），
  切平台时当前逻辑是「关旧窗 + 报错重试」，平台变多后建议改为「关闭旧窗 → 自动打开新窗」。

### 5.3 统一课程 DTO

见 §2.2 的 `CourseSummaryDto/CourseDetailDto/ChapterDto/TaskPointDto/CourseRef/TaskRef/
ProgressState`。落地策略：

1. **先只做 Display DTO**：CLI `dump --json` 和 `fetch_course` 命令返回统一 DTO，原始模型保留
   在 core 内；内部代码仍用原始模型（避免一次性大改）。
2. `CourseStatsDto` 统一为 `{chapterNodes, leaves, taskPoints, videos, documents, works,
   questions, errors}`（现有 `CourseStats` 字段可直接映射，`src/models.rs:45`）。
3. 平台特有字段进 `extra`：Hust 的 `enc/old_enc/openc/final_url/kc_enc...`、知到的
   `secret/watchState/...`、icourse 的 `term_id/source_term_id/...`。
4. 迁移期保留旧 snake_case 字段（`#[serde(flatten)]` 或双写），前端先切新字段，再删旧字段。

### 5.4 课程页组件复用（UI 壳）

**共用（course shell）**：header 布局 + 统计条 + tabs（目录/任务点/测验/诊断）+
任务点表格与筛选 + 章节目录树 + 进度条 + 取消 banner + 弹窗容器。

**平台特有（adapter / action slot）**：

```ts
interface CourseView {
  title: string;
  subtitle?: string;
  stats: StatCard[];
  tabs: TabSpec[];
  chapters: ChapterView[];
  actions: CourseAction[];      // header 动作
  rowActions: RowActionBuilder; // 任务行动作（按 kind 返回按钮）
  extraTabs?: TabSpec[];        // 知到见面课、icourse 考试等
}

interface CourseAction {
  id: "refresh" | "watch" | "quiz" | "documents" | "open" | "export"
    | "zhs-meet" | "zhs-check" | "icourse-quiz";
  label: string;
  tone?: "primary" | "ghost";
  enabled?: boolean;
  run(): void;
}
```

- adapter 负责把平台 detail 转成 `CourseView`：
  `ui/src/views/adapters/hust.ts`（现有 `course.ts` 的渲染逻辑上移为 shell，本文件只造数据）；
  `zhs.ts`（现有 `zhs-course.ts` 的树渲染改为 `ChapterView`，见面课作为 `extraTabs`）；
  `icourse.ts`（units→`ChapterView`，动作 `watch`/`icourse-quiz`）。
- 行内动作统一由 `RowActionBuilder(point) => ActionButton[]` 生成，按钮携带
  `data-action`/`data-target`，shell 统一委托；现有 `data-watch-job`/`data-doc-job`/
  `data-work-id` 命名收敛为 `data-action="video|document|work"` + `data-target-id`。
- 弹窗统一：`watch`/`quiz`/`document` 三个 HUST 弹窗 + 知到 `zhs-watch`/`zhs-meet` 弹窗都保留，
  但把「dry-run 默认 + 风险确认 + 停止 + 进度日志 + 复制结果」抽成公共 `runJobModal()`；
  §3.5 的 HUST 视频默认非 dry-run 问题在该组件里统一修正。
- 结果回写：现在是 `markJobCompleted/markWorkSubmitted/markDocumentCompleted`
  （`ui/src/views/course.ts:183/220/200`）手工改内存对象再重渲染；统一后按
  `jobId/workId` 的通用 `patchTaskProgress(view, id, state, {percent})` 处理。

### 5.5 平台选择器

- `ui/src/views/connect.ts:17-25` 的 `PLATFORM_LABEL/PLATFORM_MARK` 扩为三项：
  `hust:"学在华科大"`、`zhihuishu:"知到（智慧树）"`、`icourse163:"中国大学 MOOC"`；
  website 的 `Platform` 从 `"hust"|"zhs"` 改为 `"hust"|"zhihuishu"|"icourse163"`（或映射层兼容旧
  `?platform=zhs`）。
- 登录按钮文案、hero 文案、feature cards、风险提示按平台配置化（现在是大段三元表达式，
  `connect.ts:64-175`），建议抽 `PLATFORM_COPY: Record<Platform, ConnectCopy>`。
- 侧栏 brand/sub 已按平台切换（`views/sidebar.ts:57-63`），补 icourse163 文案即可；
  `SidebarItem` 已经是平台无关形状（`sidebar.ts:7-11`），保留。

### 5.6 CLI 子命令一致性

现状（`src/main.rs`）：`Command`（`:47`）= `List/Dump/Tree/Helper/Doc/Watch` +
`Zhs(ZhsCommand)`（`:118`，含 `List/Tree/Watch/Check/Meet{List,Status,Watch}`）。

建议目标：

```
hust-course-hack [全局 --cookies] <command>
  hust   list | dump | tree | watch | doc      # 现行命令的别名组（缺省 = hust，向后兼容）
  zhs    list | tree | watch | check | meet list|status|watch
  icourse list | tree | watch [--quiz]         # 新增；list 用 --spoc <id|url> 或扫描课程
  uly    list | tree | watch                   # 优学院（若纳入）
  doc    --course <id> ...                     # 保留为 hust doc 的顶层别名
```

- 兼容策略：`list/dump/tree/watch/doc/helper` 顶层保留，`clap` 里作为 `hust` 子命令的别名
  （`#[command(alias)]` 或 hand-written dispatch），避免破坏 README/脚本。
- icourse 与 zhs 的 `list/tree/watch` 参数对齐：`--course`（id/URL/名称）、`--dry-run`、
  `--max-*`、`--verify`；`doc` 已有的 `--job/--include-completed/--dry-run/--max-documents`
  作为所有平台任务命令的统一 flag。
- 退出码/摘要文案统一（现在 `zhs` 有 `exit_code`，`watch` 自己有 summary 打印，`doc` 用
  `bail!` —— 建议统一走 `JobSummary { total, ok, skipped, failed, cancelled, dryRun }`）。

### 5.7 事件命名统一

建议 `JobProgress` 收敛为 4 个变体（保留旧变体一两个版本过渡）：

```rust
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JobProgress {
    Crawl { done: usize, total: usize },
    Plan { job: String, stage: String, total: usize, dry_run: bool, skipped: usize },
    Stage { job: String, stage: String, done: usize, total: usize, label: String, message: Option<String> },
    Target { job: String, stage: String, index: usize, total: usize, label: String,
             status: TargetStatus, message: Option<String> },
}

#[serde(rename_all = "snake_case")]
pub enum TargetStatus { Running, Ok, Skip, DryRun, Failed, Cancelled, CircuitBroken }
```

- `job`：`hust-watch | hust-quiz | hust-doc | zhs-watch | zhs-meet | icourse-watch | ...`；
  `stage`：`crawl | plan | videos | documents | quiz | meet_list | meet_minutes | verify | circuit_check`。
- 前端（GUI/website）统一监听一个通道 `job-progress`；website 现在的 `zhs-progress`
  改为同一通道（或统一封装成 `onJobProgress`）。
- 状态词汇统一后用同一个 `status → 文案/色调` 表（现在 `ui/src/views/zhs-course.ts:22-31`、
  `watch.ts`、`quiz.ts` 各写一份）。

### 5.8 迁移步骤（与 §6 合并顺序一致）

1. **P0 落库**：把 main 工作区 WIP（documents + icourse163 + ulearning 文档/模块）变成
   可复现 commit，合入本 worktree。
2. **P1 core 平台层**：新增 `src/platform.rs` + `src/dto.rs`，`pub mod icourse163`；
   `cargo test --workspace` 全绿（不改 UI）。
3. **P2 CLI**：`hust/zhs/icourse/doc` 子命令组 + 统一 JobSummary。
4. **P3 Tauri**：`state/events/commands/zhihuishu/login` 接入统一 DTO 与事件；
   `open_login_window` 支持 icourse。
5. **P4 GUI**：`viewmodel.ts` + `course-shell.ts` + 三个 adapter；`types.ts/api.ts/main.ts`
   收敛；mock 增加 icourse；修 §3.5 的 HUST 视频默认 dry-run。
6. **P5 website**：types/api/main/core 对齐统一 DTO 与事件；新增 icourse 桥接脚本；
   视图与 GUI 保持同源（最好把 `views/*` 抽成可共享文件，或至少用生成/校验脚本防漂移）。
7. **P6 ulearning**：按同模板接入（CLI → GUI → website）。
8. **P7 文档**：README/AGENTS/userscripts/本报告同步。

---

## 6. 冲突与合并顺序

### 6.1 两分支双改文件（19 个）

以「知到提交 `6eeac65` 改动的文件」∩「main 工作区 WIP 改动的文件」计算：

```
AGENTS.md
Cargo.lock
Cargo.toml
docs/zhihuishu-miaoshua-plan.md
README.md
src-tauri/src/commands.rs
src-tauri/src/events.rs
src-tauri/src/lib.rs
src/lib.rs
src/main.rs
ui/src/api.ts
ui/src/main.ts
ui/src/mock.ts
ui/src/types.ts
website/README.md
website/scripts/build-bridge.mjs
website/src/api.ts
website/src/main.ts
website/src/mock.ts
```

### 6.2 实测冲突（Lead 本次合并）

在 worktree 把 main 工作区 WIP 应用到索引后，`git status` 观测到 **6 个未合并**，随后被
Lead 逐个解决；截至快照已无 `UU` / 冲突标记：

| 冲突文件 | 冲突性质 | 解决要点 |
| --- | --- | --- |
| `AGENTS.md` | 两分支各改「Current state / Conventions」 | 取并集：知到段 + 文档段 + 新约定（合并时实测出现 `<<<<<<< ours`/`theirs`） |
| `src/main.rs` | clap `Command` enum：知到加 `Zhs` 子命令，文档加 `Doc` | 两个 variant 都保留（现在 `:76 Doc`、`:118 Zhs`） |
| `ui/src/mock.ts` | 知到 mock（`zhsCourses/zhsDetailFor/zhsMeets`）与文档 mock 同文件 | 都保留；知到 mock 数据/方法在 `:504-1360`（`:1183`/`:1304` 拒绝真实执行），文档 mock 在同文件后段 |
| `website/README.md` | 两平台说明文字 | 取并集 |
| `website/src/api.ts` | `Backend` 接口：`completeDocuments` vs `zhs*` | 都保留（现在 `:9-30`） |
| `website/src/main.ts` | 路由/`showDetail` 同时加 `onDocument` 与知到视图 | 都保留（现在 `:345 onDocument`、`:501 openDocument`，知到流程 `:395-588`） |

其他双改文件自动合并成功但**语义仍需复核**：`src-tauri/src/events.rs`（事件 enum 追加）、
`ui/src/types.ts`（`JobProgress` union 追加）、`src-tauri/src/commands.rs`（命令注册/`generate_handler!`）、
`src-tauri/src/lib.rs`（`complete_documents` 注册）、`Cargo.toml`（版本 0.2.0→0.3.0 + `des/rsa/aes/...`）。

### 6.3 当前未落地/未接线的事实（合并后必须补）

| 项 | 现状 | 影响 |
| --- | --- | --- |
| `src/icourse163/**` | **不在 worktree**，main 分支也未 `pub mod` | 合并顺序必须先迁入并接线，否则「第三平台」不可用 |
| `src/main.rs` | 有 `Doc`/`Zhs`，**无 `icourse`/`uly`** | CLI 缺失 |
| `src/lib.rs` | `pub mod documents/ulearning/zhihuishu`，**无 `icourse163`** | 同上 |
| `src/ulearning/**` | 仅 `mod.rs`（未提交、其它会话在写） | 当前 `cargo build` 可能失败；需等其落地 |
| `src-tauri` | `Platform` 仅 Hust/Zhihuishu（`state.rs:24`）；命令无 icourse | GUI 只能显示两个平台 |
| `ui/src/types.ts` | `Platform = "hust" \| "zhihuishu"`（`:130`） | 同 |
| `website` | 平台 `"hust" \| "zhs"`（`views/connect.ts:7`） | 同；且无 icourse 桥接脚本 |
| `ui/src/main.ts:401` | 合并残留格式：`function openQuiz(...) {  openQuizModal({` 同一行 | 仅格式问题，建议 `cargo fmt` 不覆盖 TS，需 prettier/手改 |
| `src/lib.rs` 导出 | 缺 `Platform`/统一 DTO（尚不存在） | 见 §5 |

### 6.4 建议合并顺序（文件级）

| 阶段 | 内容 | 关键文件 | 验收 |
| --- | --- | --- | --- |
| **P0 冻结与落库** | main 工作区 WIP 先 commit（documents/icourse163/ulearning 文档），再合入本 worktree；解决 §6.2 冲突 | 全部 19 个双改文件 + `src/documents.rs`、`src/icourse163/**`、`tests/*`、`ui/src/views/document.ts`、`website/src/core/documents.ts`、`website/src/views/document.ts`、`docs/icourse163/**` | `git status` 干净；`cargo test --workspace`、`cd website; npm test`、`npm run build` |
| **P1 core 抽象** | `src/platform.rs`、`src/dto.rs`、`pub mod icourse163`；不改 UI | `src/lib.rs`、`src/platform.rs`、`src/dto.rs`、`src/icourse163/mod.rs` | 新增 DTO 单测；CLI 仍全绿 |
| **P2 CLI** | `hust` 别名组 + `icourse` 子命令 + 统一 JobSummary | `src/main.rs`（唯一冲突热点） | 手工 smoke：`hust list`、`hust doc --dry-run`、`icourse tree --course <HUST-id>` |
| **P3 Tauri** | `Platform` 加变体、`SessionClient` 扩展、事件统一、`login_config` 加平台、命令返回 DTO | `src-tauri/src/{state,events,commands,zhihuishu,login,lib}.rs` | `cargo check -p hust-course-hack-gui`；GUI 两平台手动回归 |
| **P4 GUI 壳** | `viewmodel.ts` + `course-shell.ts` + adapters + connect 选择器 + mock；修 HUST 视频默认 dry-run | `ui/src/{types,api,main,mock}.ts`、`ui/src/views/{connect,course,sidebar,watch,quiz,document,zhs-course,zhs-meet}.ts`、新增 `ui/src/views/{course-shell,adapters/*}.ts` | `npm run dev` 演示模式三平台可点；真机 HUST/知到回归 |
| **P5 website** | 对齐 DTO/事件；新增 icourse bridge + 白名单；补 `check`/复制等缺口 | `website/src/{types,api,main,mock}.ts`、`website/src/core/**`、`website/src/views/**`、`website/src/*.user.ts`、`website/scripts/build-bridge.mjs` | `cd website; npm test; npm run build`；真浏览器桥接 smoke |
| **P6 ulearning** | 按模板接 CLI/GUI/website | `src/ulearning/**`、三处平台枚举/视图 | 单平台 smoke |
| **P7 文档** | README/AGENTS/本报告/端点表 | `README.md`、`AGENTS.md`、`docs/**` | 文档与命令一致 |

**理由**：documents/icourse163 是「新增能力」，与知到在文件层面高度重叠（19 个双改文件），
先落库才能让后续抽象只做一次；平台抽象（P1）必须在两个功能都进仓库后做，否则会二次返工；
UI（P4/P5）最后做，避免在移动的 `types.ts/mock.ts` 上反复解冲突。

---

## 7. 需要改动的文件清单与工作量估计

估算前提：1 名熟悉仓库的开发者；含自测，不含线上真机验证的等待时间；单位「人时」。

### 7.1 汇总

| 阶段 | 内容 | 估算 |
| --- | --- | --- |
| P0 | 合并收尾（迁入 icourse163/ulearning 文件、解冲突、修 `main.ts:401` 格式、跑全量测试） | **6 h** |
| P1 | core 平台层（`platform.rs` + `dto.rs` + adapter + 单测） | **14 h** |
| P2 | CLI 重构（`hust` 别名组、`icourse` 子命令、统一 summary/退出码） | **10 h** |
| P3 | Tauri 层（state/events/commands/zhihuishu/login/lib + 登录窗口 icourse） | **16 h** |
| P4 | GUI（viewmodel + course-shell + 3 adapters + connect/sidebar/mock + 弹窗统一） | **34 h** |
| P5 | website（DTO/事件对齐 + icourse 桥接 + 视图缺口 + mock） | **28 h** |
| P6 | ulearning 接入（CLI/GUI/website，复用模板） | **14 h** |
| P7 | 文档与测试补强（README/AGENTS/端点表/集成测试） | **10 h** |
| **合计** | | **≈ 132 h（约 16–17 人日）** |

> 若范围裁剪为「只做 P0–P4、website 仅保持现状两平台」，约 **80 h（10 人日）**；
> 若再砍掉 ulearning，约 **66 h（8 人日）**。

### 7.2 文件级清单

**Rust core**

| 文件 | 动作 | 估算 |
| --- | --- | --- |
| `src/platform.rs`（新） | `Platform` 枚举 + 标签 + 平台判定 | 2 h |
| `src/dto.rs`（新） | `CourseSummaryDto/CourseDetailDto/ChapterDto/TaskPointDto/CourseRef/TaskRef/ProgressState` + 各平台 adapter + 单测 | 10 h |
| `src/lib.rs` | 模块与导出；`pub mod icourse163` | 1 h |
| `src/icourse163/**`（从主目录迁入） | 6 个文件，补 `pub mod`、`lib.rs` 导出、测试挂载 | 3 h |
| `src/main.rs` | `Command` 重构、`icourse` 子命令、统一 `JobSummary`/退出码、`doc` 兼容 | 10 h |
| `src/models.rs` | 可选：`TaskKind` 加 `Quiz`/`Resource` 或 `other` 语义说明 | 1 h |
| `Cargo.toml` | 依赖（已有 `des/rsa/aes/cbc`）、版本 | 0.5 h |

**Tauri（src-tauri）**

| 文件 | 动作 | 估算 |
| --- | --- | --- |
| `src-tauri/src/state.rs` | `Platform` 移入 core、`SessionClient`/`AppState` 扩展、`for_platform()` | 5 h |
| `src-tauri/src/events.rs` | `JobProgress` 收敛为 Crawl/Plan/Stage/Target + `TargetStatus` | 4 h |
| `src-tauri/src/commands.rs` | HUST 命令返回统一 DTO；新增 `icourse_*` 命令；`fetch_course` 适配 | 6 h |
| `src-tauri/src/zhihuishu.rs` | 事件改用统一骨架；DTO 与统一 DTO 对齐（保留 camelCase） | 4 h |
| `src-tauri/src/login.rs` | `login_config` 加 icourse/ulearning；`is_platform_page`；验活；窗口切换策略 | 5 h |
| `src-tauri/src/lib.rs` | `generate_handler!` 注册 | 0.5 h |

**GUI（ui/src）**

| 文件 | 动作 | 估算 |
| --- | --- | --- |
| `ui/src/types.ts` | 统一 DTO/事件/平台枚举/文档/知到类型整理 | 3 h |
| `ui/src/api.ts` | 命令封装扩展（icourse）、事件通道收敛 | 1.5 h |
| `ui/src/main.ts` | store 泛化（`platforms` 子状态 map）、路由、`activateSession`、登录/断开 | 6 h |
| `ui/src/views/connect.ts` | 平台选择器 3–4 项 + 文案配置化 | 2.5 h |
| `ui/src/views/course-shell.ts`（新） | 从 `course.ts` 抽取共用布局/统计/tabs/任务表/树/委托/弹窗宿主 | 10 h |
| `ui/src/views/course.ts` | 改为 HUST adapter（数据 + 动作 + 行动作） | 3 h |
| `ui/src/views/zhs-course.ts` | 改为知到 adapter；视频树映射 `ChapterView`；保留首页添加课程 | 4 h |
| `ui/src/views/zhs-meet.ts` | 作为 `extraTabs` 面板挂载；补统一 runner | 2 h |
| `ui/src/views/icourse-course.ts`（新） | icourse adapter（units→ChapterView、watch/quiz 动作） | 5 h |
| `ui/src/views/watch.ts` / `quiz.ts` / `document.ts` | 抽公共 `runJobModal`；修 HUST 视频默认 dry-run | 3 h |
| `ui/src/views/sidebar.ts` | 平台文案/图标 | 1 h |
| `ui/src/mock.ts` | `mockApi` 增加 icourse 示例 + 事件 | 3 h |

**website（website/src）**

| 文件 | 动作 | 估算 |
| --- | --- | --- |
| `website/src/types.ts` | 对齐统一 DTO/事件/平台命名（含旧 `zhs` 兼容） | 3 h |
| `website/src/api.ts` | 单通道事件 + icourse backend | 2 h |
| `website/src/main.ts` | 平台参数/路由/store 收敛 | 4 h |
| `website/src/views/connect.ts` | 平台选择器 + 桥接脚本链接 | 2 h |
| `website/src/core/{backend,client,transport}.ts` | 统一 DTO；icourse 请求（如走 HTTP 直连或新桥） | 5 h |
| `website/src/core/icourse/**`（新） | icourse163 的 TS 重写（RPC 签名、课程树、视频上报） | 8 h |
| `website/src/icourse-bridge.user.ts`（新）+ `scripts/build-bridge.mjs` + `public/*.user.js` | 新桥接脚本与构建 | 4 h |
| `website/src/views/{course,zhs-course,zhs-meet}.ts` | 与 GUI 共用壳/adapter（尽量同源） | 6 h |
| `website/src/mock.ts` | icourse 演示数据 | 2 h |
| `website/tests/*.test.ts` | 文档/事件/DTO 测试 | 3 h |

**文档 / 测试**

| 文件 | 动作 | 估算 |
| --- | --- | --- |
| `README.md` | 命令/端点表/平台说明 | 3 h |
| `AGENTS.md` | Current state/Conventions 合并与更新 | 2 h |
| `docs/analysis/crawl-and-ui-abstraction.md` | 本报告（已完成） | — |
| `tests/*.rs` | 统一 DTO/adapter/CLI 冒烟 | 4 h |
| `docs/zhihuishu-miaoshua-plan.md`、`docs/ulearning/*` | 与新 DTO/命令对齐 | 1 h |

### 7.3 风险与缓冲

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `src/main.rs` / `events.rs` / `types.ts` / `mock.ts` 冲突热点 | 每次合并返工 | 先落库再抽象；`JobProgress` 只加不改；`mock.ts` 拆分为 `mock/{hust,zhs,icourse}.ts`（建议顺手做，+3h） |
| icourse163 测验只能走 WebView DOM 自动化 | GUI 架构新增「隐藏 webview 驱动」能力，工作量被低估 | 单独列 M3，先做只读/高亮建议，自动提交需二次确认（recon §5.2/§5.3） |
| website 需要第三套桥接脚本 | 安全面扩大（白名单、origin/nonce、allowlist 维护） | 复用 `zhihuishu-bridge` 模板；白名单集中到 `core/*/transport.ts`；新增测试 |
| 知到 DTO camelCase vs website snake_case | 统一 DTO 时易错 | 统一 DTO 用 camelCase（GUI 现有约定），website 在 `core/zhs/types.ts` 加映射层，不直接改协议字段 |
| docs/zhihuishu-miaoshua-plan.md 在两处同时存在 | 合并歧义 | 以本 worktree 已提交版本为准，main 的未跟踪副本删除 |
| 并发会话同时改同一 worktree（本分析期间 ulearning 在写） | 编译/测试不稳定 | 各会话按 write scope 分工；Lead 合并前 freeze；P0 先跑一次基线 |
| HUST 视频默认非 dry-run | 误触发真实上报 | P4 统一 `runJobModal` 时修正，并加 GUI 冒烟测试 |

---

## 8. 附录：证据索引（关键 `文件:行号`）

**SmartCourse**
- `src/models.rs:11` `CourseSummary`；`:30` `CourseDetail`；`:45` `CourseStats`；`:64` `Chapter`；
  `:81` `Card`；`:111` `TaskPoint`；`:156` `TaskKind`；`:189` `Question`
- `src/client.rs:118` `list_courses`；`:127` `list_courses_with_url`；`:151` `fetch_course_with_progress`；
  `:465` `report_video_progress`；`:724` `submit_planned_work`；`:906/942/969` 文档三函数
- `src/parse.rs:76/154/177/303/340/367/389/414/503/547` 解析入口
- `src/playback.rs:35/167/181/207/342` 视频上报
- `src/submit.rs:220/611/908/1028/1100` 测验
- `src/documents.rs:23/64/135/168/202` 文档

**知到**
- `src/zhihuishu/api.rs:670/827/872/925/954/1021/1030/1040/1079/1121/1150/1182/1312/1399`
- `src/zhihuishu/models.rs:29/98/115/152/167/209/310/398`
- `src/zhihuishu/crypto.rs:132/156/192/202/250/288/335`
- `src/zhihuishu/mod.rs:45-145` 常量；`src/zhihuishu/watch.rs:40/132`；`meet.rs:108/248`

**icourse163（主目录）**
- `src/icourse163/client.rs:72/85/112/118/138/155/223`
- `src/icourse163/course.rs:26/40/54/64/85/144`
- `src/icourse163/models.rs:14/57/69/81/136/159`
- `src/icourse163/video.rs:50/68/96/127/164/188`
- `src/icourse163/crypto.rs:31/45/56/69`
- `docs/icourse163/recon-feasibility.md` L9-L18、L22-L25、L49-L62、L79-L85、L107-L126、
  L158-L178、L184-L185、L209-L220

**优学院（在飞）**
- `src/ulearning/mod.rs:1-29`；`docs/ulearning/miaoshua-plan.md` §2.2/§2.4；
  `docs/ulearning/recon-static.md` 站点表

**GUI（Tauri）**
- `src-tauri/src/state.rs:24/47/66/72/84/123/131/206/218`
- `src-tauri/src/events.rs:15/32/34/69/79/90`
- `src-tauri/src/commands.rs:178/207/370/513/767`
- `src-tauri/src/zhihuishu.rs:414-774`、`:126-411` DTO
- `src-tauri/src/login.rs:36/39-51/53-72/167/193/227/263/303/386/399`

**GUI（前端）**
- `ui/src/main.ts:74/142/165/187/272/298/348/385/520/569/644/750/777`
- `ui/src/views/{connect,course,watch,quiz,document,zhs-course,zhs-meet,sidebar}.ts` 见 §3.2 表
- `ui/src/types.ts:130/132/162/223/308`；`ui/src/api.ts:29/41/72/75`
- `ui/src/mock.ts:502/728/1183/1304`

**website**
- `website/src/env.ts:1`；`website/src/api.ts:9-30`
- `website/src/core/transport.ts:14-35/37-115`
- `website/src/core/backend.ts:46-199`（documents `:99-155`）
- `website/src/core/zhs/transport.ts:12-27/57-88/116-252`
- `website/src/core/zhs/backend.ts:26-120`
- `website/src/core/zhs/types.ts:1-120`
- `website/src/main.ts:43/55/88/103/345/501`；`website/src/views/connect.ts:7/18/47`
- `website/src/views/document.ts:41`；`website/src/core/documents.ts:55/110/129`
- `website/src/mock.ts:500/1049`

**合并状态**
- worktree `HEAD = 0e2b84b`（merge `0b52486`）；
- 双改文件 19 个（§6.1）；未合并 6 个（§6.2）；
- main 工作区未跟踪：`src/icourse163/**`、`src/documents.rs`、`tests/icourse_http.rs`、
  `tests/documents_http.rs`、`test-data/icourse-term.json`、`docs/icourse163/**`、
  `ui/src/views/document.ts`、`website/src/core/documents.ts`、`website/src/views/document.ts`、
  `website/tests/documents.test.ts`；
- 本 analysis 期间 worktree 新出现 `src/ulearning/`（其它会话在写）。
