# 知到（智慧树）：多课程类型 + 作业考试（选择题）+ 视频弹题 研究与实施计划

> 状态：协议侦察完成（2026-11-09，真实账号只读抓包），**尚未实现**
> 目标形态：**桌面客户端（Tauri GUI）**，不是 userscript / 网站版
> 关联文档：`docs/zhihuishu-miaoshua-plan.md`（共享课视频/见面课秒刷，已上线 0.3.0）

---

## 1. 现状与两个被误解的问题

### 1.1 「军理怎么都没刷」——其实刷了，是显示逻辑错了

- 2026-11-09 实测：军事理论-综合版课程进度 **10.9% → 46.9%**（视频记录接口真实生效，`watchState=1`）。
- 但 GUI 课程页显示 **0 / 59**：它用的是 `videolist` 里的 `isStudiedLesson` 字段，该字段**没有随学习记录刷新**；真实完成状态要以 `prelearningNote`/`queryStuyInfo` 的 `watchState` 或课程列表的 `progress` 为准。
- 结论：**「没刷」是 UI 数据源问题**，不是写入失败。修复方向见 §4.4。

### 1.2 「知到课程不止军理」——现有实现只覆盖「共享课」

当前 `zhs list` 只调 `queryShareCourseInfo`（共享课），账号下还有：

| 课程类型 | 课程 | 现状 |
| --- | --- | --- |
| 共享课 | 军事理论-综合版 | ✅ 已支持（视频/见面课） |
| AI 智课/智慧课程 | 微积分（B）2026级、大学生批判性思维 | ❌ 课程列表未覆盖，视频/作业协议未抓 |
| 翻转课 / 兴趣课 | 无 | 接口返回空，可暂不支持 |

### 1.3 作业考试（选择题）分布（军理实测）

`getStudentHomework` 实测返回：

| 项目 | 题目数 | 状态 | 说明 |
| --- | --- | --- | --- |
| 见面课测验（从白马庙到星辰大海…） | 5 | 已完成 20% | `meetCourseType=1` |
| 第二章单元测试 | 10 | 未提交 | `totalScore=100` |
| 第三章单元测试 | 10 | 未提交 | |
| 第四章单元测试 | 10 | 未提交 | |
| 第五章单元测试 | 10 | 未提交 | |
| **军事理论-综合版教程考试（期末）** | 68 | 未提交，`limitTime=90` 分钟，`faStudentExamRemainCount=1` | **仅 1 次机会** |

第一章单元测试已提交（100 分），可从「已提交」页回顾答案。

---

## 2. 已实测协议（真实账号，2026-11-09）

### 2.1 课程类型列表（首页抓包）

| 类型 | 接口 | 结果 |
| --- | --- | --- |
| 共享课 | `POST onlineservice-api…/student/course/share/queryShareCourseInfo`（AES 模块 **13**） | 军事理论 1 门（已实现） |
| AI 智课 | `POST onlineservice-api…/student/queryStudentAICourseList`（`secretStr`） | 微积分（B）2026级（`courseId=2099354959572668416`，`classId=299714`） |
| 微课/翻转课 | `POST …/student/course/share/queryMicroCourseInfo` | 空 |
| 选课 | `GET …/student/course/share/querySelectCourseInfo` | 空 |
| 校内智慧课程 | `GET school-platform.zhihuishu.com/spCourse/queryStudentSchoolCourseList?pageNo=1&limit=5&schoolId=360&uuid=…` | 空（需确认课程是否在此接口） |
| B2C 课程 | `POST b2cpush.zhihuishu.com/b2cpush/courseDetail/query2CCourseList` | 空 |
| 在线课程 | `GET hike-teaching-api…/student/online/course/getCourseList` | 空 |

> AI 智课（微积分/批判性思维）的视频/作业协议**尚未抓包**，需进课程页再录一轮。

### 2.2 作业考试入口

- 页面：`https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=<base64(recruitAndCourseId)>`
  - `recruitAndCourseId` 即共享课 secret（XOR 编码），base64 后作为 `recruitId` 参数。
- 路由：`#/webExamList/dohomework/<recruitId>/<stuExamId>/<examId>/<courseId>/<schoolId>/<meetCourseType>`（开始答题）
  `#/webExamList/checkHomework/...`（查看已提交）

### 2.3 API 约定

- 主机：`https://studentexam-api.zhihuishu.com/studentExam/gateway/t/v1/...`
  （登录态校验在 `/gateway/f/v1/ulogin/getLoginUserInfo`；部分考试引擎在 `taurusexam-api.zhihuishu.com/taurusExam/gateway/...`）
- 请求：`POST`，`Content-Type: application/x-www-form-urlencoded`，单字段
  `secretStr=AES-128-CBC-模块3(JSON)`，外层**没有** `date` 参数。
- 模块 3 的 key 通过 `appcomm-user…/c/has` 握手获取（与视频模块 11、见面课模块 9 同一个 RSA 流程）。
- 响应：纯 JSON `{currentTime,msg,rt,status}`；`status=200` 为成功。

### 2.4 关键接口（已实测请求/响应）

| 用途 | 路径 | 明文参数 | 响应要点 |
| --- | --- | --- | --- |
| 作业/测验列表 | `student/getStudentHomework` | `{recruitId, courseId, flag:1, pageSize:100, pageNum:0}` | `studentHomeworkList[]`：`id`(stuExamId)、`examId`、`examName`、`state`、`achieve/achieveCount`、`problemNum`、`totalScore`、`meetCourseType`、`isCheckAnswer` |
| 期末列表 | `student/getStudentFinalExam` | `{courseId, recruitId, flag:1}` | `examId`、`id`、`problemNum`、`limitTime`、`faStudentExamRemainCount` |
| 试卷 | `student/lookHomework` | `{recruitId, studentExamId, examId, schoolId, courseId}` | `examBase.workExamParts[].questionDtos[]`：题干、题型、`questionOptions[]{id,content}`、分值；**不含正确答案** |
| 已作答 | `answer/getStuAnswerInfo` | （同试卷参数） | 每题 `answer`=所选 optionId、`score` |
| 判分 | `answer/checkAnswerSheetInfo` | | 每题得分 |
| 解析 | `exam/getAllQuesitonAnalysis` | | 本次返回 `{}`（可能仅解析页/特定题型有） |
| 保存 | `answer/saveStudentAnswer` | | 保存单题/临时保存 |
| 提交 | `answer/submit` / `student/doExam`（bundle 中出现，尚未实抓） | | 待补抓 |

### 2.5 答案可见性（决定方案的核心事实）

- **未提交**试卷：`lookHomework` 只给题干和选项，**没有正确答案**。
- **已提交**试卷：`getStuAnswerInfo`（所选 optionId）+ `checkAnswerSheetInfo`（每题得分）+ 选项表 → 若得分满分，可**还原正确答案**，沉淀成答案库。
- **期末**：68 题、90 分钟、**仅 1 次**机会，不能靠「先交再改」。
- 见面课测验：`meetCourseType=1`，同一套考试引擎。

### 2.6 视频中间弹题

- 播放器（`studyvideoh5`）在播放过程中会插入「弹题」，需要作答才能继续；与作业考试不是同一条链路。
- 用户确认的规则：**弹题随便选一个即可**（不参与课程分数/或按完成度宽松处理）。
- 现有「秒刷」直接调学习记录接口、不播放视频，因此不会触发弹题；只有做「真实播放自动化」时才需要自动任选。

---

## 3. 方案对比

| 方案 | 做法 | 优点 | 风险/缺点 |
| --- | --- | --- | --- |
| **A. WebView2 自动化（推荐）** | 桌面端开一个独立 WebView 窗口加载 `stuExamWeb`，注入脚本读题/答题/提交；视频弹题同理 | 复用平台自己的签名、Cookie、验证码；改动集中在桌面壳；页面结构变化时脚本可调 | 合成点击/脚本可能被反作弊检测（页面有 `checkoutNotTrustScript`、禁用复制/右键）；需处理 iframe/懒加载 |
| **B. 纯 API（Rust core）** | 复刻模块 3 secretStr + 上述接口，直接保存/提交 | 无 DOM 依赖，稳定、可测试 | 需要答案来源；提交参数/风控（易盾、异常脚本标记）未验证；期末一次机会风险高 |
| **C. 混合（建议）** | API 负责只读（课程/作业列表、试卷、答案库提取与校验、dry-run 展示），WebView2 负责真实提交与弹题 | 读写风险隔离，UI 可先上线只读能力 | 两套协议要同步 |

**结论**：推荐 **C（混合）**——Rust core 先做只读全链路（列表/试卷/答案库），真实提交走桌面端内嵌 WebView（用户可见、可取消、可复核）。

---

## 4. 桌面客户端实现方案

### 4.1 新增窗口

- `src-tauri/src/zhs_exam.rs`：`open_exam_window(recruit_and_course_id)`，独立 WebView（与登录窗口同套临时目录约束），加载：
  `onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=<base64 secret>`
- 注入脚本（`initialization_script`，避免 CSP/时序问题）职责：
  1. 读取作业列表（优先调用页面同源 API，失败则解析 DOM）；
  2. 逐题渲染/定位：`questionDtos` → 题干 + 选项；
  3. 作答：优先答案库精确匹配（题干归一化 + 选项文本）；库中没有则：单选/判断**任选第一个**、多选按库或全选（可配置）；
  4. 保存 + 提交，回读 score；
  5. 提交后把「题干 + 正确选项」写回答案库（可导出 JSON）。
- 所有动作需用户在 GUI 中显式确认（默认 dry-run：只列题目和将选项，不提交）。

### 4.2 Rust core 新增（只读先行）

- `src/zhihuishu/exam.rs`：
  - `ZhsExamClient`（复用 ZhsClient 的 http/cookie/module-key 缓存，模块 **3**）；
  - `list_homework(recruit_id, course_id)` → `Vec<ZhsHomework>`
  - `list_final_exam(...)`, `paper(exam)` → `ZhsExamPaper{parts, questions, options}`
  - `submitted_answers(exam)` → 每题所选 + 得分（用于答案库提取）
  - 提交端点待抓包后再实现（P3），默认只读。
- 模型：`ZhsHomework { stu_exam_id, exam_id, name, state, achieved, problem_num, total_score, meet_course_type, check_answer }`、`ZhsExamQuestion { id, stem, kind, options, score }`。
- 答案库：`test-data/zhihuishu-answer-bank.json`（题干归一化 + 正确选项文本/optionId），由「已提交作业」自动提取生成。

### 4.3 桌面入口

通过桌面 GUI 使用课程及作业功能；当前产品不提供 CLI。

### 4.4 GUI 修复（「没刷」的显示逻辑）

1. 课程页完成度改用 **`watchState`/课程列表 progress**，不再用 `isStudiedLesson`；
2. 每个视频显示真实状态：`已完成（平台记录）` / `已计划` / `跳过（已完成）` / `跳过（无时长/不支持）`；
3. 秒刷结束后刷新课程进度并显示「平台进度 X% → Y%」；
4. 多课程类型分组（共享课 / AI 智课 / 智慧课程），不再只显示共享课；
5. 作业/测验入口：列出单元测试/见面课测验/期末，标注题数、次数、截止时间、是否已提交。

### 4.5 视频弹题

- 仅在「真实播放自动化」模式下启用：`answerPopup()` 监听弹题 DOM，任选第一个选项并点击「确定/继续」；
- 秒刷（接口模式）不需要也不触发弹题。

---

## 5. 答案来源策略（按优先级）

1. **已有提交记录还原**（最稳）：已提交作业 → `getStuAnswerInfo` + 满分题 → 答案库；
2. **平台重做/最高分**（待验证）：若单元测试允许多次提交且取最高分，可「先随便提交→读回正确答案→再提交」；需先确认 `achieveCount`/`remainCount` 语义与重做按钮；
3. **外部题库/AI**（需人工确认）：按题干匹配公开题库或调用 AI；默认关闭，需用户显式授权；
4. **任选**：视频弹题、无答案且允许低分的选择题（用户已确认弹题可任选）。

> 期末 68 题仅 1 次机会，**不自动提交**；只提供「试卷预览 + 答案建议（标注来源）」，由用户确认。

---

## 6. 风险与合规

- 自动答题/提交涉及学术诚信与平台用户协议；默认 dry-run，必须用户显式确认；
- 考试页有反脚本检测（`checkoutNotTrustScript`，检测到会弹「关闭插件/刷新」）；WebView 注入需尽量使用页面自身请求，避免高频/并发；
- 期末仅 1 次机会、有截止时间与限时（90 分钟）；不做自动提交；
- AI 智课/智慧课程（微积分、批判性思维）协议完全不同，需另抓一轮（视频/作业）；
- 答案库来自个人提交记录，可能含个人信息，入库前需脱敏（只保留题干/选项/答案，不含用户/班级/分数）。

---

## 7. 分阶段计划

| 阶段 | 内容 | 风险 | 产出 |
| --- | --- | --- | --- |
| **P0** | 多课程类型列表（共享课 + AI智课 + 智慧课程）+ GUI 完成度显示修正 | 低 | GUI 课程分组、§4.4 |
| **P1** | 作业/期末列表 + 试卷只读 + 答案库提取（已提交） | 低（只读） | GUI 作业列表、`zhihuishu-answer-bank.json` |
| **P2** | 已提交作业答案回填校验（比对满分题） | 低 | 答案库质量报告 |
| **P3** | WebView2 作业窗口：干跑 → 逐题作答 → 保存 → 提交（用户确认） | 中 | `open_exam_window` + 注入脚本 |
| **P4** | 视频弹题任选 + 真实播放自动化（可选） | 中 | `answerPopup` |
| **P5** | AI 智课（微积分/批判性思维）协议抓包与接入 | 中 | 新协议文档 + 列表 |
| **P6** | 测试（mock exam server）、文档、PR | 低 | tests + README/AGENTS |

---

## 8. 待确认（需要你拍板）

1. 单元测试/见面课测验**是否允许重做**（决定「先交再改」策略是否可行）？
2. 期末 68 题：只做**答案建议（不自动提交）**，还是也要自动填好等你确认？
3. 答案来源：优先「已提交记录还原」，缺失题目用 **任选** 还是 **AI**（需要额外配置）？
4. 微积分（B）/大学生批判性思维：这轮是否要一起抓协议（AI 课程链路不同）？
5. 验收标准：作业正确率优先，还是「完成即可」？

---

## 附录 A：本次实测证据（摘要）

- 时间：2026-11-09 18:20–18:26（Asia/Shanghai），真实学生账号。
- 抓包文件（仓库外）：`E:\Workspace\zhs-recon\live2-zhs-exam3\requests.jsonl`（试卷/答案）、`live2-zhs-examlist3\requests.jsonl`（作业/期末列表）、`live2-zhs\requests.jsonl`（首页各课程类型列表）。
- 模块 3 解密验证：`lookHomework` 明文 `{"recruitId":"463667","studentExamId":"56XXX3LE","examId":"5JXmnMbw","schoolId":"360","courseId":"1000011214"}`。
- 作业列表：4 个单元测试（各 10 题）+ 见面课测验（5 题，20%）+ 期末（68 题、90 分钟、1 次）。
- 课程进度：军事理论 10.9% → 46.9%（视频秒刷真实生效）；GUI 显示 0/59 为数据源问题。
