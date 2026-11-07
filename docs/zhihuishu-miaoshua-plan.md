# 知到（智慧树）秒刷功能 — 实现计划（全版本）

> 状态：已实现（2026-11-07，分支 `feat-zhihuishu-miaoshua`）· 验证记录见附录 C
> 调研结论：协议、加密、上报编码均已反解并实测通过；本期只做"秒刷"，不做测验、不碰直播。
> 目标平台：`studyvideoh5.zhihuishu.com`（共享课视频）、`stuonline.zhihuishu.com` / `lc.zhihuishu.com`（见面课回放）
> 交付形态：**全版本** = Rust core + CLI + 桌面 GUI + 网站版（含桥接脚本）+ 浏览器助手脚本；代码风格与现有项目保持一致。

## 1. 范围

### 1.1 本期做

1. **视频课秒刷**：整门共享课批量把未完成视频标记为已完成（`watchState=1`）；
2. **见面课回放秒刷**：抓取见面课列表与回放进度，逐分钟上报考勤，覆盖率**随机 90%–100%**，带**限速**与**熔断**；
3. **四个入口全做**：**CLI**、**桌面 GUI**、**网站版 website/（含知到桥接脚本）**、**浏览器 userscript**；
4. 默认安全：dry-run、真实执行需确认、每批结束查异常接口、Cookie 不外泄。

### 1.2 本期不做

- 随堂测验 / 考试（`onlineexamh5new`、`studentexam-api`）——调研已完成，本期不实现；
- 直播实时参与（11-09 / 11-23 两场只展示，不操作）；
- 翻转课 / 融合课 / 智能课（polymas 课程）；
- 见面课回放视频下载。

### 1.3 验收标准（DoD）

- [ ] `cargo test --workspace`、`cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings` 全绿；
- [ ] 现有学在华科大功能、测试无回归；
- [ ] `zhs list` / `zhs tree` 能列出共享课与章节视频树（含已完成状态）；
- [ ] `zhs watch --dry-run` 输出每节课计划（不含 Cookie/签名），`zhs watch` 真实执行后 `queryStuyInfo` 的 `watchState` 变为 1；
- [ ] `zhs meet list/status` 能列出见面课与已看分钟进度；
- [ ] `zhs meet watch` 按随机 90–100% 覆盖率、限速逐分钟上报，`getWatchHistory` 分钟数达到目标，页面"签到进度"更新；熔断可触发并中止；
- [ ] GUI：平台切换 → 知到登录 → 课程列表 → 课程页"秒刷本课视频" → 见面课页"秒刷回放考勤"；默认 dry-run、勾选风险确认后真实执行、进度事件、可取消；
- [ ] userscript：学习页/见面课页一键秒刷（同策略、同限速熔断）；
- [ ] 网站版：`website/` 增加知到平台（课程/视频树/见面课/秒刷），通过知到桥接脚本完成同源请求；`npm run build` + 现有 `npm test` 通过；
- [ ] 日志、错误信息、dry-run 报告不含 Cookie 值；文档更新 README/AGENTS；
- [ ] 代码风格与现有项目一致（§10）：`cargo fmt/clippy`、`tsc`、`npm run build` 全绿；注释语言、命名、错误处理、测试组织与现有模块一致。

## 2. 总体架构

### 2.1 新增模块（Rust core）

```
src/zhihuishu/
  mod.rs        # 导出、常量（密钥版本、URL）、公共类型
  crypto.rs     # AES secretStr、模块密钥获取（labc 等价）、XOR 编码、watchPoints、hms
  models.rs     # ZhsCourse/ZhsChapter/ZhsLesson/ZhsVideo/ZhsMeet/进度/结果类型
  api.rs        # ZhsClient：会话、Cookie、各接口封装、错误归一化、限速器
  watch.rs      # 视频课秒刷：计划、执行、复核、熔断
  meet.rs       # 见面课：列表、回放进度、随机覆盖 + 限速 + 熔断上报
```

约束（沿用 AGENTS.md）：网络与解析只在 `hust_course_hack` crate；Tauri command 保持薄；Cookie 不跨 IPC；GUI 登录窗口独立临时 WebView2 目录。

### 2.2 各入口接入

| 入口 | 改动 | 说明 |
| --- | --- | --- |
| CLI | `src/main.rs` 新增 `zhs` 子命令 | 复用全局 `--cookies`（Netscape 格式） |
| GUI | `src-tauri/src/{login,state,commands}.rs` + `ui/src/**` | 连接页加平台选择；登录窗口平台化；新增课程页/见面课页 |
| userscript | `userscripts/zhihuishu-miaoshua.user.js` | 在知到页面内运行，优先复用页面全局加密函数（`labc`/`yxyz`），不可用时用内置 WebCrypto 实现 |
| website | `website/src/core/zhs/**`、`website/src/views/**`、`website/src/zhs-bridge.user.ts`、`website/scripts/build-bridge.mjs` | 复用现有"静态站 + 桥接脚本"架构：桥接脚本注入知到页面做同源请求，静态站通过 postMessage 调用 |

### 2.3 依赖与常量

新增 crate 依赖（root `Cargo.toml`）：

```toml
aes = "0.8"          # AES-128-CBC
cbc = "0.1"          # CBC 模式 + PKCS7
base64 = "0.22"
rsa = "0.9"          # 公钥加密 + 公钥运算（模块密钥获取）
rand = "0.8"         # RSA PKCS#1 v1.5 加密随机数、覆盖率/延时间隔随机
```

常量集中放在 `src/zhihuishu/mod.rs`：

- RSA 公钥（base64 SPKI，全部模块共用）；
- 固定 IV `1g3qqdh4jvbskb9x`；
- XOR key：视频课 `zzpttjd` / 见面课 `zhihuishu`；
- 模块 id：视频课 11、见面课 9（考试类 3/5，本期不用）；
- API 根：`studyservice-api`、`appcomm-live-api`、`appcomm-user`、`stuonline`、`lc`。

## 3. 接口契约（冻结，作为并行开发依据）

```rust
// src/zhihuishu/mod.rs
pub struct ZhsClient { /* reqwest::Client + cookie jar + base urls */ }

impl ZhsClient {
    pub fn from_cookie_file(path: &std::path::Path) -> anyhow::Result<Self>;
    pub fn from_cookie_header(header: &str) -> anyhow::Result<Self>;

    pub async fn login_user(&self) -> anyhow::Result<ZhsUser>;
    pub async fn list_courses(&self) -> anyhow::Result<Vec<ZhsCourse>>;
    pub async fn course_detail(&self, course: &ZhsCourse) -> anyhow::Result<ZhsCourseDetail>;
    pub async fn exception_status(&self, course: &ZhsCourse) -> anyhow::Result<ZhsExceptionStatus>;

    pub async fn plan_videos(&self, detail: &ZhsCourseDetail, opts: &ZhsWatchOptions)
        -> anyhow::Result<Vec<ZhsVideoTarget>>;
    pub async fn watch_videos(
        &self,
        targets: &[ZhsVideoTarget],
        opts: &ZhsWatchOptions,
        progress: &(dyn Fn(ZhsProgress) -> bool + Send + Sync),
    ) -> anyhow::Result<Vec<ZhsWatchOutcome>>;

    pub async fn meet_list(&self, course: &ZhsCourse) -> anyhow::Result<Vec<ZhsMeet>>;
    pub async fn meet_progress(&self, meet: &ZhsMeet) -> anyhow::Result<ZhsMeetProgress>;
    pub async fn meet_watch(
        &self,
        meet: &ZhsMeet,
        opts: &ZhsMeetWatchOptions,
        progress: &(dyn Fn(ZhsProgress) -> bool + Send + Sync),
    ) -> anyhow::Result<ZhsMeetOutcome>;
}

#[derive(Default, Clone)]
pub struct ZhsWatchOptions {
    pub dry_run: bool,           // true: 只生成计划不发送
    pub include_completed: bool, // 默认 false：跳过 watchState=1
    pub max_videos: Option<usize>,
    pub verify: bool,            // 默认 true：每节后 queryStuyInfo 复核
}

#[derive(Clone)]
pub struct ZhsMeetWatchOptions {
    pub dry_run: bool,
    pub coverage_min: f64,   // 默认 0.90
    pub coverage_max: f64,   // 默认 1.00
    pub delay_min_ms: u64,   // 默认 2000
    pub delay_max_ms: u64,   // 默认 6000
    pub circuit_breaker: bool,   // 默认 true
    pub check_every: usize,      // 默认 10 条检查一次异常
}

pub struct ZhsProgress {
    pub stage: ZhsStage,     // Videos / MeetList / MeetMinutes / Verify / CircuitCheck
    pub done: usize,
    pub total: usize,
    pub label: String,       // 不含 Cookie/签名
    pub message: String,
}
```

GUI 命令（camelCase DTO，薄封装）：

```
zhs_login_start / zhs_login_poll        # 复用登录窗口，平台化
zhs_list_courses                        -> Vec<ZhsCourseDto>
zhs_course_detail(courseId)             -> ZhsCourseDetailDto
zhs_watch_videos(courseId, opts)        -> jobId（进度走 job-progress 事件）
zhs_meet_list(courseId)                 -> Vec<ZhsMeetDto>
zhs_meet_progress(courseId, meetId)     -> ZhsMeetProgressDto
zhs_meet_watch(courseId, meetIds, opts) -> jobId
zhs_exception_status(courseId)          -> ZhsExceptionStatusDto
zhs_cancel_job                          # 复用现有 AppState::begin_job/cancel_job
```

网站版桥接消息（postMessage，来源/nonce 校验，接口白名单）：

```ts
// 静态站 -> 知到页面桥接脚本
{ type: 'zhs-request', id: string, url: string, method: 'GET' | 'POST', body?: string }
// 知到页面桥接脚本 -> 静态站
{ type: 'zhs-response', id: string, status: number, text: string }
// 连接握手
{ type: 'zhs-hello' } / { type: 'zhs-ready', platform: 'zhihuishu', uuid: string }
```

## 4. 详细设计

### 4.1 crypto.rs

- `fetch_module_key(module: u32) -> String`：
  1. `rsa::pkcs1v15` 用公钥加密 `{"module":n}`（RSAES-PKCS1-v1_5）；
  2. `GET https://appcomm-user.zhihuishu.com/app-commserv-user/c/has?uid=<urlencoded base64>`；
  3. 取 `rt.sl`，用同一公钥做**公钥运算 + PKCS#1 去填充**（`c^e mod n`，`BigUint` 实现，校验 `00 01 FF..FF 00`）；
  4. 解析 JSON 取 `cKey`；缓存到 `Mutex<HashMap<u32,(String,Instant)>>`，TTL 30 分钟（同页面生命周期行为）。
- `encrypt_secret(module, json_value) -> String`：AES-128-CBC + PKCS7 + base64（IV 固定）。
- `post_encrypted(client, url, payload)` / `get_encrypted(client, url, payload)`：自动加 `secretStr`；GET 用 query，POST 用 form。
- `xor_encode(fields: &[String], key: &str) -> String`：`join(";")` 后逐字符 XOR，hex 补 2 位取末 4 位。
- `watch_points(duration_secs: u64) -> String`：`"0,1," + 每 2 秒追加 floor(total/5)+2`（total 按 5 秒 +5 累计）。
- `hms(secs) -> String`、`parse_hms`。
- **自检** `crypto_self_check()`：用固定向量验证 AES/XOR；真实运行时若 `getLoginUserInfo` 解密失败 → 返回明确错误"知到加密常量可能已更新"。

### 4.2 api.rs

- 复用 `reqwest` + `cookie_store`（同 `SmartCourseClient` 做法）；错误归一化 `ZhsError { code, message, endpoint }`；
- 接口封装：
  - `login_user`：`GET studyservice-api/gateway/t/v1/login/getLoginUserInfo`（模块 11）
  - `list_courses`：**待首项确认** `onlineservice-api.../student/course/share/queryShareCourseInfo`；失败时 CLI 兜底"粘贴学习页 URL/`recruitAndCourseId`"（见待确认 §9）
  - `course_detail`：`queryCourse`（拿 recruitId/courseId/classId/isApply）+ `videolist`（章节/节/小节/videoId/videoSec/isStudiedLesson）
  - `prelearning_note`：拿 `studiedLessonDto.id`（即 noteId）
  - `query_stuy_info`：`{lessonIds, lessonVideoIds, recruitId}` → `data.lv[id] = {studyTotalTime, watchState}`
  - `save_interval`：`{ewssw, sdsew, zwsds, courseId}` → `data.submitSuccess`
  - `exception_status`：视频课 `GET cheat/exceptionActionDetail`；见面课 `GET appcomm-live/chect/exceptionActionDetail`
  - 见面课：`list_teach_meeting`（明文 POST）、`live_get_watch_history`、`live_set_watch_history_secret`
- **限速器**：`RateLimiter { min_ms, max_ms }`，`tokio::time::sleep` 随机间隔；全局串行（并发 1）。

### 4.3 watch.rs（视频课）

状态机（每节课）：

```
skip? (watchState==1 && !include_completed) -> Skip
prelearning_note(lesson) -> noteId
build payload: total=interval=videoSec, position=hms(videoSec),
               ewssw=watch_points(videoSec),
               sdsew=xor_encode([recruitId,lessonId,smallLessonId,videoId,chapterId,0,total,total,position,uuid+"zhs"], "zzpttjd"),
               zwsds=base64(noteId)
POST saveDatabaseIntervalTimeV2
(verify) queryStuyInfo -> watchState==1 ? Ok : Fail
异常计数增加 -> 中止整批（熔断）
```

进度：每节课 1 次 `ZhdsProgress{stage: Videos, done, total, label: "课程名 / 节名"}`；回调返回 false → 取消。

### 4.4 meet.rs（见面课）

- `meet_list`：`POST stuonline.../teachMeeting/listTeachMeetingStu`，过滤出有回放的场次（`replayCourseUrl` 非空、`videoId` 非空），解析 `meetCourseId/liveId/videoId/startTime/endTime/examH5Url`。
- `meet_progress`：`playlist_meta`：用回放时长（从 `vod_room` 页面接口或视频时长接口取，见附录）算总分钟数 `total = ceil(duration/60)`；
  `getWatchHistory` → `watched: Vec<u32>`。
- `meet_watch` 算法（核心）：
  1. `target = ceil(total * rand(coverage_min..coverage_max))`，且 `target ≤ total`；
  2. 缺口 = 目标 − 已看；若已看 ≥ 目标 → Skip；
  3. 选分钟：已看序号升序补齐，末尾随机丢弃少量（保持覆盖随机性），从第一个缺口顺序推进；
  4. 逐条 `setWatchHistorySecret(paramSecret)`：
     - `paramSecret = xor_encode([recruitId, liveId, userId, minute, "2", videoId], "zhihuishu")`
     - 间隔 `rand(delay_min..delay_max)` ms；
     - 每 `check_every` 条：`live exceptionActionDetail`，`lock==true` 或异常计数增加 → 中止并返回 `CircuitBroken`；
  5. （可选）结束时再查一次 `getWatchHistory` 复核分钟数达标。
- 失败重试：单条失败最多重试 2 次（指数退避），仍失败则记录并继续；连续 3 条失败 → 中止。

### 4.5 CLI

```powershell
# 课程
cargo run -- --cookies zhs-cookies.txt zhs list
cargo run -- --cookies zhs-cookies.txt zhs tree   --course <secret|courseId|学习页URL>
cargo run -- --cookies zhs-cookies.txt zhs watch  --course <...> [--dry-run] [--max-videos N] [--include-completed] [--yes]
cargo run -- --cookies zhs-cookies.txt zhs check  --course <...>

# 见面课
cargo run -- --cookies zhs-cookies.txt zhs meet list   --course <...>
cargo run -- --cookies zhs-cookies.txt zhs meet status --course <...> [--meeting <meetCourseId>]
cargo run -- --cookies zhs-cookies.txt zhs meet watch  --course <...> [--meeting <id>] [--all] ^
    [--coverage 0.90-1.00] [--delay-ms 2000-6000] [--check-every 10] [--no-circuit-breaker] [--dry-run] [--yes]
```

- 输出：每项 `ok/skip/fail`，结束时汇总 `成功/跳过/失败/已中止`；退出码 0=全部成功，1=有失败/熔断；
- `--dry-run` 打印计划与将发送的字段（不含完整 `secretStr`/签名）；
- `--yes` 跳过交互确认（默认真实执行前需输入 `yes`）。

### 4.6 GUI

1. **连接页**：平台单选（学在华科大 / 知到）。知到走独立登录窗口 `onlineweb.zhihuishu.com/onlinestuh5`；回跳后读 Cookie（含 HttpOnly）→ `getLoginUserInfo` 校验 → 建会话；关闭并删除临时 WebView2 目录。
2. **课程列表**：共享课卡片（名称/进度/教师）；polymas 课程标灰"暂不支持"。
3. **课程页**：左边章节/节/小节树 + video 表格（时长、已完成）；右侧操作区"秒刷本课视频"。
4. **见面课页**：场次列表（时间/主讲/回放/测验/状态）、回放进度（已看/总分钟、百分比）、"秒刷回放考勤"按钮。
5. **执行弹窗**：默认 dry-run；勾选"我确认按随机 90–100% 覆盖率上报并承担风控风险"后真实执行；进度条 + 当前条目；可取消；结束显示结果表（可复制）。
6. **熔断提示**：检测到异常立即弹全局提示并停止队列。
7. 复用 `AppState::begin_job` / `cancel_job` / `job-progress` 事件；新 job 类型 `zhs-watch`、`zhs-meet-watch`。

### 4.7 userscript

- 文件：`userscripts/zhihuishu-miaoshua.user.js`（`@match`：`studyvideoh5.zhihuishu.com/*`、`stuonline.zhihuishu.com/*`、`lc.zhihuishu.com/live/*`）。
- 面板：三个按钮（秒刷本课视频 / 秒刷当前回放考勤 / 停止）+ 参数（覆盖率、间隔）+ 日志区。
- 加密：优先 `unsafeWindow.labc` + `unsafeWindow.yxyz`（页面自带）；不存在时用内置实现（WebCrypto AES-CBC + BigInt 公钥运算 + RSAES-PKCS1-v1_5 用 WebCrypto）。
- 页面信息：从 DOM/URL 解析 `recruitId`、`courseId`、`secret`、`liveId`、`videoId`、`userId`（`CASLOGC` cookie 的 `uuid` + `userId` 字段）。
- 同样实现限速 + 随机 90–100% + 熔断（异常接口）。

### 4.8 website（网站版，全版本要求）

现有网站版是"静态站 + 桥接 userscript"：静态站无法跨域读学校 Cookie，由桥接脚本在学校页面内做同源请求、通过 `postMessage` 回传。知到沿用同一架构：

1. **新增桥接脚本** `website/src/zhs-bridge.user.ts`（构建产物 `website/public/zhihuishu-bridge.user.js`）：
   - `@match`：`smartcourse` 之外的知到页面（`studyvideoh5.zhihuishu.com/*`、`stuonline.zhihuishu.com/*`、`lc.zhihuishu.com/live/*`）；
   - 协议：`{ type: 'zhs-request', id, url, method, body }` → 在页面内 `fetch`（带 Cookie）→ 回传 `{ id, status, text }`；
   - 校验：来源白名单、`window.opener`/`postMessage` nonce、接口路径白名单（仅允许 `studyservice-api`/`appcomm-live-api`/`appcomm-user`/`stuonline`/`lc` 的已知路径）；
   - 同时可作为"独立秒刷面板"使用（与 §4.7 userscript 功能一致，避免重复维护：userscript 的秒刷逻辑抽到 `website/src/core/zhs/` 之外共享？——**不共享**，userscript 保持自包含，website core 单独实现，二者以协议为准）。
2. **TS core 移植** `website/src/core/zhs/`：`crypto.ts`（WebCrypto AES-CBC + BigInt 公钥运算 + RSAES-PKCS1-v1_5 fallback）、`client.ts`（接口封装）、`types.ts`、`meet.ts`（随机覆盖/限速/熔断，逻辑与 Rust 版逐项对齐，并有测试）。
3. **视图**：`website/src/views/connect.ts` 增加平台选择；新增 `views/zhs-course.ts`、`views/zhs-meet.ts`；`website/src/mock.ts` 增加知到演示数据。
4. **构建**：`website/scripts/build-bridge.mjs` 同时产出 `hust-course-bridge.user.js` 与 `zhihuishu-bridge.user.js`；GitHub Pages 部署不变。
5. **限制**：网站版必须安装知到桥接脚本并保持知到页面打开（与现有学在华科大网站版一致；文档需写明）。

## 5. 任务分解（工作包 / 写作用域 / 依赖）

| WP | 内容 | 写作用域 | 依赖 | 估时 |
| --- | --- | --- | --- | --- |
| WP0 | 环境：安装 Rust（rsproxy 镜像）、验证 MSVC/Tauri 构建链、`cargo test` 基线、加依赖 | `Cargo.toml`、`Cargo.lock` | — | 1h |
| WP1 | crypto：模块密钥获取、AES、XOR、watchPoints、hms、自检 + 单测 | `src/zhihuishu/crypto.rs` | WP0 | 3–5h |
| WP2 | models + api：课程列表（含兜底）、视频树、note、queryStuyInfo、saveInterval、异常、见面课接口 + 限速器 | `src/zhihuishu/models.rs`,`api.rs` | WP1 | 4–5h |
| WP3 | watch：视频课计划/执行/复核/熔断 | `src/zhihuishu/watch.rs` | WP2 | 2–3h |
| WP4 | meet：列表/进度/随机覆盖/限速/熔断 | `src/zhihuishu/meet.rs` | WP2 | 3–5h |
| WP5 | CLI `zhs` 子命令 + dry-run + 汇总 | `src/main.rs` | WP3、WP4 | 2–3h |
| WP6 | 测试：单测补充 + `tests/zhs_mock.rs` 全流程 mock | `tests/zhs_mock.rs`、模块内 `#[cfg(test)]` | WP3、WP4 | 3–4h |
| WP7 | GUI：登录平台化、课程页、见面课页、执行弹窗、进度/取消 | `src-tauri/src/**`、`ui/src/**` | WP2、WP3、WP4 | 6–8h |
| WP8 | userscript：知到秒刷脚本（视频课 + 见面课） | `userscripts/**` | 无（协议已知，可并行） | 3–4h |
| WP9 | 文档：README、AGENTS、协议附录、风险说明 | `README.md`、`AGENTS.md`、`docs/**` | WP5、WP7 | 1–2h |
| WP10 | website：知到桥接脚本 + TS core 移植 + 两个视图 + mock + 构建 | `website/src/**`、`website/public/**`、`website/scripts/**` | WP2（协议对齐后可并行） | 8–12h |

Lead 额外职责：冻结 §3 契约、`src/lib.rs` 导出、`src/zhihuishu/mod.rs` 常量/自检、评审与最终验证。

### 5.1 并行分组（Agent Teams）

| 成员 | 负责 | 写作用域 |
| --- | --- | --- |
| Lead | WP0、契约冻结、评审、集成、WP9 文档、最终验收 | `Cargo.toml`、`src/lib.rs`、`docs/**`、`README.md`、`AGENTS.md` |
| zs-core | WP1–WP4 | `src/zhihuishu/**` |
| zs-cli | WP5 | `src/main.rs` |
| zs-gui | WP7 | `src-tauri/src/**`、`ui/src/**` |
| zs-tests | WP6 | `tests/zhs_mock.rs` |
| zs-userscript | WP8 | `userscripts/**` |
| zs-website | WP10 | `website/src/**`、`website/public/**`、`website/scripts/**` |

顺序：WP0 → WP1 → WP2（契约冻结后）→ 并行 {WP3, WP4, WP7(UI 骨架), WP8, WP10} → {WP5, WP6} → WP9 文档与集成验收。
写作用域互不重叠；`src/lib.rs` 导出由 Lead 统一修改，避免冲突。

## 6. 测试计划

| 层级 | 内容 |
| --- | --- |
| 单元 | AES 向量（固定 plaintext → 期望 ciphertext）、XOR 编解码往返、`watch_points` 序列、`hms` 边界、模块密钥 blob 解包（fixture）、覆盖率随机范围、限速间隔范围 |
| 契约 | `tests/zhs_mock.rs`：本地 mock server 实现加密协议（可解密请求），覆盖视频课全流程、见面课全流程、`code!=0`、401/登录失效、异常熔断、取消回调 |
| CLI | `--dry-run` 输出快照（不联网，输入 fixtures） |
| GUI | `npm run build`（tsc + vite）；演示模式 mock 数据可走通两个页面 |
| 网站版 | `website/tests/zhs.test.ts`：crypto 向量、随机覆盖率、限速、桥接消息协议；`npm test` + `npm run build` 通过 |
| 手工（可选） | 真实账号：单视频 + 单见面课各跑一次并复核；不纳入 CI |

## 7. 里程碑与排期（估）

| 里程碑 | 内容 | 估时 |
| --- | --- | --- |
| M0 | WP0 环境与基线 | 1h |
| M1 | WP1 + WP2（crypto/api 完成，可对真实账号做只读验证） | 7–10h |
| M2 | WP3 + WP4（两大秒刷执行器 + 单测） | 5–8h |
| M3 | WP5 CLI + WP6 测试（CLI 端到端可用） | 5–7h |
| M4 | WP7 GUI | 6–8h |
| M5 | WP8 userscript | 3–4h |
| M6 | WP10 website（桥接 + core + 视图） | 8–12h |
| M7 | WP9 文档 + 最终验证 | 1–2h |

合计约 36–52h，四条线可并行压缩（userscript / website 各自独立，GUI 依赖 core 接口）。

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 账号风控/处罚 | 高 | dry-run 默认；真实执行需确认；视频课单次限量；见面课限速 + 随机覆盖 + 熔断；每批结束查异常；文档标注"秒刷属最高风险形态" |
| 见面课 AES key 轮换 | 中 | 必须实现运行时 `labc` 等价流程（RSA 公钥加密 → c/has → 公钥运算解包），不硬编码 |
| 视频课常量轮换 | 中 | 常量集中 + 自检失败明确提示；保留由 blob 推导的兜底 |
| 课程列表接口未知 | 中 | 首个任务抓包确认 `queryShareCourseInfo` 请求体；失败则 CLI/GUI 支持粘贴学习页 URL/`recruitAndCourseId` 兜底 |
| 课程类型差异 | 中 | 仅支持 studyvideoh5 共享课；polymas 明确报错 |
| 教学限制/锁定 | 中 | `checkIsLock`/异常接口检测到即跳过并汇总 |
| 平台改版 | 中 | API 层错误归一化，保留脱敏响应片段便于定位 |
| website 跨域与桥接 | 中 | 沿用现有"静态站 + 桥接脚本"架构；桥接脚本做来源/nonce/接口白名单校验；文档写明必须保持知到页面打开 |
| 代码风格漂移 | 中 | 见 §10 约定 + DoD 强制 fmt/clippy/tsc；review checklist 覆盖 |

## 9. 待确认问题

1. 课程列表接口（`queryShareCourseInfo` 的请求体）尚未抓包确认；若不通，用"粘贴学习页 URL/`recruitAndCourseId`"兜底是否可接受？
2. CLI 真实执行是否需要交互确认（计划：默认需要；`--yes` 跳过）？
3. GUI 默认 dry-run + 勾选风险确认（与现有"测验提交"交互一致）是否可接受？
4. 视频课 `zhs watch` 默认是否限制单次最大视频数（计划：默认不限，但打印数量并要求确认；`--max-videos` 可限）？

## 10. 代码风格与工程约定（全版本一致）

新代码必须与现有项目风格一致；以下为硬性约定，评审 checklist 逐条检查。

### 10.1 Rust core

- 保持 edition 2024 / workspace 结构；**无 `rustfmt.toml`，用默认 rustfmt**：`cargo fmt --all`；
- clippy 零告警：`cargo clippy --workspace --all-targets -- -D warnings`；
- 文档注释：模块级 `//!` 与公开项 `///` 沿用现有英文风格（参考 `src/client.rs`、`src/parse.rs`）；**用户可见文案用中文**（CLI 输出、GUI 错误、进度 label）；
- 错误处理：只用 `anyhow`（`Result`、`.context()`、`bail!`），context 为英文短句，与现有代码一致；不新增错误库；
- 命名：类型 `PascalCase`、函数/字段 `snake_case`、常量 `SCREAMING_SNAKE_CASE`（`pub const`）；
- 数据模型：core 保持 `snake_case`；GUI DTO 用 `#[serde(rename_all = "camelCase")]`；
- 网络：全部收敛在 `ZhsClient`（仿 `SmartCourseClient`），模块内不散落 `reqwest` 调用；
- 进度与取消：沿用 `fetch_course_with_progress` 的回调签名 `&(dyn Fn(Progress) -> bool + Send + Sync)`，回调返回 `false` 即取消；
- 限速/等待用 `tokio::time::sleep`；随机数用 `rand`；
- 测试：模块底部 `#[cfg(test)] mod tests`（与 `answers.rs`/`parse.rs` 一致）；集成测试放 `tests/`；fixtures 放 `test-data/`，**禁止提交 Cookie、签名、带 token 的抓包**；
- 日志：用 `log` crate；不打印 Cookie 值、完整 `secretStr`、签名 URL；CLI 汇总用 `println!` 中文。

### 10.2 桌面 GUI（`src-tauri/` + `ui/`）

- Tauri command 保持薄：只做会话/状态/进度事件/文件 IO，业务在 core；
- 命令 `snake_case`，前端 `invoke` 参数 camelCase；DTO 与 `ui/src/types.ts` 同步更新；
- TS：2 空格、分号、单引号；`tsconfig` 已开 `strict`、`noUnusedLocals/Parameters`；用 `import type`；不用 `any`；
- 新视图沿用 `views/*.ts` 的 `render`/`mount` 结构，复用 `dom.ts`、`icons.ts`、`bus.ts`；`mock.ts` 演示数据仅供浏览器模式，不伪造服务端成功；
- Cookie 值不跨 IPC（只暴露 `cookieSource`/`cookieCount` 这类元信息）。

### 10.3 网站版（`website/`）

- 与现有 `website/src/core/*.ts` 同风格：2 空格、分号、单引号、`class` 封装、`import type`；
- 请求统一走 transport/桥接抽象，不直接在视图层 `fetch`；
- 新增测试放 `website/tests/zhs.test.ts`（`npm test` 使用 node strip-types）；测试不访问真实网络；
- 桥接脚本遵循现有 `bridge.user.ts` 的消息格式与来源校验模式。

### 10.4 userscript

- IIFE + `'use strict'`；保留 `// ==UserScript==` 元数据块（`@match`、`@grant none`、`@run-at document-idle`）；
- 自包含、无外部依赖；中文 UI 文案 + 英文代码注释（与现有 `hust-course-video-helper.user.js` 一致）；
- 复用现有 helper 的 `log`/`sleep`/`busy`/`stopRequested` 面板模式，保持面板样式一致。

### 10.5 文档

- README 用中文、AGENTS.md 用英文（与现状一致）；新命令、新平台写进 README 对应章节；协议表更新到本文档附录 A；
- 不提交 Cookie、签名、真实抓包原文；调研脚本不放进仓库。

### 10.6 提交与门禁

- 约定式提交：`feat(zhs): ...` / `fix(zhs): ...` / `docs: ...`，一次提交一个逻辑单元；
- 提交前必须通过：

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd website; npm test; npm run build
npm run build            # 根目录：tsc --noEmit + vite build
```

## 附录 A：协议速查

### A.1 `secretStr` 加密（所有知到接口）

```
plaintext = JSON(业务字段)
secretStr = Base64( AES-128-CBC(plaintext, key=cKey(module), iv="1g3qqdh4jvbskb9x") )  # PKCS7
POST body = secretStr=<urlencoded>[&dateFormate=<ms>]   # 视频课接口额外带 dateFormate
GET query = ?secretStr=<urlencoded>[&dateFormate=<ms>]
```

模块：视频课 `11`（key 目前常量 `azp53h0kft7qi78q`），见面课 `9`（key 每次取 key 变化）。

### A.2 模块密钥获取（labc 等价）

```
RSAES-PKCS1-v1_5(pubkey, {"module": n}) -> base64
GET https://appcomm-user.zhihuishu.com/app-commserv-user/c/has?uid=<urlencoded>
  -> {"rt":{"sl":"<base64>"}}
public-op-unpad(pubkey, sl) -> {"cKey":"<AES key>","ckv":..,"module":n,"nkv":..}
```

### A.3 视频课上报

```
sdsew = xor_encode([recruitId, lessonId, smallLessonId, videoId, chapterId, 0,
                    total, total, "HH:MM:SS", uuid+"zhs"], key="zzpttjd")
ewssw = "0,1," + 每 2 秒追加 floor(total/5)+2
zwsds = base64(prelearningNote.studiedLessonDto.id)
POST /gateway/t/v1/learning/saveDatabaseIntervalTimeV2
     {ewssw, sdsew, zwsds, courseId} -> {"code":0,"data":{"submitSuccess":true}}
```

### A.4 见面课回放考勤

```
GET /app-commserv-live/gateway/t/v1/pc/live/getWatchHistory
     {courseId: liveId, userId} -> rt="1,2,...,N"   # 已看分钟
GET /app-commserv-live/gateway/t/v1/pc/live/setWatchHistorySecret
     {paramSecret: xor_encode([recruitId, liveId, userId, minute, "2", videoId], key="zhihuishu")}
GET /app-commserv-live/gateway/t/v1/chect/exceptionActionDetail -> {"rt":{"lock":false}}
```

页面明示规则：观看直播或回放的 **80%** 即可得考勤分；本期按随机 **90–100%** 上报。

## 附录 B：调研产物与验证记录

- 抓包/解密/验证脚本：`E:\Workspace\zhs-recon\`（不在仓库内，实现时可参考）；
- 已验证：
  - 视频课秒刷：`saveDatabaseIntervalTimeV2` 返回 `submitSuccess=true`，`queryStuyInfo` 的 `watchState` 2→1；
  - 见面课：`getWatchHistory` 返回 `1..11`，手工上报第 12 分钟后变为 `1..12`；
  - 异常接口：视频课/见面课均返回 `lock=false`，异常记录页近 15 天无记录（调研操作未造成处罚）；
  - 测验题目可读（本期不实现）。

## 附录 C：实现与验证记录（2026-11-07）

### C.1 交付物

| 层 | 文件 | 规模 |
| --- | --- | --- |
| Rust core | `src/zhihuishu/{mod,crypto,models,api,watch,meet}.rs` | 约 4,300 行 |
| CLI | `src/main.rs` 新增 `zhs` 子命令 | 约 1,340 行（原 423） |
| GUI | `src-tauri/src/zhihuishu.rs` + `state/login/events/commands/lib.rs`；`ui/src/views/zhs-course.ts`、`zhs-meet.ts`、`zs.ts`、types/api/mock/connect/sidebar/main/dom/styles | Rust 约 820 行 + UI 约 1,370 行 |
| userscript | `userscripts/zhihuishu-miaoshua.user.js` | 1,243 行，单文件无依赖 |
| website | `website/src/core/zhs/{types,crypto,transport,client,watch,meet,backend}.ts`、`src/zhs-bridge.user.ts`、`src/views/zhs-*.ts`、`src/mock.ts` 等 | TS 约 2,600 行 + 测试 561 行 |
| 测试 | `tests/zhs_core.rs`（17）、`tests/zhs_mock.rs`（18），模块内 35 个单测 | 1,711 行，新增 35 个集成测试 |
| 文档 | `README.md` 新增"知到"章节、`AGENTS.md` 更新、本文档 | — |

### C.2 门禁结果（worktree `feat-zhihuishu-miaoshua`）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt --all -- --check` | ✅ 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | ✅ 0 告警 |
| `cargo test --workspace` | ✅ 117 passed / 0 failed（lib 76 + bin 5 + submit_http 1 + zhs_core 17 + zhs_mock 18） |
| `npm run build`（根目录，tsc + vite） | ✅ |
| `cd website; npm test; npm run build` | ✅ 33 passed / 0 failed，双桥接产出 |
| `cargo check -p hust-course-hack-gui` | ✅ |
| `node --check userscripts/zhihuishu-miaoshua.user.js` | ✅ |

### C.3 已知限制 / 未验证项

1. **课程列表接口**（`queryShareCourseInfo`）仍未用真实抓包确认：`ZhsClient` 为 best-effort（POST/GET 双尝试 + 宽松解析），失败时 CLI/GUI/website 均支持用学习页 URL / `recruitAndCourseId` 兜底。
2. **见面课列表响应字段**未真实抓包：顶层 `maps` 结构由 userscript 于 2026-11-07 登录态抓包确认，解析器保留多别名；真实字段变化时应收紧而不是继续加别名。
3. **真实写请求**本轮未再次发送：视频 `saveDatabaseIntervalTimeV2`、见面课 `setWatchHistorySecret` 的线上可行性来自 2026-11-07 调研实测（提交成功、`watchState` 2→1、`rt` 增加分钟）；本轮实现用离线 mock 验证请求构造与流程。首次真实使用建议先 `--dry-run` 再单条/单场验证。
4. **网站版桥接**：从 `onlineweb.zhihuishu.com` 跨子域请求 `studyservice-api`/`appcomm-live-api` 的 CORS 未真机验证；被拦截时会显示明确错误。
5. **GUI 知到登录**未用真实账号在 Tauri 窗口验证（需人工在登录窗口输入）；代码路径与 HUST 共用同一套 spawn_blocking/临时目录约束。
6. **多视频回放**：分钟→`videoId` 映射已按累计时长实现，但仅在单视频回放上实测；无时长且多视频时回退第一个 video id 并告警。
7. **风险**：秒刷属高风险形态，平台有独立行为分析（`cheat/exceptionActionDetail`）。工具默认 dry-run、限速、随机 90–100% 覆盖率与熔断；账号风险由使用者自行承担。
8. 随堂测验、考试、直播实时参与不在本期范围（测验接口调研已完成但未实现）。

### C.4 环境备注

- Rust 1.99.1（rsproxy 镜像安装，`%USERPROFILE%\.cargo\bin`，PATH 未自动修改）。
- Windows VS 2022 MSVC 14.43 下 `ring` 的 C 代码带 `/Z7` 会触发 `cl.exe D8050`；`Cargo.toml` 已加 `[profile.dev.package.ring] debug = false` 与 `[profile.test.package.ring] debug = false`，无需额外环境变量。
