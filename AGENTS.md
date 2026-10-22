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
- `src/main.rs` — `list`, `dump`, `tree`, `helper`, `watch` commands; `README.md`
  has usage and the verified endpoint table.
- `src/playback.rs` — verified video progress reporting: `enc` signature,
  `dtoken` report URL, and the `isdrag` heartbeat sequence. `watch` re-fetches
  `mArg.defaults`, `otherInfo`, `attDurationEnc` and `dtoken` on every run.
- `userscripts/hust-course-video-helper.user.js` — browser-side one-click video
  completion for the current video, current knowledge point, or the whole
  course. It is embedded as `hust_course_hack::VIDEO_HELPER_SCRIPT`.
- `src-tauri/` — Tauri 2 shell: `tauri.conf.json`, `capabilities/default.json`,
  `src/commands.rs`, `src/state.rs`, `src/events.rs`, `src/login.rs`. Commands
  wrap the core client; progress is emitted as `job-progress` events. Only one
  crawl/report job may run at a time (`AppState::begin_job`), and `cancel_job`
  stops it. `complete_quizzes` refreshes the course, plans against the embedded
  bank, and submits per-work with `quiz` progress events; `answer_bank_info`
  exposes the bank size to the UI.
- `src-tauri/src/login.rs` — the GUI opens its own webview at
  `https://smartcourse.hust.edu.cn/passport`, which redirects to the HUST
  unified authentication (`pass.hust.edu.cn/cas/login`). After the redirect back
  to smartcourse, it reads cookies (including HttpOnly) with
  `cookies_for_url`, verifies them through `list_courses_with_url`, adopts the
  session, and closes the window. The login webview uses a temporary WebView2
  data directory that is deleted on close.
- `ui/` — Vite + vanilla TypeScript frontend (no framework). The connect screen
  only offers the official login window; it has no cookies.txt or pasted-header
  import. `ui/src/mock.ts` serves demo data when the page runs outside Tauri, so
  the UI can be reviewed in a plain browser without the platform.
  `ui/src/views/quiz.ts` is the one-click quiz modal (defaults to dry-run,
  requires the confirmation checkbox before real submission); `views/course.ts`
  adds the header button, quiz-tab banner and per-work “提交本题”. The demo
  backend never claims a real quiz submission.
- Tests live in `src/parse.rs`, `src/cookie.rs`, `src/playback.rs`,
  `src/answers.rs`, `src/submit.rs`, and `tests/submit_http.rs`. The submission
  tests use `test-data/answer-bank.json` and `test-data/courses.json` to verify
  all 541 questions across the 117 quiz works encode successfully; the
  integration test runs the submit path against a local mock answering page.
  Default branch is `main`.

## Commands

Run from the repo root in PowerShell 5.1:

- `cargo run` / `cargo build`
- `cargo run -- helper --out video-helper.user.js` (writes the browser helper script; no cookies needed)
- `cargo run -- --cookies cookies.txt watch --course <id> --dry-run` (prints report URLs without sending)
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
