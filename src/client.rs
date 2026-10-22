//! Authenticated SmartCourse HTTP client.
//!
//! The crawl and video-report endpoints below were verified against
//! `smartcourse.hust.edu.cn` with a real student session. They are
//! Chaoxing-style endpoints exposed through the university's
//! `fyportal-smartcourse` and `mooc-ans` applications.
//!
//! Quiz submission uses the same client, but its POST handler has not been
//! verified against a live answering session yet; see [`crate::submit`].

use crate::{
    answers::AnswerBank,
    cookie,
    models::{
        Card, CourseDetail, CourseStats, CourseSummary, FetchOptions, PlaybackEnv, TaskKind,
        TaskPoint,
    },
    parse,
    submit::{
        self, CourseSubmissionPlan, PlannedWork, QuestionAnswer, SubmissionRequest, SubmitProgress,
        SubmitReply, WorkPage, WorkStatus, WorkSubmitOutcome, WorkTarget,
    },
};
use anyhow::{Context, Result, bail};
use futures::stream::{self, StreamExt};
use reqwest::{
    Client,
    cookie::{CookieStore, Jar},
    header::{ACCEPT, ACCEPT_LANGUAGE, REFERER},
};
use serde_json::Value;
use std::{path::Path, sync::Arc, time::Duration};
use url::Url;

pub const DEFAULT_BASE_URL: &str = "https://smartcourse.hust.edu.cn/";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const COURSE_LIST_REFERER: &str =
    "https://smartcourse.hust.edu.cn/fyportal-smartcourse/wfw/courselist/course3";

/// Progress snapshot emitted while crawling one course.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CrawlProgress {
    /// Number of knowledge points that will be fetched.
    pub total_leaves: usize,
    /// Knowledge points finished so far (successful or not).
    pub done_leaves: usize,
}

#[derive(Clone)]
pub struct SmartCourseClient {
    http: Client,
    base: Url,
    jar: Arc<Jar>,
}

impl SmartCourseClient {
    /// Build a client from an already populated cookie jar.
    pub fn with_cookie_jar(jar: Arc<Jar>) -> Result<Self> {
        Self::with_cookie_jar_and_base(jar, DEFAULT_BASE_URL)
    }

    pub fn with_cookie_jar_and_base(jar: Arc<Jar>, base: &str) -> Result<Self> {
        let base = Url::parse(base).context("invalid base URL")?;
        let http = Client::builder()
            .cookie_provider(Arc::clone(&jar))
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(40))
            .redirect(reqwest::redirect::Policy::limited(12))
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(
                    ACCEPT_LANGUAGE,
                    "zh-CN,zh;q=0.9,en;q=0.8".parse().expect("static header"),
                );
                headers.insert(
                    ACCEPT,
                    "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
                        .parse()
                        .expect("static header"),
                );
                headers
            })
            .build()
            .context("failed to build HTTP client")?;
        Ok(Self { http, base, jar })
    }

    /// Load cookies from a Netscape `cookies.txt` file.
    pub fn from_cookie_file(path: impl AsRef<Path>) -> Result<Self> {
        let jar = cookie::load_cookie_jar(path)?;
        Self::with_cookie_jar(jar)
    }

    /// Build a client from a raw `Cookie:` header value.
    pub fn from_cookie_header(header: &str) -> Result<Self> {
        let jar = cookie::jar_from_cookie_header(header)?;
        Self::with_cookie_jar(jar)
    }

    pub fn base_url(&self) -> &Url {
        &self.base
    }

    /// Read a cookie value from the jar, used as a fallback for ids that the
    /// cards page does not always expose.
    pub fn cookie_value(&self, name: &str) -> Option<String> {
        let header = self.jar.cookies(&self.base)?;
        let text = header.to_str().ok()?;
        text.split(';').find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then(|| value.to_string())
        })
    }

    /// Student course list for the current semester.
    pub async fn list_courses(&self) -> Result<Vec<CourseSummary>> {
        Ok(self.list_courses_with_url().await?.0)
    }

    /// Course list plus the final URL of the response.
    ///
    /// An unauthenticated request is redirected to the platform landing page,
    /// so the final URL distinguishes "logged in with no courses" from a
    /// missing session.
    pub async fn list_courses_with_url(&self) -> Result<(Vec<CourseSummary>, Url)> {
        let url = self.endpoint(
            "fyportal-smartcourse/fyportal/wfw/courselist/getStudyCourse",
            &[("sectionId", "0")],
        );
        let (html, final_url) = self.get_text(&url, Some(COURSE_LIST_REFERER)).await?;
        let courses = parse::parse_course_list(&html, &self.base)?;
        Ok((courses, final_url))
    }

    /// Crawl one course: home page, chapter tree, cards and task points.
    pub async fn fetch_course(
        &self,
        course: &CourseSummary,
        options: &FetchOptions,
    ) -> Result<CourseDetail> {
        self.fetch_course_with_progress(course, options, &|_| true)
            .await
    }

    /// Crawl one course and report progress after every knowledge point.
    ///
    /// The callback returns `true` to keep going. Returning `false` drops the
    /// remaining in-flight requests and fails with `cancelled`.
    pub async fn fetch_course_with_progress(
        &self,
        course: &CourseSummary,
        options: &FetchOptions,
        progress: &(dyn Fn(CrawlProgress) -> bool + Send + Sync),
    ) -> Result<CourseDetail> {
        log::info!("course {} ({})", course.name, course.course_id);

        let (home_html, final_url) = self
            .get_text(&course.detail_url, Some(COURSE_LIST_REFERER))
            .await
            .context("failed to load course home page")?;
        let page = parse::parse_course_page(&home_html)?;
        let title = if page.title.is_empty() {
            course.name.clone()
        } else {
            page.title.clone()
        };

        // The list page normally carries all ids, but fall back to the ids
        // echoed by the course page if an attribute is ever missing.
        let mut effective = course.clone();
        if effective.course_id.is_empty() {
            effective.course_id = page.course_id.clone().unwrap_or_default();
        }
        if effective.class_id.is_empty() {
            effective.class_id = page.class_id.clone().unwrap_or_default();
        }
        if effective.cpi.is_empty() {
            effective.cpi = page.cpi.clone().unwrap_or_default();
        }
        let course = &effective;

        let tree_url = self.endpoint(
            "mooc-ans/mycourse/studentstudycourselist",
            &[
                ("courseId", course.course_id.as_str()),
                ("chapterId", "0"),
                ("clazzid", course.class_id.as_str()),
                ("cpi", course.cpi.as_str()),
                ("mooc2", "1"),
            ],
        );
        let (tree_html, _) = self
            .get_text(&tree_url, Some(final_url.as_str()))
            .await
            .context("failed to load chapter tree")?;
        let mut chapters = parse::parse_chapter_tree(&tree_html)?;

        let ids = parse::leaf_ids(&chapters);
        let total = ids.len();
        log::info!("course {}: {} knowledge points", course.course_id, total);

        let mut stats = CourseStats {
            leaves: total,
            ..CourseStats::default()
        };
        stats.chapter_nodes = count_nodes(&chapters);

        let fetched = {
            let mut stream = stream::iter(ids.into_iter().enumerate().map(|(order, id)| {
                let client = self.clone();
                let course = course.clone();
                let options = options.clone();
                async move {
                    let result = client.fetch_leaf(&course, &id, &options).await;
                    (order, id, result)
                }
            }))
            .buffer_unordered(options.concurrency.max(1));

            let mut results = Vec::with_capacity(total);
            let mut done = 0usize;
            if !progress(CrawlProgress {
                total_leaves: total,
                done_leaves: 0,
            }) {
                bail!("cancelled");
            }
            while let Some(item) = stream.next().await {
                done += 1;
                results.push(item);
                if !progress(CrawlProgress {
                    total_leaves: total,
                    done_leaves: done,
                }) {
                    bail!("cancelled");
                }
            }
            results
        };

        let mut by_leaf = std::collections::HashMap::new();
        let mut results = fetched;
        results.sort_by_key(|(order, _, _)| *order);

        for (_, id, result) in results {
            match result {
                Ok(leaf) => {
                    for error in leaf.errors {
                        stats.errors.push(format!("knowledge {id}: {error}"));
                    }
                    for card in &leaf.cards {
                        stats.cards += 1;
                        for point in &card.task_points {
                            stats.task_points += 1;
                            match point.kind {
                                TaskKind::Video => stats.videos += 1,
                                TaskKind::Document => stats.documents += 1,
                                TaskKind::Work => stats.works += 1,
                                _ => {}
                            }
                            stats.questions += point.questions.len();
                        }
                    }
                    by_leaf.insert(id, leaf.cards);
                }
                Err(error) => stats.errors.push(format!("knowledge {id}: {error:#}")),
            }
        }

        parse::attach_cards(&mut chapters, &by_leaf);

        Ok(CourseDetail {
            course: course.clone(),
            title,
            enc: page.enc,
            old_enc: page.old_enc,
            openc: page.openc,
            final_url: final_url.to_string(),
            chapters,
            stats,
        })
    }

    async fn fetch_leaf(
        &self,
        course: &CourseSummary,
        knowledge_id: &str,
        options: &FetchOptions,
    ) -> Result<LeafResult> {
        let ajax_url = self.endpoint(
            "mooc-ans/mycourse/studentstudyAjax",
            &[
                ("courseId", course.course_id.as_str()),
                ("clazzid", course.class_id.as_str()),
                ("chapterId", knowledge_id),
                ("cpi", course.cpi.as_str()),
                ("verificationcode", ""),
                ("mooc2", "1"),
                ("toComputer", "false"),
                ("microTopicId", "0"),
                ("editorPreview", "0"),
                ("isPreviewVideo", "false"),
                ("videoWidth", "0"),
                ("videoHeight", "0"),
                ("targetVideoJobId", ""),
                ("cardIndex", "0"),
                ("ut", "s"),
            ],
        );
        let (html, _) = self
            .get_text(
                &ajax_url,
                Some("https://smartcourse.hust.edu.cn/mooc-ans/mycourse/studentstudy"),
            )
            .await
            .with_context(|| format!("studentstudyAjax failed for knowledge {knowledge_id}"))?;

        let cards = parse::parse_card_list(&html)?;
        let mut out = Vec::with_capacity(cards.len());
        let mut errors = Vec::new();

        for mut card in cards {
            let num = (card.index - 1).to_string();
            let cards_url = self.endpoint(
                "mooc-ans/knowledge/cards",
                &[
                    ("clazzid", course.class_id.as_str()),
                    ("courseid", course.course_id.as_str()),
                    ("knowledgeid", knowledge_id),
                    ("num", num.as_str()),
                    ("ut", "s"),
                    ("cpi", course.cpi.as_str()),
                    ("v", "2025-0424-1038-4"),
                    ("mooc2", "1"),
                    ("isMicroCourse", "false"),
                    ("editorPreview", "0"),
                    ("crossId", ""),
                ],
            );

            match self
                .fetch_card(course, knowledge_id, &cards_url, &ajax_url, options)
                .await
            {
                Ok((points, playback)) => {
                    card.task_points = points;
                    card.playback = playback;
                }
                Err(error) => {
                    log::warn!(
                        "knowledge {knowledge_id} card {} failed: {error:#}",
                        card.index
                    );
                    errors.push(format!("card {}: {error:#}", card.index));
                }
            }
            out.push(card);
        }

        Ok(LeafResult { cards: out, errors })
    }

    async fn fetch_card(
        &self,
        course: &CourseSummary,
        knowledge_id: &str,
        cards_url: &str,
        referer: &str,
        options: &FetchOptions,
    ) -> Result<(Vec<TaskPoint>, Option<PlaybackEnv>)> {
        let (html, _) = self.get_text(cards_url, Some(referer)).await?;
        let marg = parse::extract_marg(&html)?;
        let content = parse::parse_card_content(&marg);
        let mut playback = parse::parse_playback_env(&content.defaults);
        // Some deployments put reportUrl on mArg itself instead of defaults.
        if let Some(env) = playback.as_mut()
            && env.report_url.is_none()
        {
            env.report_url = marg
                .get("reportUrl")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        let fid = content
            .defaults
            .get("fid")
            .and_then(Value::as_str)
            .unwrap_or("1731")
            .to_string();
        let ktoken = content
            .defaults
            .get("ktoken")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let mut points = content.task_points;
        for point in &mut points {
            match point.kind {
                TaskKind::Video if options.include_video_info => {
                    if let Some(object_id) = point.object_id.clone() {
                        match self.video_info(&object_id, &fid, cards_url).await {
                            Ok(info) => point.video = Some(info),
                            Err(error) => {
                                log::debug!("video status for {object_id} failed: {error:#}")
                            }
                        }
                    }
                }
                TaskKind::Work if options.include_questions => {
                    let Some(work_id) = point.work_id.clone() else {
                        continue;
                    };
                    let job_id = point
                        .job_id
                        .clone()
                        .unwrap_or_else(|| format!("work-{work_id}"));
                    match self
                        .work_questions(
                            course,
                            knowledge_id,
                            &work_id,
                            &job_id,
                            &ktoken,
                            point,
                            cards_url,
                        )
                        .await
                    {
                        Ok((questions, status)) => {
                            point.questions = questions;
                            point.work_status = status;
                        }
                        Err(error) => {
                            log::warn!("work {work_id} questions failed: {error:#}");
                        }
                    }
                }
                _ => {}
            }
        }

        Ok((points, playback))
    }

    async fn video_info(
        &self,
        object_id: &str,
        fid: &str,
        referer: &str,
    ) -> Result<crate::models::VideoInfo> {
        let url = self.endpoint(
            &format!("ananas/status/{object_id}"),
            &[("k", fid), ("flag", "normal")],
        );
        let (body, _) = self.get_text(&url, Some(referer)).await?;
        let json: Value = serde_json::from_str(&body).context("video status is not JSON")?;
        Ok(parse::parse_video_info(&json))
    }

    /// Send one video progress heartbeat. The response's `isPassed` field is
    /// the authoritative completion signal.
    pub async fn report_video_progress(
        &self,
        target: &crate::playback::WatchTarget,
        playing_secs: u64,
        is_drag: u8,
    ) -> Result<crate::playback::ReportReply> {
        let url = target.report_url(&self.base, playing_secs, is_drag)?;
        let (body, final_url) = self
            .get_text_with_headers(
                &url,
                Some(crate::playback::PLAYER_REFERER),
                &[
                    ("Accept", "*/*"),
                    (
                        "Accept-Language",
                        "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
                    ),
                    ("Content-Type", "application/json"),
                    ("Sec-Fetch-Dest", "empty"),
                    ("Sec-Fetch-Mode", "cors"),
                    ("Sec-Fetch-Site", "same-origin"),
                    (
                        "User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                         (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
                    ),
                    (
                        "sec-ch-ua",
                        "\"Microsoft Edge\";v=\"155\", \"Chromium\";v=\"155\", \"Not(A:Brand\";v=\"24\"",
                    ),
                    ("sec-ch-ua-mobile", "?0"),
                    ("sec-ch-ua-platform", "\"Windows\""),
                ],
            )
            .await
            .with_context(|| format!("video report failed for job {}", target.job_id))?;

        if body.contains("passport")
            || body.contains("请先登录")
            || body.contains("用户登录")
            || body.contains("login")
        {
            bail!("login expired while reporting video progress ({final_url})");
        }

        let reply: crate::playback::ReportReply =
            serde_json::from_str(&body).with_context(|| {
                let snippet: String = body.chars().take(200).collect();
                format!("video report returned non-JSON ({final_url}): {snippet}")
            })?;
        if reply.success == Some(false) {
            bail!(
                "platform rejected the video report: {}",
                reply.msg.as_deref().unwrap_or("unknown error")
            );
        }
        Ok(reply)
    }

    /// Fetch the answering (or graded) page for one work.
    ///
    /// This always talks to the platform; callers should use the cached
    /// [`CourseDetail`] only for planning, not for the submit payload, because
    /// `enc_work`/`workAnswerId` are page-bound and must be current.
    pub async fn fetch_work_page(&self, target: &WorkTarget) -> Result<WorkPage> {
        let url = self.work_endpoint(target);
        let referer = target
            .referer
            .as_deref()
            .unwrap_or(submit::DEFAULT_WORK_REFERER);
        let (html, final_url) = self
            .get_text(&url, Some(referer))
            .await
            .with_context(|| format!("failed to load work {}", target.work_id))?;
        if html.contains("没有此页面访问权限") || html.contains("您长时间没有操作")
        {
            bail!("work page denied access ({final_url})");
        }

        let status = if final_url.path().contains("selectWorkQuestionYiPiYue")
            || html.contains("查看已批改")
        {
            WorkStatus::Graded
        } else if final_url.path().contains("doHomeWorkNew") || html.contains("doHomeWorkNew") {
            WorkStatus::InProgress
        } else {
            WorkStatus::Unknown
        };

        Ok(WorkPage {
            final_url: final_url.to_string(),
            status,
            questions: parse::parse_questions(&html),
            form: submit::parse_work_form(&html),
        })
    }

    /// Fetch the work page and build the exact POST without sending it.
    pub async fn prepare_work_submission(
        &self,
        target: &WorkTarget,
        answers: &[QuestionAnswer],
    ) -> Result<SubmissionRequest> {
        let page = self.fetch_work_page(target).await?;
        submit::prepare_submission(&self.base, target, &page, answers, submit::now_millis())
    }

    /// Submit answers for one work, re-fetching the page for fresh tokens.
    pub async fn submit_work_answers(
        &self,
        target: &WorkTarget,
        answers: &[QuestionAnswer],
    ) -> Result<SubmitReply> {
        let page = self.fetch_work_page(target).await?;
        self.validate_work_before_submit(target, &page.final_url)
            .await?;
        self.submit_work_page(target, &page, answers).await
    }

    /// Reproduce the page's `validateTimeNew` check.
    ///
    /// The answering page calls `GET /mooc-ans/work/validate` before enabling
    /// the final POST. Status 1 means the account/session is abnormal; status 2
    /// requires the platform's captcha, which this crate does not solve.
    async fn validate_work_before_submit(&self, target: &WorkTarget, referer: &str) -> Result<()> {
        let url = self.endpoint(
            "mooc-ans/work/validate",
            &[
                ("classId", target.class_id.as_str()),
                ("courseId", target.course_id.as_str()),
                ("knowledgeId", target.knowledge_id.as_str()),
                ("cpi", target.cpi.as_str()),
            ],
        );
        let (body, final_url) = self
            .get_text_with_headers(
                &url,
                Some(referer),
                &[
                    ("X-Requested-With", "XMLHttpRequest"),
                    ("Accept", "application/json, text/javascript, */*; q=0.01"),
                ],
            )
            .await
            .with_context(|| format!("work validation failed for {}", target.work_id))?;
        let value: Value = serde_json::from_str(&body)
            .with_context(|| format!("work validation returned non-JSON ({final_url})"))?;
        let status = value
            .get("status")
            .and_then(|status| status.as_i64())
            .or_else(|| {
                value
                    .get("status")
                    .and_then(Value::as_str)
                    .and_then(|status| status.parse::<i64>().ok())
            });
        match status {
            Some(1) => bail!(
                "account or session is abnormal while validating work {} ({final_url})",
                target.work_id
            ),
            Some(2) => bail!(
                "the platform requires a captcha before submitting work {}",
                target.work_id
            ),
            _ => Ok(()),
        }
    }

    /// Submit against an already fetched page.
    pub async fn submit_work_page(
        &self,
        target: &WorkTarget,
        page: &WorkPage,
        answers: &[QuestionAnswer],
    ) -> Result<SubmitReply> {
        let request =
            submit::prepare_submission(&self.base, target, page, answers, submit::now_millis())?;
        let body: std::collections::BTreeMap<&str, &str> = request
            .fields
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let response = self
            .http
            .post(&request.url)
            .header(REFERER, &request.referer)
            .header(ACCEPT, "application/json, text/javascript, */*; q=0.01")
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Origin", self.base.origin().ascii_serialization())
            .form(&body)
            .send()
            .await
            .with_context(|| format!("submit request failed for work {}", target.work_id))?;

        let status = response.status();
        let final_url = response.url().clone();
        let body = response.text().await.with_context(|| {
            format!("failed to read submit response for work {}", target.work_id)
        })?;
        if !status.is_success() {
            let snippet: String = body.chars().take(300).collect();
            bail!(
                "HTTP {status} while submitting work {} ({final_url}): {snippet}",
                target.work_id
            );
        }

        let reply = submit::parse_submit_reply(&body).with_context(|| {
            format!(
                "invalid submit response for work {} ({final_url})",
                target.work_id
            )
        })?;
        if !reply.success {
            bail!(
                "platform rejected answers for work {}: {}",
                target.work_id,
                reply.message
            );
        }
        log::info!(
            "work {} ({}): {}",
            target.work_id,
            target.job_id,
            reply.message
        );
        Ok(reply)
    }

    /// Resolve answers from the bank, then submit one work.
    pub async fn submit_work_from_bank(
        &self,
        target: &WorkTarget,
        bank: &AnswerBank,
    ) -> Result<SubmitReply> {
        let page = self.fetch_work_page(target).await?;
        let plan =
            submit::plan_questions(&page.questions, bank, &target.course_id, &target.work_id);
        if !plan.missing_question_ids.is_empty() {
            bail!(
                "no bank answer for question(s) in work {}: {}",
                target.work_id,
                plan.missing_question_ids.join(", ")
            );
        }
        if !plan.errors.is_empty() {
            bail!(
                "cannot encode question(s) in work {}: {}",
                target.work_id,
                plan.errors.join("; ")
            );
        }
        self.validate_work_before_submit(target, &page.final_url)
            .await?;
        self.submit_work_page(target, &page, &plan.answers).await
    }

    /// Submit a single work from a course plan.
    pub async fn submit_planned_work(&self, work: &PlannedWork) -> Result<SubmitReply> {
        if !work.is_complete() {
            let mut reasons = Vec::new();
            if work.question_count == 0 {
                reasons.push("no questions fetched".to_string());
            }
            if !work.missing_question_ids.is_empty() {
                reasons.push(format!(
                    "missing answers: {}",
                    work.missing_question_ids.join(", ")
                ));
            }
            if !work.errors.is_empty() {
                reasons.push(work.errors.join("; "));
            }
            if reasons.is_empty() {
                reasons.push(format!(
                    "{} of {} answers resolved",
                    work.answers.len(),
                    work.question_count
                ));
            }
            bail!(
                "work {} ({}) is not ready: {}",
                work.work_id,
                work.work_name,
                reasons.join("; ")
            );
        }
        self.submit_work_answers(&work.target, &work.answers).await
    }

    /// Submit every complete work in a course plan, sequentially.
    ///
    /// The callback returns `false` to stop before the next work. Incomplete
    /// works are reported as failures and never partially submitted.
    pub async fn submit_course_plan(
        &self,
        plan: &CourseSubmissionPlan,
        progress: &(dyn Fn(SubmitProgress) -> bool + Send + Sync),
    ) -> Vec<WorkSubmitOutcome> {
        let total_works = plan.works.len();
        let mut outcomes = Vec::with_capacity(total_works);

        for (index, work) in plan.works.iter().enumerate() {
            let (success, message) = if work.is_complete() {
                match self.submit_planned_work(work).await {
                    Ok(reply) => (true, reply.message),
                    Err(error) => (false, format!("{error:#}")),
                }
            } else {
                let mut reasons = Vec::new();
                if work.question_count == 0 {
                    reasons.push("no questions fetched".to_string());
                }
                if !work.missing_question_ids.is_empty() {
                    reasons.push(format!(
                        "missing answers: {}",
                        work.missing_question_ids.join(", ")
                    ));
                }
                if !work.errors.is_empty() {
                    reasons.push(work.errors.join("; "));
                }
                if reasons.is_empty() {
                    reasons.push(format!(
                        "{} of {} answers resolved",
                        work.answers.len(),
                        work.question_count
                    ));
                }
                (
                    false,
                    format!("skipped incomplete work: {}", reasons.join("; ")),
                )
            };

            outcomes.push(WorkSubmitOutcome {
                work_id: work.work_id.clone(),
                work_name: work.work_name.clone(),
                question_count: work.question_count,
                success,
                message,
            });

            if !progress(SubmitProgress {
                total_works,
                done_works: index + 1,
                work_id: work.work_id.clone(),
                work_name: work.work_name.clone(),
                success,
            }) {
                break;
            }
        }

        outcomes
    }

    /// One-click entry point: plan a crawled course against the answer bank and
    /// submit every complete, not-yet-graded work.
    ///
    /// Works with missing answers or unparsed questions are reported as
    /// failures and never partially submitted. Use [`submit::plan_course`]
    /// directly when the caller needs the full diagnostics.
    pub async fn complete_course_quizzes(
        &self,
        course: &CourseDetail,
        bank: &AnswerBank,
        progress: &(dyn Fn(SubmitProgress) -> bool + Send + Sync),
    ) -> Vec<WorkSubmitOutcome> {
        let plan = submit::plan_course(course, bank);
        for error in &plan.errors {
            log::warn!("course plan: {error}");
        }
        self.submit_course_plan(&plan, progress).await
    }

    fn work_endpoint(&self, target: &WorkTarget) -> String {
        let work_type = if target.work_type.as_deref() == Some("workB") {
            "b"
        } else {
            ""
        };
        self.endpoint(
            "mooc-ans/api/work",
            &[
                ("api", "1"),
                ("workId", target.work_id.as_str()),
                ("jobid", target.job_id.as_str()),
                ("originJobId", target.job_id.as_str()),
                ("needRedirect", "true"),
                ("skipHeader", "true"),
                ("knowledgeid", target.knowledge_id.as_str()),
                ("ktoken", target.ktoken.as_deref().unwrap_or("")),
                ("cpi", target.cpi.as_str()),
                ("ut", "s"),
                ("clazzId", target.class_id.as_str()),
                ("type", work_type),
                ("enc", target.enc.as_deref().unwrap_or("")),
                ("mooc2", "1"),
                ("courseid", target.course_id.as_str()),
            ],
        )
    }

    #[allow(clippy::too_many_arguments)]
    async fn work_questions(
        &self,
        course: &CourseSummary,
        knowledge_id: &str,
        work_id: &str,
        job_id: &str,
        ktoken: &str,
        point: &TaskPoint,
        referer: &str,
    ) -> Result<(Vec<crate::models::Question>, Option<String>)> {
        let target = WorkTarget {
            course_id: course.course_id.clone(),
            class_id: course.class_id.clone(),
            cpi: course.cpi.clone(),
            knowledge_id: knowledge_id.to_string(),
            work_id: work_id.to_string(),
            job_id: job_id.to_string(),
            work_type: point.work_type.clone(),
            enc: point.enc.clone(),
            ktoken: (!ktoken.is_empty()).then(|| ktoken.to_string()),
            user_id: None,
            referer: Some(referer.to_string()),
        };
        let page = self.fetch_work_page(&target).await?;
        Ok((
            page.questions,
            page.status.as_work_status().map(str::to_string),
        ))
    }

    fn endpoint(&self, path: &str, params: &[(&str, &str)]) -> String {
        let mut url = self.base.join(path).unwrap_or_else(|_| self.base.clone());
        url.query_pairs_mut().extend_pairs(params);
        url.to_string()
    }

    async fn get_text(&self, url: &str, referer: Option<&str>) -> Result<(String, Url)> {
        self.get_text_with_headers(url, referer, &[]).await
    }

    async fn get_text_with_headers(
        &self,
        url: &str,
        referer: Option<&str>,
        headers: &[(&str, &str)],
    ) -> Result<(String, Url)> {
        let mut request = self.http.get(url);
        if let Some(referer) = referer {
            request = request.header(REFERER, referer);
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("request failed: {url}"))?;
        let status = response.status();
        let final_url = response.url().clone();
        let body = response
            .text()
            .await
            .with_context(|| format!("failed to read response body: {url}"))?;

        if !status.is_success() {
            let snippet: String = body.chars().take(200).collect();
            bail!("HTTP {status} for {final_url}: {snippet}");
        }
        if body.contains("<title>404</title>") || body.contains("error-page/images/bg404.gif") {
            bail!("platform returned its 404 page for {final_url}");
        }

        Ok((body, final_url))
    }
}

struct LeafResult {
    cards: Vec<Card>,
    errors: Vec<String>,
}

fn count_nodes(nodes: &[crate::models::Chapter]) -> usize {
    nodes
        .iter()
        .map(|node| 1 + count_nodes(&node.children))
        .sum()
}

/// Fetch several courses sequentially, preserving input order.
pub async fn fetch_courses(
    client: &SmartCourseClient,
    courses: &[CourseSummary],
    options: &FetchOptions,
) -> Vec<Result<CourseDetail>> {
    let mut out = Vec::with_capacity(courses.len());
    for course in courses {
        out.push(client.fetch_course(course, options).await);
    }
    out
}
