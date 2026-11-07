use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use hust_course_hack::{
    Chapter, CourseDetail, CourseSummary, FetchOptions, REPORT_VERSION, SmartCourseClient,
    TaskKind, TaskPoint, VIDEO_HELPER_SCRIPT, WatchOptions, collect_document_targets,
    collect_targets,
    ulearning::{
        UlAction, UlCourseDetail, UlPlan, UlProgress, UlSectionPlan, UlWatchOptions, UlWatchState,
        UlearningClient, build_record_payload, plan_course, run_watch,
    },
    watch_target,
    zhihuishu::{
        ZhsClient, ZhsCourseDetail, ZhsExceptionStatus, ZhsMeet, ZhsMeetWatchOptions, ZhsProgress,
        ZhsVideoTarget, ZhsWatchOptions, ZhsWatchState, hms, watch::build_video_payload,
    },
};
use serde::Serialize;
use std::{
    io::{BufRead, IsTerminal, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Parser)]
#[command(
    name = "hust-course-hack",
    version,
    about = "Crawl HUST SmartCourse courses, chapters and task points"
)]
struct Cli {
    /// Netscape cookies.txt exported from a logged-in browser session.
    #[arg(long, default_value = "cookies.txt", global = true)]
    cookies: PathBuf,

    /// Number of knowledge points fetched concurrently.
    #[arg(long, default_value_t = 4, global = true)]
    concurrency: usize,

    /// Skip fetching chapter quiz questions.
    #[arg(long, global = true)]
    no_questions: bool,

    /// Skip fetching signed video URLs and durations.
    #[arg(long, global = true)]
    no_video_info: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print the student's current course list.
    List {
        /// Emit JSON instead of a table.
        #[arg(long)]
        json: bool,
    },
    /// Crawl courses and write a JSON file.
    Dump {
        /// Course id or class id. Repeat to select more than one; default is all.
        #[arg(long)]
        course: Vec<String>,
        /// Output JSON path.
        #[arg(long, default_value = "courses.json")]
        out: PathBuf,
    },
    /// Print the chapter/task-point tree for one course.
    Tree {
        /// Course id or class id.
        #[arg(long)]
        course: String,
    },
    /// Write the Tampermonkey video/document helper script to a file or stdout.
    Helper {
        /// Output path; defaults to stdout.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Complete document (PDF) task points through `/mooc-ans/job/document`.
    Doc {
        /// Course id, class id, or course name.
        #[arg(long)]
        course: String,
        /// Only complete this job id.
        #[arg(long)]
        job: Option<String>,
        /// Include documents the platform already marks as completed.
        #[arg(long)]
        include_completed: bool,
        /// Print the targets without sending any request.
        #[arg(long)]
        dry_run: bool,
        /// Maximum number of documents to process.
        #[arg(long)]
        max_documents: Option<usize>,
    },
    /// Complete video task points by replaying the player's progress reports.
    Watch {
        /// Course id, class id, or course name.
        #[arg(long)]
        course: String,
        /// Only report this job id.
        #[arg(long)]
        job: Option<String>,
        /// Include task points the platform already marks as completed.
        #[arg(long)]
        include_completed: bool,
        /// Send intermediate heartbeats every N seconds; 0 jumps to the end.
        #[arg(long, default_value_t = 0)]
        step: u64,
        /// Delay between heartbeats, in milliseconds.
        #[arg(long, default_value_t = 0)]
        delay_ms: u64,
        /// Print report URLs without sending them.
        #[arg(long)]
        dry_run: bool,
        /// Maximum number of videos to process.
        #[arg(long)]
        max_videos: Option<usize>,
    },
    /// Zhihuishu (智慧树 / 知到): shared-course videos and meet replay attendance.
    Zhs {
        #[command(subcommand)]
        command: ZhsCommand,
    },
    /// Ulearning (优学院 / U学): course tree, video and practice completion.
    #[command(visible_alias = "uly")]
    Ulearn {
        #[command(subcommand)]
        command: UlearnCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ZhsCommand {
    /// List the shared courses of the current account.
    List {
        /// Emit JSON instead of a table.
        #[arg(long)]
        json: bool,
    },
    /// Print the chapter/lesson/video tree and completion state of one course.
    Tree {
        /// Course reference: study-page URL, recruitAndCourseId secret,
        /// recruitId;courseId, or courseId.
        #[arg(long)]
        course: String,
    },
    /// Complete shared-course videos (skips finished ones by default; asks
    /// for confirmation before reporting).
    Watch {
        /// Course reference: study-page URL, recruitAndCourseId secret,
        /// recruitId;courseId, or courseId.
        #[arg(long)]
        course: String,
        /// Print the plan and the fields that would be sent; send nothing.
        #[arg(long)]
        dry_run: bool,
        /// Process at most N videos.
        #[arg(long)]
        max_videos: Option<usize>,
        /// Also re-report videos the platform already marks as finished.
        #[arg(long)]
        include_completed: bool,
        /// Skip the interactive confirmation and report immediately.
        #[arg(long)]
        yes: bool,
    },
    /// Print the video-course and meet-course anti-cheat status.
    Check {
        /// Course reference: study-page URL, recruitAndCourseId secret,
        /// recruitId;courseId, or courseId.
        #[arg(long)]
        course: String,
    },
    /// Meet-course (见面课) replay attendance commands.
    Meet {
        #[command(subcommand)]
        command: ZhsMeetCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ZhsMeetCommand {
    /// List the meet-course sessions of one course.
    List {
        /// Course reference.
        #[arg(long)]
        course: String,
    },
    /// Print replay attendance progress (watched/total minutes, percent).
    Status {
        /// Course reference.
        #[arg(long)]
        course: String,
        /// Only inspect this meetCourseId or liveId.
        #[arg(long)]
        meeting: Option<u64>,
    },
    /// Report replay attendance minute by minute (random coverage, rate
    /// limit and circuit breaker).
    Watch {
        /// Course reference.
        #[arg(long)]
        course: String,
        /// Only process this meetCourseId or liveId.
        #[arg(long)]
        meeting: Option<u64>,
        /// Process every meet course that has a replay.
        #[arg(long)]
        all: bool,
        /// Coverage window, for example 0.90-1.00.
        #[arg(long, default_value = "0.90-1.00")]
        coverage: String,
        /// Delay window between reports in milliseconds, for example
        /// 2000-6000.
        #[arg(long, default_value = "2000-6000")]
        delay_ms: String,
        /// Check the anti-cheat endpoint after every N reports.
        #[arg(long, default_value_t = 10)]
        check_every: usize,
        /// Disable the anti-cheat circuit breaker.
        #[arg(long)]
        no_circuit_breaker: bool,
        /// Print the plan and the fields that would be sent; send nothing.
        #[arg(long)]
        dry_run: bool,
        /// Skip the interactive confirmation and report immediately.
        #[arg(long)]
        yes: bool,
    },
}

/// Arguments of `zhs watch`, kept in a struct to stay below clippy's
/// too-many-arguments threshold.
#[derive(Debug, Clone, Copy)]
struct VideoWatchArgs {
    dry_run: bool,
    max_videos: Option<usize>,
    include_completed: bool,
    yes: bool,
}

/// Arguments of `zhs meet watch`.
#[derive(Debug, Clone)]
struct MeetWatchArgs {
    course: String,
    meeting: Option<u64>,
    all: bool,
    coverage: String,
    delay_ms: String,
    check_every: usize,
    no_circuit_breaker: bool,
    dry_run: bool,
    yes: bool,
}

#[derive(Debug, Subcommand)]
enum UlearnCommand {
    /// List the courses of the current account.
    List {
        /// Emit JSON instead of a table.
        #[arg(long)]
        json: bool,
    },
    /// Print the chapter/section/page tree and completion state of one course.
    Tree {
        /// Course reference: player URL, textbookId=...&classId=...,
        /// textbookId;classId, or textbookId.
        #[arg(long)]
        course: String,
    },
    /// Complete video/document sections, and optionally practice sections.
    Watch {
        /// Course reference: player URL, textbookId=...&classId=...,
        /// textbookId;classId, or textbookId.
        #[arg(long)]
        course: String,
        /// Print the plan and payload summaries; send nothing.
        #[arg(long)]
        dry_run: bool,
        /// Process at most N actionable sections.
        #[arg(long)]
        max_sections: Option<usize>,
        /// Also re-submit sections the platform already marks as completed.
        #[arg(long)]
        include_completed: bool,
        /// Also submit sections that contain practice pages (answers are
        /// fetched from the server).
        #[arg(long)]
        practice: bool,
        /// Delay window between submissions in milliseconds, for example
        /// 3000-5000.
        #[arg(long, default_value = "3000-5000")]
        delay_ms: String,
        /// Skip the interactive confirmation and submit immediately.
        #[arg(long)]
        yes: bool,
    },
    /// Check the session and whether the course can be completed.
    Check {
        /// Course reference.
        #[arg(long)]
        course: String,
    },
}

/// Arguments of `ulearn watch`.
#[derive(Debug, Clone)]
struct UlearnWatchArgs {
    course: String,
    dry_run: bool,
    max_sections: Option<usize>,
    include_completed: bool,
    practice: bool,
    delay_ms: String,
    yes: bool,
}

/// Placeholder user uuid used when building the masked dry-run preview; the
/// real uuid is only available after an authenticated request and is not
/// needed for printing the plan.
const PREVIEW_UUID: &str = "preview0";

/// Tally of terminal states used by the Chinese end-of-run summary.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct RunSummary {
    ok: usize,
    skipped: usize,
    failed: usize,
    aborted: usize,
    cancelled: usize,
}

impl RunSummary {
    fn record(&mut self, state: ZhsWatchState) {
        match state {
            ZhsWatchState::Ok => self.ok += 1,
            ZhsWatchState::Skip => self.skipped += 1,
            ZhsWatchState::DryRun => {}
            ZhsWatchState::Failed => self.failed += 1,
            ZhsWatchState::Cancelled => self.cancelled += 1,
            ZhsWatchState::CircuitBroken => self.aborted += 1,
        }
    }

    fn record_ul(&mut self, state: UlWatchState) {
        match state {
            UlWatchState::Ok => self.ok += 1,
            UlWatchState::Skip => self.skipped += 1,
            UlWatchState::DryRun => {}
            UlWatchState::Failed => self.failed += 1,
            UlWatchState::Cancelled => self.cancelled += 1,
            UlWatchState::CircuitBroken => self.aborted += 1,
        }
    }

    fn print(&self) {
        println!(
            "\n汇总：成功 {}，跳过 {}，失败 {}，已中止 {}",
            self.ok, self.skipped, self.failed, self.aborted
        );
        if self.cancelled > 0 {
            println!("已取消：{}", self.cancelled);
        }
    }

    fn exit_code(&self) -> i32 {
        if self.failed > 0 || self.aborted > 0 || self.cancelled > 0 {
            1
        } else {
            0
        }
    }
}

#[derive(Debug, Serialize)]
struct Dump {
    generated_at_unix: u64,
    courses: Vec<CourseDetail>,
    errors: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let cli = Cli::parse();
    let options = FetchOptions {
        include_questions: !cli.no_questions,
        include_video_info: !cli.no_video_info,
        concurrency: cli.concurrency.max(1),
    };

    match cli.command {
        Command::Helper { out } => helper(out),
        Command::List { json } => {
            let client = SmartCourseClient::from_cookie_file(&cli.cookies)?;
            list(&client, json).await
        }
        Command::Dump { course, out } => {
            let client = SmartCourseClient::from_cookie_file(&cli.cookies)?;
            dump(&client, &options, course, out).await
        }
        Command::Tree { course } => {
            let client = SmartCourseClient::from_cookie_file(&cli.cookies)?;
            tree(&client, &options, course).await
        }
        Command::Doc {
            course,
            job,
            include_completed,
            dry_run,
            max_documents,
        } => {
            let client = SmartCourseClient::from_cookie_file(&cli.cookies)?;
            doc(
                &client,
                &options,
                course,
                job,
                include_completed,
                dry_run,
                max_documents,
            )
            .await
        }
        Command::Watch {
            course,
            job,
            include_completed,
            step,
            delay_ms,
            dry_run,
            max_videos,
        } => {
            let client = SmartCourseClient::from_cookie_file(&cli.cookies)?;
            let watch_options = WatchOptions {
                include_completed,
                job,
                max_videos,
                step_secs: step,
                delay_ms,
            };
            watch(&client, &options, course, watch_options, dry_run).await
        }
        Command::Zhs { command } => {
            let code = zhs(command, &cli.cookies).await?;
            if code != 0 {
                std::process::exit(code);
            }
            Ok(())
        }
        Command::Ulearn { command } => {
            let code = ulearn(command, &cli.cookies).await?;
            if code != 0 {
                std::process::exit(code);
            }
            Ok(())
        }
    }
}

fn helper(out: Option<PathBuf>) -> Result<()> {
    match out {
        Some(path) => {
            std::fs::write(&path, VIDEO_HELPER_SCRIPT)
                .with_context(|| format!("failed to write {}", path.display()))?;
            println!("wrote {}", path.display());
        }
        None => print!("{VIDEO_HELPER_SCRIPT}"),
    }
    Ok(())
}

async fn list(client: &SmartCourseClient, json: bool) -> Result<()> {
    let courses = client.list_courses().await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&courses)?);
        return Ok(());
    }

    if courses.is_empty() {
        eprintln!(
            "no courses found; the cookie may be expired or the account has no current courses"
        );
        return Ok(());
    }

    println!("{:<20} {:<20} NAME", "COURSE_ID", "CLASS_ID");
    for course in &courses {
        println!(
            "{:<20} {:<20} {}",
            course.course_id, course.class_id, course.name
        );
    }
    println!("\n{} course(s)", courses.len());
    Ok(())
}

async fn dump(
    client: &SmartCourseClient,
    options: &FetchOptions,
    wanted: Vec<String>,
    out: PathBuf,
) -> Result<()> {
    let courses = client.list_courses().await?;
    let selected = select_courses(courses, &wanted)?;
    if selected.is_empty() {
        bail!("no courses selected");
    }

    let mut details = Vec::new();
    let mut errors = Vec::new();
    for course in &selected {
        match client.fetch_course(course, options).await {
            Ok(detail) => {
                print_stats(&detail);
                details.push(detail);
            }
            Err(error) => {
                let message = format!("course {} ({}): {error:#}", course.name, course.course_id);
                eprintln!("error: {message}");
                errors.push(message);
            }
        }
    }

    let dump = Dump {
        generated_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
        courses: details,
        errors,
    };
    let json = serde_json::to_string_pretty(&dump).context("failed to serialize crawl result")?;
    std::fs::write(&out, json).with_context(|| format!("failed to write {}", out.display()))?;
    println!("\nwrote {}", out.display());
    Ok(())
}

async fn tree(client: &SmartCourseClient, options: &FetchOptions, wanted: String) -> Result<()> {
    let courses = client.list_courses().await?;
    let selected = select_courses(courses, &[wanted])?;
    let Some(course) = selected.first() else {
        bail!("course not found");
    };
    let detail = client.fetch_course(course, options).await?;
    println!("{} ({})", detail.title, detail.course.course_id);
    for chapter in &detail.chapters {
        print_chapter(chapter, 0);
    }
    print_stats(&detail);
    Ok(())
}

async fn doc(
    client: &SmartCourseClient,
    options: &FetchOptions,
    wanted: String,
    job: Option<String>,
    include_completed: bool,
    dry_run: bool,
    max_documents: Option<usize>,
) -> Result<()> {
    println!("hust-course-hack v{REPORT_VERSION} (doc)");
    let courses = client.list_courses().await?;
    let selected = select_courses(courses, &[wanted])?;
    let Some(course) = selected.first() else {
        bail!("course not found");
    };

    // Document completion only needs the chapter/card structure; questions and
    // video signatures would only slow the crawl down.
    let fetch_options = FetchOptions {
        include_questions: false,
        include_video_info: false,
        concurrency: options.concurrency.max(1),
    };
    let detail = client.fetch_course(course, &fetch_options).await?;
    let mut targets = collect_document_targets(&detail, include_completed);
    if let Some(job) = &job {
        targets.retain(|target| &target.job_id == job);
    }
    if let Some(max) = max_documents {
        targets.truncate(max);
    }

    println!("{} ({})", detail.title, detail.course.course_id);
    if targets.is_empty() {
        println!("no document task points to complete");
        return Ok(());
    }
    println!("{} document(s) to complete", targets.len());
    if dry_run {
        for (index, target) in targets.iter().enumerate() {
            println!(
                "[{}/{}] {} (job {} card {})",
                index + 1,
                targets.len(),
                target.label(),
                target.job_id,
                target.card_id
            );
        }
        println!("\ndry run: no requests sent");
        return Ok(());
    }

    let mut completed = 0usize;
    let mut failed = 0usize;
    for (index, target) in targets.iter().enumerate() {
        println!("[{}/{}] {}", index + 1, targets.len(), target.label());
        match client.complete_document(target).await {
            Ok(report) => {
                completed += 1;
                println!("  status=true (job {})", report.job_id);
            }
            Err(error) => {
                failed += 1;
                eprintln!("  error: {error:#}");
            }
        }
    }
    println!("\ncompleted={completed} failed={failed}");
    if failed > 0 {
        bail!("{failed} document(s) could not be completed");
    }
    Ok(())
}

async fn watch(
    client: &SmartCourseClient,
    options: &FetchOptions,
    wanted: String,
    watch_options: WatchOptions,
    dry_run: bool,
) -> Result<()> {
    println!("hust-course-hack v{REPORT_VERSION} (watch)");
    let courses = client.list_courses().await?;
    let selected = select_courses(courses, &[wanted])?;
    let Some(course) = selected.first() else {
        bail!("course not found");
    };

    // The report needs the per-card playback environment and the per-video
    // `dtoken`, so video info must be fetched even if the global flag is off.
    let fetch_options = FetchOptions {
        include_questions: false,
        include_video_info: true,
        concurrency: options.concurrency.max(1),
    };
    let detail = client.fetch_course(course, &fetch_options).await?;
    let targets = collect_targets(client, &detail, &watch_options)?;

    println!("{} ({})", detail.title, detail.course.course_id);
    if targets.is_empty() {
        println!("no video task points to report");
        return Ok(());
    }
    println!("{} video(s) to report", targets.len());

    let mut passed = 0usize;
    let mut failed = 0usize;
    for (index, target) in targets.iter().enumerate() {
        println!("[{}/{}] {}", index + 1, targets.len(), target.label());
        if dry_run {
            let end = target.duration_secs.max(1);
            let start = target.played_secs.min(end);
            println!(
                "  start: {}",
                target.report_url(client.base_url(), start, 4)?
            );
            println!("  end:   {}", target.report_url(client.base_url(), end, 4)?);
            continue;
        }

        match watch_target(client, target, &watch_options).await {
            Ok(true) => {
                passed += 1;
                println!("  isPassed=true");
            }
            Ok(false) => {
                failed += 1;
                eprintln!("  isPassed=false");
            }
            Err(error) => {
                failed += 1;
                eprintln!("  error: {error:#}");
            }
        }
    }

    if dry_run {
        println!("\ndry run: no requests sent");
    } else {
        println!("\npassed={passed} failed={failed}");
    }
    Ok(())
}

fn select_courses(courses: Vec<CourseSummary>, wanted: &[String]) -> Result<Vec<CourseSummary>> {
    if wanted.is_empty() {
        return Ok(courses);
    }

    let selected: Vec<CourseSummary> = courses
        .into_iter()
        .filter(|course| {
            wanted.iter().any(|value| {
                value == &course.course_id || value == &course.class_id || value == &course.name
            })
        })
        .collect();

    if selected.is_empty() {
        bail!("no course matched {wanted:?}");
    }
    Ok(selected)
}

fn print_chapter(chapter: &Chapter, depth: usize) {
    let indent = "  ".repeat(depth);
    let number = chapter.number.as_deref().unwrap_or("");
    let done = match chapter.completed {
        Some(true) => " [done]",
        Some(false) => " [todo]",
        None => "",
    };
    println!(
        "{indent}{}{} {}{}",
        if number.is_empty() {
            String::new()
        } else {
            format!("{number} ")
        },
        chapter.title,
        if chapter.id.is_empty() {
            String::new()
        } else {
            format!(" (#{})", chapter.id)
        },
        done
    );

    for card in &chapter.cards {
        println!("{indent}  - card {}: {}", card.index, card.title);
        for point in &card.task_points {
            println!("{indent}    * {}", describe_point(point));
        }
    }
    for child in &chapter.children {
        print_chapter(child, depth + 1);
    }
}

fn describe_point(point: &TaskPoint) -> String {
    let kind = match point.kind {
        TaskKind::Video => "video",
        TaskKind::Document => "document",
        TaskKind::Work => "work",
        TaskKind::Audio => "audio",
        TaskKind::Live => "live",
        TaskKind::Other => "other",
    };
    let mut extra = Vec::new();
    if let Some(duration) = point.duration_secs {
        extra.push(format!("{duration}s"));
    }
    if let Some(size) = point.size_bytes {
        extra.push(format!("{size} bytes"));
    }
    if point.completed == Some(true) {
        extra.push("done".to_string());
    }
    if !point.questions.is_empty() {
        extra.push(format!("{} questions", point.questions.len()));
    }
    if let Some(status) = &point.work_status {
        extra.push(status.clone());
    }
    if point.video.is_some() {
        extra.push("stream ready".to_string());
    }

    if extra.is_empty() {
        format!("[{kind}] {}", point.name)
    } else {
        format!("[{kind}] {} ({})", point.name, extra.join(", "))
    }
}

fn print_stats(detail: &CourseDetail) {
    let stats = &detail.stats;
    println!(
        "\n{}: chapters={}, leaves={}, cards={}, tasks={}, videos={}, documents={}, works={}, questions={}",
        detail.title,
        stats.chapter_nodes,
        stats.leaves,
        stats.cards,
        stats.task_points,
        stats.videos,
        stats.documents,
        stats.works,
        stats.questions
    );
    for error in stats.errors.iter().take(5) {
        eprintln!("  warning: {error}");
    }
    if stats.errors.len() > 5 {
        eprintln!("  ... and {} more warnings", stats.errors.len() - 5);
    }
}

/// Build the Zhihuishu client from the global `--cookies` file.
fn zhs_client(cookies: &Path) -> Result<ZhsClient> {
    ZhsClient::from_cookie_file(cookies).context(
        "加载知到 Cookie 失败：需要 Netscape 格式的 cookies.txt（从已登录知到的浏览器导出）",
    )
}

/// Dispatch one `zhs` subcommand. The returned value is the process exit code.
async fn zhs(command: ZhsCommand, cookies: &Path) -> Result<i32> {
    match command {
        ZhsCommand::List { json } => {
            let client = zhs_client(cookies)?;
            zhs_list(&client, json).await
        }
        ZhsCommand::Tree { course } => {
            let client = zhs_client(cookies)?;
            zhs_tree(&client, &course).await
        }
        ZhsCommand::Watch {
            course,
            dry_run,
            max_videos,
            include_completed,
            yes,
        } => {
            let client = zhs_client(cookies)?;
            let args = VideoWatchArgs {
                dry_run,
                max_videos,
                include_completed,
                yes,
            };
            zhs_video_watch(&client, &course, args).await
        }
        ZhsCommand::Check { course } => {
            let client = zhs_client(cookies)?;
            zhs_check(&client, &course).await
        }
        ZhsCommand::Meet { command } => {
            let client = zhs_client(cookies)?;
            match command {
                ZhsMeetCommand::List { course } => zhs_meet_list(&client, &course).await,
                ZhsMeetCommand::Status { course, meeting } => {
                    zhs_meet_status(&client, &course, meeting).await
                }
                ZhsMeetCommand::Watch {
                    course,
                    meeting,
                    all,
                    coverage,
                    delay_ms,
                    check_every,
                    no_circuit_breaker,
                    dry_run,
                    yes,
                } => {
                    let args = MeetWatchArgs {
                        course,
                        meeting,
                        all,
                        coverage,
                        delay_ms,
                        check_every,
                        no_circuit_breaker,
                        dry_run,
                        yes,
                    };
                    zhs_meet_watch(&client, args).await
                }
            }
        }
    }
}

async fn zhs_list(client: &ZhsClient, json: bool) -> Result<i32> {
    let courses = match client.list_courses().await {
        Ok(courses) => courses,
        Err(error) => {
            eprintln!("获取知到共享课列表失败：{error:#}");
            eprintln!(
                "课程列表接口可能已变更；可改用学习页 URL 或 recruitAndCourseId 指定课程，例如："
            );
            eprintln!(
                "  cargo run -- --cookies cookies.txt zhs tree --course \"<学习页 URL 或 secret>\""
            );
            return Ok(1);
        }
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&courses)?);
        return Ok(0);
    }
    if courses.is_empty() {
        eprintln!("没有找到知到共享课；请确认账号已选课且 Cookie 未过期");
        return Ok(0);
    }

    println!(
        "{:<14} {:<12} {:<32} {:<12} 进度",
        "课程ID", "选课ID", "课程名称", "教师"
    );
    for course in &courses {
        let progress = course
            .progress
            .map(|value| format!("{value:.0}%"))
            .unwrap_or_else(|| "-".to_string());
        println!(
            "{:<14} {:<12} {:<32} {:<12} {}",
            course.course_id, course.recruit_id, course.name, course.teacher, progress
        );
    }
    println!("\n共 {} 门知到共享课", courses.len());
    Ok(0)
}

async fn zhs_tree(client: &ZhsClient, reference: &str) -> Result<i32> {
    let course = client.resolve_course(reference).await?;
    let detail = client.course_detail(&course).await?;
    print_zhs_tree(&detail);
    Ok(0)
}

fn print_zhs_tree(detail: &ZhsCourseDetail) {
    let course = &detail.course;
    println!(
        "{}（courseId={}，recruitId={}）",
        course.label(),
        course.course_id,
        course.recruit_id
    );

    let mut chapters = 0usize;
    let mut lessons = 0usize;
    let mut videos = 0usize;
    for chapter in &detail.chapters {
        chapters += 1;
        let name = if chapter.name.trim().is_empty() {
            "未命名章"
        } else {
            chapter.name.trim()
        };
        let limit = if chapter.limit_checked == Some(true) {
            "（教学限制）"
        } else {
            ""
        };
        let pass = if chapter.is_pass == Some(1) {
            " [已通过]"
        } else {
            ""
        };
        println!("{chapters}. {name}{limit}{pass}");
        if chapter.lessons.is_empty() {
            println!("   （无节）");
        }
        for (lesson_index, lesson) in chapter.lessons.iter().enumerate() {
            lessons += 1;
            let name = if lesson.name.trim().is_empty() {
                format!("第{}节", lesson_index + 1)
            } else {
                lesson.name.trim().to_string()
            };
            let studied = if lesson.is_studied.unwrap_or(0) != 0 {
                " [已完成]"
            } else {
                ""
            };
            println!("   {}.{} {name}{studied}", chapters, lesson_index + 1);

            let lesson_videos = lesson.all_videos();
            if lesson_videos.is_empty() {
                println!("        （无视频）");
            }
            for (video_index, video) in lesson_videos.iter().enumerate() {
                videos += 1;
                let name = if video.name.trim().is_empty() {
                    format!("小节{}", video_index + 1)
                } else {
                    video.name.trim().to_string()
                };
                let state = if video.is_studied.unwrap_or(0) != 0 {
                    "已完成"
                } else {
                    "未完成"
                };
                println!(
                    "        - {name} [{state}] 时长 {}  videoId={} lessonVideoId={}",
                    hms(video.video_sec),
                    video.video_id,
                    video.lesson_video_id
                );
            }
        }
    }
    println!(
        "\n统计：章节 {chapters}，节 {lessons}，视频 {videos}，已完成 {}",
        detail.completed_videos()
    );
}

async fn zhs_video_watch(client: &ZhsClient, reference: &str, args: VideoWatchArgs) -> Result<i32> {
    let resolved = client.resolve_course(reference).await?;
    let detail = client.course_detail(&resolved).await?;
    let options = ZhsWatchOptions {
        dry_run: args.dry_run,
        include_completed: args.include_completed,
        max_videos: args.max_videos,
        verify: true,
    };
    let targets = client.plan_videos(&detail, &options).await?;

    let course = &detail.course;
    println!(
        "{}（courseId={}，recruitId={}）",
        course.label(),
        course.course_id,
        course.recruit_id
    );
    println!(
        "视频 {} 节，平台已完成 {} 节",
        detail.total_videos(),
        detail.completed_videos()
    );
    if targets.is_empty() {
        println!("没有可处理的视频");
        return Ok(0);
    }

    let mut runnable = 0usize;
    let mut skipped = 0usize;
    for (index, target) in targets.iter().enumerate() {
        match target.skip_reason(&options) {
            Some(reason) => {
                skipped += 1;
                println!(
                    "[{}/{}] {} —— {reason}",
                    index + 1,
                    targets.len(),
                    target.label
                );
            }
            None => {
                runnable += 1;
                println!(
                    "[{}/{}] {} —— 时长 {}，将上报完整观看进度",
                    index + 1,
                    targets.len(),
                    target.label,
                    hms(target.video_sec)
                );
            }
        }
    }

    if args.dry_run {
        print_video_preview(&targets, &options)?;
        println!("\n预演：计划上报 {runnable} 节，跳过 {skipped} 节，未发送任何请求");
        return Ok(0);
    }
    if runnable == 0 {
        println!("\n所有视频均已跳过，无需执行");
        return Ok(0);
    }

    let prompt = format!("确认上报以上 {runnable} 节视频的观看进度？");
    if !confirm_real_run(&prompt, args.yes)? {
        println!("已取消，未发送任何请求。");
        return Ok(0);
    }

    println!();
    let progress = |event: ZhsProgress| {
        print_progress(&event);
        true
    };
    let outcomes = client.watch_videos(&targets, &options, &progress).await?;

    let mut summary = RunSummary::default();
    for outcome in &outcomes {
        if !matches!(outcome.state, ZhsWatchState::Ok | ZhsWatchState::Skip) {
            println!(
                "[{}] {}：{}",
                outcome.state.label(),
                outcome.label,
                outcome.message
            );
        }
        summary.record(outcome.state);
    }
    summary.print();
    Ok(summary.exit_code())
}

/// Print the fields a real video report would send, with the XOR-encoded
/// `sdsew` masked. No network and no credentials are used.
fn print_video_preview(targets: &[ZhsVideoTarget], options: &ZhsWatchOptions) -> Result<()> {
    let runnable: Vec<&ZhsVideoTarget> = targets
        .iter()
        .filter(|target| target.skip_reason(options).is_none())
        .collect();
    if runnable.is_empty() {
        return Ok(());
    }
    println!("\n将发送字段（已脱敏，仅预览）：");
    for target in runnable {
        println!("  {}（{}）", target.label, hms(target.video_sec));
        for line in video_preview_lines(target)? {
            println!("{line}");
        }
    }
    Ok(())
}

/// Build the masked dry-run preview lines of one video target.
fn video_preview_lines(target: &ZhsVideoTarget) -> Result<Vec<String>> {
    let payload = build_video_payload(target, PREVIEW_UUID, 0)?;
    let ewssw = payload["ewssw"].as_str().unwrap_or_default();
    let head: Vec<&str> = ewssw.split(',').take(5).collect();
    let count = ewssw.split(',').count();
    Ok(vec![
        format!("    ewssw = {}…（共 {count} 个观看点）", head.join(",")),
        format!(
            "    sdsew = {}（uuid 以 {} 占位）",
            mask_secret(payload["sdsew"].as_str().unwrap_or_default()),
            PREVIEW_UUID
        ),
        "    zwsds = 运行时由 prelearningNote 获取（base64(noteId)）".to_string(),
    ])
}

async fn zhs_check(client: &ZhsClient, reference: &str) -> Result<i32> {
    let course = client.resolve_course(reference).await?;
    println!(
        "{}（courseId={}，recruitId={}）",
        course.label(),
        course.course_id,
        course.recruit_id
    );

    let mut failed = false;
    let mut abnormal = false;
    match client.exception_status(&course).await {
        Ok(status) => {
            abnormal |= status.lock || status.abnormal;
            println!("视频课风控：{}", describe_status(&status));
        }
        Err(error) => {
            failed = true;
            eprintln!("视频课风控检查失败：{error:#}");
        }
    }

    match client.meet_list(&course).await {
        Ok(meets) if meets.is_empty() => println!("见面课：没有场次"),
        Ok(meets) => {
            for meet in &meets {
                match client.meet_exception_status(meet).await {
                    Ok(status) => {
                        abnormal |= status.lock || status.abnormal;
                        println!(
                            "见面课「{}」风控：{}",
                            meet.label(),
                            describe_status(&status)
                        );
                    }
                    Err(error) => {
                        failed = true;
                        eprintln!("见面课「{}」风控检查失败：{error:#}", meet.label());
                    }
                }
            }
        }
        Err(error) => {
            failed = true;
            eprintln!("获取见面课列表失败，跳过见面课风控检查：{error:#}");
        }
    }

    if abnormal {
        println!("\n检测到风控异常，请先处理异常记录后再执行秒刷。");
    }
    Ok(if failed || abnormal { 1 } else { 0 })
}

fn describe_status(status: &ZhsExceptionStatus) -> String {
    if status.lock {
        format!("已锁定（{}）", status.message)
    } else if status.abnormal {
        format!("异常（{}）", status.message)
    } else {
        format!("正常（{}）", status.message)
    }
}

async fn zhs_meet_list(client: &ZhsClient, reference: &str) -> Result<i32> {
    let course = client.resolve_course(reference).await?;
    let meets = client.meet_list(&course).await?;
    println!("{}（courseId={}）", course.label(), course.course_id);
    if meets.is_empty() {
        println!("没有见面课场次");
        return Ok(0);
    }
    for (index, meet) in meets.iter().enumerate() {
        let teacher = if meet.teacher.trim().is_empty() {
            "未知教师"
        } else {
            meet.teacher.trim()
        };
        let replay = if meet.has_replay() {
            "有回放"
        } else {
            "无回放"
        };
        println!("[{index}] {}", meet.label());
        println!(
            "      教师：{teacher}  {replay}  meetCourseId={} liveId={}",
            meet.meet_course_id, meet.live_id
        );
        if let Some(video_id) = meet.video_id {
            println!("      videoId={video_id}");
        }
    }
    Ok(0)
}

async fn zhs_meet_status(client: &ZhsClient, reference: &str, meeting: Option<u64>) -> Result<i32> {
    let course = client.resolve_course(reference).await?;
    let meets = client.meet_list(&course).await?;
    let selected = replay_meets(&meets, meeting)?;
    println!("{}（courseId={}）", course.label(), course.course_id);
    if selected.is_empty() {
        println!("没有可回放的见面课");
        return Ok(0);
    }

    let mut exit_code = 0;
    for meet in selected {
        match client.meet_progress(meet).await {
            Ok(progress) => println!(
                "{}：已看 {}/{} 分钟（{}%）",
                meet.label(),
                progress.watched_count,
                progress.total_minutes,
                progress.percent
            ),
            Err(error) => {
                exit_code = 1;
                eprintln!("{}：读取回放进度失败：{error:#}", meet.label());
            }
        }
    }
    Ok(exit_code)
}

async fn zhs_meet_watch(client: &ZhsClient, args: MeetWatchArgs) -> Result<i32> {
    if args.meeting.is_some() && args.all {
        bail!("--meeting 与 --all 不能同时使用");
    }
    let (coverage_min, coverage_max) = parse_coverage(&args.coverage)?;
    let (delay_min_ms, delay_max_ms) = parse_delay_ms(&args.delay_ms)?;
    let options = ZhsMeetWatchOptions {
        dry_run: args.dry_run,
        coverage_min,
        coverage_max,
        delay_min_ms,
        delay_max_ms,
        circuit_breaker: !args.no_circuit_breaker,
        check_every: args.check_every,
    };

    let course = client.resolve_course(&args.course).await?;
    let meets = client.meet_list(&course).await?;
    let selected = replay_meets(&meets, args.meeting)?;
    if selected.is_empty() {
        println!("没有可回放的见面课");
        return Ok(0);
    }
    if args.meeting.is_none() && !args.all && selected.len() > 1 {
        let available: Vec<String> = selected
            .iter()
            .map(|meet| {
                format!(
                    "{}（meetCourseId={}，liveId={}）",
                    meet.label(),
                    meet.meet_course_id,
                    meet.live_id
                )
            })
            .collect();
        bail!(
            "该课程有 {} 场可回放见面课，请用 --meeting <id> 指定，或加 --all 处理全部：\n  {}",
            selected.len(),
            available.join("\n  ")
        );
    }

    println!("{}（courseId={}）", course.label(), course.course_id);
    println!(
        "见面课计划：{} 场；覆盖率 {:.0}%-{:.0}%；间隔 {}-{} ms；风控检查每 {} 条（{}）",
        selected.len(),
        options.coverage_min * 100.0,
        options.coverage_max * 100.0,
        options.delay_min_ms,
        options.delay_max_ms,
        options.check_every,
        if options.circuit_breaker {
            "已启用熔断"
        } else {
            "已关闭熔断"
        }
    );

    if args.dry_run {
        println!(
            "将发送字段（已脱敏）：GET setWatchHistorySecret，paramSecret = xor_encode([recruitId, liveId, userId, minute, \"2\", videoId], \"zhihuishu\")，每分钟一条"
        );
        let progress = |event: ZhsProgress| {
            print_progress(&event);
            true
        };
        let mut planned = 0usize;
        let mut errors = 0usize;
        for meet in selected {
            match client.meet_watch(meet, &options, &progress).await {
                Ok(outcome) => {
                    planned += 1;
                    println!("[预演] {}：{}", outcome.label, outcome.message);
                }
                Err(error) => {
                    errors += 1;
                    eprintln!("[预演] {}：无法生成计划：{error:#}", meet.label());
                }
            }
        }
        println!("\n预演：{planned} 场见面课计划，未发送任何上报");
        return Ok(if errors > 0 { 1 } else { 0 });
    }

    for meet in &selected {
        match client.meet_progress(meet).await {
            Ok(progress) => println!(
                "  - {}：已看 {}/{} 分钟（{}%）",
                meet.label(),
                progress.watched_count,
                progress.total_minutes,
                progress.percent
            ),
            Err(error) => eprintln!(
                "  - {}：读取当前进度失败（仍会尝试执行）：{error:#}",
                meet.label()
            ),
        }
    }

    let prompt = format!("确认按上述参数上报 {} 场见面课的回放考勤？", selected.len());
    if !confirm_real_run(&prompt, args.yes)? {
        println!("已取消，未发送任何请求。");
        return Ok(0);
    }

    println!();
    let progress = |event: ZhsProgress| {
        print_progress(&event);
        true
    };
    let mut summary = RunSummary::default();
    let mut errors = 0usize;
    for meet in selected {
        match client.meet_watch(meet, &options, &progress).await {
            Ok(outcome) => {
                println!(
                    "[{}] {}：{}",
                    outcome.state.label(),
                    outcome.label,
                    outcome.message
                );
                summary.record(outcome.state);
            }
            Err(error) => {
                errors += 1;
                eprintln!("[失败] {}：{error:#}", meet.label());
            }
        }
    }
    summary.failed += errors;
    summary.print();
    Ok(summary.exit_code())
}

/// Select the meet courses to operate on.
///
/// Without `--meeting`, only entries that expose a replay are returned. With
/// an explicit id the entry is returned even if the list did not expose the
/// replay URL, because the user asked for it by id.
fn replay_meets(meets: &[ZhsMeet], meeting: Option<u64>) -> Result<Vec<&ZhsMeet>> {
    match meeting {
        Some(id) => {
            let selected: Vec<&ZhsMeet> = meets
                .iter()
                .filter(|meet| meet.meet_course_id == id || meet.live_id == id)
                .collect();
            if selected.is_empty() {
                let available: Vec<String> = meets
                    .iter()
                    .filter(|meet| meet.has_replay())
                    .map(|meet| {
                        format!(
                            "{}（meetCourseId={}，liveId={}）",
                            meet.label(),
                            meet.meet_course_id,
                            meet.live_id
                        )
                    })
                    .collect();
                if available.is_empty() {
                    bail!("未找到 meetCourseId/liveId 为 {id} 的见面课，且该课程没有可回放的场次");
                }
                bail!(
                    "未找到 meetCourseId/liveId 为 {id} 的见面课；可回放场次：\n  {}",
                    available.join("\n  ")
                );
            }
            Ok(selected)
        }
        None => Ok(meets.iter().filter(|meet| meet.has_replay()).collect()),
    }
}

fn print_progress(event: &ZhsProgress) {
    let suffix = if event.message.trim().is_empty() {
        String::new()
    } else {
        format!("：{}", event.message)
    };
    println!(
        "[{}] {}/{} {}{suffix}",
        event.stage.label(),
        event.done,
        event.total,
        event.label
    );
}

/// Ask for an explicit `yes` before a real (mutating) run.
///
/// A non-interactive stdin fails immediately with a hint to pass `--yes` or
/// use `--dry-run`.
fn confirm_real_run(prompt: &str, assume_yes: bool) -> Result<bool> {
    if assume_yes {
        return Ok(true);
    }
    if !std::io::stdin().is_terminal() {
        bail!(
            "真实执行需要交互确认，但当前不是交互终端；请加 --yes 确认执行，或先用 --dry-run 预览计划"
        );
    }
    print!("{prompt} 输入 yes 继续（其他任意输入将取消）：");
    std::io::stdout()
        .flush()
        .context("failed to flush stdout")?;
    let mut answer = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut answer)
        .context("failed to read the confirmation")?;
    let answer = answer.trim();
    Ok(answer.eq_ignore_ascii_case("yes") || answer.eq_ignore_ascii_case("y"))
}

/// Mask a long secret so only its first eight characters are shown.
fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return "（空）".to_string();
    }
    let shown: String = chars.iter().take(8).collect();
    format!("{shown}…（共 {} 字符，已脱敏）", chars.len())
}

/// Split a `min-max` CLI window.
fn split_range(spec: &str) -> Result<(&str, &str)> {
    let spec = spec.trim();
    let Some((min, max)) = spec.split_once('-') else {
        bail!("区间格式应为 min-max（例如 0.90-1.00 或 2000-6000）：{spec}");
    };
    let (min, max) = (min.trim(), max.trim());
    if min.is_empty() || max.is_empty() {
        bail!("区间格式应为 min-max（例如 0.90-1.00 或 2000-6000）：{spec}");
    }
    Ok((min, max))
}

fn parse_coverage(spec: &str) -> Result<(f64, f64)> {
    let (min, max) = split_range(spec)?;
    let min: f64 = min
        .parse()
        .with_context(|| format!("无法解析覆盖率下限：{min}"))?;
    let max: f64 = max
        .parse()
        .with_context(|| format!("无法解析覆盖率上限：{max}"))?;
    if !(0.0..=1.0).contains(&min) || !(0.0..=1.0).contains(&max) {
        bail!("覆盖率必须在 0.0 到 1.0 之间（例如 0.90-1.00）");
    }
    if min > max {
        bail!("覆盖率下限不能大于上限：{spec}");
    }
    Ok((min, max))
}

fn parse_delay_ms(spec: &str) -> Result<(u64, u64)> {
    let (min, max) = split_range(spec)?;
    let min: u64 = min
        .parse()
        .with_context(|| format!("无法解析间隔下限：{min}"))?;
    let max: u64 = max
        .parse()
        .with_context(|| format!("无法解析间隔上限：{max}"))?;
    if min > max {
        bail!("上报间隔下限不能大于上限：{spec}");
    }
    Ok((min, max))
}

/// Build the Ulearning client from the global `--cookies` file.
fn ulearn_client(cookies: &Path) -> Result<UlearningClient> {
    UlearningClient::from_cookie_file(cookies).context(
        "加载优学院 Cookie 失败：需要 Netscape 格式的 cookies.txt（从已登录优学院的浏览器导出，需包含 AUTHORIZATION cookie）",
    )
}

/// Dispatch one `ulearn` subcommand. The returned value is the process exit code.
async fn ulearn(command: UlearnCommand, cookies: &Path) -> Result<i32> {
    match command {
        UlearnCommand::List { json } => {
            let client = ulearn_client(cookies)?;
            ulearn_list(&client, json).await
        }
        UlearnCommand::Tree { course } => {
            let client = ulearn_client(cookies)?;
            ulearn_tree(&client, &course).await
        }
        UlearnCommand::Watch {
            course,
            dry_run,
            max_sections,
            include_completed,
            practice,
            delay_ms,
            yes,
        } => {
            let client = ulearn_client(cookies)?;
            let args = UlearnWatchArgs {
                course,
                dry_run,
                max_sections,
                include_completed,
                practice,
                delay_ms,
                yes,
            };
            ulearn_watch(&client, args).await
        }
        UlearnCommand::Check { course } => {
            let client = ulearn_client(cookies)?;
            ulearn_check(&client, &course).await
        }
    }
}

async fn ulearn_list(client: &UlearningClient, json: bool) -> Result<i32> {
    let courses = match client.list_courses().await {
        Ok(courses) => courses,
        Err(error) => {
            eprintln!("获取优学院课程列表失败：{error:#}");
            eprintln!("课程列表接口可能不可用；可改用播放器 URL 或 textbookId 指定课程，例如：");
            eprintln!(
                "  cargo run -- --cookies cookies.txt ulearn tree --course \"https://ua.ulearning.cn/learnCourse/learnCourse.html?courseId=47353&classId=1019700\""
            );
            return Ok(1);
        }
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&courses)?);
        return Ok(0);
    }
    if courses.is_empty() {
        eprintln!("没有找到优学院课程；请确认账号已选课且 Cookie 未过期");
        return Ok(0);
    }

    println!(
        "{:<12} {:<12} {:<32} {:<14} 剩余",
        "课程ID", "班级ID", "课程名称", "教师"
    );
    for course in &courses {
        let class_id = course
            .class_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "-".to_string());
        println!(
            "{:<12} {:<12} {:<32} {:<14} {}",
            course.textbook_id,
            class_id,
            course.name,
            course.author.as_deref().unwrap_or("-"),
            format_remaining(course.remaining_secs)
        );
    }
    println!("\n共 {} 门优学院课程", courses.len());
    Ok(0)
}

async fn ulearn_tree(client: &UlearningClient, reference: &str) -> Result<i32> {
    let course = client.resolve_course(reference)?;
    let detail = client.course_detail(&course).await?;
    print_ulearn_header(&detail);

    for (chapter_index, chapter) in detail.chapters.iter().enumerate() {
        let chapter_number = chapter_index + 1;
        let name = if chapter.name.trim().is_empty() {
            format!("第{chapter_number}讲")
        } else {
            chapter.name.trim().to_string()
        };
        println!("{chapter_number}. {name}");
        if chapter.sections.is_empty() {
            println!("   （无节）");
        }
        for (section_index, section) in chapter.sections.iter().enumerate() {
            let status = match client.section_record(section.id).await {
                Ok(record) if record.completed() => "已完成",
                Ok(_) => "未完成",
                Err(_) => "状态未知",
            };
            let name = if section.name.trim().is_empty() {
                format!("第{}节", section_index + 1)
            } else {
                section.name.trim().to_string()
            };
            println!(
                "   {chapter_number}.{} {name} [{status}] itemid={}",
                section_index + 1,
                section.id
            );
            if section.pages.is_empty() {
                println!("        （目录未返回页面；watch 时会重新枚举）");
            }
            for (page_index, page) in section.pages.iter().enumerate() {
                let kind = if page.is_video() {
                    "视频"
                } else if page.is_practice() {
                    "练习"
                } else if page.is_document() {
                    "图文"
                } else {
                    "其他"
                };
                let name = if page.name.trim().is_empty() {
                    format!("页面{}", page_index + 1)
                } else {
                    page.name.trim().to_string()
                };
                println!(
                    "        - [{kind}] {name} pageId={} relationId={}",
                    page.id, page.relation_id
                );
            }
        }
    }
    println!(
        "\n统计：章节 {}，节 {}",
        detail.chapters.len(),
        detail.section_count()
    );
    Ok(0)
}

fn print_ulearn_header(detail: &UlCourseDetail) {
    let course = &detail.course;
    let class_id = course
        .class_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "-".to_string());
    println!(
        "{}（textbookId={}，classId={}，剩余：{}）",
        course.label(),
        course.textbook_id,
        class_id,
        format_remaining(detail.remaining_secs.or(course.remaining_secs))
    );
    if let Some(class_name) = detail
        .class_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
    {
        println!("班级：{}", class_name.trim());
    }
}

async fn ulearn_watch(client: &UlearningClient, args: UlearnWatchArgs) -> Result<i32> {
    let (delay_min_ms, delay_max_ms) = parse_delay_ms(&args.delay_ms)?;
    let options = UlWatchOptions {
        dry_run: args.dry_run,
        include_completed: args.include_completed,
        max_sections: args.max_sections,
        delay_min_ms,
        delay_max_ms,
        stop_on_error: true,
        verify: true,
    };
    let course = client.resolve_course(&args.course)?;
    let progress = |event: UlProgress| {
        print_ul_progress(&event);
        true
    };
    let plan = plan_course(client, &course, &options, &progress).await?;
    if plan.cancelled {
        println!("计划已取消");
        return Ok(0);
    }
    let (_, practice_sections, done, unsupported) = plan.counts();
    print_ulearn_plan(&plan, args.practice);

    let executable = count_executable(&plan, args.practice);
    if args.dry_run {
        print_ul_payload_preview(&plan, args.practice)?;
        println!(
            "\n预演：将提交 {executable} 节，跳过 {} 节（已完成 {done}、不支持 {unsupported}），未发送任何请求",
            plan.sections.len().saturating_sub(executable)
        );
        if !args.practice && practice_sections > 0 {
            println!("提示：{practice_sections} 个含练习的节已跳过，加 --practice 才会提交。");
        }
        return Ok(0);
    }
    if executable == 0 {
        println!("\n没有需要提交的节");
        return Ok(0);
    }

    let prompt = format!("确认提交以上 {executable} 节的完成记录吗？");
    if !confirm_real_run(&prompt, args.yes)? {
        println!("已取消，未发送任何请求。");
        return Ok(0);
    }

    println!();
    let mut execution_plan = plan.clone();
    if !args.practice {
        execution_plan
            .sections
            .retain(|section| section.action != UlAction::CompletePractice);
    }
    let outcomes = run_watch(client, &execution_plan, &options, &progress).await?;

    let mut summary = RunSummary::default();
    if !args.practice {
        summary.skipped += plan
            .sections
            .iter()
            .filter(|section| section.action == UlAction::CompletePractice)
            .count();
    }
    for outcome in &outcomes {
        if !matches!(outcome.state, UlWatchState::Ok | UlWatchState::Skip) {
            println!(
                "[{}] {}：{}",
                outcome.state.label(),
                outcome.label,
                outcome.message
            );
        }
        summary.record_ul(outcome.state);
    }
    summary.print();
    Ok(summary.exit_code())
}

fn print_ulearn_plan(plan: &UlPlan, practice: bool) {
    let (complete, practice_sections, done, unsupported) = plan.counts();
    let class_id = plan
        .course
        .class_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "-".to_string());
    println!(
        "\n课程：{}（textbookId={}，classId={}，剩余：{}）",
        plan.course.label(),
        plan.course.textbook_id,
        class_id,
        format_remaining(plan.remaining_secs.or(plan.course.remaining_secs))
    );
    println!(
        "计划：可刷视频/图文 {complete} 节，含练习 {practice_sections} 节，已完成 {done} 节，不支持 {unsupported} 节"
    );
    if !practice && practice_sections > 0 {
        println!("（含练习的节默认跳过；加 --practice 才会提交）");
    }
    for (position, section) in plan.sections.iter().enumerate() {
        let index = position + 1;
        let label = section.label();
        if section.action == UlAction::CompletePractice && !practice {
            println!("[{index}] {label} —— 跳过：含练习（未加 --practice）");
            continue;
        }
        match section.action {
            UlAction::Complete | UlAction::CompletePractice => {
                let start = section.study_start_time.unwrap_or(0);
                println!(
                    "[{index}] {label} —— {}，itemid={}，studyStartTime={start}，{}",
                    section.action.label(),
                    section.section_id,
                    section.summary()
                );
            }
            UlAction::SkipDone => println!("[{index}] {label} —— 已完成，跳过"),
            UlAction::SkipUnsupported | UlAction::SkipExpired => {
                println!(
                    "[{index}] {label} —— {}：{}",
                    section.action.label(),
                    section.note
                );
            }
        }
    }
}

/// Number of sections that would actually be submitted.
fn count_executable(plan: &UlPlan, practice: bool) -> usize {
    plan.sections
        .iter()
        .filter(|section| {
            section.is_actionable() && (practice || section.action != UlAction::CompletePractice)
        })
        .count()
}

fn print_ul_payload_preview(plan: &UlPlan, practice: bool) -> Result<()> {
    let executable: Vec<&UlSectionPlan> = plan
        .sections
        .iter()
        .filter(|section| {
            section.is_actionable() && (practice || section.action != UlAction::CompletePractice)
        })
        .collect();
    if executable.is_empty() {
        return Ok(());
    }
    println!("\n将发送的 payload 摘要（正文经 DES 加密后提交，不打印 token/密文）：");
    for section in executable {
        let start = section.study_start_time.unwrap_or(0);
        println!(
            "  {}：{}",
            section.label(),
            ul_payload_summary(section, start)?
        );
    }
    Ok(())
}

/// Build a one-line, secret-free summary of the `sync` payload.
fn ul_payload_summary(section: &UlSectionPlan, study_start_time: i64) -> Result<String> {
    let payload = build_record_payload(section, study_start_time)?;
    let mut pages = Vec::new();
    for page in payload["pageStudyRecordDTOList"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let page_id = page["pageid"].as_i64().unwrap_or(0);
        let mut detail = format!("pageid={page_id}/complete={}", page["complete"]);
        let videos: Vec<String> = page["videos"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|video| format!("videoid={}/time={}", video["videoid"], video["time"]))
            .collect();
        if !videos.is_empty() {
            detail.push_str(&format!("，视频[{}]", videos.join(",")));
        }
        let questions = page["questions"].as_array().map(Vec::len).unwrap_or(0);
        if questions > 0 {
            detail.push_str(&format!("，练习 {questions} 题"));
        }
        pages.push(detail);
    }
    Ok(format!(
        "POST sync itemid={}，complete=1，score={}，studyStartTime={}，{} 页 [{}]",
        payload["itemid"].as_i64().unwrap_or(0),
        payload["score"].as_i64().unwrap_or(0),
        payload["studyStartTime"].as_i64().unwrap_or(0),
        pages.len(),
        pages.join("；")
    ))
}

async fn ulearn_check(client: &UlearningClient, reference: &str) -> Result<i32> {
    match client.validate().await {
        Ok(_) => println!("会话：有效"),
        Err(error) => {
            eprintln!("优学院会话无效：{error:#}");
            return Ok(1);
        }
    }
    let course = client.resolve_course(reference)?;
    let detail = client.course_detail(&course).await?;
    print_ulearn_header(&detail);

    let sections = detail.section_count();
    let mut completed = 0usize;
    let mut unknown = 0usize;
    for chapter in &detail.chapters {
        for section in &chapter.sections {
            match client.section_record(section.id).await {
                Ok(record) if record.completed() => completed += 1,
                Ok(_) => {}
                Err(_) => unknown += 1,
            }
        }
    }
    let remaining = sections.saturating_sub(completed + unknown);
    println!(
        "\n章节：{} 章 / {sections} 节；已完成 {completed} 节，未完成 {remaining} 节，状态未知 {unknown} 节",
        detail.chapters.len()
    );
    if detail.is_expired() {
        println!("可学性：已过期，拒绝刷课");
        return Ok(1);
    }
    if sections == 0 {
        println!("可学性：目录为空，无法刷课");
        return Ok(1);
    }
    println!("可学性：可以刷课（建议先用 --dry-run 预览）");
    Ok(0)
}

fn format_remaining(seconds: Option<i64>) -> String {
    match seconds {
        None => "未知".to_string(),
        Some(secs) if secs < 0 => "已过期".to_string(),
        Some(secs) if secs < 3_600 => format!("{} 分钟", (secs / 60).max(1)),
        Some(secs) if secs < 86_400 => format!("{} 小时", secs / 3_600),
        Some(secs) => format!("{} 天", secs / 86_400),
    }
}

fn print_ul_progress(event: &UlProgress) {
    let suffix = if event.message.trim().is_empty() {
        String::new()
    } else {
        format!("：{}", event.message)
    };
    println!(
        "[{}] {}/{} {}{suffix}",
        event.stage.label(),
        event.done,
        event.total,
        event.label
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use hust_course_hack::ulearning::{UlPage, UlPageKind, UlPagePlan, UlQuestionAnswer, UlVideo};

    fn meet(meet_course_id: u64, live_id: u64, has_replay: bool) -> ZhsMeet {
        ZhsMeet {
            meet_course_id,
            live_id,
            replay_url: has_replay
                .then(|| "https://lc.zhihuishu.com/live/vod_room.html".to_string()),
            ..ZhsMeet::default()
        }
    }

    #[test]
    fn masks_secret_values() {
        let masked = mask_secret("0123456789abcdef");
        assert!(masked.starts_with("01234567"));
        assert!(!masked.contains("89abcdef"));
        assert!(masked.contains("共 16 字符"));
        assert_eq!(mask_secret(""), "（空）");
        assert!(mask_secret("short").starts_with("short"));
    }

    #[test]
    fn parses_cli_ranges() {
        assert_eq!(parse_coverage("0.90-1.00").unwrap(), (0.90, 1.00));
        assert!(parse_coverage("90-100").is_err());
        assert!(parse_coverage("1.20-1.50").is_err());
        assert!(parse_coverage("0.99-0.90").is_err());
        assert!(parse_coverage("bad").is_err());

        assert_eq!(parse_delay_ms("2000-6000").unwrap(), (2000, 6000));
        assert!(parse_delay_ms("6000-2000").is_err());
        assert!(parse_delay_ms("-").is_err());
        assert!(parse_delay_ms("1.5-2").is_err());
    }

    #[test]
    fn selects_meet_replays() {
        let meets = vec![meet(1, 11, true), meet(2, 22, false), meet(3, 33, true)];
        let replays = replay_meets(&meets, None).unwrap();
        assert_eq!(replays.len(), 2);
        assert_eq!(replays[0].meet_course_id, 1);
        assert_eq!(replays[1].meet_course_id, 3);

        let by_id = replay_meets(&meets, Some(22)).unwrap();
        assert_eq!(by_id.len(), 1);
        assert_eq!(by_id[0].live_id, 22);

        assert!(replay_meets(&meets, Some(99)).is_err());
    }

    #[test]
    fn summarizes_terminal_states() {
        let mut summary = RunSummary::default();
        summary.record(ZhsWatchState::Ok);
        summary.record(ZhsWatchState::Ok);
        summary.record(ZhsWatchState::Skip);
        assert_eq!(summary.ok, 2);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.exit_code(), 0);

        summary.record(ZhsWatchState::Failed);
        assert_eq!(summary.exit_code(), 1);

        let mut broken = RunSummary::default();
        broken.record(ZhsWatchState::CircuitBroken);
        assert_eq!(broken.aborted, 1);
        assert_eq!(broken.exit_code(), 1);

        let mut cancelled = RunSummary::default();
        cancelled.record(ZhsWatchState::Cancelled);
        assert_eq!(cancelled.cancelled, 1);
        assert_eq!(cancelled.exit_code(), 1);
    }

    #[test]
    fn builds_masked_video_preview() {
        let target = ZhsVideoTarget {
            recruit_id: 463667,
            course_id: 1000011214,
            chapter_id: 1000116293,
            lesson_id: 1000337351,
            lesson_video_id: 1000244446,
            video_id: 70622143,
            video_sec: 468,
            label: "军事理论 / 第一章 / 第一节".to_string(),
            completed: false,
        };
        let lines = video_preview_lines(&target).unwrap();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("ewssw"));
        assert!(lines[0].contains("观看点"));
        assert!(lines[1].contains("sdsew"));
        assert!(lines[1].contains("已脱敏"));
        assert!(lines[2].contains("zwsds"));
    }

    fn ul_video_section() -> UlSectionPlan {
        UlSectionPlan {
            chapter_id: 141_351_390,
            chapter_name: "第一讲 导论".to_string(),
            section_id: 2_377_981,
            section_name: "第一节".to_string(),
            pages: vec![UlPagePlan {
                page: UlPage {
                    id: 2_377_983,
                    relation_id: 2_377_984,
                    name: "视频页".to_string(),
                    content_type: 6,
                },
                kind: UlPageKind::Video,
                videos: vec![UlVideo {
                    video_id: 1_563_126,
                    duration_secs: 1_326,
                }],
                questions: Vec::new(),
                coursepage_id: None,
                score: 100,
            }],
            action: UlAction::Complete,
            study_start_time: Some(1_794_062_059),
            score: 100,
            note: String::new(),
        }
    }

    fn ul_practice_section() -> UlSectionPlan {
        UlSectionPlan {
            chapter_id: 141_351_390,
            chapter_name: "第一讲 导论".to_string(),
            section_id: 2_379_018,
            section_name: "章节练习".to_string(),
            pages: vec![UlPagePlan {
                page: UlPage {
                    id: 2_379_019,
                    relation_id: 2_379_020,
                    name: "章节练习".to_string(),
                    content_type: 7,
                },
                kind: UlPageKind::Practice,
                videos: Vec::new(),
                questions: vec![UlQuestionAnswer {
                    question_id: 17_393_623,
                    score: 20,
                    answer: vec!["D".to_string()],
                }],
                coursepage_id: Some(9_002),
                score: 100,
            }],
            action: UlAction::CompletePractice,
            study_start_time: Some(1_794_062_059),
            score: 100,
            note: String::new(),
        }
    }

    #[test]
    fn formats_remaining_windows() {
        assert_eq!(format_remaining(None), "未知");
        assert_eq!(format_remaining(Some(-1)), "已过期");
        assert_eq!(format_remaining(Some(120)), "2 分钟");
        assert_eq!(format_remaining(Some(3_600)), "1 小时");
        assert_eq!(format_remaining(Some(2 * 86_400)), "2 天");
    }

    #[test]
    fn builds_ulearn_payload_summaries_without_secrets() {
        let video_line = ul_payload_summary(&ul_video_section(), 1_794_062_059).unwrap();
        assert!(video_line.contains("itemid=2377981"));
        assert!(video_line.contains("videoid=1563126/time=1326"));
        assert!(!video_line.contains("AUTHORIZATION"));
        assert!(!video_line.contains("token"));

        let practice_line = ul_payload_summary(&ul_practice_section(), 1_794_062_059).unwrap();
        assert!(practice_line.contains("itemid=2379018"));
        assert!(practice_line.contains("练习 1 题"));
        assert!(!practice_line.contains("answerList"));
    }

    #[test]
    fn counts_executable_sections_with_the_practice_toggle() {
        let plan = UlPlan {
            sections: vec![
                UlSectionPlan {
                    action: UlAction::Complete,
                    ..UlSectionPlan::default()
                },
                UlSectionPlan {
                    action: UlAction::CompletePractice,
                    ..UlSectionPlan::default()
                },
                UlSectionPlan {
                    action: UlAction::SkipDone,
                    ..UlSectionPlan::default()
                },
            ],
            ..UlPlan::default()
        };
        assert_eq!(count_executable(&plan, false), 1);
        assert_eq!(count_executable(&plan, true), 2);
    }

    #[test]
    fn summarizes_ulearn_terminal_states() {
        let mut summary = RunSummary::default();
        summary.record_ul(UlWatchState::Ok);
        summary.record_ul(UlWatchState::Skip);
        summary.record_ul(UlWatchState::CircuitBroken);
        summary.record_ul(UlWatchState::Failed);
        assert_eq!(summary.ok, 1);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.aborted, 1);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.exit_code(), 1);
    }
}
