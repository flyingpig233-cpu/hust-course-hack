# AGENTS.md

## Project

Rust desktop app with a Tauri 2 GUI. Purpose: convenience operations for a target course platform (fetch exercise answers, auto-watch videos, one-click exercise submission).

- The target platform, login flow, and API endpoints are **not documented by
  the platform**. The endpoints this project uses were verified live against a
  real student session and are documented in `README.md`. Re-verify them when
  the platform changes; do not invent new endpoints.
- Rust logic should stay separate from Tauri/UI code so it can be tested without launching the GUI.

## Current state

The crawling core and the Tauri 2 desktop shell are implemented.

- Root `Cargo.toml` is a workspace: the Rust edition 2024 library
  (`hust_course_hack`), CLI binary (`hust-course-hack`), and the `src-tauri`
  GUI crate (`hust-course-hack-gui`).
- HTTP stack: `reqwest` (rustls, cookie jar) + `tokio`; HTML parsing: `scraper`.
- `src/client.rs` — authenticated requests and the course crawl pipeline.
  `fetch_course_with_progress` reports per-knowledge-point progress and can be
  cancelled by returning `false` from the callback.
- `src/cookie.rs` — Netscape `cookies.txt` loader.
- `src/parse.rs` — course list, chapter tree, cards/`mArg`, quiz questions.
- `src/answers.rs` — loads `test-data/answer-bank.json`, normalizes stems, and
  resolves a crawled `Question` by question id or the `stem_index` fallback.
  `AnswerBank::builtin()` embeds the same file (`DEFAULT_ANSWER_BANK_JSON`) so
  the GUI installer has a working bank without a file picker.
- `src/submit.rs` — quiz submission protocol: parses the work page's
  `form#form1` action and hidden fields (including `answerId`, `enc`,
  `randomOptions`, `isAccessibleCustomFid`), reuses that action instead of
  rebuilding its tokenized query, encodes single/multiple/true-false/fill/short
  answers, builds a course plan (`plan_course`), and parses the server reply.
  Verified live on 2026-10-22: form action/fields, judge `true`/`false`,
  fill `tiankongsize` + `answerEditor`, `answerwqbid` trailing comma, and
  `/work/validate` -> `status=3`. A real 6-question true/false work was
  submitted end-to-end: the server returned `success=true` and the work became
  graded. Fill/multiple-choice encodings are page-verified but not yet
  individually submitted; test one such work before bulk submission.
- `src/models.rs` — serializable data model shared by the CLI and the GUI.
- `src/main.rs` — `list`, `dump`, `tree`, `helper`, `watch`, `doc` commands plus
  the `zhs` subcommands (`list`, `tree`, `watch`, `check`, `meet list/status/watch`)
  for Zhihuishu; `README.md` has usage and the verified endpoint table.
- `src/documents.rs` — direct document (PDF) completion: collects document task
  points from a crawled course, resolves each card's `jtoken` from the
  `/mooc-ans/phone/wxcard` `window.AttachmentSetting`, and reports
  `/mooc-ans/job/document` (`status: true` only). The contract is the one the
  platform PDF viewer's `finishJob()` sends, ported from Chaoxing's official
  client (`flutter_chaoxing` 0.4.2). Live-verified on 2026-11-07: all 49
  document task points of 大学英语词汇解析(一) returned `status: true`.
- `src/zhihuishu/` — Zhihuishu (智慧树 / 知到) support verified live on
  2026-11-07. `crypto.rs` implements the `secretStr` AES-128-CBC wrapper, the
  runtime module-key handshake (`RSAES-PKCS1-v1_5 {"module":n}` -> `c/has?uid=` ->
  public operation + PKCS#1 unpad -> `cKey`), the XOR field encoders and the
  watch-point sequence; `api.rs` is `ZhsClient` (session, shared-course list with
  study-URL/secret fallback, video tree, `prelearningNote`/`queryStuyInfo`/
  `saveDatabaseIntervalTimeV2`, meet list/replay progress/minute reports,
  anti-cheat status, and `ZhsEndpoints` injection for tests); `watch.rs` is the
  video completion planner/executor; `meet.rs` is the replay attendance executor
  with random 90–100% coverage, 2–6 s pacing and a circuit breaker. Protocol
  notes live in `docs/zhihuishu-miaoshua-plan.md`.
- `src/playback.rs` — verified video progress reporting: `enc` signature,
  `dtoken` report URL, and the `isdrag` heartbeat sequence. `watch` re-fetches
  `mArg.defaults`, `otherInfo`, `attDurationEnc` and `dtoken` on every run.
- `userscripts/hust-course-video-helper.user.js` — browser-side one-click video
  completion for the current video, current knowledge point, or the whole
  course, plus PDF browsing and per-document completion through the platform
  viewer's `finishJob()`. It is embedded as
  `hust_course_hack::VIDEO_HELPER_SCRIPT`; the file name is kept for
  compatibility. CLI/GUI/website complete documents through
  `src/documents.rs` instead; the userscript stays as the browser fallback.
- `userscripts/zhihuishu-miaoshua.user.js` — browser-side one-click video
  completion and meet-replay attendance for Zhihuishu. It reuses the page's
  `labc`/`yxyz` crypto helpers when present and falls back to WebCrypto +
  BigInt; meet coverage is randomized (90–100%), reports are paced (2–6 s) and
  the anti-cheat endpoint is polled as a circuit breaker.
- `src-tauri/` — Tauri 2 shell: `tauri.conf.json`, `capabilities/default.json`,
  `src/commands.rs`, `src/state.rs`, `src/events.rs`, `src/login.rs`. Commands
  wrap the core client; progress is emitted as `job-progress` events. Only one
  crawl/report job may run at a time (`AppState::begin_job`), and `cancel_job`
  stops it. `complete_quizzes` refreshes the course, plans against the embedded
  bank, and submits per-work with `quiz` progress events; `complete_documents`
  refreshes the course and reports each document with `document` progress
  events; `answer_bank_info` exposes the bank size to the UI.
- `src-tauri/src/login.rs` — the GUI opens its own webview at
  `https://smartcourse.hust.edu.cn/passport`, which redirects to the HUST
  unified authentication (`pass.hust.edu.cn/cas/login`). After the redirect back
  to smartcourse, it reads cookies (including HttpOnly) with
  `cookies_for_url`, verifies them through `list_courses_with_url`, adopts the
  session, and closes the window. The login webview uses a temporary WebView2
  data directory that is deleted on close. `open_login_window` also accepts an
  optional platform; for Zhihuishu it opens
  `https://onlineweb.zhihuishu.com/onlinestuh5`, reads the cookies and validates
  them with `getLoginUserInfo` before adopting the session.
- `src-tauri/src/zhihuishu.rs` — thin Zhihuishu Tauri commands
  (`zhs_list_courses`, `zhs_course_detail`, `zhs_watch_videos`,
  `zhs_meet_list/progress/watch`, `zhs_exception_status`, `zhs_add_course`) and
  the `zhs-watch` / `zhs-meet-watch` job events; `SessionInfo` carries a
  `platform` field.
- `ui/` — Vite + vanilla TypeScript frontend (no framework). The connect screen
  only offers the official login window; it has no cookies.txt or pasted-header
  import. `ui/src/mock.ts` serves demo data when the page runs outside Tauri, so
  the UI can be reviewed in a plain browser without the platform.
  `ui/src/views/quiz.ts` is the one-click quiz modal (defaults to dry-run,
  requires the confirmation checkbox before real submission); `views/course.ts`
  adds the header button, quiz-tab banner and per-work “提交本题”. The demo
  backend never claims a real quiz submission. The connect screen also offers
  the Zhihuishu platform; `views/zhs-course.ts` and `views/zhs-meet.ts` mirror
  the CLI semantics (dry-run default, risk confirmation, progress/cancel).
- `website/` — standalone Vite + TypeScript static app that mirrors the core
  for SmartCourse and, since the Zhihuishu branch, also for Zhihuishu through
  the `zhihuishu-bridge.user.js` userscript (`src/core/zhs/`,
  `src/views/zhs-*.ts`, `src/zhs-bridge.user.ts`). Cross-origin requests are
  relayed by the bridge inside a Zhihuishu page, so the static site never sees
  cookies.
- Tests live in `src/parse.rs`, `src/cookie.rs`, `src/playback.rs`,
  `src/answers.rs`, `src/submit.rs`, `src/documents.rs`, `src/zhihuishu/**`, plus
  `tests/submit_http.rs`, `tests/documents_http.rs`, `tests/zhs_core.rs` and
  `tests/zhs_mock.rs`. The submission tests use `test-data/answer-bank.json` and
  `test-data/courses.json` to verify all 541 questions across the 117 quiz works
  encode successfully; the integration tests run the submit and document paths
  against local mock pages, and `tests/zhs_mock.rs` runs the Zhihuishu
  video/meet flows against a local mock HTTP server that decrypts `secretStr`
  and asserts the `sdsew`/`paramSecret` fields. Default branch is `main`.

## Commands

Run from the repo root in PowerShell 5.1:

- `cargo run` / `cargo build`
- `cargo run -- helper --out video-helper.user.js` (writes the browser helper script for videos and PDF documents; no cookies needed)
- `cargo run -- --cookies cookies.txt watch --course <id> --dry-run` (prints report URLs without sending)
- `cargo run -- --cookies cookies.txt doc --course <id> --dry-run` (prints document targets without reporting)
- `cargo run -- --cookies zhs-cookies.txt zhs list` (Zhihuishu shared courses; also
  `zhs tree`, `zhs watch`, `zhs check`, `zhs meet list/status/watch` — see README)
- `cd website; npm test; npm run build` (website tests and static build)
- `cargo test --workspace`
- `cargo fmt --all`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `npm install` (once, installs Vite, TypeScript, Tauri CLI, dialog/opener plugins)
- `npm run tauri dev` (Vite + desktop window)
- `npm run tauri build` (release build / installer)
- `npm run dev` (browser-only demo mode on `http://localhost:1420`)

`rustfmt` and `clippy` are installed. The workspace path contains a space (`hack hust`), so quote paths in shell commands.

## Conventions

- Do not commit platform credentials, cookies, tokens, or captured authenticated responses.
- The HTTP stack is `reqwest` + `tokio`; keep new network code behind
  `SmartCourseClient` so tests can use fixtures instead of a live session.
- Signed video URLs from `/ananas/status` expire; fetch them fresh instead of
  persisting them as permanent links.
- Quiz submission tokens (`workAnswerId`, `workRelationId`, `enc_work`) are
  page-bound: re-fetch the answering page for every submit instead of caching
  them in a plan or on disk. Reuse `form#form1`'s action verbatim; do not
  reconstruct its `token`/encrypted `totalQuestionNum` query. Never submit a
  work whose plan is incomplete (`missing_question_ids` / `errors` non-empty).
- Fill-in answers must keep both `answer{id}{n}` (mobile handler) and
  `answerEditor{id}{n}` (web textarea name); free-text keeps
  `answer{id}` + `answerEditor{id}`. `answerwqbid` keeps the page's trailing
  comma.
- The GUI uses the embedded `DEFAULT_ANSWER_BANK_JSON`. When
  `test-data/answer-bank.json` changes, rebuild the app; there is intentionally
  no runtime file picker for the bank. Keep the bank out of logs and never print
  course/answer values unnecessarily.
- The video report signature (`md5("[clazzId][userid][jobid][objectId][playingTime*1000][d_yHJ!$pdA~5][duration*1000][clipTime]")`)
  and the `/a/{cpi}/{dtoken}` path are verified against a real HAR. If the
  platform changes them, update `src/playback.rs` and its tests; do not hardcode
  a captured `dtoken`/`otherInfo`.
- Document (PDF) completion uses the platform's own document job protocol:
  fetch `GET /mooc-ans/phone/wxcard` for the card, read the attachment's
  `jtoken` from `window.AttachmentSetting`, then call
  `GET /mooc-ans/job/document` with `jobid`, `knowledgeid`, `courseid`,
  `clazzid`, `jtoken`, `checkMicroTopic`, `microTopicId` and
  `courseEngineInfo`. Only `status: true` counts as completed; never paint a
  completion locally. This is the request the H5 PDF viewer's `finishJob()`
  sends, ported from Chaoxing's official client (`flutter_chaoxing` 0.4.2).
  Live-verified on 2026-11-07: `phone/wxcard` returned the attachment
  `jtoken` and all 49 documents of the English course reported
  `status: true`. If the platform changes the shape, fall back to the viewer
  path in `userscripts/hust-course-video-helper.user.js` and update
  `src/documents.rs`. Office/WPS files may use a different viewer and job.
- Keep Tauri commands thin: session/state bookkeeping, progress events, and
  file IO only. All HTTP and parsing stays in the `hust_course_hack` crate.
- GUI authentication must go through the isolated login window
  (`src-tauri/src/login.rs`). Do not add cookies.txt or pasted-Cookie-header
  import to the GUI; the CLI keeps its `--cookies` option.
- Cookie values must never cross the IPC boundary. The frontend only sees
  `SessionInfo { cookieSource, cookieCount }`; do not add commands that return
  cookie contents.
- `Webview::cookies_for_url` / `cookies` deadlock when called from a synchronous
  command or event handler on Windows. Read them from a blocking worker thread
  (the login path uses `spawn_blocking`).
- Tauri commands that create windows must be `async`. A synchronous command
  runs on the main thread, and `WebviewWindowBuilder::build` waits for the main
  event loop, which deadlocks and leaves the new window blank and "not
  responding".
- The login webview must keep using a per-login temporary data directory, and
  the directory must be removed when the window is destroyed. If you change the
  login flow, verify that no platform cookies remain under the app's WebView2
  profile.
- The login window is intentionally excluded from
  `src-tauri/capabilities/default.json`; it must not get Tauri IPC permissions.
- GUI DTOs use camelCase via `#[serde(rename_all = "camelCase")]`; the core
  models stay snake_case. Update `ui/src/types.ts` whenever a model changes.
- Long-running GUI work emits `job-progress` events and must go through
  `AppState::begin_job` so only one job runs; new jobs should honor
  `cancel_job` where practical.
- Keep `ui/src/mock.ts` demo-only. It must not be required at runtime under
  Tauri, and it must never fake a server-confirmed video completion.
- New Tauri plugins need both a Rust `.plugin(...)` registration and the
  matching permission in `src-tauri/capabilities/default.json`.
- Tauri 2 is the agreed major version. Confirm before bumping majors.
- Zhihuishu protocol constants (module ids, fixed IV, XOR keys, API bases and
  paths) live in `src/zhihuishu/mod.rs`. Fetch the meet module key at runtime
  through the `c/has` handshake instead of hardcoding it, and keep the protocol
  notes in `docs/zhihuishu-miaoshua-plan.md` in sync when the platform changes.
- Zhihuishu jobs are high-risk: keep dry-run the default, randomize meet
  coverage (90–100%), pace minute reports (2–6 s), poll
  `cheat/exceptionActionDetail` as a circuit breaker, and never log cookies,
  `secretStr`, `sdsew` or `paramSecret` values.
- Keep Zhihuishu network code behind `ZhsClient`; tests must use
  `ZhsEndpoints`/`with_cookie_jar_and_endpoints` with the local mock server
  (`tests/zhs_mock.rs`) and never a live session.
- The Zhihuishu website path relies on the `zhihuishu-bridge.user.js`
  userscript; keep the postMessage origin/nonce/endpoint-allowlist checks on
  both sides, and remember the `lc.zhihuishu.com` page replaces the global
  `Map` with a Java-style polyfill.
