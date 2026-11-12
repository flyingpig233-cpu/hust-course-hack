# AGENTS.md

## Project

Rust desktop app with a Tauri 2 GUI. Purpose: convenience operations for a target course platform (fetch exercise answers, auto-watch videos, one-click exercise submission).

- The target platform, login flow, and API endpoints are **not documented by
  the platform**. The endpoints this project uses were verified live against a
  real student session and are documented in `README.md`. Re-verify them when
  the platform changes; do not invent new endpoints.
- Rust logic should stay separate from Tauri/UI code so it can be tested without launching the GUI.

## Current state

- The product is the Tauri 2 desktop GUI (`src-tauri/`, `ui/`) backed by the independent Rust core (`src/`).
- The core supports SmartCourse, Zhihuishu, and Ulearning. Tests use fixtures and local mock servers.
- The GUI uses isolated official login windows, keeps session cookies in memory, emits progress events, and permits one job at a time. Risky operations default to dry-run.
- `ui/src/mock.ts` provides demo data for development outside Tauri.
- CI checks the core, desktop UI, and Windows GUI. Releases publish NSIS and MSI installers.

## Commands

Run from the repo root in PowerShell:

- `npm install`
- `npm run tauri dev` / `npm run tauri build`
- `npm run build`
- `cargo test -p hust-course-hack`
- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`

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
  `status: true`. If the platform changes the shape, investigate the viewer
  protocol and update `src/documents.rs`. Office/WPS files may use a different viewer and job.
- Keep Tauri commands thin: session/state bookkeeping, progress events, and
  file IO only. All HTTP and parsing stays in the `hust_course_hack` crate.
- GUI authentication must go through the isolated login window
  (`src-tauri/src/login.rs`). Do not add cookies.txt or pasted-Cookie-header
  import to the GUI.
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
- Ulearning protocol constants (DES key `12345678`, API/web bases, cookie name
  `AUTHORIZATION`) live in `src/ulearning/mod.rs`; the `AUTHORIZATION` token is
  read from cookies and sent as both `Authorization` and `UA-AUTHORIZATION`
  headers — never log it and never return it over IPC.
- Ulearning sync bodies are DES-ECB encrypted; keep `src/ulearning/cipher.rs`
  accurate, and never add the
  plaintext token or sync body to logs. Server reply `2` means cheat detection:
  stop the whole batch immediately (`run_watch` returns `CircuitBroken`).
- Ulearning directory/page fields come from the public player JS (no captured
  fixture); keep the tolerant parsing in `src/ulearning/parse.rs` and ask for a
  live capture before removing aliases. Keep dry-run the default and 3–5 s
  pacing on real runs.
