# 优学院（ulearning.cn）视频秒刷 — 实施计划

> 状态：**已在本账号全量执行通过**（2026-11-07：56 个视频/图文节 + 17 个章节练习节全部提交，17 讲课件进度 100%、分数 100；服务端 73 次 sync 无一次返回 `2`）。本文保留为实施依据与后续移植到 CLI/GUI 的规格。
> 目标平台：`ua.ulearning.cn/learnCourse`（播放器）+ `api.ulearning.cn`（记录/答案接口）
> 非目标：作业/测验/小组作业、考试（`utest`）、直播、课堂、考勤
> 上游分析：[`web-analysis.md`](./web-analysis.md)（协议细节与证据都在那里，本文不重复取证过程）

## 1. 目标与验收

### 目标

在既有仓库（Rust core + CLI + Tauri GUI + userscript + website）上新增「优学院视频秒刷」：

1. 用 cookie/token 会话直接调接口，把一节视频标记为已完成（`section.complete=1`、`video.status=1`）；
2. 支持整门课批量（按章/节/页枚举），跳过已完成、可取消、默认 dry-run；
3. 三个入口：CLI（先）、GUI（后）、userscript（可选）；
4. 不回归：现有学在华科大功能与测试全绿。

### 验收标准（Definition of Done）

- [ ] `cargo test --workspace` 全绿；`cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings` 通过；
- [ ] `uly watch --dry-run` 打印「章/节/页 → 将发送的 payload 摘要」，不打 token、不发送；
- [ ] 真实运行后，`GET /studyrecord/item/{sectionId}` 里 `completion_status=1`，课程页 `#/course/textbook` 对应讲进度变化；
- [ ] 批量模式：失败即停、限速可配、进度事件可取消；
- [ ] 日志、dry-run 报告、错误信息中不出现 `AUTHORIZATION` 值。

## 2. 已实测通过的协议（实现依据）

### 2.1 会话与入口

| 项 | 值 |
| --- | --- |
| 播放器入口 | `https://ua.ulearning.cn/learnCourse/learnCourse.html?courseId={textbookId}&chapterId={chapterIdForClass}&classId={classId}` |
| 记录 API | `https://api.ulearning.cn` |
| 鉴权 | Header `Authorization: <token>` + `UA-AUTHORIZATION: <token>`（有的请求还要 `version: 1`） |
| token 来源 | cookie `AUTHORIZATION`（域 `.ulearning.cn`）；或登录 `POST https://courseapi.ulearning.cn/users/login {loginName,password}` → `authorization` |
| 课程 id 关系 | 课程页 `courseId`（ocId，如 165508）→ 播放器 `courseId`/`textbookId`（如 47353）；`classId`（如 1019700） |

实现约定：与现有 `--cookies cookies.txt` 一致，从 Netscape cookies 文件读取 `AUTHORIZATION`，**不引入账号密码登录**。

### 2.2 课程树枚举（批量入口）

```
GET https://api.ulearning.cn/course/stu/{textbookId}/directory?classId={classId}
```
返回章 → 节 → 页（含 `relationId`）。实测该接口一次给出整门课结构；第一讲包含 4 个「节」节点（3 视频 + 1 章节练习）。

辅助：

```
GET /course/{textbookId}/basicinformation     # 标题、locale
GET /course/{textbookId}/remaining            # time<0 = 过期，直接拒绝刷
GET /classes/{textbookId}?classId={classId}
GET /wholepage/item/stu/{sectionId}           # {itemid, wholepageDTOList:[…]}
GET /wholepage/stu/{pageId}                   # coursepageDTOList[]：视频/题目/文档
```

### 2.3 单页数据

- 视频页：`contentType=6`，`coursepageDTOList[0]` 有 `type=4`、`coursepageDTOid`、`resourceid`、`videoLength`（秒）。
- 练习页：`contentType=7`，`coursepageDTOList[0].type=6`，`questionDTOList[]`（**正确答案不下发**）。
- 页 `relationid` 才是记录里的 `pageid`；节 `id` 是 `itemid`。

### 2.4 完成记录上报（核心，已验证）

```
POST https://api.ulearning.cn/yws/api/personal/sync?courseType=4&platform=PC
Content-Type: application/json
Authorization: <token>
UA-AUTHORIZATION: <token>

body = DES-ECB(PKCS7, key="12345678", JSON(payload))   # CryptoJS.DES.encrypt 输出 Base64
```

`payload`：

```json
{
  "itemid": 2377981,
  "autoSave": 1,
  "withoutOld": null,
  "complete": 1,
  "studyStartTime": 1794062059,
  "score": 100,
  "pageStudyRecordDTOList": [{
    "pageid": 2377982,
    "complete": 1,
    "studyTime": 1000,
    "score": 100,
    "answerTime": 1,
    "submitTimes": 0,
    "questions": [],
    "videos": [{
      "videoid": 1563126, "current": 1326, "status": 1,
      "recordTime": 1326, "time": 1326,
      "startEndTimeList": [{"startTime": 1794319537, "endTime": 1794320137}, {"startTime": 1794320137, "endTime": 1794320863}]
    }],
    "speaks": []
  }]
}
```

要点：

- 服务端返回 `1`=成功、`2`=判定刷分/终止；其余视为失败。
- **实测该 payload 返回 1**，回读 `completion_status=1`，课程页进度 25%（1/4 页）。
- `studyStartTime` 用 `GET /studyrecord/initialize/{sectionId}` 的返回值；缺省也能过（本次用了页面加载时的值）。
- `page.studyTime` 客户端上限 1000 秒；服务端存了 1008（有自己的累加规则），说明不是强校验。
- 视频完成阈值在前端是 95%，但我们直接给 `status=1`，无需凑阈值。\n- **`startEndTimeList` 必须是真实的 epoch 时间区间**（播放器上报的是每次实际播放的起止时间戳）：旧实现写 `[{"startTime":0,"endTime":duration}]` 会被服务端判定刷课并返回 `2`；现在按视频时长生成一组以当前时间结尾的 epoch 区间。

### 2.5 单节秒刷流程

```
resolve(cookies)
→ GET /course/stu/{textbookId}/directory?classId=
→ 对每个 chapter: GET /wholepage/chapter/stu/{chapterId}（或直接遍历目录里的节）
→ 对每个 section:
    GET /studyrecord/item/{sectionId}?courseType=4   # 已 complete=1 → 跳过
    GET /wholepage/item/stu/{sectionId}              # 拿到 page + relationid
    GET /wholepage/stu/{pageId}                      # 拿到 videoLength / resourceid / 题目
    GET /studyrecord/initialize/{sectionId}          # studyStartTime
    if 页全是视频: POST sync(complete=1, videos[status=1,...])
    if 含练习页:   默认跳过该节并标记 "需人工/不处理"
→ 逐节限速（默认 3~5s 间隔），失败即停
→ 汇总：成功 / 跳过(已完成) / 跳过(含练习) / 失败
```

### 2.6 章节练习（已实测打通）

- 答案接口：`GET /questionAnswer/{questionId}?parentId={pageId}`（`parentId` 必须是**页面 id**）→ `correctAnswerList: ["D"]`。
  播放器 `Question.getQuestionAnswer()` 用它本地判分；**对未作答题目也返回答案**，90/90 实测命中。
- 提交流程（与视频同一条 sync）：
  1. `GET /wholepage/item/stu/{sectionId}` → 页面（`contentType=7`）；
  2. `GET /wholepage/stu/{pageId}` → `coursepageDTOList[0].questionDTOList[]`（含 `questionid/score/choiceitemModels`）；
  3. 逐题 `GET /questionAnswer/{qid}?parentId={pageId}` → 答案字母；
  4. sync：页面 `complete=1, score=100, submitTimes=1, coursepageId={coursepageDTOid}`，
     `questions=[{questionid, answerList:["D"], score}]`；节 `complete=1`。
- 实测结果：17 节 / 90 题全部提交成功，课件页对应章 100%。
- 题库：`test-data/ulearning-answer-bank.json`（90 题，`question_id → answer` + 题干/选项/所属节）。

### 2.7 关键约束（实现时必须保留）

- `pageid` 用页面 `relationid`；`videoid` 用 `resourceid`；`time` 用 `videoLength`（秒）。
- 视频完成阈值前端是 95%，但我们直接给 `status=1`，不需要凑。
- 含练习的节必须带 `questions[]`，否则该页不算完成（讲进度卡在 3/4）。
- `studyStartTime` 用 `/studyrecord/initialize/{sectionId}`；不填也能过（本次大量使用了页面加载值）。
- 幂等：先用 `/studyrecord/item/{sectionId}` 判 `completion_status==1` 再跳过。

## 3. 代码结构与改动范围

遵循 AGENTS.md：网络与解析留在 `hust_course_hack`，Tauri 命令只做状态/事件/IO。

```
src/ulearning/mod.rs        新：模块入口 + 错误类型
src/ulearning/client.rs     新：UlearningClient（reqwest + cookie jar，注入 Authorization 头）
src/ulearning/models.rs     新：Course/Chapter/Section/Page/VideoRecord DTO（serde，snake_case）
src/ulearning/parse.rs      新：目录树、页面内容解析（纯函数，可 fixture 测试）
src/ulearning/cipher.rs     新：DES-ECB + PKCS7 加密（`des` crate 或 `cipher` + `des`）
src/ulearning/record.rs     新：payload 构造（纯函数）+ 提交 + 回读校验
src/ulearning/plan.rs       新：批量计划（跳过已完成/含练习、限速、dry-run）
src/main.rs                 改：新增 `uly` 子命令组
src-tauri/src/commands.rs   改：`uly_plan` / `uly_complete` / `uly_cancel`
src-tauri/src/state.rs      改：复用 AppState::begin_job 的 job 锁（现只允许一个 job）
ui/src/views/              改：新增「优学院秒刷」视图（默认 dry-run + 确认勾选）
ui/src/types.ts            改：新 DTO
```

依赖新增：`des = "0.8"`（`cipher` 生态）或 `rust-crypto`；优先选纯 Rust、无 C 依赖的 `des`/`cbc`。若不想加依赖，可用 `md5` 思路手写 DES 不现实——**建议加 `des` crate**，并在 `docs/ulearning` 记录版本。

## 4. 数据模型（草案）

```rust
pub struct UlyCourse { pub oc_id: i64, pub textbook_id: i64, pub name: String }
pub struct UlyChapter { pub id: i64, pub name: String, pub sections: Vec<UlySection> }
pub struct UlySection {
    pub id: i64,                    // itemid
    pub name: String,
    pub id_for_class: Option<i64>,  // chapterIdForClass 用
    pub pages: Vec<UlyPage>,
    pub record: Option<UlySectionRecord>,
}
pub struct UlyPage { pub id: i64, pub relation_id: i64, pub content_type: i64, pub name: String }
pub struct UlyVideo { pub video_id: i64, pub duration_secs: i64 }
pub struct UlySectionPlan {
    pub section_id: i64, pub chapter_id: i64,
    pub pages: Vec<UlyPagePlan>,
    pub action: UlyAction, // Complete | SkipDone | SkipHasQuiz | SkipExpired
}
```

不变量：`action == Complete` 的节必须「所有页都是视频/文档且拿到 videoLength」，否则降级为 `SkipHasQuiz`；`dry-run` 绝不发 POST。

## 5. CLI 设计

```bash
# 沿用 --cookies
hust-course-hack --cookies uly-cookies.txt uly courses
hust-course-hack --cookies uly-cookies.txt uly plan --textbook 47353 --class 1019700
hust-course-hack --cookies uly-cookies.txt uly watch --textbook 47353 --class 1019700 --dry-run
hust-course-hack --cookies uly-cookies.txt uly watch --textbook 47353 --class 1019700 \
    --limit-chapters 1 --delay 5 --stop-on-error
hust-course-hack --cookies uly-cookies.txt uly verify --textbook 47353 --class 1019700
```

- `plan`：只读，输出表格式计划 + 统计；
- `watch --dry-run`（默认）：打印每节将发送的 payload 摘要（不含 token）；
- `watch`：真实提交，`--limit-chapters/--limit-sections` 控制灰度，`--delay` 默认 5s；
- `verify`：回读 `studyrecord/item` 与课件进度，输出核对表。

## 6. GUI 设计

- 连接页：仍只走官方登录窗口（AGENTS.md 约束）；优学院登录态用独立 webview，读 `cookies_for_url('https://api.ulearning.cn')` 拿 `AUTHORIZATION`，**cookie 值不跨 IPC**（只暴露 `SessionInfo`）。
- 课程页新增「优学院 · 秒刷本课视频」按钮 → 模态：先跑 `uly_plan` 展示「可刷 N 节 / 含练习跳过 M 节 / 已完成 K 节」；勾选确认后 `uly_complete`。
- 进度：复用 `job-progress` 事件（章/节粒度），支持 `cancel_job`。
- 安全：默认 dry-run，真实提交需勾选确认；模态里明示「只处理纯视频节，含章节练习的节会跳过」。

## 7. 测试计划

1. **单元**：DES 加密用 CryptoJS 的已知向量对拍（页面里 `CryptoJS.DES.encrypt` 输出与 Rust 一致）；payload 构造 golden test（本次实测 payload 作为 fixture）。
2. **解析**：用一次抓包的 `directory` / `wholepage` JSON 做 fixture，覆盖视频页、练习页、过期页。
3. **HTTP mock**：本地 mock `api.ulearning.cn` 行为（返回 1 / 2 / 401 / 500），验证重试、失败即停、跳过逻辑。
4. **集成（手工）**：`--limit-sections 1` 灰度一次 → `verify` 回读 → 课件页人工看进度；再放量到一章。
5. **回归**：`cargo test --workspace`、fmt、clippy；确认原有 HUST 功能不受影响。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 批量触发风控（返回 2 / 账号异常） | 默认限速 5s、`--limit-*` 灰度、失败即停、记录每节响应码；发现 2 立刻停止并提示 |
| 账号被标记 | 只在用户明确确认后真实提交；默认 dry-run；不在日志/报告写 token |
| 服务端改协议 | 接口版本集中在 `ulearning/client.rs`；`verify` 失败即显式报错，不静默 |
| 练习页被误判为视频页 | 解析层按 `contentType==6 && element.type==4` 严格判定；否则跳过 |
| 视频时长/ID 对不上 | `videoid` 取 `resourceid`、`time` 取 `videoLength`；为空则该节跳过而不是猜 |
| 隐私 | 不落盘课程内容/答案；不打印用户信息；演示数据只进 `mock.ts` |

## 9. 分期与工期（估）

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| P0 | `cipher` + `record` + 单节真实提交 + verify（已在真机验证 1 次） | 0.5 天 |
| P1 | `client` + `directory` 枚举 + `plan` + CLI `watch --dry-run` | 1 天 |
| P2 | 批量限速/幂等/失败即停 + CLI `watch` + `verify` | 1 天 |
| P3 | Tauri 命令 + GUI 模态 + 进度/取消 | 1 天 |
| P4 | 测试补齐（DES 向量、fixture、mock）+ 文档 + 灰度验收 | 1 天 |

## 10. Agent Teams 分工（并行）

| 角色 | 任务 | 写域 |
| --- | --- | --- |
| rust-core | `src/ulearning/{cipher,record,client,parse,plan}.rs` + 单测 | `src/ulearning/`、`src/main.rs` |
| gui | `src-tauri` 命令 + `ui/src/views/uly.ts` + types | `src-tauri/`、`ui/` |
| verify | 真机灰度脚本（`--limit-sections 1`）+ 验收记录 | `docs/ulearning/verify-log.md` |

依赖：gui 依赖 rust-core 的命令签名 → 先定接口再并行；verify 依赖 P1 完成。

## 11. 待确认问题

1. 是否接受「只刷视频、练习跳过，课件进度封顶 75%」？还是要研究练习伪造（高风险，需另开账号验证）？
2. GUI 是否需要优学院独立登录窗口（与现有 smartcourse 登录窗口并列），还是先用 CLI + cookies？
3. 批量灰度上限：一次最多刷多少节（建议首轮 1 章 = 4 节）？
4. 是否要做 `uly verify` 的课程页进度自动核对（需要解析 `courseapi` 的进度接口，未抓）。

