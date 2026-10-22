# HUST SmartCourse 课程助手

Rust 核心库 + CLI + Tauri 2 桌面 GUI，用于读取 `https://smartcourse.hust.edu.cn` 上当前账号的课程数据：

- 课程列表和课程基本信息（课程 id、班级 id、cpi、封面、详情页）
- 章节目录树（章 / 节 / 知识点，含完成状态）
- 每个知识点下的卡片和任务点
- 视频任务点：文件名、大小、时长、完成状态、观看进度、截图、签名播放/下载地址
- 文档任务点：文件名、大小、类型、objectId、jobId
- 章节测验/练习题：题目、题型、选项、我的答案、正确答案、得分（已批改的作业才有答案）
- 作业页面状态：`graded`（查看已批改）或 `in_progress`（做题页）

网络层与解析层完全独立于 Tauri/UI，桌面壳通过 Tauri command 直接调用
`SmartCourseClient`。

## 桌面 GUI（Tauri 2）

`src-tauri/` 是 Tauri 2 外壳，`ui/` 是原生 TypeScript + Vite 前端。网络与解析仍然全部在
`SmartCourseClient` 里，command 层只负责会话状态、进度事件和文件读写。

环境：Rust 1.85+、Node.js 20+、WebView2 Runtime（Windows 10/11 通常已安装）。

```powershell
npm install
npm run tauri dev      # 开发：Vite + 桌面窗口
npm run tauri build    # 生产：构建安装包
```

界面能力：

| 页面 | 功能 |
| --- | --- |
| 连接 | 打开内嵌登录窗口，使用学校统一身份认证登录；成功后自动读取会话并关闭窗口 |
| 课程首页 | 搜索 / 刷新课程，卡片式入口 |
| 课程详情 | 目录树（章 / 节 / 知识点 / 卡片 / 任务点）、任务点表格与筛选、测验题目与答案、诊断信息 |
| 测验任务 | 右上角“完成题目”或测验页“提交本题”：内置题库匹配答案，已批改作业跳过，题库缺答案的作业不提交；默认试运行，确认后才发送真实提交 |
| 视频任务 | 整门课或单视频上报；试运行只生成签名 URL；可设置心跳间隔、延迟、数量上限并随时停止 |
| 工具 | 导出课程 JSON、在浏览器打开课程页、查看并保存 Tampermonkey 助手脚本 |

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

## 一键完成视频（浏览器脚本）

优先使用下面的 `watch` 直连上报；本脚本保留作为浏览器兜底，也适合手动逐个知识点处理。
脚本走的是已经在真实账号上验证过的播放器路径：覆盖 `reportProgress`、seek 到结尾、
触发 `ended`，最后调用平台的 `ed_complete`。

```powershell
cargo run -- helper --out video-helper.user.js
```

在 Tampermonkey 中新建脚本，粘贴生成的文件内容（`helper` 不需要 cookies）。进入课程
学习页（`studentstudy`）后，右上角会出现面板：

| 按钮 | 行为 |
| --- | --- |
| 完成当前视频 | 只处理当前播放器 |
| 完成本页视频 | 遍历当前知识点的所有卡片标签 |
| 完成整门课 | 按章节目录顺序遍历未完成的知识点，逐个处理视频；页面跳转后从 `sessionStorage` 继续 |
| 停止 | 中止当前任务 |

脚本只在当前浏览器会话内运行，不读取也不保存 cookies。处理完成后建议重新抓一次课程树
（`tree` 或 `dump`）确认对应任务点变成已完成；前端状态变化不等同于服务端已计入进度。

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

> 章节测验提交（`POST /mooc-ans/work/addStudentWorkNewWeb`）已在核心库实现，但还没有用真实
> 作答会话验证，因此没有列入上表；验证通过后请补上并更新 `src/submit.rs` 的说明。

`knowledge/cards` 返回的 HTML 里有一个内联 `mArg = {...};` JSON，任务点列表就在
`mArg.attachments` 中；视频/文档/测验的 `jobid`、`objectid`、`workid`、完成状态和
观看进度都来自这里。

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
- 平台改版时优先检查 `stats.errors` 和题目解析结果；解析器依赖的 class 名集中在
  `src/parse.rs`。
