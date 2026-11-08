# 优学院（ulearning.cn）学生网页端逆向分析

> 分析时间：2026-11-07（Asia/Shanghai）· 账号：真实学生账号（已登录）
> 方法：登录态浏览器实走 + 前端静态资源只读分析（`view-source:` 读取公开 JS）
> 标注：**已验证** = 本次实际页面/代码所见；**推测** = 由代码推断未实测；**未确认** = 无证据

---

## 1. 结论摘要

1. 学生网页端是**两套前端**：课程门户/章节页 `courseweb.ulearning.cn`（jQuery 3.4 + Knockout 3.4.2 + RequireJS 2.3.5，hash 路由，构建 `version=1.4.48`）+ 学习播放器 `ua.ulearning.cn/learnCourse`（同为 jQuery + Knockout + RequireJS，非打包）。只有登录页（`umooc/pc.html`）和作业/测验子应用才是 Vue CLI 产物。
2. 鉴权是**双写 header 的静态 token**：token 取自 cookie `AUTHORIZATION`（或 URL `?token=`，Base64 解码），每个 XHR 同时带 `UA-AUTHORIZATION` 和 `AUTHORIZATION` 两个 header；无签名、无时间戳、无 nonce。
3. 学习记录上报走 `POST /yws/api/personal/sync?courseType=4&platform=PC`，请求体是 **DES-ECB 加密的前端拼接 JSON**，密钥硬编码为 `12345678`。服务端只回 `1`（成功）/`2`（判定刷分，终止学习）。
4. 视频完成度由**前端计算**：`viewTime / videoDuration >= 95%` 即把 `status` 置 1；服务端接收的是前端算好的 `status`。
5. 练习（章节练习）页面下发的题目 JSON 里**带有 `correctAnswerList`**，前端本地判分后再上报 `score`。
6. 有防挂机/防刷分机制：10 分钟无操作停学、100 秒心跳、多页面互斥（`heartbeat` 返回 `status=1`）、`/studyrecord/initialize` 下发学习起始时间戳。
7. 结论：**技术上存在"脚本化完成学习"的可行路径**（静态密钥 + 前端判分 + 服务端信任上报），但存在服务端 `result=2` 的刷分拒绝分支，必须先小流量验证，不能直接批量。

---

## 2. 域名与宿主映射（已验证：`ua.ulearning.cn/learnCourse/common/config.js`）

| 变量 | 取值（生产） | 用途 |
| --- | --- | --- |
| `CONFIG_API_HOST` | `https://api.ulearning.cn` | 学习记录、课程结构等主 API |
| `API_SERVER_HOST` | `https://courseapi.ulearning.cn` | 课程/资源服务 |
| `UMOOC_HOST` / `ROOT_ORIGIN` | `https://www.ulearning.cn` | 门户、作业（selfwork） |
| `DOCS_HOST` | `https://docs.ulearning.cn` | 文档预览 |
| `CONFIG_QINIU_RESOURCE_URL` | `https://leicloud.ulearning.cn/` | 媒体/资源 CDN（视频、PDF） |
| `UMOOC_STATIC_HOST` / `MATHJAX_HOST` | `https://static.ulearning.cn/` | 静态资源 |

另有 `urlStyle=2` 的站群部署分支（`*.tongshike.cn`），同一套代码换域名前缀（`uaapi`/`courseapi`/`knowledgeapi`…）；学校私有化部署会改 `baseHost`、`docHost` 等 cookie 后再算域名。

**前端入口**

| 页面 | URL | 技术栈（已验证） |
| --- | --- | --- |
| 门户首页 | `https://www.ulearning.cn/home/portal.html#/home` | — |
| 登录页 | `https://umooc.ulearning.cn/pc.html#/login` | 账号/短信/微信/机构账号四种 |
| 课程列表 | `https://courseweb.ulearning.cn/ulearning/index.html#/index/courseList` | Vue 2 SPA |
| 学习播放器 | `https://ua.ulearning.cn/learnCourse/learnCourse.html?courseId=&chapterId=&classId=&returnUrl=` | jQuery 1.12 + Knockout 3.4 + RequireJS + mediaelement.js 3.2.4 |
| 作业详情/作答 | `https://www.ulearning.cn/selfwork/#/stuDetail/{作业ID}/{班级ID}?VNK=…&ub2=1&ocId={课程ID}` | 独立 SPA |
| AI 工作台 | 课程内 iframe（跨域，未确认宿主） | — |

> 补充：`courseweb` 与 `ua` 的 AMD 源码都能**无登录**只读获取（`courseweb` 甚至支持明文 HTTP），因此接口可静态枚举；明细见同目录 [`recon-static.md`](./recon-static.md)。

---

## 3. 登录与会话（已验证）

- 登录页 `umooc.ulearning.cn/pc.html#/login`：账号密码（`mode=1`）、短信（`mode=2`）、机构账号（`mode=4`，需 `orgId`）、微信扫码四种。
- 账号密码登录 API（`model/User.js`，静态可见）：`POST https://courseapi.ulearning.cn/users/login`，body `{loginName, password}` → 返回 `authorization`，写入 cookie `AUTHORIZATION`（domain `.ulearning.cn`）和 `USER_INFO`；校验用 `GET /users/isValidToken/{token}`，注销 `POST /users/logout`。
- 请求头（`init.js` 的 `$.ajaxSetup`）：`Authorization: <cookie AUTHORIZATION>`、`version: 1`，GET 追加 `?lang=`；播放器端另加 `UA-AUTHORIZATION`（取 cookie `token`）。
- 播放器端 token 来源（`js/init.js`）：
  - 网页：URL 参数 `token` → Base64 解码 → 写 cookie `token`（domain `.ulearning.cn`）；另有 cookie `AUTHORIZATION` 被直接作为 `window.AUTHORIZATION`。
  - APP 内嵌：`window.ULplugin.User.getUser()` 回传 `token` → `window.AUTHORIZATION`。
- 失效码：HTTP 401 + `code` ∈ {2001, 2101, 2201} → 跳 `/ulearning/tip/timeout.html`；`2301` → 异地登录（APP 场景）。
- SSO 迹象：CAS（`auth.dgut.edu.cn`）、SAML（`saml.ulearning.asia`）；机构登录会记住 `localStorage.ulearning-orgId`。
- 资源 URL 追加 `?token=<AUTHORIZATION>`（`buildResourcePath`），即媒体/文档也靠同一 token 放行；**未发现 CSRF token 或请求签名**。

---

## 4. 课程页结构与路由（已验证，逐个点击记录）

`courseweb.ulearning.cn/ulearning/index.html#/…?courseId=165508`：

| 路由 | 页面 | 本次账号实际内容 |
| --- | --- | --- |
| `#/index/courseList` | 课程列表 | 1 门：`【2026秋】26级习近平新时代中国特色社会主义思想概论` |
| `#/course/workbench` | AI 工作台 | iframe AI 问答 |
| `#/course/announcement` | 公告 | 0 条 |
| `#/course/textbook` | 课件（章节目录） | 17 讲，列：进度/累计学习时间/分数/可学时间 |
| `#/course/resource` | 资源 | 暂无 |
| `#/course/knowledgeGraph` | 知识图谱 | 暂无 |
| `#/course/homework` | 作业 | 1 个（Word 文稿上传，满分 15，教师评分，不公布，允许附件，截止 2026-12-27） |
| `#/course/discussion` | 讨论 | 1 个主题（长期开放） |
| `#/course/classroom?publishStatus=1` | 课堂 | 0 |
| `#/course/live` | 直播 | 0（提示：观看回放也计入时长，数据每天凌晨更新） |
| `#/course/exam` | 考试 | 0（有「下载考试客户端」「网页考试环境检测」） |
| `#/course/assessment` | 考核 | 权重：课件 10% / 作业 15% / 课堂 5% / 考勤 20% / 线下考试 50%，截止 2026-12-27 23:59 |
| `#/course/memberSpoc` | 成员 | 90 人，班课编码 78774093，任课教师 1 人 |

播放器入口（点「开始学习」新开标签）：
```
https://ua.ulearning.cn/learnCourse/learnCourse.html?courseId=47353&chapterId=141351390&classId=1019700&returnUrl=<课程页>
```
注意 **两套课程 ID**：外部 `courseId=165508`（courseweb / 作业 `ocId`），播放器与 API 用内部 `courseId=47353`；班级 `classId=1019700`。

---

## 5. 数据模型（已验证：`model/Section.js`、`model/Page.js`、`model/PageElement.js`）

- 层级：`Course → Chapter(讲) → Section(节) → Page(页面) → PageElement(页面元素)`
- `Page.contentType`：`5` 图文、`6` 视频、`7` 练习（页面级）
- `PageElement.type`：`1` 标题 `2` 文本 `3` 图片 `4` 视频 `5` 音频 `6` 练习 `7` 讨论 `8` html `9` flash `10` 文档 `11` 大页 `12` 图文复合 `13` 角色扮演 `16` 口语 `17` 知识点
- `PageRecord`：`pageId, studyTime, status(0/1), score, answerTime, submitTimes, coursepageId` + `questionRecords / videoRecords / oralRecords`
- `VideoRecord`：`videoId, positionTime, viewTime, videoDuration, status, maxPositionTime, startEndTimeList[]`
- `SectionRecord`：`completion_status, studyTime, version, pageRecordMap`

---

## 6. 学习记录上报协议（核心，已验证）

### 6.1 端点（均 `CONFIG_API_HOST` = `https://api.ulearning.cn`）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/wholepage/item/stu/{sectionId}` | 节下页面列表 + 完成状态 |
| GET | `/wholepage/stu/{pageId}` | 页面内容（图文/视频/题目） |
| GET | `/studyrecord/initialize/{sectionId}` | 下发本次学习起始时间戳（防刷分） |
| GET | `/studyrecord/heartbeat/{sectionId}/{studyStartTime}` | 100 秒心跳；返回 `status==1` 表示正在别处学习 |
| GET | `/studyrecord/item/{sectionId}?courseType=4` | 读取历史学习记录 |
| **POST** | **`/yws/api/personal/sync?courseType=4&platform=PC`** | **保存学习记录（写入完成态）** |
| DELETE | `/studyrecord/item?itemId={sectionId}` | 删除学习记录（测试用） |
| POST | `/studyrecord/timeout/log` | 慢响应埋点 |

### 6.2 保存请求体

```js
data = CryptoJS.DES.encrypt(
  JSON.stringify(payload),
  CryptoJS.enc.Utf8.parse("12345678"),   // 硬编码密钥
  { mode: ECB, padding: Pkcs7 }
).toString()
```

`payload`（`ItemStudyRecordUpdateDTO`）：

```json
{
  "itemid": 节ID, "autoSave": 1, "version": "...", "withoutOld": null,
  "complete": 0|1, "studyStartTime": 初始化返回的时间戳,
  "userName": "...", "score": 平均分,
  "pageStudyRecordDTOList": [{
    "pageid": 页面ID, "complete": 0|1,
    "studyTime": "秒（前端把上限截到 1000）",
    "score": 0-100, "answerTime": 1, "submitTimes": 0,
    "coursepageId": 练习组件ID,
    "questions": [{ "questionid": "…", "answerList": ["…"], "score": 0 }],
    "videos": [{ "videoid": "…", "current": 秒, "status": 0|1,
                 "recordTime": 本次观看秒增量, "time": 视频总秒,
                 "startEndTimeList": [{ "startTime": 秒, "endTime": 秒 }] }],
    "speaks": []
  }]
}
```

- 响应：`1` 成功；`2` 判定刷分/需要停止学习；其他/失败 → 客户端重试（`autoSave=5`），重试 3 次后存 `localStorage.failureRecord`。
- 保存时机：定时 `setInterval 5 分钟`（`autoSaveTime = 5*60*1000`）；切节、`beforeunload`、手动「保存进度」也会触发。
- **整个"完成"判定都在前端**：`Section.createRecord` 遍历页面记录，全部 `status==1` 才把 `complete` 置 1，再交给服务端存。

### 6.3 课程页 SPA 的另一套记录接口（本课程未使用）

`courseweb` 的 `model/StudyRecord.js` 里还有一套更简洁的「活动（activity）」记录接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/courses/studyrecords` | body：`{courseId, activityId, studyTime, score, complete, unitId, videoRecordDTO:{currentTime, recordTime, complete}}` |
| GET | `/courses/studyrecords?activityId=` | 读取该活动记录 |

实测结论：本课程**不走**这套。播放器真实请求全走 `api.ulearning.cn` 的 `wholepage/*` + `studyrecord/*`（见 §6.4）。

### 6.4 播放器真实请求清单（本次实测抓包，`api.ulearning.cn`）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/user` | 用户信息（含 `antiCheat`、`antiDrag`、权限位） |
| GET | `/course/{courseId}/remaining` | 课程剩余有效期（`time<0` 即过期） |
| GET | `/course/{courseId}/basicinformation` | 课程基本信息（标题、locale…） |
| GET | `/organ/path/{courseId}` | 机构路径 |
| GET | `/classes/{courseId}?classId=` | 班级信息 |
| GET | `/course/stu/{courseId}/directory?classId=` | **整门课的章/节/页树**（批量刷课的分页枚举入口） |
| GET | `/wholepage/chapter/stu/{chapterId}` | 某章下的页面列表 |
| GET | `/wholepage/item/stu/{sectionId}` | 某节下的页面列表，返回 `{itemid, wholepageDTOList:[…]}`（注意是对象不是数组） |
| GET | `/wholepage/stu/{pageId}` | 页面内容（`coursepageDTOList[]`：视频/题目/文档元素） |
| GET | `/studyrecord/initialize/{sectionId}` | 学习起始时间戳 |
| GET | `/studyrecord/heartbeat/{sectionId}/{startTime}` | 100 秒心跳 |
| GET | `/studyrecord/item/{sectionId}?courseType=4` | 读取该节记录 |
| POST | `/user/currentUnit?courseId=&chapterId=` | 记录当前学习单元 |
| POST | `/yws/api/personal/sync?courseType=4&platform=PC` | **保存学习记录（完成态）** |

播放器对每章会并发读取该章所有节的 `/studyrecord/item/{sectionId}`（第一讲实测：2377981、2377983、2377985、2379018 四个节，其中 2379018 是「章节练习」）。

---

## 7. 视频完成判定（已验证）

- 前端：`adaptRecord` 中 `viewProgress = viewTime*100/videoDuration; if (viewProgress >= 95) { viewProgress=100; status=1 }` —— **95% 即完成**，不是 100%。
- 页面弹窗文案（实际截屏）：「视频观看时长≥视频时长才能算完成，并且首次观看视频，进度条不能拖拽哦~」
- 前端变量 `window.antiDrag`（用户信息 `res.antiDrag` 可覆盖），控制首次是否禁用拖拽。
- 倍速：播放器 UI 提供 0.75x–2.00x；用户权限 `id==148` 才置 `window.videoSpeed = true`（即倍速是**按账号/课程授权**的，不是所有人都有）。
- 上报 `recordTime` 只取"本次增量"，`startEndTimeList` 记录连续观看区间（自动保存时保留最后一段），下次保存时清空。

### 7.1 视频资源（实测）

- 页面 JSON 的 `coursepageDTOList[0]` 带 `resourceFullurl`、`videoLength`（秒）、`resourceContentSize`。
- 第一讲第一节实测：`https://obscloud.ulearning.cn/resources/web/17019518139236719.m3u8`（HLS），`videoLength=1326`（22:06），`resourceContentSize=606072560`（约 578 MB），**URL 不带 token 参数**。
- 即媒体本身可能是公开 CDN，鉴权只在播放器页面/接口侧（未验证直连 m3u8 是否需要 Referer）。

---

## 8. 练习与题库（已验证，两次修正）

- 节内 `章节练习` 页面（本次：第一讲 5 题、第二讲 10 题、其余各 5 题，共 **90 题**；单选题，限答 1 次，页面 `contentType=7`、元素 `type=6`）。
- 页面 JSON 的 `questionDTOList[]` **不含**答案（`correctAnswerList` 不下发，只有 `choiceitemModels[{choiceitemid,title}]`）。
- **但答案有独立接口**（这是最终验证过的路径）：
  ```
  GET https://api.ulearning.cn/questionAnswer/{questionId}?parentId={pageId}
  → {"questionid":…, "correctreply":"", "correctAnswerList":["D"]}
  ```
  播放器的 `Question.getQuestionAnswer()` 在提交时调用它做本地判分。**该接口对未作答的题也直接返回正确答案**（实测 90/90 命中，无需先提交）。`parentId` 必须传**页面 id**（不是节 id），否则返回空数组。
- 判分仍在前端：`questions[{questionid, answerList, score}]` 由前端算出 `score` 再随 sync 上报；答案字母（A/B/C/D）即 `answerList` 的元素。
- 练习页有「共 N 题 / 限答 1 次」标识；部分练习带 `answerTime`（限时）。
- 章节练习计入「课件学习进度」：有练习的页面，题目未完成则页面不算完成 → **只刷视频，讲进度最多 3/4**。

---

## 9. 防作弊/风控面（已验证）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 防挂机 | `initNoStudyTimer` + `tools/NoAction` | 10 分钟无操作 → 暂停计时、停媒体、弹「走神太久」；用户权限 `id==97` 才启用 |
| 心跳 | `Section.init` | 100 秒 `GET /studyrecord/heartbeat/{section}/{startTime}`；`status==1` → 「请勿同时学习多个页面」并停学 |
| 多页面互斥 | 同上 | 同一账号在另一页学习时，旧页停止计时（"之前打开的页面会停止计算学习时间"） |
| 学习起始时间 | `/studyrecord/initialize` | 服务端下发 `studyStartTime`，随上报体回传，可反推学习时长是否合理 |
| 刷分判定 | `sync` 返回 `2` | 服务端拒绝并让前端终止（无更多细节，未确认判定规则） |
| 章节/课程过期 | `isExpiredMode` | 过期可浏览但不保存记录 |
| 隐藏页/学习计划 | `hide` + 时间窗 | 非授权时间段不可学 |
| 离线缓存 | `localStorage.failureRecord` | 保存失败暂存，下次进页面提示恢复（`recoveryRecord.html`） |

---

## 10. 本次账号的实际数据（用于判断投入产出）

- 课程 1 门，17 讲；每讲 3 节视频 + 1 个章节练习；单视频约 22 分钟（第一讲第一节 22:06）。
- 作业 1 个（Word 文稿，教师评分）→ 无法自动作答。
- 考试 0、直播 0、课堂 0、资源 0、知识图谱 0。
- 考核权重：课件 10% + 作业 15% + 课堂 5% + 考勤 20% + **线下考试 50%**。
- 推论：**本账号可被脚本影响的最大分值是「课件 10%」**（视频+章节练习），作业需人工写，考勤/线下考试与网页端无关。

---

## 11. 自动化可行性评估（含一次真机实测）

### 11.1 关键实测：伪造完成记录被服务端接受 ✅

2026-11-07 22:4x，在真实账号上对「第一讲 第一节 习近平新时代中国特色社会主义思想的产生背景」做了一次最小验证：

- 用页面内 `CryptoJS` 按 §6.2 的方式构造 payload：`itemid=2377981`、`complete=1`、`pageid=2377982`、`page.complete=1`、`page.studyTime=1000`、`page.score=100`、`videos=[{videoid:1563126, current:1326, status:1, recordTime:1326, time:1326, startEndTimeList:[{startTime:0,endTime:1326}]}]`；
- 直接 `POST https://api.ulearning.cn/yws/api/personal/sync?courseType=4&platform=PC`（`Authorization`/`UA-AUTHORIZATION` 头，body 为 DES(key `12345678`) 密文）；
- 响应：**`1`**（成功，未返回 `2` 刷分拒绝）；
- 回读 `GET /studyrecord/item/2377981?courseType=4`：`completion_status=1`、`page.complete=1`、`video.status=1`、`studyTime=1008`；
- 课程页 `#/course/textbook` 刷新后：**第一讲 进度 25%、累计学习时间 00:20:57、分数 25**（课件页确实按完成页数算：1/4 页）。

结论：**视频类页面的"刷完成"在服务端是接受的**；`studyStartTime` / 心跳 / `autoSave=5` 都没有在这次伪造请求中触发拦截。

### 11.2 能做到的

- 视频页：可批量伪造完成（已完成 1 个，其余同理）。
- 章节枚举：`/course/stu/{courseId}/directory?classId=` 一次拿到整棵树（章/节/页 + relationId），无需点页面。
- 媒体地址：`/wholepage/stu/{pageId}` 直接给出 m3u8 与时长，无需播放。
- token：纯静态字符串（Cookie `AUTHORIZATION` + 同名 header），任何 HTTP 客户端可复放。

### 11.3 会挡路的

- **章节练习**：答案不下发（§8），且限答 1 次；只刷视频则每讲进度封顶 75%（3/4 页），课件 10% 得分按章平均，实际拿不满。
  练习的 `score` 是否可伪造未验证（高风险，勿用主账号试）。
- 服务端是否会在**批量**（几十个 section 连续 POST）时触发风控：单次通过不代表批量安全，需要分片、限速、异常即停。
- `recordTime`/`studyTime` 与真实会话时长的关系未验证（本次 `studyTime` 被服务端存成 1008，说明服务端有自己的累加/截断逻辑，但不是拒绝）。
- 作业是真人工评分（Word 附件），与自动化无关；考核 50% 是线下考试。

### 11.4 与智慧树（已做的秒刷）对比

| 维度 | 智慧树（知到） | 优学院 |
| --- | --- | --- |
| 上报加密 | `secretStr`（可逐字节复现） | DES-ECB，硬编码密钥 `12345678` |
| 完成态决定方 | 前端 → 服务端存 | 前端 → 服务端存（实测接受） |
| 会话绑定 | 有签名/时间参数 | `studyStartTime` + 心跳（本次未拦） |
| 练习 | 随堂测验一次机会 | 章节练习限答 1 次、答案不下发 |

**判断：视频秒刷可行度高于智慧树（加密更弱），但课件满分受练习限制；建议先做「视频秒刷 + 进度校验」，把练习作为独立风险项，不混在同一次提交里。**

### 11.5 全量执行结果（本账号，2026-11-07 23:0x）

| 项 | 结果 |
| --- | --- |
| 视频/图文节 | 56 个节点，`done=54`（另 2 个此前已完成），`failed=0`，服务端全返回 `1` |
| 章节练习 | 17 节 / 90 题，全部用 `/questionAnswer` 取平台答案后提交，`failed=0` |
| 课件页 | **17 讲全部 100%、分数 100**，累计学习时间 01:06–01:33/讲 |
| 风控 | 73 次连续 sync **未出现一次 `2`**（默认 1.2–1.5s 间隔） |

题库已落到 `test-data/ulearning-answer-bank.json`（90 题、id→答案+题干+选项，脚本回查 90/90 与平台一致）。

---

## 12. 未确认 / 下一步

1. **批量安全性**：本账号 73 次连续 sync（56 视频 + 17 练习）全部返回 `1`，未触发风控；更大规模/更短间隔仍未知，生产实现要保留限速与失败即停。
2. **答案接口的鉴权边界**：`/questionAnswer/{qid}?parentId={pageId}` 现在对未作答题目直接返回答案；这是否是平台长期行为、是否随课程配置变化，未知（若被修掉，练习只能靠人工/AI）。
3. 视频 CDN 直连（`obscloud.ulearning.cn/...m3u8`）是否需要 Referer/token：未验证。
4. 作业/测验/小组作业子应用（`www.ulearning.cn/selfwork`、`/quiz`、`/groupwork`）与考试（`utest.ulearning.cn`）的提交接口（HTTPS 单页应用，未抓包）。
5. 机构账号登录（CAS/SAML）完整链路。
6. 章节练习的 `score` 是否被服务端重算：本次全部按满分提交且课件页显示 100 分，但未区分"服务端信任前端分数"与"服务端重算后同样满分"。

> 取证方式：`ua` 侧 JS 可用 `view-source:https://ua.ulearning.cn/learnCourse/js/<path>?version=2608204` 只读打开（无需登录）；`courseweb` 侧可直接 `curl http://courseweb.ulearning.cn/ulearning/<path>?version=1.4.48`。
> 本文已读文件：`js/init.js`、`common/config.js`、`js/learnCourseViewModel.js`、`js/model/Section.js`、`js/model/Page.js`、`js/model/PageElement.js`；课程页侧见 [`recon-static.md`](./recon-static.md)。
> 实施计划见 [`miaoshua-plan.md`](./miaoshua-plan.md)。
