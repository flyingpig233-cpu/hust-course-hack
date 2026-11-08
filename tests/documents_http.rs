//! HTTP-level tests for direct document completion.
//!
//! The mock platform serves the two cookie-only `mooc-ans` requests used by
//! [`SmartCourseClient::complete_document`] and verifies the query parameters
//! that the H5 card page / PDF viewer would send.

use hust_course_hack::{DocumentTarget, SmartCourseClient};
use reqwest::cookie::Jar;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

const SETTING_HTML: &str = r#"<!doctype html><html><body>
<script>
window.AttachmentSetting = {"attachments":[
  {"type":"document","jobid":"job-1","jtoken":"tok-1",
   "property":{"objectid":"obj-1","name":"讲义.pdf"}}
]};
</script>
</body></html>"#;

fn read_request(stream: &mut TcpStream) -> String {
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
    let body = &buffer[header_end..];
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    let mut body = body.to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).expect("read body");
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    format!("{head}{}", String::from_utf8_lossy(&body))
}

fn spawn_server(
    requests: usize,
    setting_html: &'static str,
    report_body: &'static str,
) -> (
    std::net::SocketAddr,
    Arc<Mutex<Vec<String>>>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    let address = listener.local_addr().expect("mock server address");
    let captured = Arc::new(Mutex::new(Vec::new()));
    let server_capture = Arc::clone(&captured);
    let server = thread::spawn(move || {
        for _ in 0..requests {
            let (mut stream, _) = listener.accept().expect("accept request");
            let head = read_request(&mut stream);
            let path = head
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or_default()
                .to_string();
            server_capture.lock().unwrap().push(head);
            let (content_type, response) = if path.starts_with("/mooc-ans/phone/wxcard") {
                ("text/html; charset=utf-8", setting_html)
            } else if path.starts_with("/mooc-ans/job/document") {
                ("application/json", report_body)
            } else {
                ("text/plain; charset=utf-8", "not found")
            };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            )
            .expect("write response");
        }
    });
    (address, captured, server)
}

fn target() -> DocumentTarget {
    DocumentTarget {
        course_id: "17310000026063".to_string(),
        class_id: "17310000023403".to_string(),
        cpi: "17310000196268".to_string(),
        knowledge_id: "582263".to_string(),
        knowledge_title: "Unit 1".to_string(),
        card_id: "417613".to_string(),
        job_id: "job-1".to_string(),
        object_id: Some("obj-1".to_string()),
        name: "0.1 Introduction.pdf".to_string(),
    }
}

#[tokio::test]
async fn completes_document_with_wxcard_jtoken() {
    let (address, captured, server) = spawn_server(2, SETTING_HTML, r#"{"status":true}"#);
    let base = format!("http://{address}/");
    let client = SmartCourseClient::with_cookie_jar_and_base(Arc::new(Jar::default()), &base)
        .expect("build client");

    let report = client
        .complete_document(&target())
        .await
        .expect("document report should be accepted");
    assert!(report.accepted);
    assert_eq!(report.job_id, "job-1");

    server.join().expect("mock server finished");
    let requests = captured.lock().unwrap();
    assert_eq!(requests.len(), 2);

    let wxcard = &requests[0];
    assert!(wxcard.starts_with("GET /mooc-ans/phone/wxcard?"));
    for pair in [
        "cardid=417613",
        "courseid=17310000026063",
        "knowledgeid=582263",
        "clazzid=17310000023403",
        "cpi=17310000196268",
        "ut=s",
        "isMicroCourse=false",
    ] {
        assert!(
            wxcard.contains(pair),
            "wxcard URL is missing {pair}: {wxcard}"
        );
    }

    let report_request = &requests[1];
    assert!(report_request.starts_with("GET /mooc-ans/job/document?"));
    for pair in [
        "jobid=job-1",
        "knowledgeid=582263",
        "courseid=17310000026063",
        "clazzid=17310000023403",
        "jtoken=tok-1",
        "checkMicroTopic=true",
        "microTopicId=undefined",
        "courseEngineInfo=false",
    ] {
        assert!(
            report_request.contains(pair),
            "document URL is missing {pair}: {report_request}"
        );
    }
}

#[tokio::test]
async fn fails_when_the_card_has_no_matching_jtoken() {
    let (address, captured, server) = spawn_server(
        1,
        r#"<html>window.AttachmentSetting = {"attachments":[]};</html>"#,
        "{}",
    );
    let base = format!("http://{address}/");
    let client = SmartCourseClient::with_cookie_jar_and_base(Arc::new(Jar::default()), &base)
        .expect("build client");

    let error = client
        .complete_document(&target())
        .await
        .expect_err("missing jtoken must fail");
    assert!(error.to_string().contains("jtoken"), "{error:#}");

    server.join().expect("mock server finished");
    assert_eq!(captured.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn surfaces_rejected_document_report() {
    let (address, captured, server) = spawn_server(
        2,
        SETTING_HTML,
        r#"{"status":false,"msg":"document is archived"}"#,
    );
    let base = format!("http://{address}/");
    let client = SmartCourseClient::with_cookie_jar_and_base(Arc::new(Jar::default()), &base)
        .expect("build client");

    let error = client
        .complete_document(&target())
        .await
        .expect_err("rejected report must fail");
    assert!(
        format!("{error:#}").contains("document is archived"),
        "{error:#}"
    );

    server.join().expect("mock server finished");
    assert_eq!(captured.lock().unwrap().len(), 2);
}
