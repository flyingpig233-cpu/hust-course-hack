//! DES-ECB + PKCS#7 + Base64 encryption used by the Ulearning `sync` endpoint.
//!
//! The player encrypts the study-record JSON with the hardcoded key
//! `12345678`, `CryptoJS.mode.ECB` and `CryptoJS.pad.Pkcs7`, then sends the
//! Base64 ciphertext as the request body. This module reproduces that exactly;
//! the block-mode and padding are implemented explicitly so the output can be
//! compared byte-for-byte against captured/CryptoJS samples in tests.
//!
//! This is obfuscation, not secrecy: the key ships with the web client and is
//! public. It must never be treated as a credential.

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use des::Des;
use des::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, generic_array::GenericArray};

/// Hardcoded DES key used by the Ulearning player for `sync` bodies.
pub const DES_KEY: &str = "12345678";

/// DES block size in bytes.
const BLOCK: usize = 8;

fn des_cipher() -> Result<Des> {
    Des::new_from_slice(DES_KEY.as_bytes()).map_err(|_| anyhow::anyhow!("invalid DES key"))
}

/// Encrypt UTF-8 plaintext with DES-ECB/PKCS#7 and return Base64.
///
/// Equivalent to `CryptoJS.DES.encrypt(text, Utf8.parse("12345678"),
/// {mode: ECB, padding: Pkcs7}).toString()`.
pub fn encrypt_ecb_base64(plaintext: &str) -> Result<String> {
    let cipher = des_cipher()?;
    let mut data = plaintext.as_bytes().to_vec();

    // PKCS#7: always append 1..=8 padding bytes.
    let pad = BLOCK - data.len() % BLOCK;
    data.resize(data.len() + pad, pad as u8);

    for chunk in data.chunks_mut(BLOCK) {
        let block = GenericArray::from_mut_slice(chunk);
        cipher.encrypt_block(block);
    }
    Ok(STANDARD.encode(&data))
}

/// Decrypt a Base64 DES-ECB/PKCS#7 ciphertext back to UTF-8.
///
/// Used by tests and mock servers to inspect what the client sent; the client
/// itself only encrypts.
pub fn decrypt_ecb_base64(ciphertext_b64: &str) -> Result<String> {
    let cipher = des_cipher()?;
    let mut data = STANDARD
        .decode(ciphertext_b64.trim())
        .context("invalid base64 sync ciphertext")?;
    if data.is_empty() || data.len() % BLOCK != 0 {
        bail!("invalid DES ciphertext length: {}", data.len());
    }

    for chunk in data.chunks_mut(BLOCK) {
        let block = GenericArray::from_mut_slice(chunk);
        cipher.decrypt_block(block);
    }

    let pad = usize::from(*data.last().expect("non-empty ciphertext"));
    if pad == 0 || pad > BLOCK || pad > data.len() {
        bail!("invalid PKCS#7 padding (pad byte {pad})");
    }
    if data[data.len() - pad..]
        .iter()
        .any(|byte| usize::from(*byte) != pad)
    {
        bail!("invalid PKCS#7 padding bytes");
    }
    data.truncate(data.len() - pad);
    String::from_utf8(data).context("DES plaintext is not valid UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors generated with an independent DES implementation (.NET
    // DESCryptoServiceProvider, ECB + PKCS7). They match what CryptoJS produces
    // for the same key/mode/padding.
    const VECTORS: [(&str, &str); 5] = [
        ("hello world", "KNugLrX23UddguNoHIO7dw=="),
        (
            "{\"itemid\":2377981,\"autoSave\":1,\"complete\":1,\"studyStartTime\":1794062059,\"score\":100}",
            "+rydL4Ll3U9fTNud6KUNjnYolPDSz1lmz/bsowEmdj5YhH7vbf5mnpT9nCHuapcnntH8/MBDIiZfDTUIqUtNgccx+r7YoTHTYIUWGV3UxcyDDKV8X6ulhA==",
        ),
        ("12345678", "ltACiHjVjIn+uVm31GQvyw=="),
        ("1234567890123456", "ltACiHjVjIlpJacuILgm9/65WbfUZC/L"),
        ("", "/rlZt9RkL8s="),
    ];

    #[test]
    fn encrypts_reference_vectors() {
        for (plaintext, expected) in VECTORS {
            assert_eq!(
                encrypt_ecb_base64(plaintext).unwrap(),
                expected,
                "plaintext {plaintext:?}"
            );
        }
    }

    #[test]
    fn decrypts_reference_vectors() {
        for (plaintext, ciphertext) in VECTORS {
            assert_eq!(decrypt_ecb_base64(ciphertext).unwrap(), plaintext);
        }
    }

    #[test]
    fn round_trips_utf8_and_block_boundaries() {
        for text in [
            "中文内容",
            "a",
            "1234567",
            "123456789",
            "{\"complete\":1,\"score\":100}",
        ] {
            let ciphertext = encrypt_ecb_base64(text).unwrap();
            assert_eq!(decrypt_ecb_base64(&ciphertext).unwrap(), text);
        }
    }

    #[test]
    fn rejects_bad_ciphertext() {
        assert!(decrypt_ecb_base64("").is_err());
        assert!(decrypt_ecb_base64("AAAA").is_err());
        assert!(decrypt_ecb_base64("not-base64!!!").is_err());
    }
}
