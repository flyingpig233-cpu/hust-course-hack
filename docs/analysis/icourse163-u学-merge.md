# U学（优学院）/ icourse163（中国大学 MOOC）实现现状与合并缺口分析

> **取证快照**：2026-11-08 00:13–00:21（Asia/Shanghai）。本文为只读分析：没有修改主目录 `E:\Workspace\HUST_Course_Hack` 的任何文件，没有 commit。
>
> 分析期间主目录发生了两件事，直接影响结论，务必先读 §2.3：
> 1. 主目录（`main` 分支，HEAD `0b52486`）的脏工作树里**曾存在** `src/icourse163/**` 与 `tests/icourse_http.rs`（快照 S1）；
> 2. 在 00:11–00:20 期间，另一会话按用户要求**回滚并删除了 icourse163 模块**（快照 S2）。`src/icourse163/`、`tests/icourse_http.rs`、`test-data/icourse-term.json` 均已不存在，只剩 `docs/icourse163/recon-feasibility.md` 与本地抓包目录 `.tmp-icourse/`。
>
> 因此文中所有 `src/icourse163/*.rs : 行号` 证据都标注为 **S1 快照**（文件现已删除，行号对应 00:13–00:18 读到的内容）；其余证据（docs、主目录 tracked diff、worktree 分支）均为实时状态。
> 分支事实：`feat-zhihuishu-miaoshua` = `6eeac65`（知到实现）+ 合并提交 `0e2b84b`（把 `0b52486` 的优学院文档并入）；主目录 `main` = `0b52486`（优学院侦察文档 + 练习题库）+ 未提交的 0.3.0 文档功能。

---

## 0. 结论速览（TL;DR）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 「U学」指哪个平台 | **U学 = 优学院（Ulearning，`ulearning.cn`）**，不是中国大学 MOOC。证据：团队任务 task-11/12/13/14/15 的标题与描述直接写「优学院（U学 / ulearning.cn）」；`docs/ulearning/*` 全部是优学院域名；worktree `src/ulearning/mod.rs:1-2` 注释「优学院（Ulearning / U学）」。 |
| 2 | U学与 icourse163 是同一平台吗 | **两个平台，协议完全不同**：优学院用 `api.ulearning.cn` + Cookie `AUTHORIZATION` 双 header + DES-ECB(key `12345678`)；icourse163 用 `www.icourse163.org` + `csrfKey` + `Timestamp/Nonce/System/Auth-Signature` MD5 签名。详见 §1.2。 |
| 3 | icourse163 代码在哪、完成度 | 快照 S1 中主目录有 6 个文件（共约 1666 行）的「中国大学 MOOC SPOC」core：RPC/签名、课程树、视频秒刷、模型、测试（禁用）；**且从未 wire 进任何 surface**（§3）。S2 中已全部删除，git 无记录、不可恢复（§2.3）。 |
| 4 | 现在还能合并 icourse163 吗 | **没有代码可合并**。唯一残留是侦察文档 `docs/icourse163/recon-feasibility.md`（协议结论完整，实测视频 5/5、测验 4/4 满分）。若要支持中国大学 MOOC，只能按该文档重新实现。 |
| 5 | documents.rs 与 icourse163 的关系 | **无关系**。`documents.rs` 是超星「学在华科大」的 `mooc-ans` PDF 任务点协议，和 icourse163 的 `MocResourceBean` 文档族不共用；它已作为 0.3.0 功能完整接到 CLI/GUI/website，并已并入 worktree。 |
| 6 | 对本次合并的建议 | 目标若是「U学 = 优学院」：**不做 icourse163，继续 task-11…15**；目标若是「中国大学 MOOC」：单开 feature，按 §6.3 从零补齐，且排在优学院之后以避免 `src/main.rs`/`src-tauri`/`ui`/`website` 热点文件三线并行。 |

---

## 1. 「U学」身份判定

### 1.1 判定结论：U学 = 优学院（ulearning.cn）

仓库里**没有任何字符串「U学」**（全仓 grep：`Select-String -Pattern 'U学|优学'` 只命中「优学院」文档；`docs/` 与代码均无「U学」）。「U学」是用户/团队对 **优学院（Ulearning）** 的口语简称，依据：

- task-11「WP-U1: **优学院（U学）** Rust core 实现」、task-12「WP-U4: **优学院（U学）** userscript」、task-13/14/15 同样措辞——团队已用这个称呼指代优学院。
- `docs/ulearning/recon-static.md:1`「# 优学院（ulearning.cn）学生网页端 · 静态资源侦察报告」；`:12` 学生端 HTML `<title>Ulearning</title>`。
- `docs/ulearning/web-analysis.md:21-30` 域名与宿主映射（`ua.ulearning.cn` / `api.ulearning.cn` / `courseapi.ulearning.cn` / `www.ulearning.cn`）。
- `docs/ulearning/miaoshua-plan.md:1-5` 目标平台与实施计划。
- worktree `src/ulearning/mod.rs:1-2`：「优学院（Ulearning / U学）学生端支持」；`:33-45` 常量 `API_BASE = https://api.ulearning.cn`、`WEB_BASE = https://ua.ulearning.cn`、`LOGIN_URL = https://umooc.ulearning.cn/pc.html#/login`、`AUTH_COOKIE = "AUTHORIZATION"`。
- 已提交事实：`main` 分支 `0b52486`（`docs(ulearning): add web recon, miaoshua plan and practice answer bank`）是「U学」当前唯一的已提交成果：`docs/ulearning/{recon-static,web-analysis,miaoshua-plan}.md` + `test-data/ulearning-answer-bank.json`（`git show --stat 0b52486`）。

### 1.2 U学（优学院）≠ icourse163（中国大学 MOOC）对照表

| 维度 | 优学院 / U学 | 中国大学 MOOC / icourse163 |
| --- | --- | --- |
| 主站 | `ua.ulearning.cn`（播放器）、`api.ulearning.cn`（记录 API）、`courseweb.ulearning.cn`（课程 SPA）`docs/ulearning/web-analysis.md:21-30` | `www.icourse163.org`（SPOC 页 `/spoc/course/HUST-<id>`）`docs/icourse163/recon-feasibility.md:4,49` |
| 会话/鉴权 | Cookie `AUTHORIZATION`（域 `.ulearning.cn`），每个请求同时带 `Authorization` + `UA-AUTHORIZATION`；**无签名/时间戳** `docs/ulearning/web-analysis.md:12,53`、`docs/ulearning/miaoshua-plan.md:35-36` | Cookie `NTESSTUDYSI` 作 `csrfKey`（URL 参数），需 `Timestamp/Nonce/System/Auth-Signature` 四头；签名 `md5(body+nonce+timestamp+盐).toUpperCase()` `docs/icourse163/recon-feasibility.md:49-62`；S1 `src/icourse163/mod.rs:25-38`、`crypto.rs:56-63` |
| 课程结构 | 课程(ocId) → 章(chapter) → 节(section/itemid) → 页(page/relationid) `docs/ulearning/miaoshua-plan.md:41-62` | term → chapters → lessons → units（`MocTermDto`）；SPOC 本身无章节，内容在源课程 term `docs/icourse163/recon-feasibility.md:23-25,75-85`；S1 `course.rs:40-59` |
| 进度上报 | `POST /yws/api/personal/sync?courseType=4&platform=PC`，body 为 DES-ECB(PKCS7, key `12345678`) 加密 JSON `docs/ulearning/web-analysis.md:117-150`、`miaoshua-plan.md:64-109` | `POST /web/j/courseRpcBean.saveMocContentLearn.rpc`，JSON 学习日志 + 签名；一次 `finished:true` 即 100% `docs/icourse163/recon-feasibility.md:103-126,158-178`；S1 `video.rs:48-91` |
| 完成判定 | 前端计算 `status=1` 后上报，服务端接受（实测）`docs/ulearning/web-analysis.md:150,245-255` | 服务端按学习日志置 `completePercent=1`，未校验真实时长（实测）`docs/icourse163/recon-feasibility.md:158-178` |
| 练习/测验答案 | `GET /questionAnswer/{qid}?parentId={pageId}` 对未答题直接返答案 `docs/ulearning/web-analysis.md:202-214` | 无答案接口；测验靠 WebView DOM 自动化 + 公开题库 `docs/icourse163/recon-feasibility.md:187-199` |
| 本仓库代码 | worktree `src/ulearning/**`（task-11 进行中；截至 00:20 仅有 `mod.rs` stub + `lib.rs:15` 接线）；文档 + 题库已合并 | S1 主目录 `src/icourse163/**`（未提交、未接线）→ **S2 已删除** |
| 风险面 | 服务端 `sync` 返回 `2` 即刷分中止；练习限 1 次 `docs/ulearning/web-analysis.md:218-229,264-271` | 视频秒刷可能加风控；测验一开卷即建草稿 30 分钟计时，超时自动 0 分并消耗次数；考试 1 次机会 `docs/icourse163/recon-feasibility.md:184,246-252` |

**一句话**：用户说的「U学」= 优学院；icourse163 是中国大学 MOOC（HUST 的大学体育 SPOC 就在这上面）。二者只是「都是课程平台」，协议/代码/风险全部独立，**不能互相代称，也不能共用接口层**。

### 1.3 为什么用户会说「U学」

1. 优学院英文品牌是 **Ulearning**（页面 `<title>Ulearning</title>`，`docs/ulearning/recon-static.md:12`），学生口头简称「U学」自然成立；团队任务板也沿用了这个叫法（task-11 起）。
2. 主目录那轮会话先做了优学院（U学）侦察/实施计划（提交 `0b52486`，22:26–23:04），之后才去做 icourse163（23:30 起，`docs/icourse163/recon-feasibility.md` 时间戳 23:57）——说明「U学」和「icourse163」是用户先后提出的两个目标，前者已有文档/题库落地，后者是被回滚的那一个。

---

## 2. icourse163 实现现状（快照 S1，现已删除）

### 2.1 S1 代码清单（主目录，00:13 读取）

| 文件 | 行数 | mtime | 内容 | 关键位置（S1 快照行号） |
| --- | --- | --- | --- | --- |
| `src/icourse163/mod.rs` | 95 | 00:02 | 模块入口、常量、`ContentType` | `:23` `BASE`；`:26` `AUTH_SALT`；`:32` `CSRF_COOKIE=NTESSTUDYSI`；`:35` `STUDY_INFO_COOKIE`；`:47/50/53` RPC 名；`:60-95` 视频/未知类型 |
| `src/icourse163/crypto.rs` | 162 | 00:02 | csrfKey、Auth-Signature、nonce | `:31-52` `AuthSignature::for_body/headers`；`:56-63` `auth_signature`；`:69-85` `csrf_key`；`:99-106` nonce；`:113-123` MD5 固定向量测试 |
| `src/icourse163/client.rs` | 291 | 00:06 | `IcourseClient`：reqwest + cookie jar + RPC | `:85-109` `with_cookie_jar_and_base`；`:112-121` `from_cookie_file/from_cookie_header`；`:138-149` `csrf_key`；`:155-220` `rpc(name, body, encoding, need_auth)`；`:223-245` `get_text`；`:249-262` `normalize_reply` |
| `src/icourse163/course.rs` | 404 | 00:06 | 课程树、SPOC 定位、`window.*` 解析 | `:40-51` `fetch_course_tree`；`:54-59` `parse_term_reply`；`:64-80` `normalize_course_id`；`:85-141` `parse_spoc_course_page`；`:144-158` `resolve_spoc_course`；`:164-205` `resolve_course_tree`；`:207-273` `extract_window_object/take_balanced` |
| `src/icourse163/models.rs` | 268 | 00:06 | `IcourseTerm/Chapter/Lesson/Unit/WatchTarget/WatchOutcome` | `:12-28` term；`:32-52` `find_unit/units/video_count`；`:81-105` Unit 字段；`:136-149` `WatchTarget`；`:159-193` `WatchOutcome::verified` |
| `src/icourse163/video.rs` | 446 | 00:06 | 视频秒刷：计划/日志/重试/限速/复核 | `:37-42` `WatchContext{course_id,user_id}`；`:48-91` `LearnLogDto`+`rpc_body`；`:96-120` `plan_videos`；`:127-141` `whoami`；`:144-161` `user_id_from_study_info`；`:164-180` `resolve_user_id`；`:188-271` `complete_videos`（重试 1 次、1.2s 限速、重拉树复核） |

S1 的测试/夹具：

- `tests/icourse_http.rs`（11060 B，mtime 00:11:44）：本地 mock server 覆盖三条 RPC + 校验 `Auth-Signature == md5(body+nonce+timestamp+salt)`；**但第 1 行写明「已按用户要求回滚：icourse163 模块已移除，本测试暂时禁用（文件因沙箱权限无法删除）」，第 2 行 `#![cfg(any())]`**。
- `test-data/icourse-term.json`（4287 B，mtime 00:04:19）：`getLastLearnedMocTermDto` 的真实结构夹具（S2 已删除）。

### 2.2 S1 完成度评估

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| RPC 客户端 + csrfKey + 签名 | ✅ 代码完成 | S1 `client.rs:155-220` + `crypto.rs:56-63`，签名有固定向量测试 `crypto.rs:113-123` |
| 课程树（term → chapters/lessons/units） | ✅ 代码完成 | S1 `course.rs:40-59`、`models.rs:12-105` |
| SPOC 源学期定位 | ⚠️ 代码完成但**未登录实测** | 实现注释自述「待实测」（S1 `course.rs:11-13`），页面解析基于静态分析；无法解析时要求 `--term`（`:184-190`） |
| 视频秒刷（一次 finished:true → 100%） | ✅ 代码完成，协议已实测 | `docs/icourse163/recon-feasibility.md:158-178`（2/2 后累计 5/5）、S1 `video.rs:188-271` |
| 视频播放 token / HLS / 下载 | ❌ 未实现 | 协议已知（`recon:87-101`），代码没做（本功能不需要） |
| 测验列表 / 答题 | ❌ 未实现 | recon §5.4 计划了 `quiz.rs`（`recon:225-233`），S1 实际没有该文件；4/4 满分只是 CDP 脚本实测（`recon:187-199`、`.tmp-icourse/*.js`），Rust 侧零实现 |
| 考试 | ❌ 未实现（也不建议） | `recon:217-220,250` |
| 文档任务点 | ❌ 未实现（本课无此任务） | `recon:18`；icourse163 文档族是 `MocResourceBean`，与超星 `documents.rs` 无关 |
| CLI / GUI / website / userscript 接入 | ❌ 完全没有 | 见 §3 |
| 测试 | ⚠️ 已写好但禁用 | `tests/icourse_http.rs:1-2` |

**编译阻塞（S1 就存在）**：`client.rs:113` 调 `cookie::load_cookie_jar_for(path, BASE)`、`:119` 调 `cookie::jar_from_cookie_header_for(header, BASE)`，但 `src/cookie.rs` 只有 `load_cookie_jar`（`:115`）与 `jar_from_cookie_header`（`:154`），**没有带 `_for` 的变体**（主目录与 worktree 都只有旧签名）。也就是说：即使把 `pub mod icourse163` 加回 `lib.rs`，S1 代码也编译不过——这是「半成品被回滚」的又一处证据。

依赖侧无新增需求：`md5`、`percent-encoding`、`log`、`url` 都已在 0.2.0 的 `Cargo.toml` 里（主目录 `Cargo.toml:27-46`），S1 没有引入新 crate；反观 worktree 的 `Cargo.toml` 为知到/优学院新增了 `aes/cbc/rsa/rand/base64/des`。

### 2.3 S2：用户要求回滚，代码已删除（关键事实）

时间线（主目录）：

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 00:02–00:06 | `src/icourse163/**` 最后写入 | 文件 mtime |
| 00:04 | `test-data/icourse-term.json` 写入 | mtime |
| 00:10–00:11 | `src/lib.rs`、`src/main.rs` 被改回（只保留 documents，无 icourse163）；`tests/icourse_http.rs` 加回滚注释并 `#![cfg(any())]` | `lib.rs` mtime 00:10:16、`main.rs` 00:11:08、`tests/icourse_http.rs:1-2` |
| 00:13–00:20 | `src/icourse163/`、`tests/icourse_http.rs`、`test-data/icourse-term.json` **被删除** | 主目录 `git status` 中不再出现这些 untracked 路径；`Get-ChildItem` 找不到 |

回滚后的残留（主目录，截至 00:20:38）：

- `docs/icourse163/recon-feasibility.md`（16147 B，mtime 23:57）——**保留**，是唯一可复用的成果；
- `.tmp-icourse/`（约 120 个文件，含 `cookies.json` 3570 B、大量 `act-*.json`/`paper-*.json` 抓包、CDP 脚本）——保留，已被 `.gitignore:13` 的 `/.tmp-icourse/` 忽略；
- 无 dangling commit、无 stash（`git reflog` 只有 2 条；`git fsck --dangling` 无 commit），因为 icourse163 从未 `git add`/commit。**删除的 6 个源文件无法从 git 恢复**；恢复只能靠 `docs/icourse163/recon-feasibility.md` 的协议/结构描述（§4）重写。

> 合并含义：**当前不存在「待合并的 icourse163 实现」**。§6.3 的缺口清单是「若日后还要做」的施工图，不是「从主目录搬代码」的清单。

---

## 3. surface 接入逐项检查（grep `icourse` / `icourse163` 全仓）

检查范围：主目录（S1 与 S2 各一次）+ worktree（00:20），排除 `target/`、`node_modules/`、`dist/`、`.git/`、`.tmp-icourse/`。

| Surface | 期望接入点 | 主目录（S1，00:13） | 主目录（S2，00:20） | worktree（00:20，含知到+documents） |
| --- | --- | --- | --- | --- |
| core 模块 | `src/lib.rs` 的 `pub mod icourse163;` | ❌ 无（`lib.rs:7-16` 只有 `documents:10` 等） | ❌ 无 | ❌ 无（`lib.rs:10 documents`、`:15 ulearning`、`:16 zhihuishu`） |
| CLI | `src/main.rs` 的 `icourse` 子命令 | ❌ 无（`Command` 枚举 `main.rs:42-89` 只有 `List/Dump/Tree/Helper/Doc/Watch`；S1 的 icourse163 只在独立模块+禁用测试里出现） | ❌ 无 | ❌ 无（`main.rs:49-129`：`List/Dump/Tree/Helper/Doc/Watch/Zhs`，`Zhs` 在 `:118`） |
| GUI 命令 | `src-tauri/src/commands.rs` / `lib.rs` | ❌ 无（`src-tauri/src/lib.rs` invoke 列表只有 HUST+documents；无 `icourse*` 命令） | ❌ 无 | ❌ 无（只有 `commands::*` + `zhihuishu::zhs_*`；`src-tauri/src/lib.rs:36-44`） |
| GUI 平台枚举 | `src-tauri/src/state.rs` 的 `Platform` | ❌ 无 | ❌ 无 | ❌ 无（`state.rs:24-30` 只有 `Hust:27`、`Zhihuishu:29`；`SessionClient:66` 两分支） |
| GUI 视图 | `ui/src/views/` | ❌ 无 | ❌ 无 | ❌ 无（只有 `zhs-course.ts/zhs-meet.ts/document.ts` 等） |
| website core | `website/src/core/` | ❌ 无 | ❌ 无 | ❌ 无（`core/zhs/*`、`core/documents.ts`，无 icourse） |
| website 视图/桥 | `website/src/views/`、`public/*.user.js` | ❌ 无 | ❌ 无 | ❌ 无（`zhs-bridge.user.js`、`hust-course-bridge.user.js`） |
| userscript | `userscripts/` | ❌ 无（只有 `hust-course-video-helper.user.js`） | ❌ 无 | ❌ 无（+ `zhihuishu-miaoshua.user.js`） |
| tests | `tests/icourse_http.rs` | ⚠️ 存在但禁用（`:1-2`） | ❌ 已删除 | ❌ 无（`tests/{submit_http,zhs_core,zhs_mock,documents_http}.rs`） |
| 文档 | `docs/icourse163/`、README、AGENTS | ✅ 仅 `docs/icourse163/recon-feasibility.md`；README/AGENTS 无 icourse163 字样 | ✅ 仅 recon 文档 | ❌ worktree 无 `docs/icourse163/`（recon 未合并） |
| 依赖 | `Cargo.toml` | ✅ S1 无新增依赖 | — | 与 icourse163 无关的 `aes/cbc/rsa/rand/base64/des`（为知到/优学院） |

**结论**：icourse163 在 S1 就是「core 孤岛」——0/6 个用户可见 surface 接入；S2 删除后连孤岛都没了。它**从未进入任何 git 提交**（`git log --all` 无 icourse163 相关提交；`0b52486` 只含优学院文档）。

---

## 4. icourse163 协议摘要与实测结论

> 依据：`docs/icourse163/recon-feasibility.md`（2026-11-07 23:30–00:10 登录实测，状态见其 `:3-5`）与 S1 代码互证。所有结论均已在真实学生账号验证（除标注「待实测」）。

### 4.1 RPC 与鉴权（recon:44-62；S1 `client.rs:155-220`、`crypto.rs:31-63`）

```
POST https://www.icourse163.org/web/j/<Service>.<method>.rpc?csrfKey=<Cookie NTESSTUDYSI>
```

- 课程树等 form 接口：`application/x-www-form-urlencoded`（`termId=...`）。
- 需要鉴权的 JSON 接口额外 4 头：
  - `Timestamp`（ms）、`Nonce`（1000..10000）、`System: v1`、
  - `Auth-Signature = md5(JSON.stringify(body) + nonce + timestamp + "fu2s2kxcswgn5hqanx7asmlogyr5wu29").toUpperCase()`。
- 实测：带 Cookie + `csrfKey` + 签名 → `{"code":0,"result":true}`；缺 `csrfKey` → `{"code":-1002,"message":"非法跨域请求"}`（recon:61-62）。
- 签名必须基于「实际发送出去的 body 字符串」，S1 因此让 `RpcBody` 只序列化一次（`client.rs:179-196`）。
- 仓储里的实现：`mod.rs:23-53` 常量、`crypto.rs:56-63` 签名、`client.rs:155-220` 请求、`:249-262` `code!=0` 归一化为错误。

### 4.2 登录与会话（recon:64-73, 147-152）

- 网页登录表单：`POST //www.icourse163.org/passport/reg/icourseLogin.do`，`username/passwd`（明文）+ returnUrl/failUrl/saveLogin/oauthType。
- 登录后 Cookie：`NTES_YD_SESS`/`NTES_YD_PASSPORT`、`STUDY_SESS`/`STUDY_PERSIST`/`STUDY_INFO`、`NTESSTUDYSI`（=csrfKey，JS 可读）。
- 验活/取会员：`memberBean.getMocMember`（S1 `video.rs:127-141`，参数与返回结构**待实测**）；兜底从 `STUDY_INFO` Cookie 解析 `id`（S1 `video.rs:144-161`），再不行要求 `--user-id`（`:164-180`）。
- 仓储设计：CLI 走 `cookies.txt`（`IcourseClient::from_cookie_file`），GUI 设计上走独立登录 webview 读 HttpOnly Cookie（recon §5/§6，未实现）。

### 4.3 课程树与 SPOC 定位（recon:75-85；S1 `course.rs`）

- `POST /web/j/courseBean.getLastLearnedMocTermDto.rpc`，form `termId` → `result.mocTermDto.chapters[].lessons[].units[]`；
  unit 字段：`id/contentId/contentType/durationInSeconds/learnTime/completePercent/viewStatus`（`models.rs:81-105`）。
- 备选：`courseBean.getMocTermDto.rpc {termId,isDraft:0,excludeUnrelease:0}`（`isDraft`/`excludeUnrelease` 必须 `0/1`，传 `"false"` 报 `-1005`）。
- **SPOC 陷阱**：SPOC term（如 `1488313494`）`chapters: []`，内容在源课程 term（如 `1488269453`）；学习日志同时出现 SPOC `courseId` 与源 `termId`（recon:22-25, 152-156）。S1 `course.rs:144-205` 用 `window.courseDto/termDto/moocCourseCardDto` 从 SPOC 页解析源 term——**该页面解析未登录实测**（`course.rs:11-13`），解析失败时必须 `--term`。
- 单元详情/视频 token：`/dwr/.../CourseBean.getLessonUnitLearnVo.dwr` + `resourceRpcBean.getResourceTokenV2.rpc` → `vod.study.163.com/eds/api/v1/vod/video` 取 HLS（recon:87-101）。S1 **未实现**（秒刷不需要）。

### 4.4 视频秒刷：saveMocContentLearn（recon:103-126, 158-178；S1 `video.rs`）

一次请求即可把视频从 0% 打成 100%：

```json
{"dto":{"unitId":1321495206,"finished":true,"index":2,"duration":60000,
 "courseId":1486416181,"lessonId":1279020182,"videoId":1214491698,"termId":1488269453,
 "userId":"1149184926","contentType":1,"action":"LEARN_TIME_COUNT",
 "videoTime":819,"learnedVideoTimeCount":819}}
```

- 上报前无需起始日志、无需按 60s 分段；`index` 任意；`duration` 固定 60000ms；`videoTime`/`learnedVideoTimeCount` = 视频时长秒。
- 实测：2 个视频各一次请求后 `completePercent` 0.0061/0.0030 → **1**（`learnTime` 分钟数随之增加）；累计 5/5 视频完成（recon:31-35, 158-178）。
- S1 实现：`LearnLogDto::completed`（`video.rs:68-90`）、`plan_videos` 跳过 `contentType!=1` 或 `completePercent>=1`（`:96-120`）、`complete_videos` 失败重试 1 次 + 每节 1.2s 限速 + 重新拉树复核 `completePercent>=1`（`:188-271`）、`WatchOutcome::verified` 以复核为准（`models.rs:190-192`）。
- 风险：服务端当前不校验真实耗时，属「信任客户端」；可能后续加风控（要求分段/间隔/真实 `learnTime`），留真实加速播放兜底（recon:248）。

### 4.5 测验 DOM 自动化（recon:128-143, 180-199；**无 Rust 实现**）

- 页面流程：`#/learn/quiz?id=<quizId>` →「开始测验」→ `POST /web/j/mocQuizRpcBean.getOpenQuizPaperDto.rpc {tid, aid:0, withStdAnswerAndAnalyse:false}` → **建草稿答卷（aid + startTime，开始 30 分钟倒计时）** → 选项自动 `saveDraftAnswers` →「提交答案」→ `submitAnswers {paperDto}` → `#/learn/quizscore`。
- DOM：题目容器 `.u-questionItem`；选项 `ul.choices li` 内 `input[type=radio]`（点 `label`）；提交 `.j-submitBtn`；确认框 `.m-dialog` + `.j-left`；操作过快弹「并发限制」需重试。
- 实测：CDP 在真实学习页执行 DOM 点击，4 个单元测试各 10 题全部 **100.00/100.00**（recon:187-199）；答案来源是公开《大学体育》题库（5 章 × 10 题，90/90 命中）。
- **高风险**：`getOpenQuizPaperDto` 一开卷就建草稿并开始计时，晚提交会**超时自动交卷 0 分并消耗 1 次机会**（实测 23:03 草稿 23:35 自动 0 分，recon:184）；因此工具必须 dry-run + 提交前二次确认、并处理残留草稿。
- 考试：1 次机会、60 分钟、随机组卷；只做读题/答案建议，**绝不自动提交**（recon:217-220, 250）。

### 4.6 文档（PDF）与 icourse163 的关系

- 本课程（大学体育 SPOC）**无文档任务点**（recon:18）。
- icourse163 若有文档，接口族是 `MocResourceBean.saveContentForResource`（recon:18），**不是**超星的 `/mooc-ans/phone/wxcard` + `/mooc-ans/job/document`。因此 `src/documents.rs` 与 icourse163 无共用可能（详见 §5）。

### 4.7 实测状态总表（recon:246-252）

| 项 | 状态 |
| --- | --- |
| 登录 / Cookie / 签名脱离浏览器复现 | ✅ |
| 课程树（源 term）/ SPOC 源 term 定位 | ✅（源 term 实测；SPOC 页 `window.*` 解析待实测） |
| 视频秒刷 | ✅ 5/5 视频完成 |
| 测验自动答题 | ✅ 4/4 满分（CDP DOM 路径，非 Rust） |
| 文档任务点 | ➖ 本课无 |
| 期末考 | ❌ 未做（1 次机会，页面显示未开放） |
| 学期总进度 | 9/9 学习任务完成（recon:252） |

---

## 5. `src/documents.rs` 的能力与现状（与 icourse163 无关）

### 5.1 它是什么

- 针对**超星「学在华科大」SmartCourse** 的 PDF 文档任务点直报：解析课程树里的文档任务点 → `GET /mooc-ans/phone/wxcard` 读 `window.AttachmentSetting` 取每个附件的 `jtoken` → `GET /mooc-ans/job/document?jobid&knowledgeid&courseid&clazzid&jtoken&...`，只有响应 `status: true` 才算完成。
- 实现：`src/documents.rs`（321 行，`:1-13` 模块说明与实测结论；`:31-56` `DocumentTarget`/`DocumentReport`；`:60-` `collect_document_targets`/`parse_attachment_setting`/`attachment_jtoken`/`parse_document_report`）；`src/client.rs:906/942/969` 三个方法 `fetch_document_attachment_setting` / `report_document_read` / `complete_document`。
- 与官方客户端同协议（flutter_chaoxing 0.4.2 的 `fetchDocumentJobs`/`reportDocumentRead`），2026-11-07 实测某课程 49/49 文档 `status: true`（AGENTS.md、README 的 0.3.0 段落）。

### 5.2 主目录现状（0.3.0，已完整接线）

| Surface | 接入证据（主目录当前行号） |
| --- | --- |
| core | `src/lib.rs:10` `pub mod documents;`、`:21-25` 导出；`src/documents.rs:1-321`；`src/client.rs:906/942/969` |
| CLI | `src/main.rs:71-88` `Doc` 子命令、`:145` 分发、`:280-355` `async fn doc(...)`（dry-run/`--job`/`--max-documents`/失败汇总） |
| GUI | `src-tauri/src/commands.rs:61/76/87` DTO、`:367` `complete_documents`、`:783` `emit_document`；`src-tauri/src/events.rs` 新增 `DocumentPlan`/`Document` 事件；`src-tauri/src/lib.rs:30` 注册 |
| ui | `ui/src/api.ts` `completeDocuments`；`ui/src/types.ts` `DocumentRequest/Result/Summary` + `documentPlan/document` 进度；`ui/src/views/document.ts`（316 行）；`ui/src/main.ts` `openDocuments` + `onDocuments` |
| website | `website/src/core/documents.ts`（159 行）、`website/src/views/document.ts`（357 行）、`website/tests/documents.test.ts`（139 行）；`website/src/main.ts` `openDocument`/`onDocument`；`website/src/api.ts`/`types.ts`/`mock.ts` |
| tests | `tests/documents_http.rs`（本地 mock 校验 wxcard/job/document 参数与拒绝分支） |
| docs | README 新增「直接完成文档（doc）」章节（`README.md` diff +78 行）；AGENTS.md 更新模块/命令/约定 |

worktree 已在合并中接收该功能：`git status` 显示 `A src/documents.rs`、`A tests/documents_http.rs`、`A ui/src/views/document.ts`、`A website/src/core/documents.ts`、`A website/src/views/document.ts`、`A website/tests/documents.test.ts`，以及 `M` 的 client/lib/main/tauri/ui/website 共享文件。

### 5.3 与 icourse163 的关系

**没有关系，也不该共用**：icourse163 的文档族是 `MocResourceBean.saveContentForResource`（recon:18），域名/签名/参数全不同；把 `documents.rs` 当 icourse163 文档支持会得到错误的端点与鉴权。`documents.rs` 属于「超星平台」，不属于「U学」，更不属于 icourse163。

---

## 6. 合并缺口清单

### 6.1 现实前提

- icourse163 **没有可合并的代码**（S2 已删除、从未提交）；「合并缺口」只能是「若仍要做，需要新建什么」。
- U学（优学院）的**文档+题库已合并**（`0e2b84b` 合并 `0b52486`），**实现代码在 worktree 原地开发**（task-11…15），不是从主目录搬。
- 主目录还有未提交的 0.3.0 文档功能；worktree 已用 patch 方式搬入（`git status` 中的 `A` 文件），这是绕开「git merge 不带 untracked」的正确做法，后续 icourse163 若恢复也要同样手动搬。

### 6.2 目标 = U学（优学院）：不涉及 icourse163

| 层 | 文件/状态（worktree 00:20） | 缺口 |
| --- | --- | --- |
| core | `src/ulearning/mod.rs` 仅 stub（`mod.rs:1-2,33-45`），`lib.rs:15` 已接线；`Cargo.toml` 已有 `des/cipher` 依赖 | task-11：cipher/client/models/parse/plan/record（按 `docs/ulearning/miaoshua-plan.md:149-166`） |
| CLI | `src/main.rs` 无 `ulearn` 子命令（task-13 pending） | 加 `ulearn`/`uly` 子命令（与 `zhs` 同风格） |
| GUI | `src-tauri/src/state.rs:24-30` `Platform` 只有 Hust/Zhihuishu；无 ulearning 命令 | task-14：Platform::Ulearning、`src-tauri/src/ulearning.rs`、登录窗口、UI 视图 |
| website | 无 `core/ul/**`、无桥 | task-15 |
| userscript | 无 `ulearning-miaoshua.user.js` | task-12 |
| tests | 无 `tests/ul_*` | 随 task-11 模块内单测 + 后续 mock |
| 文档 | `docs/ulearning/*` 已合并；README/AGENTS 未写优学院章节 | task-7（Lead）收尾 |

与知到分支的冲突文件（同一批热点，见 §6.4）：`Cargo.toml`（已由 Lead 加 `des`）、`src/lib.rs`（已加 `pub mod ulearning`）、`src/main.rs`（task-13 与 zhs 的 `Command`/`ZhsCommand` 同文件）、`src-tauri/**`、`ui/**`、`website/**`、`AGENTS.md`/`README.md`。

### 6.3 目标 = 中国大学 MOOC（icourse163）：若仍要做的施工清单

> 依据 `docs/icourse163/recon-feasibility.md` §5.4/§6 + S1 模块设计（`mod.rs:25-53`、`course.rs:40-205`、`video.rs:96-271`）。

| 层 | 文件 | 要补什么 | 冲突风险 |
| --- | --- | --- | --- |
| core | `src/icourse163/{mod,crypto,client,course,models,video}.rs` | 重建（或按 §2.1 设计重写）；**修 `cookie.rs` 辅助函数**（补 `load_cookie_jar_for`/`jar_from_cookie_header_for` 或改用现有函数）；`lib.rs` 加 `pub mod icourse163` + 别名导出（避免 `models::Chapter/Lesson` 与 `crate::models::Chapter` 同名） | `src/lib.rs`、`src/cookie.rs` 与 zhs/ulearning 同文件 |
| core | `src/icourse163/quiz.rs` | 未实现：`getOpenQuizInfo`/`getOpenQuizPaperDto`/`getNewExamList` 数据层（DOM 自动化另放 Tauri） | 新文件，无冲突 |
| CLI | `src/main.rs` | `Icourse`/`IcourseCommand {list,tree,watch,check}`；复用 `--cookies`/`--dry-run/--max-*/--yes` 风格；`--term` 覆盖 SPOC 源学期 | **与 `ZhsCommand`、`Doc`、task-13 `ulearn` 同文件**（最高冲突点） |
| GUI | `src-tauri/src/state.rs` | `Platform::Icourse163`（`state.rs:24-30`）+ `SessionClient` 分支（`:66`） | 与 task-14 同一枚举 |
| GUI | `src-tauri/src/login.rs` | icourse163 登录窗口：打开 `https://www.icourse163.org/passport`（或 SPOC 页），读 `www.icourse163.org` Cookie（含 HttpOnly：`NTES_YD_SESS/STUDY_SESS/STUDY_INFO/NTESSTUDYSI`），用 `memberBean.getMocMember`/课程树验活；沿用 `spawn_blocking` + 临时 WebView2 目录 | 与 zhs 平台分支同文件 |
| GUI | `src-tauri/src/{icourse163.rs,commands.rs,events.rs,lib.rs}` | 薄命令 `icourse_*`；`JobProgress` 新变体（`IcoursePlan/Icourse`）与 zhs `Video/Meet`、documents `Document` 同枚举；invoke 注册 | `events.rs`/`commands.rs`/`lib.rs` 三平台共用，冲突高 |
| GUI | `src-tauri/src/icourse163_dom.rs`（新） | 测验 DOM 自动化：WebView2 打开 `#/learn/quiz?id=...`，`label.click()` 选项、`.j-submitBtn`、`.m-dialog .j-left` 确认；**必须 dry-run 默认 + 用户二次确认**，并处理 30 分钟草稿超时（recon:184, 211-215） | 新文件；风险最高，协议只经 CDP 验证 |
| ui | `ui/src/views/icourse-course.ts`、`icourse-quiz.ts` + `api.ts/types.ts/main.ts/mock.ts/connect.ts` | 课程页（章/节/视频/测验）、秒刷弹窗（dry-run+限速）、测验确认弹窗；平台选择第三项 | `ui/src/main.ts`、`types.ts`、`mock.ts`、`connect.ts` 与 zhs+documents+ulearning 全部同文件 |
| website | `website/src/core/icourse163/**` | TS 移植 RPC/签名（MD5 需浏览器内 JS 实现，不能依赖 `crypto.subtle`）+ 课程树 + saveMocContentLearn；跨域必须 `icourse163-bridge.user.ts` 注入 `www.icourse163.org` 页面（同源请求 + postMessage 白名单） | `website/src/main.ts/api.ts/types.ts/mock.ts` 与 zhs+documents 同文件 |
| website | `website/src/views/icourse-*.ts`、`website/tests/icourse.test.ts` | 课程页/秒刷弹窗/测验确认；离线测试（签名向量、计划、白名单） | 新文件为主 |
| userscript | `userscripts/icourse163-miaoshua.user.js` | DOM 一键路径：当前视频标记完成（调 `window.tokenEncrypt` 不必要，秒刷走接口）、测验逐题作答+提交确认、考试只高亮不提交（recon §4.5 的 CDP 脚本可移植） | 无同文件冲突；需更新 AGENTS/README/userscript 列表 |
| tests | `tests/icourse_http.rs` | 重建并**去掉 `#![cfg(any())]`**；mock 校验 `csrfKey`、四头签名、`getLastLearnedMocTermDto`、`memberBean.getMocMember`、`saveMocContentLearn` 字段与复核 | 与 zhs_mock/documents_http 无文件冲突，但 `cargo test` 时长增加 |
| tests | `test-data/icourse-term.json` | 重建 term fixture（脱敏） | 新文件 |
| docs | `docs/icourse163/*`（worktree 还没有）；README/AGENTS 章节 | 把 recon 文档合入 worktree；写命令表/风险 | `README.md`/`AGENTS.md` 与 zhs/ulearning/documents 同文件 |

**顺序建议**：core → CLI → tests → GUI 命令/登录 → ui → website → userscript → 文档；每步单独 commit，不要和优学院并行改 `src/main.rs`/`src-tauri`/`ui`/`website`。

### 6.4 与知到分支的冲突文件清单（实测交集）

对「知到分支改动文件（`git diff --name-only 71dec82 6eeac65`，53 个）」∩「主目录未提交改动（`git status`，42 个）」求交集，19 个文件**已经/将会**在同一处被改两次：

```
AGENTS.md
Cargo.lock
Cargo.toml
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
docs/zhihuishu-miaoshua-plan.md   # 主目录有同名未跟踪副本
```

其中 worktree 本轮合并已经实际冲突并解决过：`AGENTS.md`、`README.md`、`src/main.rs`、`ui/src/mock.ts`、`website/README.md`、`website/src/api.ts`、`website/src/main.ts`（`git status` 曾显示 `UU`；`website/src/main.ts` 的 2 处冲突由 task-10 解决）。**icourse163 若接入，会再次命中 `src/lib.rs`、`src/main.rs`、`src-tauri/{lib,commands,events,state,login}.rs`、`ui/{api,main,types,mock}`、`website/{api,types,main,mock,core/*}`**——与优学院 task-13/14/15 完全重叠。

解决建议：
1. **串行写热点文件**：`src/main.rs`（CLI）、`src-tauri/src/{state,commands,events,lib,login}.rs`、`ui/src/{main,types,api,mock}.ts`、`website/src/{main,types,api,mock}.ts` 每次只允许一个任务在写；用 write scope 互斥（task 板已标注）。
2. **先各平台独立模块文件，再做一次性接线 commit**：core 新文件（`src/ulearning/**`、`src/icourse163/**`）并行写不冲突；接线（lib/main/tauri/ui/website）由 Lead 或单一 owner 串行完成。
3. **worktree + 小步提交 + 每步 `cargo fmt/clippy/test`、`npm test/build`**；避免「git merge 主目录脏工作树」（untracked 不随 merge 走，0.3.0 documents 就是这样用 patch 搬的）。
4. 文档（`AGENTS.md`/`README.md`/`docs/*`）最后统一由 Lead 写，避免每个 feature 都改同一段。

---

## 7. 三/四平台统一抽象建议

> task-9（ui-analyst）会给出更细的爬取/UI 抽象；这里只给合并落地需要的骨架与命名，重点标注 icourse163/优学院 接入时应遵守的边界。

### 7.1 Platform 枚举与会话（`src-tauri/src/state.rs`）

现状（worktree）：`Platform { Hust, Zhihuishu }`（`state.rs:24-30`，`label()` 给中文名），`SessionClient::Hust/Zhihuishu`（`:66`），`SessionInfo.platform`（camelCase 到前端）。

建议扩展：

```rust
pub enum Platform {
    #[default] Hust,        // 学在华科大（SmartCourse）
    Zhihuishu,              // 知到（智慧树）
    Ulearning,              // 优学院（U学）
    #[serde(rename = "icourse163")] Icourse163, // 可选，最后做
}
```

- 每平台一个 session 结构（`HustSession`/`ZhsSession`/`UlSession`/`IcourseSession`）与 `SessionClient` 分支；沿用 `AppState::begin_job` 单 job 锁与 `job-progress` 事件。
- 登录窗口平台化：`login.rs` 用一张 `(platform -> login_url, cookie_url, validate_fn)` 表，统一 `spawn_blocking` 读 Cookie、临时 WebView2 目录清理；`open_login_window(platform)` 已支持可选平台（AGENTS 对 zhs 的约定），新增平台只加表项 + 验活函数。
- 命令命名前缀：`zhs_*`（已有）、`ul_*`（task-14）、`icourse_*`（若做）；事件名 `zhs-watch`/`ul-watch`/`icourse-watch`，避免混用 `job-progress` 的 kind 字符串（前端已按 platform 分流，见 `ui/src/main.ts:109-135`、`website/src/main.ts:56,104-117`）。

### 7.2 统一课程 DTO 与任务点

现状三套完全独立：HUST `models::{CourseDetail,Chapter,TaskPoint,TaskKind}`；知到 `src/zhihuishu/models.rs`（`ZhsCourse/ZhsCourseDetail/...`）；优学院规划 `UlCourse/UlChapter/UlSection/UlPage/UlTarget`（`docs/ulearning/miaoshua-plan.md:170-191`）；icourse163 S1 `IcourseTerm/Chapter/Lesson/Unit`（`models.rs:12-105`）。

建议（core crate 内）：

```rust
pub struct PlatformCourseSummary { pub platform: Platform, pub id: String, pub name: String, pub extra: PlatformExtra }
pub struct PlatformCourseDetail {
    pub platform: Platform, pub course_id: String, pub title: String,
    pub chapters: Vec<PlatformChapter>,
}
pub struct PlatformChapter { pub id: String, pub name: String, pub lessons: Vec<PlatformLesson> }
pub struct PlatformLesson { pub id: String, pub name: String, pub tasks: Vec<PlatformTaskPoint> }
pub struct PlatformTaskPoint {
    pub id: String, pub name: String,
    pub kind: TaskKind,            // Video | Quiz | Document | Reading | Unknown
    pub status: TaskStatus,        // Unknown | NotStarted | InProgress{done,total} | Completed | Failed
    pub progress: Option<Progress>,// 平台原始字段映射
    pub platform_ref: PlatformRef, // 回写协议所需的平台 id（unitId/videoId/sectionId/jobid…）
}
```

- `PlatformRef` 用 enum 保存各平台回写所需标识（HUST mArg/jobid、ZHS secret、UL itemid/pageid、icourse unitId/lessonId/videoId/termId），避免把四套字段塞进一个扁平结构。
- 各平台模块提供 `to_platform_detail()` 适配函数（纯函数，可 fixture 测试），UI/website 只消费统一 DTO；平台特有操作（如知到见面课、优学院章节练习、icourse163 测验 DOM）通过 `PlatformAction` 列表挂载，而不是在通用课程页里 `if platform == ...` 散落。
- 已完成度语义要统一成 `TaskStatus`：知到 `isStudied`（0/1）、HUST `completed`/`playing_time`、优学院 `completion_status`、icourse163 `completePercent`（`>=1.0`）——建议在 core 里做一次归一化并加单测。

### 7.3 core 边界与命名冲突

- **不要**用一个 async trait 对象统一所有平台（Rust async trait + 不同 cookie/签名实现会复杂化）；用「每平台一个 Client + 统一 DTO 适配 + enum dispatch」即可，符合 AGENTS「网络留在 core、命令保持薄」。
- icourse163 的 `models::Chapter`/`Lesson` 与 `crate::models::Chapter` 同名：模块内没问题，`lib.rs` re-export 时必须别名（如 `pub use icourse163::models as icourse_models;`），否则 `pub use` 冲突。
- 会话/凭据：所有平台都遵守「Cookie 不进 IPC、日志不打印 token/签名/`secretStr`/`AUTHORIZATION`/`csrfKey`/`Auth-Signature`」。

### 7.4 CLI 命名建议

保持现有前缀命令风格（HUST 根命令 + `zhs` 子命令，`main.rs:42-129`）：

```
hust-course-hack --cookies c.txt list|dump|tree|helper|watch|doc   # HUST（遗留，不动）
hust-course-hack --cookies zhs-cookies.txt zhs list|tree|watch|check|meet ...
hust-course-hack --cookies ul-cookies.txt  ulearn list|tree|watch|check        # U学（task-13）
hust-course-hack --cookies ic-cookies.txt  icourse list|tree|watch|check [--term T]  # 若做 icourse163
```

- 三平台共享同一组 flag 语义：`--dry-run`、`--yes`、`--max-*`、`--include-completed`、`--delay-ms`、进度输出到 stderr/中文汇总；把 `WatchArgs` 这类结构抽到 `main.rs` 顶部复用（知到已有 `VideoWatchArgs`，`main.rs` `:199` 附近）。
- 退出码：0 成功、1 部分失败/失败；不因「部分跳过」返回 1。

### 7.5 GUI / website 路由与组件

- connect 页：平台选择扩展为 `hust | zhihuishu | ulearning | (icourse163)`；`activePlatform()`（`ui/src/main.ts:109`）与 `store.platform`（`:76`）已是现成入口，website 用 `?platform=zhs`（`website/src/main.ts:43`）扩展 `?platform=ul|icourse`。
- 课程页：抽「通用外壳（侧栏 + 课程头 + 章节目录 + 任务点表格 + 刷新/取消）+ 平台操作区（按钮/弹窗）」；现有 `ui/src/views/course.ts`（HUST）、`views/zhs-course.ts`、`views/document.ts` 先做样式/结构抽取，再给优学院/icourse163 复用，避免三套复制。
- job 事件：`JobProgress`（`src-tauri/src/events.rs`）继续按平台加变体（zhs 的 `Video/Meet`、documents 的 `DocumentPlan/Document`、将来的 `Ul*`/`Icourse*`），前端按 `platform` 过滤（`ui/src/main.ts:109-135` 已有平台判断）。
- website：沿用「静态站 + 桥接用户脚本」模式：`zhs-bridge.user.js`/`zhihuishu-bridge.user.ts` + `core/zhs/transport.ts` 的白名单/`nonce`/origin 校验（`website/src/core/zhs/transport.ts:1-70`）。为优学院新增 `ulearning-bridge`（`ua.ulearning.cn`/`courseweb.ulearning.cn` 白名单）、为 icourse163 新增 `icourse163-bridge`（`www.icourse163.org` 白名单 + 在页面内算 MD5 签名）。三套桥共享 postMessage 信封但各自白名单，不能用一个通用 proxy。

### 7.6 三平台不变量（写进 AGENTS）

1. dry-run 默认，真实提交需显式确认（`--yes` / 勾选）；2. Cookie/Token 不跨 IPC、不落日志；3. 每平台限速 + 失败即停（zhs 2–6s/知到熔断；UL 3–5s、`sync` 返回 `2` 立即中止；icourse163 每节 1–2s）；4. 不可自动提交考试（icourse163 1 次机会、知到见面课/考试同理按现有约定）；5. 测验类操作「开卷即计时」的平台（icourse163）必须先 dry-run 展示匹配结果并要求二次确认；6. 所有协议常量集中在各平台 `mod.rs`，测试用 mock，不访问真实会话。

---

## 8. 风险清单（按严重度）

| # | 风险 | 证据 | 缓解 |
| --- | --- | --- | --- |
| R1 | **把 icourse163 当成「U学」合并**：两者平台不同；icourse163 已被用户要求回滚，代码已删除 | §1.2；`tests/icourse_http.rs:1-2`（S1，回滚注释）；S2 文件已删 | 合并前确认目标：U学=优学院走 task-11…15；要中国大学 MOOC 就单开 feature，用 §6.3 施工图 |
| R2 | **主目录 `.tmp-icourse/cookies.json` 等真实会话材料留在磁盘** | `cookies.json` 3570 B（mtime 23:36），`.tmp-icourse/` 约 120 个抓包文件；`.gitignore:13` 已忽略 `/.tmp-icourse/` | 不 `git add -f`、不打包分享；任务结束后建议本机删除；任何 commit 前 `git status --ignored` 复核 |
| R3 | **git merge 带不动主目录未提交代码**：0.3.0 documents 曾未提交，icourse163 删除前也从未提交 | `git status`：`?? src/documents.rs` 等；`git reflog` 无 icourse163 commit；worktree 的 0.3.0 改动来自主目录 tracked diff（`.agents/snapshot-v0.3.0/tracked.patch` 快照），属手动搬运 | 新功能先提交到 feature 分支再合并；迁移用 `git diff`/`git apply --3way`，不要依赖 `git merge` 脏工作树 |
| R4 | **热点文件多线并行**：`src/main.rs`、`src-tauri/**`、`ui/**`、`website/**` 被知到/文档/优学院/（将来）icourse163 同时改 | §6.4 交集 19 文件；worktree 已出现 `UU` 冲突（AGENTS、main.rs、ui/mock、website/main 等） | 串行写热点文件；每步 `cargo test`/`npm test`；平台实现先写独立新文件 |
| R5 | **icourse163 测验 DOM 自动化风险**：一开卷即建草稿 + 30 分钟倒计时，超时自动 0 分并消耗 1 次机会 | `docs/icourse163/recon-feasibility.md:184, 211-215` | 只做 dry-run + 答案匹配展示 + 人工确认；绝不批量开卷；不在考试上自动提交（1 次机会，`:217-220, 250`） |
| R6 | **视频秒刷风控不确定**：服务端当前不校验时长，可能加风控 | `recon:248`；`video.rs:31-33`（限速 1.2s） | 保留限速/失败即停/复核；页面上有异常立即停 |
| R7 | **SPOC 源学期定位未实测**：`window.courseDto/termDto/moocCourseCardDto` 解析只在静态分析里出现 | S1 `course.rs:11-13`；`recon:23-25, 151-156` | 保留 `--term` 手动覆盖；登录态回归一次再依赖自动解析 |
| R8 | **文档功能与 icourse163 混淆**：两者端点不同，误接会报错且可能写错任务点 | §5.3；`recon:18` | 按平台分模块；README/AGENTS 明确 documents=超星 |
| R9 | **`documents.rs` 的 Office/WPS 附件**：`wxcard` 可能不返回 `jtoken` | AGENTS 0.3.0 段落、README「doc」章节 | 已实现为报错跳过；继续按文档提示先单条 `--job` 验证 |

---

## 9. 给 Lead 的合并结论

1. **U学 = 优学院（ulearning.cn）**，不是 icourse163；本轮 U学 工作应继续 task-11…15（core/CLI/GUI/website/userscript），不需要 icourse163。
2. **icourse163 没有可合并的东西**：S1 只有未接线的 core + 禁用测试，S2 已按用户要求删除；git 无记录。若用户仍要中国大学 MOOC，按 §6.3 重建，并排到优学院之后，避免热点文件冲突（§6.4）。
3. **documents（0.3.0）与两者都无关**，但已完整接入并正在并入 worktree；合并时把它当独立 feature 验证（`cargo test --workspace` 含 `tests/documents_http.rs`，website `npm test` 含 `documents.test.ts`）。
4. **最高风险**：R1（平台混淆/误合并）+ R2（`.tmp-icourse/cookies.json` 真实会话材料落盘）+ R4（热点文件并行写冲突）。

---

## 附录 A：取证快照与方法

| 项 | 说明 |
| --- | --- |
| 快照时间 | 2026-11-08 00:13–00:21（Asia/Shanghai），主目录文件在同一时段被另一会话回滚，已标注 S1/S2 |
| 主目录只读 | 未创建/修改/删除主目录任何文件；`git status` 前后一致（除对方会话自身变化） |
| 只读命令 | `git status/diff/log/show/reflog/fsck`、`Select-String`、`Get-Content`、`Get-ChildItem` |
| worktree | 只写 `docs/analysis/`；未改源码、未 commit |
| 未执行 | 未运行 `cargo test`/`npm test`（worktree 合并进行中、主目录只读），构建验证由 Lead 统一做 |

### 附录 B：icourse163 回滚时间线

| 时间 | 事件 |
| --- | --- |
| 2026-11-07 23:30–00:10 | 登录实测 + 侦察，产出 `docs/icourse163/recon-feasibility.md`（23:57，16147 B） |
| 11-07 23:33–11-08 00:14 | `.tmp-icourse/` 抓包与 CDP 脚本（含 `cookies.json` 3570 B） |
| 11-08 00:02–00:06 | `src/icourse163/**` 实现写入 |
| 11-08 00:04 | `test-data/icourse-term.json` 写入 |
| 11-08 00:10–00:11 | `src/lib.rs`/`src/main.rs` 去 icourse163 接线；`tests/icourse_http.rs` 禁用并注明「已按用户要求回滚」 |
| 11-08 00:13–00:20 | `src/icourse163/`、`tests/icourse_http.rs`、`test-data/icourse-term.json` 删除；`docs/icourse163/recon-feasibility.md` 与 `.tmp-icourse/` 保留 |
| 结果 | 无 git 记录可恢复；唯一复用物是 recon 文档 |
