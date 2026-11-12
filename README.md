# 华科课程助手（桌面版）

基于 Rust 和 Tauri 2 的 Windows 桌面应用，支持学在华科大、知到（智慧树）和优学院（U学）。

- 查看课程目录、任务点和已批改测验的答案与得分。
- 学在华科大支持视频、PDF 文档任务及题库匹配的测验提交。
- 知到支持共享课视频及见面课回放；优学院支持视频、图文和章节练习。
- 写入操作默认试运行；实际执行前需确认风险。任务支持进度展示和取消。

## 安装与使用

从 [GitHub Releases](https://github.com/flyingpig233-cpu/hust-course-hack/releases/latest) 下载 Windows x64 的 NSIS 安装程序或 MSI 安装包。启动后选择平台，在官方登录窗口完成登录。登录会话只保存在内存中；登录窗口使用独立临时数据目录。

## 开发与发布

需要 Rust、Node.js 和 WebView2 Runtime。网络与解析逻辑位于独立的 Rust 核心库，Tauri 命令负责会话、进度和文件操作。

```powershell
npm install
npm run tauri dev
npm run build
cargo test -p hust-course-hack
cargo fmt --all --check
npm run tauri build
```

CI 检查核心库、桌面前端和 Windows GUI；推送 `v*` 标签会通过 GitHub Actions 构建并发布 NSIS、MSI 和校验文件。发布前同步更新 `Cargo.toml`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和 `package.json` 的版本号。

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

> 章节测验提交已在真实会话验证；不同题型的验证范围见 `src/submit.rs`。
>
> 文档两行（`phone/wxcard`、`job/document`）来自 Chaoxing 官方客户端 7.0.2 的协议移植
> （`flutter_chaoxing` 0.4.2）。2026-11-07 已用真实账号在 HUST 验证：`wxcard` 返回
> `window.AttachmentSetting` 和 `jtoken`；`job/document` 对《大学英语词汇解析(一)》49 个文档
> 全部返回 `status: true`。第一次使用时仍建议先在桌面版试运行并单个确认。

`knowledge/cards` 返回的 HTML 里有一个内联 `mArg = {...};` JSON，任务点列表就在
`mArg.attachments` 中；视频/文档/测验的 `jobid`、`objectid`、`workid`、完成状态和
观看进度都来自这里。文档的 `jtoken` 不在 `mArg` 里，需要按卡片 id 调 `/mooc-ans/phone/wxcard`
再取 `window.AttachmentSetting.attachments[].jtoken`。
