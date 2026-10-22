use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use hust_course_hack::{
    Chapter, CourseDetail, CourseSummary, FetchOptions, REPORT_VERSION, SmartCourseClient,
    TaskKind, TaskPoint, VIDEO_HELPER_SCRIPT, WatchOptions, collect_targets, watch_target,
};
use serde::Serialize;
use std::{
    path::PathBuf,
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
    /// Write the Tampermonkey video helper script to a file or stdout.
    Helper {
        /// Output path; defaults to stdout.
        #[arg(long)]
        out: Option<PathBuf>,
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
