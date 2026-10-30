# HUST Course 网页版

独立的 TypeScript + Vite 静态应用，复用桌面版界面，把 Rust core 的课程抓取、HTML/JSON 解析、题库匹配、视频签名与心跳、测验计划与提交迁移至 `src/core/`。运行时无需 Rust、Tauri 或后端服务器。

线上地址：https://flyingpig233-cpu.github.io/hust-course-hack/

## 使用

1. 在 Chrome/Edge/Firefox 安装 Tampermonkey，并按扩展提示允许用户脚本运行。
2. 打开网页，点击“安装桥接脚本 .user.js”并安装。
3. 点击“连接学校课程页面”。在打开的学校窗口完成统一身份认证，并允许连接页面显示的本站来源。
4. 返回静态站查看课程。使用期间保持学校窗口打开；如果学校登录跳转导致窗口被浏览器隔离，请先完成学校登录，然后重新点击连接。
5. 视频和测验任务默认试运行；测验实际提交还需要勾选确认框。平台要求验证码时，到学校页面手动处理。

`?demo=1` 是独立演示模式，只有合成示例数据，不会执行真实提交或视频上报。生产默认使用真实 TS core，不会静默切换到演示数据。

## 为什么需要桥接脚本

GitHub Pages 与学校平台属于不同来源。普通静态页面不能读取学校的 HttpOnly Cookie，也不能绕过学校的跨域策略。桥接脚本只在 `smartcourse.hust.edu.cn` 顶层页面运行，由该页面发起同源请求，通过 `postMessage` 将接口正文返回助手。来源、窗口对象、随机连接 nonce 和课程接口白名单会在两侧校验，连接需在学校页面明确允许。Cookie/密码不会被读取或传给静态站；不使用公共代理、不上传课程数据。

学校浏览器登录态仍由浏览器保存。断开连接会取消任务、关闭连接窗口并清空助手内存，但不会清除学校浏览器 Cookie。刷新静态站后需重新连接。不要把 Cookie、原始课程 JSON、抓包或带签名 URL 加进静态资源。

## 本地开发与打包

Node.js 24+。

```powershell
cd website
npm ci
npm test
npm run build
npm run dev
# http://127.0.0.1:1421/
```

`dist/` 可直接由任意静态 HTTP 服务托管，资源使用相对路径，兼容 GitHub Pages 仓库子目录。不要双击 `index.html` 以 file:// 运行。

`npm run build` 会编译应用和桥接脚本，并更新 `public/hust-course-bridge.user.js`（便于开发时安装同一份脚本）。修改桥接源码后请重新构建并在 Tampermonkey 重新安装脚本。

## 功能与目录

- `src/core/client.ts`：课程列表 → 课程首页 → 章节 → 卡片 → 视频详情/练习题；可配置并发、请求取消、错误诊断与进度事件。
- `src/core/parse.ts`：与 Rust 模型一致的章节、卡片、任务点和题目解析；`mArg` 仅解析 JSON，绝不 eval 平台代码。
- `src/core/answers.ts`：题号优先、NFKC 题干兜底匹配，支持单选、多选、判断、填空和自由文本编码。
- `src/core/playback.ts`、`md5.ts`：复现已有协议的 MD5 签名和 4→3→4→2 心跳序列；只有服务端 `isPassed=true` 才标记完成。
- `src/core/submit.ts`：提交前刷新题页、保留表单 action 的签名查询串和隐藏字段、完整性检查、验证码前置校验；已批改或缺答案作业不提交。
- `src/core/backend.ts`：浏览器会话、单任务互斥、题库加载、取消与界面适配。
- `src/bridge.user.ts`：学校窗口桥接；`public/` 包含编译脚本、课程助手（视频 / PDF 文档）和运行所需题库。
- `tests/`：合成 HTML、模拟 transport 与原 Rust 签名向量；验证内置 541 题答案可编码。测试不会使用真实 Cookie、请求学校或提交真实作业。

题库为已有仓库题库的运行时字段副本，不包含个人作答、得分、班级信息或登录令牌。更新题库时同时更新 `public/answer-bank.json`，保持 `question_index` 和 `stem_index` 一致。

## GitHub Pages

唯一位于 `website/` 外的部署文件是 GitHub 规定位置的 `../.github/workflows/website-pages.yml`。
仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
推送 `main` 的 website 修改会执行 `npm ci`、测试、构建，并部署 `website/dist/`；也可在 Actions 中手动运行 workflow。

部署遵循 [GitHub Pages 自定义 workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。桥接通信遵循 [postMessage 来源检查](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)。

## 验证范围

自动化覆盖离线解析、所有内置题目的答案编码、签名向量、模拟抓取、视频心跳和测验试运行/提交协议。真实学校浏览器登录、平台页面变化、验证码与校方实际计分须在用户浏览器会话中验证；构建或离线测试通过不代表真实任务已完成。
