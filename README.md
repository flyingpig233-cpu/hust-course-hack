# 华科课程助手（SmartCourse / 知到 / 优学院）

Rust 核心库 + CLI + Tauri 2 桌面 GUI，用于读取 `https://smartcourse.hust.edu.cn`（学在华科大）、
知到（智慧树）与优学院（U学，`*.ulearning.cn`）上当前账号的课程数据：

- 课程列表、章节目录树、任务点、视频/文档/测验数据（学在华科大）；
- 知到（智慧树）共享课视频与见面课回放考勤；
- 优学院（U学）课程目录、视频/图文与章节练习。
- 章节目录树（章 / 节 / 知识点，含完成状态）
- 每个知识点下的卡片和任务点
- 视频任务点：文件名、大小、时长、完成状态、观看进度、截图、签名播放/下载地址
- 文档任务点：文件名、大小、类型、objectId、jobId；可通过 `doc` / 桌面端“完成文档”直接上报完成
- 章节测验/练习题：题目、题型、选项、我的答案、正确答案、得分（已批改的作业才有答案）
- 作业页面状态：`graded`（查看已批改）或 `in_progress`（做题页）

网络层与解析层完全独立于 Tauri/UI，桌面壳通过 Tauri command 直接调用
`SmartCourseClient`。

> 0.3.0 新增：CLI、桌面 GUI 和网页版都可直接完成 PDF 文档任务点
> （`/mooc-ans/phone/wxcard` 取 `jtoken` → `/mooc-ans/job/document`）。协议按 Chaoxing
> 官方客户端移植，并已在 2026-11-07 用真实账号实测（49/49 个文档返回 `status: true`）；
> 首次使用仍建议先试运行并只跑一个文档。
>
> 0.3.0 同时新增优学院（U学）平台，并把三平台（学在华科大 / 知到 / 优学院）统一到
> CLI、桌面 GUI、网站版和浏览器助手四个入口；协议调研与分析报告见
> `docs/ulearning/`、`docs/analysis/`。

## 自部署网页版（server/）

此自部署后端目前仅支持学在华科大的课程抓取、视频和测验；文档任务、知到及优学院请使用桌面版或 `website/` 独立网站版。

`server/` 是一个 axum Web 服务（`hust-course-web`），把同一个 `SmartCourseClient` 包成
HTTP API，让课程助手从浏览器直接使用——不需要桌面应用，也不需要油猴脚本：

- 登录：与桌面版一致的统一身份认证。浏览器新窗口打开 `/login/`，服务器中转
  `smartcourse.hust.edu.cn/passport` 及其跳转的 `pass.hust.edu.cn` CAS 官方页面（所有
  URL 改写回代理，只允许 `*.hust.edu.cn`，账号密码由官方页面的脚本加密并只提交给学校
  服务器）。CAS 回调落到 smartcourse 页面时，服务器从本次登录的独立 Cookie jar 中取出
  会话 Cookie，用课程列表接口验证后建立服务端会话（与桌面登录窗口 `login.rs` 同一套
  判定），返回“登录成功”页并自动关窗；前端轮询 `GET /api/login/status` 接管会话。会话
  只保存在内存中，服务重启后需重新登录。
- 任务：抓取课程、视频上报、测验提交都是后台任务（同一时间一个），前端轮询
  `GET /api/jobs/current?cursor=N` 重放与 GUI 相同的进度事件，取消用
  `POST /api/jobs/cancel`。
- 访问控制：设置 `COURSEHACK_TOKEN`（或 `--token`）后，除 `GET /api/config` 外的所有
  API 都要带 `X-Access-Token`（登录入口 `/login/` 用 `?t=` 校验，中转请求用登录 Cookie
  关联）；对外只暴露 nginx 的一个路径前缀，服务本身只监听 127.0.0.1。
- 前端：`ui/` 同一套代码，`npm run build:web` 以 `VITE_BACKEND=web` 模式构建出
  `ui/dist-web`（base 为 `/course-hack/`），由 nginx 反代 `/course-hack/` 到本服务。

```powershell
cargo run -p hust-course-web -- --listen 127.0.0.1:8787 --web-dir ui/dist-web --token YOUR_TOKEN
# --url-prefix 默认 /course-hack（nginx 反代时剥离的前缀）；根路径部署时传空字符串
```

服务器端部署（Ubuntu + nginx）：在宿主机用 rsproxy.cn 的 Rust 工具链
`cargo build --release -p hust-course-web`，部署目录为 `/root/workspace/website/`
（二进制与 `ui/dist-web` 在 `course-hack/` 下，与个人静态站点 `site/` 并列），用
systemd（`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome=read-only`、专用用户）
常驻，nginx 的站点 root 指向 `site/` 并增加一个
`location /course-hack/ { proxy_pass http://127.0.0.1:8787/; }`。服务用户要能读
`/root` 下的路径（`/root` 需 711，资源目录 `a+rX`）。

已知限制：CAS 页面的企业微信扫码登录依赖相对地址的轮询接口，经中转后不可用；
请使用页面上的“密码登录”。

## 桌面 GUI（Tauri 2）

### 下载安装

从 [GitHub Releases](https://github.com/flyingpig233-cpu/hust-course-hack/releases/latest)
下载 Windows x64 安装包：一般用户选择 `x64-setup.exe`，需要 MSI 的环境选择 `.msi`。
两种安装包任选其一。安装后打开应用，使用内嵌的学校统一身份认证窗口登录。
安装包未做代码签名；Windows 可能显示“未知发布者”。

`src-tauri/` 是 Tauri 2 外壳，`ui/` 是原生 TypeScript + Vite 前端。网络与解析仍然全部在
`SmartCourseClient` 里，command 层只负责会话状态、进度事件和文件读写。

环境：Rust 1.85+、Node.js 20+、WebView2 Runtime（Windows 10/11 通常已安装）。

```powershell
npm install
npm run tauri dev      # 开发：Vite + 桌面窗口
npm run tauri build    # 生产：构建安装包
```

### 发版（GitHub Actions）

- `.github/workflows/ci.yml`：推到 `main` / 提 PR 时跑 `cargo fmt --check`、
  `cargo clippy`、`cargo test`（核心库 + server）、前端 `ui/dist` 与网页版构建、
  网站测试，以及 Windows 上 GUI crate 的 clippy。
- `.github/workflows/release.yml`：打 `v*` tag 时在 `windows-latest` 上构建
  NSIS + MSI 安装包和 CLI，自动创建 GitHub Release 并上传资产。

```powershell
# 1. 同时改四处版本号（不一致时 release workflow 会在构建前失败）：
#    Cargo.toml / src-tauri/Cargo.toml / src-tauri/tauri.conf.json / package.json
# 2. 提交并打 tag，推送即触发构建
git commit -am "release: v0.3.1"
git tag v0.3.1
git push origin main --tags
```

也可以在 Actions 页面手动触发 `Release`：tag 留空则用 `v<当前版本>`，勾选
“只创建草稿 Release”只建草稿不对外发布。Release 资产包含
`HUST-Course-Hack_<版本>_x64-setup.exe`（NSIS）、同版本 `.msi`、
`hust-course-hack_<版本>_cli_windows_x64.zip` 和 `SHA256SUMS.txt`。
构建产物同时作为 workflow artifact 保留 7 天，发布失败也能从那次 run 里下载。

界面能力（连接页可选择三个平台：学在华科大 / 知到（智慧树）/ 优学院（U学），各自独立登录窗口与
课程页；所有写操作默认试运行，真实执行需勾选风险确认）：

| 页面 | 功能 |
| --- | --- |
| 连接 | 打开内嵌登录窗口，使用学校统一身份认证登录；成功后自动读取会话并关闭窗口 |
| 课程首页 | 搜索 / 刷新课程，卡片式入口 |
| 课程详情 | 目录树（章 / 节 / 知识点 / 卡片 / 任务点）、任务点表格与筛选、测验题目与答案、诊断信息 |
| 测验任务 | 右上角“完成题目”或测验页“提交本题”：内置题库匹配答案，已批改作业跳过，题库缺答案的作业不提交；默认试运行，确认后才发送真实提交 |
| 视频任务 | 整门课或单视频上报；试运行只生成签名 URL；可设置心跳间隔、延迟、数量上限并随时停止 |
| 文档任务 | 顶部“完成文档”或文档行“完成”：按卡片取 `jtoken` 后调用 `/mooc-ans/job/document`；默认试运行，逐条显示服务端结果 |
| 平台切换 | 连接页选择学在华科大 / 知到 / 优学院；知到含见面课页，优学院含章/节/页课程树与视频/章节练习秒刷 |
| 工具 | 导出课程 JSON、在浏览器打开课程页、查看并保存 Tampermonkey 课程助手脚本（视频 / 文档，浏览器兜底） |

登录流程：点击“打开 HUST 登录窗口”后，应用打开
`https://smartcourse.hust.edu.cn/passport`（跳转到 `pass.hust.edu.cn` 统一身份认证）。
登录成功并回到 smartcourse 后，应用从 WebView 读取包含 HttpOnly 的会话 Cookie，调用课程列表接口
验证通过才建立会话，然后自动关闭登录窗口。GUI **不需要 cookies.txt**，也不接收粘贴的 Cookie。

登录窗口使用独立的临时 WebView2 数据目录：会话读取后、窗口关闭时删除该目录，不在应用数据目录
留下平台登录态。会话只保存在内存中，通过 IPC 只暴露来源和 Cookie 数量，不暴露 Cookie 值。

抓取与上报是长任务：进度通过 `job-progress` 事件推到前端，同一时间只允许一个任务，抓取过程中
可以取消。抓取选项（题目 / 视频详情 / 并发数）在课程页右上角“抓取设置”，修改后点刷新生效。

“一键完成题目”使用编译进应用的 `test-data/answer-bank.json`（当前 541 题），不需要选择文件。
弹窗默认处于“试运行”，只刷新课程并生成匹配计划；取消勾选试运行、再勾选“我确认提交未批改作业”
后才会发送真实提交请求。已批改作业自动跳过，题目没抓全或题库缺少答案的作业只会在日志里标记为
跳过，不会部分提交。成功后作业在界面上临时显示“已提交”，最终结果仍以平台批改为准。

“完成文档”同样默认试运行：只刷新课程并列出待完成的 PDF 任务点，不发请求；取消试运行后才逐个
调用 `/mooc-ans/phone/wxcard` 取 `jtoken` 并上报 `/mooc-ans/job/document`，只有服务端
`status: true` 才在界面上标记完成。文档完成状态在课程树里通常是“未知”，以弹窗日志和平台任务点
页面为准。浏览器脚本仍保留作为 viewer 路径兜底。

`npm run dev` 后直接在普通浏览器打开 `http://localhost:1420` 会进入**演示模式**
（`ui/src/mock.ts` 内置示例课程，不访问平台），方便调整界面；在 Tauri 窗口中运行时自动使用
真实后端。

## 快速开始（CLI）

CLI 仍然使用导出的 Cookie 文件；桌面 GUI 请使用上一节的登录窗口。

需要一个已登录浏览器的 Netscape 格式 `cookies.txt`（浏览器插件或 `curl -c` 导出）。

```powershell
cargo run -- --cookies "D:\cookies.txt" list
cargo run -- --cookies "D:\cookies.txt" list --json

# 抓取单门课程，包含题目和视频签名地址
cargo run -- --cookies "D:\cookies.txt" dump --course 17310000026063 --out courses.json

# 抓取全部课程（当前 sectionId=0，即页面上“全部”）
cargo run -- --cookies "D:\cookies.txt" dump --out courses.json

# 只打印目录和任务点，不抓题目/视频地址
cargo run -- --cookies "D:\cookies.txt" --no-questions --no-video-info tree --course 17310000026063

# 只看文档完成计划，不发请求
cargo run -- --cookies "D:\cookies.txt" doc --course 17310000026063 --dry-run

# 完成整门课的文档（PDF）任务点
cargo run -- --cookies "D:\cookies.txt" doc --course 17310000026063
```

常用参数（全局参数，放在子命令前后都可以）：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--cookies` | `cookies.txt` | Netscape cookies 文件 |
| `--concurrency` | `4` | 同时抓取的知识点数量 |
| `--no-questions` | 关闭 | 跳过章节测验题目 |
| `--no-video-info` | 关闭 | 跳过 `/ananas/status` 视频详情 |

`dump` 输出结构：

```json
{
  "generated_at_unix": 1792654600,
  "courses": [
    {
      "course_id": "17310000026063",
      "class_id": "17310000023403",
      "cpi": "17310000196268",
      "name": "大学英语词汇解析(一)",
      "title": "大学英语词汇解析(一)",
      "cover_url": "...",
      "detail_url": "...",
      "enc": "...",
      "old_enc": "...",
      "openc": "...",
      "final_url": "...",
      "chapters": [
        {
          "id": "582259",
          "title": "Unit 1",
          "number": "1",
          "level": 1,
          "is_leaf": false,
          "children": [
            {
              "id": "582263",
              "title": "Introduction: 课程导入 ——词汇学习策略（1）",
              "number": "1.1",
              "level": 2,
              "is_leaf": true,
              "completed": true,
              "cards": [
                {
                  "index": 1,
                  "card_id": "417613",
                  "title": "学习材料",
                  "task_points": [
                    {
                      "kind": "video",
                      "name": "0.01 ....mp4",
                      "object_id": "...",
                      "job_id": "...",
                      "size_bytes": 244039903,
                      "duration_secs": 821,
                      "completed": true,
                      "played_ms": 820000,
                      "video": {
                        "duration_secs": 821,
                        "download_url": "...",
                        "stream_url": "...",
                        "hd_stream_url": "...",
                        "screenshot": "..."
                      }
                    }
                  ]
                }
              ]
            }
          ]
        }
      ],
      "stats": {
        "chapter_nodes": 57,
        "leaves": 53,
        "cards": 99,
        "task_points": 148,
        "videos": 49,
        "documents": 49,
        "works": 50,
        "questions": 230,
        "errors": []
      }
    }
  ],
  "errors": []
}
```

`kind` 的取值：`video`、`document`、`work`、`audio`、`live`、`other`。
新的/未知任务点不会丢失，原始 attachment JSON 保存在 `raw` 字段里。
卡片还会带 `playback`（`mArg.defaults` 的摘要），视频任务点会带 `dtoken`。

## 浏览器助手脚本（视频 / 文档）

视频优先使用下面的 `watch` 直连上报；本脚本保留作为浏览器兜底，也适合手动逐个知识点处理。
脚本走的是已经在真实账号上验证过的播放器路径：覆盖 `reportProgress`、seek 到结尾、
触发 `ended`，最后调用平台的 `ed_complete`。

文档（PDF）在 CLI、桌面端和网站版里走直接上报；浏览器脚本仍保留 viewer 路径作为兜底：
脚本找到课程页里的 `iframe.insertdoc-online-pdf`，调用 viewer 暴露的 `finishJob()`，由平台发
`/mooc-ans/job/document` 并在成功后加 `ans-job-finished`。

```powershell
cargo run -- helper --out video-helper.user.js
```

在 Tampermonkey 中新建脚本，粘贴生成的文件内容（`helper` 不需要 cookies）。进入课程
学习页（`studentstudy`）后，右上角会出现面板（文件名保留 `video-helper` 以兼容旧链接）：

| 按钮 | 行为 |
| --- | --- |
| 完成当前视频 | 只处理当前播放器 |
| 完成本页视频 | 遍历当前知识点的所有卡片标签 |
| 完成整门课 | 按章节目录顺序遍历未完成的知识点，逐个处理视频；页面跳转后从 `sessionStorage` 继续 |
| 浏览当前文档 | 滚动到当前 PDF 并高亮；继续使用平台 viewer 的全屏/翻页 |
| 完成当前文档 | 调用当前 PDF viewer 的 `finishJob()`，以 `ans-job-finished` 出现为准 |
| 完成本页文档 | 遍历当前知识点的卡片标签，逐个完成其中的 PDF |
| 停止 | 中止当前任务 |

脚本只在当前浏览器会话内运行，不读取也不保存 cookies。处理完成后建议重新抓一次课程树
（`tree` 或 `dump`）确认对应任务点变成已完成；前端状态变化不等同于服务端已计入进度
（文档的 `ans-job-finished` 由 `finishJob` 的成功回调添加，是平台侧的完成信号）。

文档限制：只支持平台内联的 PDF；Office/WPS 文档走另一套跨域 viewer；归档或没有 job 的
文档平台可能不响应；一屏内即可放下的 PDF 在打开时平台自己就会完成。文档按钮先覆盖当前
知识点，整门课文档遍历暂未包含。如果完成后再抓取课程树仍显示未知状态，可能是平台的
`mArg` 不返回文档完成字段，不要据此判断完成失败。

**验证状态**：2026-10-30 在真实课程学习页实测：`iframe.insertdoc-online-pdf` 的
`finishJob()` 可调用；调用后 `/mooc-ans/job/document` 返回 200，任务点出现
`ans-job-finished`。

## 直接上报完成视频（watch）

`watch` 不打开浏览器，直接复现播放器的进度上报请求。2026-10-22 的 HAR 已验证：
`playingTime` 从 0 跳到 646（总时长 647）时服务端返回 `isPassed:true`，签名可以逐字节复现。

```powershell
# 只看计划，不发请求
cargo run -- --cookies "D:\cookies.txt" watch --course 17310000026063 --dry-run

# 完成整门课的视频
cargo run -- --cookies "D:\cookies.txt" watch --course 17310000026063

# 只处理一个任务点（job id 来自 tree/dump 里的 job_id）
cargo run -- --cookies "D:\cookies.txt" watch --course 17310000026063 --job YOUR_JOB_ID
```

第一次运行建议先 `--dry-run` 检查 URL，再用 `--job <jobid>` 只跑一个视频，确认服务端返回
`isPassed=true` 后再跑整门课。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--course` | 必填 | 课程 id、班级 id 或课程名 |
| `--job` | 无 | 只处理指定 job id |
| `--include-completed` | 关闭 | 连已完成的任务点也重新上报 |
| `--step` | `0` | `0` 表示直接跳到结尾；大于 0 时每 N 秒发一次中间心跳 |
| `--delay-ms` | `0` | 心跳之间的等待毫秒数 |
| `--dry-run` | 关闭 | 只打印 start/end 上报 URL |
| `--max-videos` | 无 | 最多处理多少个视频 |

`watch` 必须抓取视频信息（`dtoken`），因此全局 `--no-video-info` 对它无效。`--dry-run`
会打印带 `dtoken`/`enc` 的 URL，注意不要公开分享。

上报流程：

1. `knowledge/cards` 拿到每张卡片的 `mArg.defaults`（`userid`、`clazzId`、`courseid`、`reportUrl`）；
2. 附件里的 `otherInfo`、`attDurationEnc`、`attDuration` 原样回传；如果 `otherInfo` 尾部带有
   `&courseId=...`（可能是 `%26courseId%3D...` 形式），先解码，只保留签名部分，`courseId`
   用单独参数传递；
3. `/ananas/status/{objectId}` 拿到 `dtoken`；
4. 依次发送 `isdrag=4`（开始）、`isdrag=3`（播放）、`isdrag=4`（结束）、`isdrag=2`（确认），以响应里的 `isPassed` 为准。

签名：

```text
md5("[clazzId][userid][jobid][objectId][playingTime*1000][d_yHJ!$pdA~5][duration*1000][clipTime]")
```

`--step`/`--delay-ms` 用于平台加强节奏校验时放慢请求；默认快速模式与验证时的播放器行为一致。

## 直接完成文档（doc）

`doc` 不打开浏览器，直接走平台的文档任务点协议：

1. `GET /mooc-ans/phone/wxcard?cardid&courseid&knowledgeid&clazzid&cpi&ut=s&isMicroCourse=false`
   返回卡片 HTML，其中的 `window.AttachmentSetting` JSON 为每个附件提供 `jtoken`；
2. `GET /mooc-ans/job/document?jobid&knowledgeid&courseid&clazzid&jtoken&checkMicroTopic=true&microTopicId=undefined&courseEngineInfo=false`
   只有响应 `status: true` 才视为服务端已计入完成。

这条请求与平台 PDF viewer 的 `finishJob()` 相同。协议来自 Chaoxing 官方客户端 7.0.2
（`flutter_chaoxing` 0.4.2 的 `fetchDocumentJobs` / `reportDocumentRead`）；Rust 实现在
`src/documents.rs`，桌面端和网站版复用同一套字段与判定。

```powershell
# 只看计划，不发请求
cargo run -- --cookies "D:\cookies.txt" doc --course 17310000026063 --dry-run

# 完成整门课文档
cargo run -- --cookies "D:\cookies.txt" doc --course 17310000026063

# 只处理一个任务点（job id 来自 tree/dump 里的 job_id）
cargo run -- --cookies "D:\cookies.txt" doc --course 17310000026063 --job YOUR_JOB_ID
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--course` | 必填 | 课程 id、班级 id 或课程名 |
| `--job` | 无 | 只处理指定 job id |
| `--include-completed` | 关闭 | 连平台已标记完成的文档也重新上报 |
| `--dry-run` | 关闭 | 只打印待完成文档，不发请求 |
| `--max-documents` | 无 | 最多处理多少个文档 |

第一次运行建议先 `--dry-run`，再用 `--job <jobid>` 只确认一个文档，最后跑整门课。文档的
完成状态在课程树里通常是 `null`（平台 `mArg` 不返回），不要据此判断失败；以 `doc` 输出和平台
任务点页面的状态为准。Office/WPS 附件可能不走 `/mooc-ans/job/document`；如果 `wxcard` 没有返回
对应 `jtoken`，该文档会报错并跳过。

**验证状态**：2026-11-07 已用真实账号在 HUST 上验证：`/mooc-ans/phone/wxcard` 返回
`window.AttachmentSetting` 与 `jtoken`，`/mooc-ans/job/document` 对
《大学英语词汇解析(一)》全部 **49/49** 个文档返回 `status: true`；`doc` 命令实际完成整门课，
无失败。`tests/documents_http.rs` 另外覆盖了协议参数和拒绝分支。桌面 GUI 复用同一个核心方法；
网页版走同一协议但经桥接窗口，尚未单独在真实浏览器里跑过整门课。仍建议第一次先 `--job`
单个确认；Office/WPS 文档若没有对应 `jtoken` 会报错跳过。

## 一键完成题目（核心库接口）

`src/answers.rs` 加载 `test-data/answer-bank.json`（GUI 使用编译进应用的副本），
`src/submit.rs` 把答案编码成平台的作答表单。GUI 已接入；CLI 还没有对应子命令。核心库 API：

```rust
use hust_course_hack::{AnswerBank, FetchOptions, SmartCourseClient};

let bank = AnswerBank::load("test-data/answer-bank.json")?;
let detail = client.fetch_course(&course, &FetchOptions::default()).await?;

let outcomes = client
    .complete_course_quizzes(&detail, &bank, &|progress| {
        println!("{}/{} {}", progress.done_works, progress.total_works, progress.work_name);
        true // 返回 false 会停止后续提交
    })
    .await;

for outcome in outcomes {
    println!(
        "{}: {} ({})",
        outcome.work_name,
        if outcome.success { "ok" } else { "failed" },
        outcome.message
    );
}
```

行为：

- 先按 `question_id` 查答案，找不到时用规范化题干查 `stem_index` 兜底；
- 已批改的作业跳过；题目没抓全或题库缺答案的作业**不会提交**，而是留在 plan 里并带上
  `missing_question_ids` / `errors`，方便前端提示；
- 提交前重新拉取作答页，直接复用 `form#form1` 的 action（其中已经带有该作业专属的
  `token`、加密 `totalQuestionNum`、`workid`、`originJobId`、`testmooc2` 等参数），再追加
  页面 JS 的 `ua=pc&formType=post&saveStatus=1&pos=&version=1`；这些令牌不缓存；
- 表单会带回页面上的 `answerId`、`enc`、`cpi`、`randomOptions`、`isAccessibleCustomFid`
  等隐藏字段，并按页面渲染的题目数量拒绝部分提交；
- 单选 / 多选 / 判断 / 填空 / 简答分别编码；判断题统一为 `true` / `false`，多选按字母排序
  （与页面 `sortMultiAnswer()` 一致），`answerwqbid` 末尾带逗号；
- 填空题同时发送 `tiankongsize{id}`、`answer{id}{n}` 和页面实际使用的
  `answerEditor{id}{n}`；简答题同时发送 `answer{id}` 和 `answerEditor{id}`；
- 最终提交前调用 `/mooc-ans/work/validate`（真实页面也是先调用它）：`status=1` 视为账号异常，
  `status=2` 视为需要验证码并直接报错，不会继续提交；
- 单作业接口：`prepare_work_submission`（只看请求）、`submit_work_answers`、
  `submit_work_from_bank`；整门课接口：`complete_course_quizzes`，或先 `plan_course`
  再 `submit_course_plan` 以拿到完整的缺失/错误诊断。

**验证状态**：2026-10-22 已用真实账号完成端到端验证。作答页的 `form#form1` action、隐藏字段、
判断题 `true/false`、填空题 `tiankongsize` + `answerEditor`、`answerwqbid` 尾逗号，以及
`/work/validate` 返回 `status=3` 都已确认真实页面一致；随后实际提交了一份 6 道判断题的
`2.1 练习题`，服务端返回 `success=true`，重新抓取课程后该作业已变成“已批改”。

整门课提交仍建议先用弹窗的“试运行”查看匹配情况，再把“最多处理作业数”设为 1 提交一份，
确认平台结果后再批量跑。填空题/多选题的编码已按真实页面结构生成，但这次实测的是判断题作业；
第一次处理含填空/多选的课程时，建议同样先单份确认。

题库的 `low` / `medium` 置信度题目（尤其是填空题）建议提交前人工复核，具体题号见
`test-data/README.md` 的 `review` 部分。

## 知到（智慧树）视频与见面课秒刷

除学在华科大之外，本仓库也支持知到（智慧树）共享课：

- 课程/章节/视频树：只读抓取，含视频时长与完成状态；
- **视频课秒刷**：把未完成视频直接标记为已完成（`watchState=1`）；
- **见面课回放考勤秒刷**：按"随机 90%–100% 覆盖率 + 每次 2–6 秒随机间隔 + 每 10 条检查异常接口"逐分钟上报，达到页面要求的观看比例；
- 不支持：随堂测验、考试、直播实时参与、翻转课/融合课/智能课（polymas）。

### CLI

```powershell
$zhs = "D:\zhs-cookies.txt"

# 课程列表（实测接口；失败时可用学习页 URL / recruitAndCourseId 兜底）
cargo run -- --cookies $zhs zhs list
cargo run -- --cookies $zhs zhs tree --course "<学习页 URL 或 recruitAndCourseId>"

# 视频课：先 dry-run 看计划，再真实上报
cargo run -- --cookies $zhs zhs watch --course "..." --dry-run
cargo run -- --cookies $zhs zhs watch --course "..."

# 见面课
cargo run -- --cookies $zhs zhs meet list --course "..."
cargo run -- --cookies $zhs zhs meet status --course "..." --meeting <meetCourseId>
cargo run -- --cookies $zhs zhs meet watch --course "..." --meeting <meetCourseId> --dry-run
cargo run -- --cookies $zhs zhs meet watch --course "..." --all --coverage 0.90-1.00 --delay-ms 2000-6000

# 视频课/见面课异常状态
cargo run -- --cookies $zhs zhs check --course "..."
```

常用参数：`--dry-run` 只打印计划；`--yes` 跳过交互确认；`--max-videos`；`--include-completed`；见面课另有 `--coverage`、`--delay-ms`、`--check-every`、`--no-circuit-breaker`。

### 桌面 GUI

连接页选择"知到"平台，内嵌登录窗口打开 `https://onlineweb.zhihuishu.com/onlinestuh5`，登录成功后读取 Cookie（含 HttpOnly）并校验会话。课程页可"秒刷本课视频"，见面课页可查看回放进度并"秒刷回放考勤"；默认 dry-run，真实执行需勾选风险确认，进度通过 `job-progress` 事件推送、可取消。

### 浏览器助手脚本

`userscripts/zhihuishu-miaoshua.user.js` 安装到 Tampermonkey 后，在知到学习页/回放页右下角出现面板，可一键秒刷本课视频或当前回放考勤，并可调整覆盖率与间隔。脚本优先复用页面自带的加密函数，缺失时使用内置 WebCrypto 实现。

### 网站版

`website/` 增加知到平台（课程/视频树/见面课/秒刷）。跨域请求由 `zhihuishu-bridge.user.js` 桥接脚本在知到页面内完成：安装桥接脚本、保持知到页面打开，即可在静态站操作。

### 实现与风险

- 请求体使用 `secretStr`（AES-128-CBC，固定 IV）；见面课 AES key 每次运行时通过 RSA 公钥握手获取，不硬编码；视频课 key 优先运行时获取，失败回退已验证常量；
- 视频完成上报字段：`sdsew`（XOR 编码字段表）、`ewssw`（监测点序列）、`zwsds`（noteId 的 base64）；
- 见面课考勤：`getWatchHistory` 查已看分钟，`setWatchHistorySecret` 逐分钟上报；
- 平台有独立行为分析（`cheat/exceptionActionDetail`）：秒刷属高风险形态，本工具默认 dry-run、限速、随机覆盖率与熔断；请自行评估账号风险；
- 课程列表接口（`queryShareCourseInfo`）已于 2026-11-08 用真实账号抓包确认（加密模块 13、`pageNo` 分页）；失败时仍可用学习页 URL/`recruitAndCourseId` 兜底；见面课列表响应字段也可能随平台调整。
- **见面课列表接口**已于 2026-11-09 实测修正（`stuonline.zhihuishu.com/stuonline/json/teachMeeting/listTeachMeetingStu`，表单 `recruitId` + `page.pageNo/pageSize`，响应 `maps`/`mapCount`）；`zhs meet list` 与 `zhs check` 已真机验证。
- 见面课回放分钟上报：接口返回成功（`rt:true`），但对已结束场次回读 `getWatchHistory` 仍为空（`rt:"#"`）；是否真正计入考勤需在考勤有效窗口/页面复核，界面仍默认 `--dry-run`。

## 优学院（U学）视频与章节练习秒刷

除学在华科大、知到之外，本仓库也支持优学院（Ulearning / U学，`*.ulearning.cn`）学生端：

- 课程目录（章 / 节 / 页）与完成状态：只读抓取；
- **视频/图文秒刷**：调用学习记录接口把视频页标记为已完成（`status=1`）；
- **章节练习秒刷**：从 `/questionAnswer/{qid}?parentId={pageId}` 取答案后按实测 payload 提交，
  页面 `complete=1`、`score=100`；
- 不支持：作业/测验（`utest`）、小组作业、考试、直播、课堂、考勤。

### CLI

```powershell
$ul = "D:\ul-cookies.txt"

# 课程目录（列表已实测；也可用播放器 URL 或 textbookId=..&classId=..）
cargo run -- --cookies $ul ulearn tree --course "textbookId=47353&classId=1019700"

# 视频/图文：先看计划，再真实上报
cargo run -- --cookies $ul ulearn watch --course "..." --dry-run
cargo run -- --cookies $ul ulearn watch --course "..."

# 含章节练习（从平台取答案后提交）
cargo run -- --cookies $ul ulearn watch --course "..." --practice

# 会话/课程可学性检查
cargo run -- --cookies $ul ulearn check --course "..."
```

常用参数：`--dry-run` 只打印计划（不发 POST）；`--yes` 跳过确认；`--max-sections`；
`--include-completed`；`--practice` 处理含练习的节；`--delay-ms 3000-5000` 限速。

### 桌面 GUI

连接页选择“优学院”，内嵌登录窗口打开 `https://umooc.ulearning.cn/pc.html#/login`，登录后读取
`AUTHORIZATION` Cookie 并校验会话。课程页可“秒刷本课”（默认 dry-run，真实执行需勾选风险确认，
可勾选包含章节练习），进度通过 `job-progress`/`ul-watch` 事件推送、可取消。

### 浏览器助手脚本

`userscripts/ulearning-miaoshua.user.js` 安装到 Tampermonkey 后，在
`ua.ulearning.cn/learnCourse` 播放器页右下角出现面板，可秒刷本课视频或章节练习（dry-run 默认、
3–5 秒随机限速、失败即停、判定刷分立即中止）。脚本优先使用页面自带的 CryptoJS，缺失时内置
DES-ECB 实现。

### 网站版

`website/` 增加优学院平台并通过 `ulearning-bridge.user.js` 在优学院页面内转发同源请求；静态站不接触
`AUTHORIZATION` token（由桥接脚本在页面内注入请求头）。

### 实现与风险

- 鉴权：Cookie `AUTHORIZATION`，每个请求同时带 `Authorization` 与 `UA-AUTHORIZATION` 头；
  token 不打印、不跨窗口传递；
- 记录上报：`POST /yws/api/personal/sync?courseType=4&platform=PC`，body 为
  DES-ECB（key `12345678`，PKCS7，Base64）加密的 JSON；服务端返回 `1` 成功、`2` 判定刷分
  （立即熔断停止整批）；
- 目录/页面字段来自公开播放器 JS，**没有原始响应 fixture**；首次使用建议先 `--dry-run` 核对，
  再单节灰度并回读 `/studyrecord/item` 的 `completion_status`；
- 课程列表已实测（`courseapi` 的 `/courses/students` + `/textbook/student/{ocId}/list`）；失败时仍可用播放器 URL 或 `textbookId/classId` 兜底；
- 默认 dry-run、3–5 秒随机限速、失败即停；请自行评估账号与平台风控风险。

## 已验证的平台接口

以下接口在 2026-10 使用真实学生账号验证通过。路径都相对于
`https://smartcourse.hust.edu.cn`。

| 用途 | 方法 | 路径 | 关键参数 |
| --- | --- | --- | --- |
| 学生课程列表 | GET | `/fyportal-smartcourse/fyportal/wfw/courselist/getStudyCourse` | `sectionId=0`（0 = 全部） |
| 课程首页/获取 enc | GET | `/fyportal-smartcourse/courselist/opencoursenewfy` | `role=3&courseId=&clazzId=&cpi=&ckenc=`，会 302 到 `mooc-smartcourse/.../mycourse/stu` |
| 章节目录树 | GET | `/mooc-ans/mycourse/studentstudycourselist` | `courseId&chapterId=0&clazzid&cpi&mooc2=1` |
| 卡片列表 | GET | `/mooc-ans/mycourse/studentstudyAjax` | `courseId&clazzid&chapterId&cpi&...&ut=s` |
| 卡片内容 / 任务点 | GET | `/mooc-ans/knowledge/cards` | `clazzid&courseid&knowledgeid&num&cpi&ut=s` |
| 章节测验题目 | GET | `/mooc-ans/api/work` | `workId&jobid&originJobId&knowledgeid&ktoken&clazzId&enc&courseid`，跟随 302 |
| 视频签名地址 | GET | `/ananas/status/{objectId}` | `k={fid}` |
| 视频进度上报 | GET | `/mooc-ans/multimedia/log/a/{cpi}/{dtoken}` | `clazzId&playingTime&duration&clipTime&objectId&otherInfo&courseId&jobid&userid&isdrag&view=pc&enc&rt&dtype=Video&_t&attDuration&attDurationEnc&courseEngineInfo` |
| 文档附件 / jtoken | GET | `/mooc-ans/phone/wxcard` | `cardid&courseid&knowledgeid&clazzid&cpi&ut=s&isMicroCourse=false`，响应含 `window.AttachmentSetting` |
| 文档完成上报 | GET | `/mooc-ans/job/document` | `jobid&knowledgeid&courseid&clazzid&jtoken&checkMicroTopic=true&microTopicId=undefined&courseEngineInfo=false`，仅 `status: true` 成功 |

> 章节测验提交（`POST /mooc-ans/work/addStudentWorkNewWeb`）已在核心库实现，但还没有用真实
> 作答会话验证，因此没有列入上表；验证通过后请补上并更新 `src/submit.rs` 的说明。
>
> 文档两行（`phone/wxcard`、`job/document`）来自 Chaoxing 官方客户端 7.0.2 的协议移植
> （`flutter_chaoxing` 0.4.2）。2026-11-07 已用真实账号在 HUST 验证：`wxcard` 返回
> `window.AttachmentSetting` 和 `jtoken`；`job/document` 对《大学英语词汇解析(一)》49 个文档
> 全部返回 `status: true`。第一次使用时仍建议先用 `doc --dry-run` 和 `--job` 单个确认。

`knowledge/cards` 返回的 HTML 里有一个内联 `mArg = {...};` JSON，任务点列表就在
`mArg.attachments` 中；视频/文档/测验的 `jobid`、`objectid`、`workid`、完成状态和
观看进度都来自这里。文档的 `jtoken` 不在 `mArg` 里，需要按卡片 id 调 `/mooc-ans/phone/wxcard`
再取 `window.AttachmentSetting.attachments[].jtoken`。

## 库用法

```rust
use hust_course_hack::{FetchOptions, SmartCourseClient};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = SmartCourseClient::from_cookie_file(r"D:\cookies.txt")?;
    let courses = client.list_courses().await?;
    let options = FetchOptions::default();
    for course in &courses {
        let detail = client
            .fetch_course_with_progress(course, &options, &|progress| {
                println!("{}/{}", progress.done_leaves, progress.total_leaves);
                true // 返回 false 会中止抓取并返回 cancelled 错误
            })
            .await?;
        println!("{}: {} 个知识点", detail.title, detail.stats.leaves);
    }
    Ok(())
}
```

也可以从内存里的 Cookie header 构造：

```rust
let client = SmartCourseClient::from_cookie_header("name=value; other=value")?;
```

## 安全与限制

- **不要提交 `cookies.txt`**。CLI 会在日志里只记录 cookie 数量，不会打印 cookie 值；GUI 的
  登录窗口不产生 cookies.txt，读取会话后删除临时浏览器数据目录。
- GUI 的登录窗口没有 Tauri 权限，只用于学校登录页；登录窗口产生的会话 Cookie 不会通过 IPC
  返回给前端。
- `watch` 使用的 `dtoken`、`otherInfo`、`attDurationEnc` 与会话/视频绑定；每次运行都会
  重新获取，不要抓包后写死。
- 视频的 `download_url` / `stream_url` / `hd_stream_url` 带有时效签名，过期后需要重新请求
  `/ananas/status`，不要把它们当成永久链接保存。
- 未批改的章节测验只返回题目，不返回正确答案；已批改的作业（页面标题为“查看已批改作业”）
  才会带 `correct_answer`。
- 平台可能把“课程存在但没有章节”的课程返回为空目录（本账号的军事理论、信息技术导论、
  华科大校史就是这种情况），这是平台数据，不是抓取失败。
- 单个知识点/卡片/作业失败不会中断整门课程，错误会记录在 `stats.errors`。
- 文档完成依赖 `/mooc-ans/phone/wxcard` 返回的 `jtoken`；该 token 是页面/附件绑定的短期凭证，
  每次完成都重新获取，不写入磁盘。只有 `/mooc-ans/job/document` 返回 `status: true` 才算完成，
  命令不会在本地伪造完成状态。
- 优学院（U学）的 `AUTHORIZATION` token 不打印、不跨窗口；学习记录 body 用前端硬编码密钥
  DES 加密，平台改版时 `src/ulearning/cipher.rs` 与 `website/src/core/ul/crypto.ts` 都要同步。
- 优学院的目录/页面字段来自公开播放器 JS（无原始响应 fixture），首次使用先 `--dry-run` 核对；
  服务端返回 `2` 表示判定刷分，工具会立即停止整批。
- 三个平台的写操作（视频/文档/测验/文档/练习）默认都是 dry-run 或需勾选风险确认；真实执行前
  请先单条灰度并回读平台状态。
- 平台改版时优先检查 `stats.errors` 和题目解析结果；解析器依赖的 class 名集中在
  `src/parse.rs`。
