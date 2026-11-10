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
  (`hust_course_hack`), CLI binary (`hust-course-hack`), the `src-tauri`
  GUI crate (`hust-course-hack-gui`), and the `server` crate
  (`hust-course-web`, an axum wrapper around the core library for the
  self-hosted web version).
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
  for Zhihuishu and the `ulearn` subcommands (`list`, `tree`, `watch`, `check`)
  for Ulearning; `README.md` has usage and the verified endpoint table.
- `src/documents.rs` — direct document (PDF) completion: collects document task
  points from a crawled course, resolves each card's `jtoken` from the
  `/mooc-ans/phone/wxcard` `window.AttachmentSetting`, and reports
  `/mooc-ans/job/document` (`status: true` only). The contract is the one the
  platform PDF viewer's `finishJob()` sends, ported from Chaoxing's official
  client (`flutter_chaoxing` 0.4.2). Live-verified on 2026-11-07: all 49
  document task points of 大学英语词汇解析(一) returned `status: true`.
- `src/ulearning/` — Ulearning (优学院 / U学) student web app support, verified
  from a real session on 2026-11-07 (`docs/ulearning/{recon-static,web-analysis,miaoshua-plan}.md`).
  `cipher.rs` is DES-ECB + PKCS#7 + Base64 with the frontend key `12345678`;
  `client.rs` is `UlearningClient` (dual `Authorization`/`UA-AUTHORIZATION`
  headers, cookie-file/header constructors, injectable base for tests);
  `parse.rs` decodes directory/wholepage/studyrecord/questionAnswer responses;
  `record.rs` builds and submits the `/yws/api/personal/sync` payload; `plan.rs`
  is the dry-run planner and paced executor (skip completed/unsupported,
  practice answers, `completion_status` verification, code `2` cheat circuit
  breaker). The `AUTHORIZATION` token is never logged.
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
- `userscripts/ulearning-miaoshua.user.js` — browser-side one-click video and
  chapter-practice completion for Ulearning's player page. It encrypts the
  `/yws/api/personal/sync` body with the page's `CryptoJS.DES` (built-in DES
  fallback), sends dual `Authorization`/`UA-AUTHORIZATION` headers, defaults to
  dry-run, paces at 3–5 s and stops on server `2` (cheat detection).
- `userscripts/ulearning-miaoshua.user.js` is not embedded in the Rust binary;
  it is installed manually from the repo/website.
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
  the CLI semantics (dry-run default, risk confirmation, progress/cancel). A
  third platform (Ulearning / 优学院) is offered on the same connect screen with
  `src-tauri/src/ulearning.rs` commands and `views/ul-course.ts`.
- `website/` — standalone Vite + TypeScript static app that mirrors the core
  for SmartCourse, Zhihuishu and Ulearning through three bridge userscripts
  (`hust-course-bridge`, `zhihuishu-bridge`, `ulearning-bridge`). Cross-origin
  requests are relayed by the bridge inside each platform page, so the static
  site never sees cookies; `src/core/{zhs,ul}/**` mirror the Rust protocols and
  `src/views/{zhs-*,ul-*}.ts` mirror the GUI flow (dry-run, risk confirmation,
  progress/cancel).
- Tests live in `src/parse.rs`, `src/cookie.rs`, `src/playback.rs`,
  `src/answers.rs`, `src/submit.rs`, `src/documents.rs`, `src/zhihuishu/**`,
  `src/ulearning/**`, plus `tests/submit_http.rs`, `tests/documents_http.rs`,
  `tests/zhs_core.rs` and `tests/zhs_mock.rs`. The submission tests use
  `test-data/answer-bank.json` and `test-data/courses.json` to verify all 541
  questions across the 117 quiz works encode successfully; the integration
  tests run the submit and document paths against local mock pages,
  `tests/zhs_mock.rs` runs the Zhihuishu video/meet flows against a local mock
  HTTP server that decrypts `secretStr`, and `src/ulearning/**` carries its own
  DES/payload/parser/plan unit tests. Default branch is `main`.
- `.github/workflows/` — `ci.yml` (push/PR) runs `cargo fmt --check`, clippy and
  tests for `hust-course-hack` + `hust-course-web`, builds `ui/dist`, the web
  bundle (`VITE_BACKEND=web`) and `website/`, and lints the GUI crate on
  `windows-latest` (`cargo test --workspace` cannot run there on Linux:
  `src-tauri` needs WebKitGTK). `release.yml` builds the NSIS + MSI installers
  and the CLI on a `v*` tag, stages them in `release-assets/`, and publishes a
  GitHub Release with `gh release` (assets: `*-setup.exe`, `.msi`, CLI zip,
  `SHA256SUMS.txt`); it fails before building when the version in `Cargo.toml`,
  `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` or `package.json`
  disagrees with the tag. `website-pages.yml` deploys the static site.

## Commands

Run from the repo root in PowerShell 5.1:

- `cargo run` / `cargo build`
- `cargo run -- helper --out video-helper.user.js` (writes the browser helper script for videos and PDF documents; no cookies needed)
- `cargo run -- --cookies cookies.txt watch --course <id> --dry-run` (prints report URLs without sending)
- `cargo run -- --cookies cookies.txt doc --course <id> --dry-run` (prints document targets without reporting)
- `cargo run -- --cookies zhs-cookies.txt zhs list` (Zhihuishu shared courses; also
  `zhs tree`, `zhs watch`, `zhs check`, `zhs meet list/status/watch` — see README)
- `cargo run -- --cookies ul-cookies.txt ulearn tree --course "textbookId=..&classId=.."`
  (Ulearning; also `ulearn watch --dry-run`, `ulearn watch --practice`, `ulearn check`)
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
- `server/` (the web version) follows the same rules: it wraps only
  `SmartCourseClient`, exposes the same camelCase DTOs as the Tauri commands,
  keeps cookie values server-side (the browser only ever sees `cookieSource`
  and `cookieCount`), runs one job at a time, and never persists sessions to
  disk. The access passcode lives in `COURSEHACK_TOKEN` / `--token`, never in
  the repo.
- Web login goes through the official unified-auth relay
  (`server/src/login.rs`): `/login/` proxies `smartcourse.hust.edu.cn/passport`
  and the CAS pages on `pass.hust.edu.cn` with every URL rewritten back
  through `/login/p?url=<encoded>`. The relay only fetches `*.hust.edu.cn`
  over http/https, keeps one cookie jar per login attempt (replaced whenever
  `/login/` is opened again), and captures the session exactly like the
  desktop login window: when the flow lands on a smartcourse page that is not
  `/passport` or `/sso/`, verify `list_courses_with_url` stayed on
  `getStudyCourse` before adopting. Do not add cookie-paste or other
  credential-entry endpoints to the web version.
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
- Releases are cut from GitHub Actions, not from a local machine: bump the
  version in `Cargo.toml`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`
  and `package.json` together, then push a `vX.Y.Z` tag. Keep those four in
  sync; `release.yml` refuses to build when they disagree with the tag. Never
  commit build output (`ui/dist`, `release-assets/`) or installer binaries.
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
- Ulearning protocol constants (DES key `12345678`, API/web bases, cookie name
  `AUTHORIZATION`) live in `src/ulearning/mod.rs`; the `AUTHORIZATION` token is
  read from cookies and sent as both `Authorization` and `UA-AUTHORIZATION`
  headers — never log it and never return it over IPC.
- Ulearning sync bodies are DES-ECB encrypted; keep `src/ulearning/cipher.rs`
  and `website/src/core/ul/crypto.ts` byte-compatible, and never add the
  plaintext token or sync body to logs. Server reply `2` means cheat detection:
  stop the whole batch immediately (`run_watch` returns `CircuitBroken`).
- Ulearning directory/page fields come from the public player JS (no captured
  fixture); keep the tolerant parsing in `src/ulearning/parse.rs` and ask for a
  live capture before removing aliases. Keep dry-run the default and 3–5 s
  pacing on real runs.
