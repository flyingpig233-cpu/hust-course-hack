//! HTTP-level test for the quiz submit path using a local mock platform.
//!
//! This does not try to validate the real handler's semantics; it verifies the
//! client sends the page-derived fields, the per-question answer fields and the
//! expected query parameters, then treats `{"status":true}` as success.

use hust_course_hack::{QuestionAnswer, SmartCourseClient, WorkTarget};
use reqwest::cookie::Jar;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

const WORK_HTML: &str = r#"
<html><head><title>作业</title></head><body>
  <form id="form1" method="post">
    <input type="hidden" id="workAnswerId" name="workAnswerId" value="9001">
    <input type="hidden" id="totalQuestionNum" name="totalQuestionNum" value="2">
    <input type="hidden" id="fullScore" name="fullScore" value="20">
    <input type="hidden" id="workRelationId" name="workRelationId" value="7001">
    <input type="hidden" id="enc_work" name="enc_work" value="enc-work">
    <input type="hidden" id="answertype101" value="0">
    <input type="hidden" id="answertype102" value="0">
  </form>
  <a href="doHomeWorkNew">answer</a>
  <div class="TiMu" data="101" id="question101">
    <div class="Zy_TItle"><div class="qtContent">
      <span class="newZy_TItle">【单选题】</span>Question one
    </div></div>
    <ul class="Zy_ulTop">
      <li><i class="fl">A、</i><a>alpha</a></li>
      <li><i class="fl">B、</i><a>beta</a></li>
    </ul>
  </div>
  <div class="TiMu" data="102" id="question102">
    <div class="Zy_TItle"><div class="qtContent">
      <span class="newZy_TItle">【单选题】</span>Question two
    </div></div>
    <ul class="Zy_ulTop">
      <li><i class="fl">A、</i><a>alpha</a></li>
      <li><i class="fl">B、</i><a>beta</a></li>
    </ul>
  </div>
</body></html>"#;

fn read_request(stream: &mut TcpStream) -> (String, String) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).expect("read request");
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let header_end = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
        .expect("request has headers");
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut body = buffer[header_end..].to_vec();

    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    while body.len() < content_length {
        let read = stream.read(&mut chunk).expect("read body");
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }

    (
        head,
        String::from_utf8_lossy(&body[..content_length.min(body.len())]).to_string(),
    )
}

#[tokio::test]
async fn posts_page_fields_and_answers() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    let address = listener.local_addr().expect("mock server address");
    let captured = Arc::new(Mutex::new(Vec::new()));

    let server_capture = Arc::clone(&captured);
    let server = thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().expect("accept request");
            let (head, body) = read_request(&mut stream);
            let is_post = head.starts_with("POST ");
            server_capture.lock().unwrap().push((head, body));
            let (content_type, response) = if is_post {
                ("application/json", r#"{"status":true,"msg":"提交成功"}"#)
            } else {
                ("text/html; charset=utf-8", WORK_HTML)
            };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            )
            .expect("write response");
        }
    });

    let base = format!("http://{address}/");
    let client = SmartCourseClient::with_cookie_jar_and_base(Arc::new(Jar::default()), &base)
        .expect("build client");
    let target = WorkTarget {
        course_id: "17310000026063".to_string(),
        class_id: "17310000023403".to_string(),
        cpi: "17310000196268".to_string(),
        knowledge_id: "582304".to_string(),
        work_id: "work-1".to_string(),
        job_id: "job-1".to_string(),
        work_type: Some("workA".to_string()),
        enc: Some("enc-1".to_string()),
        ktoken: Some("kt-1".to_string()),
        user_id: Some("6000".to_string()),
        referer: None,
    };

    let page = client
        .fetch_work_page(&target)
        .await
        .expect("fetch work page");
    assert_eq!(page.questions.len(), 2);
    assert_eq!(page.form.hidden_value("workAnswerId"), Some("9001"));

    let answers = vec![
        QuestionAnswer {
            question_id: "101".to_string(),
            question_type: 0,
            answer: "B".to_string(),
            labels: vec!["B".to_string()],
            blanks: Vec::new(),
            text: "beta".to_string(),
            options: Vec::new(),
            source: None,
            confidence: None,
        },
        QuestionAnswer {
            question_id: "102".to_string(),
            question_type: 0,
            answer: "A".to_string(),
            labels: vec!["A".to_string()],
            blanks: Vec::new(),
            text: "alpha".to_string(),
            options: Vec::new(),
            source: None,
            confidence: None,
        },
    ];

    let reply = client
        .submit_work_page(&target, &page, &answers)
        .await
        .expect("submit answers");
    assert!(reply.success);
    assert_eq!(reply.message, "提交成功");

    server.join().expect("mock server finished");

    let requests = captured.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let (post_head, post_body) = &requests[1];
    assert!(post_head.starts_with("POST /mooc-ans/work/addStudentWorkNewWeb?"));
    for pair in [
        "token=enc-work",
        "workAnswerId=9001",
        "workid=7001",
        "courseid=17310000026063",
        "jobid=job-1",
        "ut=s",
    ] {
        assert!(
            post_head.contains(pair),
            "submit URL is missing {pair}: {post_head}"
        );
    }
    for pair in [
        "enc_work=enc-work",
        "courseId=17310000026063",
        "classId=17310000023403",
        "knowledgeid=582304",
        "workAnswerId=9001",
        "totalQuestionNum=2",
        "answerwqbid=101%2C102%2C",
        "answertype101=0",
        "answer101=B",
        "answertype102=0",
        "answer102=A",
    ] {
        assert!(
            post_body.contains(pair),
            "submit body is missing {pair}: {post_body}"
        );
    }
}
