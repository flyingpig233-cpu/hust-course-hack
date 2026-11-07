//! Zhihuishu crypto helpers: AES `secretStr`, the RSA module-key handshake,
//! XOR field lists and the synthetic watch-point sequence.
//!
//! Every algorithm here was recovered from the live site and verified against
//! captured request/response pairs (see [the plan](docs/zhihuishu-miaoshua-plan.md),
//! appendix A/B). The AES-CBC implementation below is written directly on top
//! of the `aes` block cipher so the fixed IV and the PKCS#7 padding are explicit
//! and easy to audit.
//!
//! The meet-course module key is **never** hardcoded: it is fetched at runtime
//! through [`fetch_module_key`], which mirrors the page's `labc(module)` helper.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use aes::Aes128;
use aes::cipher::{Block, BlockDecrypt, BlockEncrypt, KeyInit};
use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rsa::{BigUint, Pkcs1v15Encrypt, RsaPublicKey, pkcs8::DecodePublicKey, traits::PublicKeyParts};
use serde::Deserialize;
use serde_json::Value;

use super::{
    AES_IV, MODULE_KEY_TTL_SECS, PUBLIC_KEY_B64, VIDEO_MODULE_KEY_FALLBACK, XOR_KEY_VIDEO,
    ZHS_USER_AGENT,
};

/// Module-key payload returned by `c/has` after the public-key unpad step.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ModuleKey {
    /// AES key used for `secretStr` of this module (`cKey`).
    #[serde(rename = "cKey")]
    pub c_key: String,
    /// Secondary key reported by the server (`key`); not needed to encrypt.
    #[serde(default)]
    pub key: Option<String>,
    /// Module id echoed by the server.
    #[serde(default)]
    pub module: Option<u32>,
    /// Client key version (`ckv`).
    #[serde(default)]
    pub ckv: Option<i64>,
    /// Server key version (`nkv`).
    #[serde(default)]
    pub nkv: Option<i64>,
    /// Client OS version (`osVersion`).
    #[serde(default)]
    pub os_version: Option<i64>,
}

/// In-memory module key cache with a 30-minute TTL, matching the page lifetime.
///
/// The cache is `Send + Sync`; a fresh key is fetched only when the entry is
/// missing or expired.
#[derive(Debug)]
pub struct ModuleKeyCache {
    ttl: Duration,
    entries: Mutex<HashMap<u32, (String, Instant)>>,
}

impl Default for ModuleKeyCache {
    fn default() -> Self {
        Self::new(Duration::from_secs(MODULE_KEY_TTL_SECS))
    }
}

impl ModuleKeyCache {
    /// Build an empty cache with a custom TTL.
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Return a cached, unexpired key.
    pub fn get(&self, module: u32) -> Option<String> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries
            .get(&module)
            .filter(|(_, at)| at.elapsed() < self.ttl)
            .map(|(key, _)| key.clone())
    }

    /// Store (or refresh) one module key.
    pub fn put(&self, module: u32, key: impl Into<String>) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.insert(module, (key.into(), Instant::now()));
    }

    /// Drop every cached key (used by tests and by a forced re-key).
    pub fn clear(&self) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.clear();
    }
}

/// Parse the RSA public key used by the `c/has` handshake.
fn rsa_public_key() -> Result<RsaPublicKey> {
    let der = STANDARD
        .decode(PUBLIC_KEY_B64)
        .context("invalid embedded Zhihuishu RSA public key")?;
    RsaPublicKey::from_public_key_der(&der)
        .context("failed to parse embedded Zhihuishu RSA public key")
}

/// Validate an AES key is exactly 16 bytes (AES-128).
fn aes_key(key: &str) -> Result<[u8; 16]> {
    let bytes = key.as_bytes();
    if bytes.len() != 16 {
        bail!(
            "invalid Zhihuishu AES key length: expected 16 bytes, got {}",
            bytes.len()
        );
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn fixed_iv() -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv.copy_from_slice(AES_IV.as_bytes());
    iv
}

/// AES-128-CBC + PKCS#7 encrypt and base64-encode, producing `secretStr`.
pub fn encrypt_secret(key: &str, plaintext: &str) -> Result<String> {
    let key = aes_key(key)?;
    let cipher = Aes128::new_from_slice(&key).map_err(|_| anyhow!("invalid Zhihuishu AES key"))?;

    // PKCS#7: always append 1..=16 padding bytes.
    let pad = 16 - plaintext.len() % 16;
    let mut data = plaintext.as_bytes().to_vec();
    data.resize(data.len() + pad, pad as u8);

    let mut previous = fixed_iv();
    for chunk in data.chunks_mut(16) {
        for (byte, prev) in chunk.iter_mut().zip(previous.iter()) {
            *byte ^= *prev;
        }
        cipher.encrypt_block(Block::<Aes128>::from_mut_slice(chunk));
        previous.copy_from_slice(chunk);
    }
    Ok(STANDARD.encode(&data))
}

/// AES-128-CBC + PKCS#7 decrypt a base64 `secretStr`.
///
/// Used by [`crypto_self_check`] and by tests; the client itself only needs to
/// encrypt requests.
pub fn decrypt_secret(key: &str, ciphertext_b64: &str) -> Result<String> {
    let key = aes_key(key)?;
    let cipher = Aes128::new_from_slice(&key).map_err(|_| anyhow!("invalid Zhihuishu AES key"))?;
    let mut data = STANDARD
        .decode(ciphertext_b64.trim())
        .context("invalid base64 secretStr")?;
    if data.is_empty() || data.len() % 16 != 0 {
        bail!("invalid AES ciphertext length: {}", data.len());
    }

    let mut previous = fixed_iv();
    for chunk in data.chunks_mut(16) {
        let mut current = [0u8; 16];
        current.copy_from_slice(chunk);
        cipher.decrypt_block(Block::<Aes128>::from_mut_slice(chunk));
        for (byte, prev) in chunk.iter_mut().zip(previous.iter()) {
            *byte ^= *prev;
        }
        previous = current;
    }

    let pad = usize::from(*data.last().expect("non-empty"));
    if pad == 0 || pad > 16 || pad > data.len() {
        bail!("invalid PKCS#7 padding (pad byte {pad})");
    }
    if data[data.len() - pad..]
        .iter()
        .any(|b| usize::from(*b) != pad)
    {
        bail!("invalid PKCS#7 padding bytes");
    }
    data.truncate(data.len() - pad);
    String::from_utf8(data).context("AES plaintext is not valid UTF-8")
}

/// Encrypt a JSON payload into the `secretStr` form.
pub fn encrypt_secret_json(key: &str, payload: &Value) -> Result<String> {
    let plaintext = serde_json::to_string(payload).context("failed to serialize secret payload")?;
    encrypt_secret(key, &plaintext)
}

/// XOR-encode a field list into the site's `sdsew` / `paramSecret` format.
///
/// The page implementation joins the fields with `;`, XORs every character with
/// the repeating key, formats the result as lowercase hex (padded to two
/// digits) and keeps the last four hex characters.
pub fn xor_encode(fields: &[String], key: &str) -> String {
    let joined = fields.join(";");
    let key_bytes = key.as_bytes();
    if key_bytes.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(joined.len() * 2);
    for (index, ch) in joined.chars().enumerate() {
        let value = (ch as u32) ^ u32::from(key_bytes[index % key_bytes.len()]);
        let hex = format!("{value:x}");
        let hex = if hex.len() < 2 {
            format!("0{hex}")
        } else {
            hex
        };
        let start = hex.len().saturating_sub(4);
        out.push_str(&hex[start..]);
    }
    out
}

/// Decode a hex XOR list produced by [`xor_encode`].
///
/// Only two-hex-digit chunks are handled, which covers every value the site
/// sends as a `recruitAndCourseId` secret (digits, `;` and letters).
pub fn xor_decode(encoded: &str, key: &str) -> Result<String> {
    let encoded = encoded.trim();
    if !encoded.len().is_multiple_of(2) {
        bail!("invalid XOR-encoded string length: {}", encoded.len());
    }
    let key_bytes = key.as_bytes();
    if key_bytes.is_empty() {
        bail!("XOR key must not be empty");
    }
    let mut out = String::with_capacity(encoded.len() / 2);
    for (index, chunk) in encoded.as_bytes().chunks(2).enumerate() {
        let text = std::str::from_utf8(chunk).context("non-ASCII XOR-encoded string")?;
        let byte = u8::from_str_radix(text, 16).context("invalid hex in XOR-encoded string")?;
        out.push(char::from(byte ^ key_bytes[index % key_bytes.len()]));
    }
    Ok(out)
}

/// Synthetic watch-point sequence (`ewssw`) for a video of `duration_secs`.
///
/// Equivalent to the site's helper:
/// `['0','1']` then, for every `k` while `k * 1.99 < duration`, push
/// `floor(5 * floor(k * 1.99 / 4.99) / 5) + 2`.
pub fn watch_points(duration_secs: u64) -> String {
    let duration = duration_secs as f64;
    let mut values: Vec<u64> = vec![0, 1];
    let mut k: u64 = 0;
    while (k as f64) * 1.99 < duration {
        let total = 5.0 * ((k as f64) * 1.99 / 4.99).floor();
        values.push((total / 5.0).floor() as u64 + 2);
        k += 1;
    }
    values
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// Format seconds as `HH:MM:SS`, matching the site's `hms` helper.
pub fn hms(secs: u64) -> String {
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

/// Parse `HH:MM:SS` (or `MM:SS`) back into seconds.
pub fn parse_hms(text: &str) -> Option<u64> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    let numbers: Option<Vec<u64>> = parts.iter().map(|p| p.parse::<u64>().ok()).collect();
    let numbers = numbers?;
    match numbers.as_slice() {
        [h, m, s] => Some(h * 3600 + m * 60 + s),
        [m, s] => Some(m * 60 + s),
        [s] => Some(*s),
        _ => None,
    }
}

/// RSA-encrypt `{"module": n}` the way the page's `labc(n)` does.
pub fn rsa_encrypt_module(module: u32) -> Result<String> {
    let key = rsa_public_key()?;
    let payload = serde_json::json!({ "module": module }).to_string();
    let mut rng = rand::thread_rng();
    let ciphertext = key
        .encrypt(&mut rng, Pkcs1v15Encrypt, payload.as_bytes())
        .map_err(|e| anyhow!("RSA encryption failed: {e}"))?;
    Ok(STANDARD.encode(ciphertext))
}

/// Apply the raw RSA public operation and strip PKCS#1 v1.5 type-2 padding.
///
/// This is the inverse of the server-side private-key operation: the server
/// sends `c = m^d mod n` (a signature-shaped blob), and the client recovers
/// `m` with `c^e mod n`.
fn public_op_unpad(key: &RsaPublicKey, blob: &[u8]) -> Result<Vec<u8>> {
    let modulus = key.n();
    let ciphertext = BigUint::from_bytes_be(blob);
    if &ciphertext >= modulus {
        bail!("RSA module-key blob is not smaller than the public modulus");
    }
    let message = ciphertext.modpow(key.e(), modulus);
    let bytes = message.to_bytes_be();

    // The encoded block is 00 || 01 || FF..FF || 00 || payload; the leading
    // zero byte is dropped by `to_bytes_be`, so accept both forms.
    let body = match bytes.first() {
        Some(0) => &bytes[1..],
        _ => &bytes[..],
    };
    if body.first() != Some(&0x01) {
        bail!("invalid PKCS#1 v1.5 padding: missing block-type marker");
    }
    let mut index = 1;
    while index < body.len() && body[index] == 0xFF {
        index += 1;
    }
    if index < 10 {
        bail!("invalid PKCS#1 v1.5 padding: separator too early");
    }
    if body.get(index) != Some(&0x00) {
        bail!("invalid PKCS#1 v1.5 padding: missing separator");
    }
    Ok(body[index + 1..].to_vec())
}

/// Decode the `rt.sl` blob returned by `c/has` into a [`ModuleKey`].
pub fn decrypt_module_key_blob(blob_b64: &str) -> Result<ModuleKey> {
    let key = rsa_public_key()?;
    let blob = STANDARD
        .decode(blob_b64.trim())
        .context("invalid base64 module-key blob")?;
    let plaintext = public_op_unpad(&key, &blob)?;
    let module_key: ModuleKey =
        serde_json::from_slice(&plaintext).context("module-key blob is not a cKey JSON object")?;
    if module_key.c_key.is_empty() {
        bail!("module-key blob did not contain a cKey");
    }
    if module_key.c_key.len() != 16 {
        bail!(
            "module-key blob returned an unexpected cKey length ({})",
            module_key.c_key.len()
        );
    }
    Ok(module_key)
}

/// Fetch a module key at runtime, mirroring the page's `labc(module)` helper.
///
/// 1. RSAES-PKCS1-v1_5 encrypt `{"module": n}` with the shared public key;
/// 2. `GET <appcomm_user_base>/app-commserv-user/c/has?uid=<base64>`;
/// 3. read `rt.sl`, run the public operation and strip PKCS#1 padding;
/// 4. return the `cKey` from the decoded JSON.
///
/// `appcomm_user_base` is a parameter so integration tests can point the
/// handshake at a local mock server; production callers pass
/// [`super::APPCOMM_USER_BASE`].
pub async fn fetch_module_key(
    http: &reqwest::Client,
    appcomm_user_base: &str,
    module: u32,
) -> Result<String> {
    let uid = rsa_encrypt_module(module)?;
    let url = format!("{appcomm_user_base}/app-commserv-user/c/has");
    let response = http
        .get(&url)
        .query(&[("uid", uid.as_str())])
        .header(reqwest::header::USER_AGENT, ZHS_USER_AGENT)
        .send()
        .await
        .with_context(|| format!("module-key request failed for module {module}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .context("failed to read module-key response")?;
    if !status.is_success() {
        bail!("module-key endpoint returned HTTP {status}");
    }
    let value: Value = serde_json::from_str(&text).context("module-key response is not JSON")?;
    let blob = value
        .pointer("/rt/sl")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/data/sl").and_then(Value::as_str))
        .context("module-key response is missing rt.sl")?;
    let key = decrypt_module_key_blob(blob)?;
    log::debug!("fetched Zhihuishu module {module} key (ckv={:?})", key.ckv);
    Ok(key.c_key)
}

/// Verify the embedded constants against captured protocol samples.
///
/// Returns an error with a Chinese user-facing hint when the platform rotated
/// its crypto constants; callers should surface that message verbatim. The
/// check is offline and cheap, so clients run it once when they are created.
pub fn crypto_self_check() -> Result<()> {
    const PLAINTEXT: &str = "{\"videoId\":70796671,\"dateFormate\":1794059294000}";
    const CIPHERTEXT: &str =
        "FmhUDZ6n4Tv6m90r5dj3KMK3oxlaFlD9DAGEuzSX+9LeNgzdSWaXdNNfC1SeVevn9fTy6Nxn+scj2pyLhFFxKg==";
    // This XOR vector intentionally uses the *page capture* field layout
    // (`chapterId,0,0,total,hms,uuid`) so it verifies the raw algorithm against
    // the live page. The completion report built by
    // `watch::build_video_payload` uses the slightly different live-tested
    // layout (`chapterId,0,total,total,hms,uuid+"zhs"`). Do not "fix" one to
    // match the other: both are correct for their respective senders.
    const XOR_FIELDS: [&str; 10] = [
        "463667",
        "1000337351",
        "1000244446",
        "70622143",
        "1000116293",
        "0",
        "0",
        "468",
        "00:07:48",
        "abcdefgh",
    ];
    const XOR_EXPECTED: &str = "4e4c4342425d5f4b4a4044475953494f414f455a544a484440405e52414d40424658554e494b45445a54\
4b4b46464d595f4a41404f405c5c414a404e445d5e4e424b151609001f1c171c";

    let ciphertext = encrypt_secret(VIDEO_MODULE_KEY_FALLBACK, PLAINTEXT)
        .context("AES self-check failed to encrypt the reference payload")?;
    if ciphertext != CIPHERTEXT {
        bail!("知到加密常量可能已更新：AES secretStr 自检未通过（请更新代码常量）");
    }
    let plaintext = decrypt_secret(VIDEO_MODULE_KEY_FALLBACK, CIPHERTEXT)
        .context("AES self-check failed to decrypt the reference payload")?;
    if plaintext != PLAINTEXT {
        bail!("知到加密常量可能已更新：AES 解密自检未通过");
    }

    let fields: Vec<String> = XOR_FIELDS.iter().map(|s| (*s).to_string()).collect();
    if xor_encode(&fields, XOR_KEY_VIDEO) != XOR_EXPECTED {
        bail!("知到加密常量可能已更新：视频上报 XOR 自检未通过（zzpttjd）");
    }
    if watch_points(5) != "0,1,2,2,2" {
        bail!("知到加密常量可能已更新：watchPoints 自检未通过");
    }
    if hms(826) != "00:13:46" || parse_hms("00:13:46") != Some(826) {
        bail!("知到加密常量可能已更新：hms 自检未通过");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPTURED_MODULE_BLOB: &str = "bHh4XnFfDYprnOcYwUpPfxFfE2DWlEXbz4AIwEeJ5QvUkNjkGRJcdwSab6PKDibGkMOBLOT9or/\
nas7MyMrjLzof8VaWOsdTBn/vgDM14M+ubEo3itu051bjGWizlMwtgJ2mEli/uspItbefvVIKkeTc5hzhn5m14uCxxH3ZLHM=";

    #[test]
    fn encrypts_the_captured_video_payload() {
        let plaintext = "{\"videoId\":70796671,\"dateFormate\":1794059294000}";
        let ciphertext = encrypt_secret(VIDEO_MODULE_KEY_FALLBACK, plaintext).unwrap();
        assert_eq!(
            ciphertext,
            "FmhUDZ6n4Tv6m90r5dj3KMK3oxlaFlD9DAGEuzSX+9LeNgzdSWaXdNNfC1SeVevn9fTy6Nxn+scj2pyLhFFxKg=="
        );
        assert_eq!(
            decrypt_secret(VIDEO_MODULE_KEY_FALLBACK, &ciphertext).unwrap(),
            plaintext
        );
    }

    #[test]
    fn round_trips_payloads_with_partial_blocks() {
        for plaintext in ["", "a", "0123456789abcde", "0123456789abcdef"] {
            let ciphertext = encrypt_secret(VIDEO_MODULE_KEY_FALLBACK, plaintext).unwrap();
            assert_eq!(
                decrypt_secret(VIDEO_MODULE_KEY_FALLBACK, &ciphertext).unwrap(),
                plaintext
            );
        }
    }

    #[test]
    fn rejects_non_16_byte_keys() {
        assert!(encrypt_secret("short", "x").is_err());
        assert!(decrypt_secret("zzpttjd", "AAAA").is_err());
    }

    #[test]
    fn xor_matches_captured_sdsew_vector() {
        let fields: Vec<String> = [
            "463667",
            "1000337351",
            "1000244446",
            "70622143",
            "1000116293",
            "0",
            "0",
            "468",
            "00:07:48",
            "abcdefgh",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
        let encoded = xor_encode(&fields, XOR_KEY_VIDEO);
        assert_eq!(
            encoded,
            "4e4c4342425d5f4b4a4044475953494f414f455a544a484440405e52414d40424658554e494b45445a544b4b46464d595f4a41404f405c5c414a404e445d5e4e424b151609001f1c171c"
        );
        let decoded = xor_decode(&encoded, XOR_KEY_VIDEO).unwrap();
        assert_eq!(decoded, fields.join(";"));
    }

    #[test]
    fn course_secret_matches_captured_study_url() {
        let secret = xor_encode(
            &["463667".to_string(), "1000011214".to_string()],
            super::super::XOR_KEY_COURSE,
        );
        assert_eq!(secret, "4e5e5a5e435e4859454a585959445b425c");
        assert_eq!(
            xor_decode(&secret, super::super::XOR_KEY_COURSE).unwrap(),
            "463667;1000011214"
        );
    }

    #[test]
    fn watch_points_matches_the_site_helper() {
        assert_eq!(watch_points(0), "0,1");
        assert_eq!(watch_points(5), "0,1,2,2,2");
        assert_eq!(watch_points(10), "0,1,2,2,2,3,3,3");
        let long = watch_points(826);
        assert!(long.starts_with("0,1,2,2,2,3,3,3,4,4,5,5,5,6,6,7,7,7,8,8,9,9,9,10,"));
        assert!(long.ends_with(",167"));
    }

    #[test]
    fn hms_round_trips() {
        assert_eq!(hms(0), "00:00:00");
        assert_eq!(hms(826), "00:13:46");
        assert_eq!(hms(3661), "01:01:01");
        assert_eq!(parse_hms("01:01:01"), Some(3661));
        assert_eq!(parse_hms("13:46"), Some(826));
        assert_eq!(parse_hms("bad"), None);
    }

    #[test]
    fn decrypts_the_captured_module_key_blob() {
        let key = decrypt_module_key_blob(CAPTURED_MODULE_BLOB).unwrap();
        assert_eq!(key.c_key, VIDEO_MODULE_KEY_FALLBACK);
        assert_eq!(key.module, Some(11));
        assert_eq!(key.ckv, Some(2));
    }

    #[test]
    fn self_check_passes_with_current_constants() {
        crypto_self_check().unwrap();
    }

    #[test]
    fn cache_honours_ttl_and_modules() {
        let cache = ModuleKeyCache::new(Duration::from_millis(50));
        assert!(cache.get(11).is_none());
        cache.put(11, "azp53h0kft7qi78q");
        assert_eq!(cache.get(11).as_deref(), Some("azp53h0kft7qi78q"));
        assert!(cache.get(9).is_none());
        std::thread::sleep(Duration::from_millis(60));
        assert!(cache.get(11).is_none());
        cache.put(11, "x");
        cache.clear();
        assert!(cache.get(11).is_none());
    }
}
