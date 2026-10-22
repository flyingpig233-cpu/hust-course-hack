//! Loading browser-exported cookies into a `reqwest` cookie jar.
//!
//! The expected format is the Netscape `cookies.txt` file written by browser
//! extensions (and by `curl -c`). A plain `Cookie: a=b; c=d` header is also
//! accepted so callers can pass cookies from memory.

use anyhow::{Context, Result, bail};
use reqwest::cookie::Jar;
use std::{
    fs,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use url::Url;

const BASE_URL: &str = "https://smartcourse.hust.edu.cn/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CookieRecord {
    pub domain: String,
    pub include_subdomains: bool,
    pub path: String,
    pub secure: bool,
    pub expires: i64,
    pub name: String,
    pub value: String,
}

/// Parse the body of a Netscape cookies file.
///
/// Lines beginning with `#` are comments, except `#HttpOnly_`, which is a
/// normal cookie line with an HttpOnly marker.
pub fn parse_netscape_cookies(contents: &str) -> Vec<CookieRecord> {
    let mut out = Vec::new();
    for raw_line in contents.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }

        let line = if let Some(rest) = line.strip_prefix("#HttpOnly_") {
            rest
        } else if line.starts_with('#') {
            continue;
        } else {
            line
        };

        let fields: Vec<&str> = if line.contains('\t') {
            line.split('\t').collect()
        } else {
            line.split_whitespace().collect()
        };
        if fields.len() < 7 {
            log::debug!("skipping malformed cookie line: {line}");
            continue;
        }

        // Values are allowed to contain tabs in theory; keep everything after
        // the sixth separator in the value.
        let name = fields[5].trim();
        if name.is_empty() {
            continue;
        }
        let value = fields[6..].join("\t");

        out.push(CookieRecord {
            domain: fields[0].trim().to_string(),
            include_subdomains: fields[1].trim().eq_ignore_ascii_case("TRUE"),
            path: fields[2].trim().to_string(),
            secure: fields[3].trim().eq_ignore_ascii_case("TRUE"),
            expires: fields[4].trim().parse().unwrap_or(0),
            name: name.to_string(),
            value,
        });
    }
    out
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn jar_with_url() -> Result<(Jar, Url)> {
    Ok((Jar::default(), Url::parse(BASE_URL)?))
}

fn add_record(jar: &Jar, base: &Url, record: &CookieRecord) -> Result<()> {
    if record.expires != 0 && record.expires < now_unix() {
        return Ok(());
    }

    let mut header = format!("{}={}", record.name, record.value);
    if !record.domain.is_empty() {
        header.push_str("; Domain=");
        header.push_str(record.domain.trim_start_matches('.'));
    }
    if !record.path.is_empty() {
        header.push_str("; Path=");
        header.push_str(&record.path);
    }
    if record.secure {
        header.push_str("; Secure");
    }

    jar.add_cookie_str(&header, base);
    Ok(())
}

/// Load a Netscape cookie file into a shared `reqwest` jar.
pub fn load_cookie_jar(path: impl AsRef<Path>) -> Result<Arc<Jar>> {
    let path = path.as_ref();
    let contents = fs::read_to_string(path)
        .with_context(|| format!("failed to read cookie file {}", path.display()))?;
    let records = parse_netscape_cookies(&contents);
    if records.is_empty() {
        bail!(
            "no cookies found in {} (expected a Netscape cookies.txt export)",
            path.display()
        );
    }

    let (jar, base) = jar_with_url()?;
    for record in &records {
        add_record(&jar, &base, record)?;
    }
    log::info!("loaded {} cookies from {}", records.len(), path.display());
    Ok(Arc::new(jar))
}

/// Build a shared `reqwest` jar from cookies captured from a live browser
/// session (for example the Tauri login webview).
///
/// Domain and path attributes are preserved when present; host-only cookies
/// are scoped to the platform base URL.
pub fn jar_from_records(records: impl IntoIterator<Item = CookieRecord>) -> Result<Arc<Jar>> {
    let (jar, base) = jar_with_url()?;
    let mut count = 0usize;
    for record in records {
        add_record(&jar, &base, &record)?;
        count += 1;
    }
    if count == 0 {
        bail!("no cookies found in session");
    }
    Ok(Arc::new(jar))
}

/// Build a jar from a raw `Cookie:` header value.
pub fn jar_from_cookie_header(header: &str) -> Result<Arc<Jar>> {
    let header = header
        .trim()
        .strip_prefix("Cookie:")
        .unwrap_or(header.trim());
    let (jar, base) = jar_with_url()?;
    let mut count = 0usize;
    for pair in header.split(';') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let cookie = format!("{name}={}", value.trim());
        jar.add_cookie_str(&cookie, &base);
        count += 1;
    }
    if count == 0 {
        bail!("no cookies found in header");
    }
    Ok(Arc::new(jar))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_netscape_lines_and_skips_comments() {
        let input = "\
# Netscape HTTP Cookie File
#HttpOnly_.hust.edu.cn\tTRUE\t/\tFALSE\t0\tfid\t1731
smartcourse.hust.edu.cn\tFALSE\t/\tTRUE\t1793258235\twebsite_fid\t42
";
        let cookies = parse_netscape_cookies(input);
        assert_eq!(cookies.len(), 2);
        assert_eq!(cookies[0].name, "fid");
        assert_eq!(cookies[0].domain, ".hust.edu.cn");
        assert_eq!(cookies[0].value, "1731");
        assert!(cookies[1].secure);
        assert_eq!(cookies[1].expires, 1793258235);
    }

    #[test]
    fn expires_old_cookies() {
        let input = "smartcourse.hust.edu.cn\tFALSE\t/\tFALSE\t1\told\tx\n";
        let cookies = parse_netscape_cookies(input);
        assert_eq!(cookies.len(), 1);
    }

    #[test]
    fn builds_jar_from_live_cookie_records() {
        use reqwest::cookie::CookieStore;

        let jar = jar_from_records(vec![CookieRecord {
            domain: "smartcourse.hust.edu.cn".to_string(),
            include_subdomains: false,
            path: "/".to_string(),
            secure: true,
            expires: 0,
            name: "session".to_string(),
            value: "abc123".to_string(),
        }])
        .unwrap();

        let url = Url::parse(BASE_URL).unwrap();
        let header = jar.cookies(&url).unwrap();
        assert!(header.to_str().unwrap().contains("session=abc123"));
    }
}
