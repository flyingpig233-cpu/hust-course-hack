//! Unit-test gaps for the Zhihuishu core, exercised through the crate's public
//! API only.
//!
//! The mock-server integration tests live in `zhs_mock.rs`; this file covers the
//! deterministic pieces: AES `secretStr` vectors, the module-key blob fixture,
//! XOR `sdsew`/course-secret encoding, `watch_points`/`hms`, the module-key
//! cache TTL, meet coverage planning, video payload construction and the pure
//! course-reference parser. Nothing here touches the network.

use std::collections::HashSet;
use std::time::Duration;

use hust_course_hack::zhihuishu::watch::{build_video_payload, plan_videos};
use hust_course_hack::zhihuishu::{
    ModuleKeyCache, ZhsChapter, ZhsCourse, ZhsCourseDetail, ZhsLesson, ZhsMeetProgress,
    ZhsMeetWatchOptions, ZhsVideo, ZhsVideoTarget, ZhsWatchOptions, crypto_self_check,
    decrypt_module_key_blob, decrypt_secret, encrypt_secret, hms, parse_course_reference,
    parse_hms, plan_meet_minutes, watch_points, xor_decode, xor_encode,
};
use rand::SeedableRng;
use rand::rngs::StdRng;

/// Video-module fallback key (`module = 11`), the same constant the client uses
/// when the runtime handshake is unavailable.
const VIDEO_KEY: &str = "azp53h0kft7qi78q";

/// A real `c/has` blob captured from the live site; decoding it must yield the
/// current module-11 `cKey` (and must keep working when the platform rotates the
/// video key, which is exactly what `crypto_self_check` guards).
const CAPTURED_MODULE_BLOB: &str = "bHh4XnFfDYprnOcYwUpPfxFfE2DWlEXbz4AIwEeJ5QvUkNjkGRJcdwSab6PKDibGkMOBLOT9or/\
nas7MyMrjLzof8VaWOsdTBn/vgDM14M+ubEo3itu051bjGWizlMwtgJ2mEli/uspItbefvVIKkeTc5hzhn5m14uCxxH3ZLHM=";

/// XOR-encoded `sdsew` captured from the live study page. It decodes to
/// `463667;1000337351;1000244446;70622143;1000116293;0;0;468;00:07:48;abcdefgh`.
const CAPTURED_SDSEW: &str = "4e4c4342425d5f4b4a4044475953494f414f455a544a484440405e52414d40424658554e494b45445a54\
4b4b46464d595f4a41404f405c5c414a404e445d5e4e424b151609001f1c171c";

/// `recruitAndCourseId` secret of `recruitId=463667` / `courseId=1000011214`.
const CAPTURED_COURSE_SECRET: &str = "4e5e5a5e435e4859454a585959445b425c";

#[test]
fn crypto_self_check_passes_with_current_constants() {
    crypto_self_check().expect("offline crypto self-check must pass for the shipped constants");
}

#[test]
fn encrypts_and_decrypts_the_captured_video_payload() {
    const PLAINTEXT: &str = "{\"videoId\":70796671,\"dateFormate\":1794059294000}";
    const CIPHERTEXT: &str =
        "FmhUDZ6n4Tv6m90r5dj3KMK3oxlaFlD9DAGEuzSX+9LeNgzdSWaXdNNfC1SeVevn9fTy6Nxn+scj2pyLhFFxKg==";

    let ciphertext = encrypt_secret(VIDEO_KEY, PLAINTEXT).expect("encrypt captured payload");
    assert_eq!(ciphertext, CIPHERTEXT, "AES-CBC output changed");
    let plaintext = decrypt_secret(VIDEO_KEY, CIPHERTEXT).expect("decrypt captured payload");
    assert_eq!(plaintext, PLAINTEXT);

    // Partial blocks must still round-trip through PKCS#7 padding.
    for len in [1usize, 15, 16, 17, 31, 32, 33, 200] {
        let text = "x".repeat(len);
        let ciphertext = encrypt_secret(VIDEO_KEY, &text).expect("encrypt");
        assert_eq!(
            decrypt_secret(VIDEO_KEY, &ciphertext).expect("decrypt"),
            text,
            "round-trip failed for {len} bytes"
        );
    }
}

#[test]
fn decrypts_the_captured_module_key_blob() {
    let key = decrypt_module_key_blob(CAPTURED_MODULE_BLOB).expect("decode captured module blob");
    assert_eq!(key.c_key, VIDEO_KEY);
    assert_eq!(key.module, Some(11));
    assert_eq!(key.ckv, Some(2));
    assert_eq!(key.nkv, Some(3));
    assert_eq!(key.c_key.len(), 16, "AES-128 key must be 16 bytes");
}

#[test]
fn xor_matches_the_captured_sdsew_vector() {
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
    .map(|value| (*value).to_string())
    .collect();

    assert_eq!(xor_encode(&fields, "zzpttjd"), CAPTURED_SDSEW);
    assert_eq!(
        xor_decode(CAPTURED_SDSEW, "zzpttjd").expect("decode sdsew"),
        fields.join(";")
    );

    // The video report appends the literal `zhs` to the short login uuid.
    let mut with_suffix = fields.clone();
    with_suffix[9] = "abcdefghzhs".to_string();
    let encoded = xor_encode(&with_suffix, "zzpttjd");
    assert_eq!(
        xor_decode(&encoded, "zzpttjd").expect("decode"),
        with_suffix.join(";")
    );
    assert_ne!(
        encoded, CAPTURED_SDSEW,
        "the uuid suffix changes the encoding"
    );
}

#[test]
fn course_secret_round_trips_between_ids_and_xor() {
    let course = ZhsCourse {
        recruit_id: 463667,
        course_id: 1000011214,
        ..ZhsCourse::default()
    };
    assert_eq!(course.course_secret(), CAPTURED_COURSE_SECRET);
    assert_eq!(course.secret_or_derive(), CAPTURED_COURSE_SECRET);
    assert_eq!(
        xor_decode(CAPTURED_COURSE_SECRET, "zhihuishu").expect("decode course secret"),
        "463667;1000011214"
    );

    let explicit = ZhsCourse {
        secret: Some("ignored-by-derive".to_string()),
        ..course.clone()
    };
    assert_eq!(explicit.secret_or_derive(), "ignored-by-derive");
}

#[test]
fn watch_points_match_the_page_helper() {
    assert_eq!(watch_points(0), "0,1");
    assert_eq!(watch_points(1), "0,1,2");
    assert_eq!(watch_points(2), "0,1,2,2");
    assert_eq!(watch_points(4), "0,1,2,2,2");
    assert_eq!(watch_points(5), "0,1,2,2,2");

    let values: Vec<u64> = watch_points(468)
        .split(',')
        .map(|value| value.parse().expect("numeric watch point"))
        .collect();
    // 2 fixed values + every k with k * 1.99 < 468 (k = 0..=235).
    assert_eq!(values.len(), 2 + 236);
    assert_eq!(&values[..8], &[0, 1, 2, 2, 2, 3, 3, 3]);
    for pair in values.windows(2) {
        assert!(
            pair[1] >= pair[0],
            "watch points must be non-decreasing: {pair:?}"
        );
    }

    // Short videos still get the two fixed leading values.
    assert_eq!(watch_points(3), "0,1,2,2");
}

#[test]
fn hms_formats_and_parses_edges() {
    for (secs, text) in [
        (0u64, "00:00:00"),
        (59, "00:00:59"),
        (60, "00:01:00"),
        (3599, "00:59:59"),
        (3600, "01:00:00"),
        (826, "00:13:46"),
        (86399, "23:59:59"),
    ] {
        assert_eq!(hms(secs), text);
        assert_eq!(parse_hms(text), Some(secs));
    }
    assert_eq!(parse_hms("02:03"), Some(123));
    assert_eq!(parse_hms("42"), Some(42));
    assert_eq!(parse_hms("1:2:3:4"), None);
    assert_eq!(parse_hms("abc"), None);
    assert_eq!(parse_hms(""), None);
}

#[test]
fn module_key_cache_honours_ttl_and_modules() {
    let cache = ModuleKeyCache::new(Duration::from_millis(30));
    assert!(cache.get(11).is_none());

    cache.put(11, "video-key");
    cache.put(9, "meet-key");
    assert_eq!(cache.get(11).as_deref(), Some("video-key"));
    assert_eq!(cache.get(9).as_deref(), Some("meet-key"));
    assert!(cache.get(13).is_none());

    std::thread::sleep(Duration::from_millis(60));
    assert!(cache.get(11).is_none(), "expired key must not be returned");
    assert!(cache.get(9).is_none());

    // A refresh restarts the TTL and `clear` drops everything.
    cache.put(9, "fresh");
    assert_eq!(cache.get(9).as_deref(), Some("fresh"));
    cache.clear();
    assert!(cache.get(9).is_none());

    // The default cache uses the plan's 30-minute lifetime.
    let default_cache = ModuleKeyCache::default();
    default_cache.put(11, "k");
    assert_eq!(default_cache.get(11).as_deref(), Some("k"));
}

#[test]
fn meet_watch_options_defaults_match_the_plan() {
    let opts = ZhsMeetWatchOptions::default();
    assert!(opts.dry_run, "core default must stay read-only");
    assert_eq!(opts.coverage_min, 0.90);
    assert_eq!(opts.coverage_max, 1.00);
    assert_eq!(opts.delay_min_ms, 2_000);
    assert_eq!(opts.delay_max_ms, 6_000);
    assert!(opts.circuit_breaker);
    assert_eq!(opts.check_every, 10);
}

#[test]
fn video_watch_options_default_to_dry_run() {
    let opts = ZhsWatchOptions::default();
    assert!(opts.dry_run, "core default must stay read-only");
    assert!(!opts.include_completed);
    assert!(opts.max_videos.is_none());
    assert!(opts.verify);
    let live = ZhsWatchOptions {
        dry_run: false,
        ..ZhsWatchOptions::default()
    };
    assert!(!live.dry_run);
}

#[test]
fn plan_meet_minutes_excludes_watched_and_stays_sorted() {
    let mut rng = StdRng::seed_from_u64(7);
    let watched = [1u32, 5, 5, 200];
    let minutes = plan_meet_minutes(10, &watched, 8, &mut rng);
    assert_eq!(
        minutes.len(),
        8 - 2,
        "out-of-range watched minutes are ignored"
    );
    assert!(minutes.windows(2).all(|pair| pair[0] < pair[1]), "sorted");
    assert!(!minutes.contains(&1));
    assert!(!minutes.contains(&5));
    assert!(minutes.iter().all(|minute| (1..=10).contains(minute)));
    let unique: HashSet<u32> = minutes.iter().copied().collect();
    assert_eq!(unique.len(), minutes.len());
}

#[test]
fn plan_meet_minutes_reaches_the_target_and_is_randomized() {
    let total = 100u32;
    let target = 90u32;
    let mut distinct = HashSet::new();
    for seed in 0..16u64 {
        let mut rng = StdRng::seed_from_u64(seed);
        let minutes = plan_meet_minutes(total, &[], target, &mut rng);
        assert_eq!(minutes.len(), target as usize, "seed {seed}");
        assert!(minutes.iter().all(|minute| (1..=total).contains(minute)));
        assert!(minutes.windows(2).all(|pair| pair[0] < pair[1]));
        distinct.insert(minutes);
    }
    assert!(
        distinct.len() > 1,
        "random tail drops should produce more than one selection"
    );

    // A full coverage target has no tail to refill from, so at most ~5% of the
    // selected minutes can be dropped; the count stays close to the target.
    let mut rng = StdRng::seed_from_u64(99);
    let minutes = plan_meet_minutes(120, &[], 120, &mut rng);
    assert!(
        (114..=120).contains(&minutes.len()),
        "len = {}",
        minutes.len()
    );
}

#[test]
fn plan_meet_minutes_returns_empty_when_nothing_to_do() {
    let mut rng = StdRng::seed_from_u64(1);
    assert!(plan_meet_minutes(0, &[], 10, &mut rng).is_empty());
    assert!(plan_meet_minutes(10, &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10, &mut rng).is_empty());
    assert!(plan_meet_minutes(10, &[1, 2, 3], 3, &mut rng).is_empty());
    // Target below the watched count also means "nothing to report".
    assert!(plan_meet_minutes(10, &[1, 2, 3], 2, &mut rng).is_empty());
}

#[test]
fn video_target_skip_reason_covers_the_edge_cases() {
    let opts = ZhsWatchOptions::default();
    let target = ZhsVideoTarget {
        video_id: 3,
        lesson_video_id: 4,
        video_sec: 100,
        completed: true,
        ..ZhsVideoTarget::default()
    };
    assert!(target.skip_reason(&opts).is_some());
    let include = ZhsWatchOptions {
        include_completed: true,
        ..ZhsWatchOptions::default()
    };
    assert!(target.skip_reason(&include).is_none());

    let incomplete = ZhsVideoTarget {
        completed: false,
        ..target.clone()
    };
    assert!(incomplete.skip_reason(&opts).is_none());
    let missing_video = ZhsVideoTarget {
        video_id: 0,
        completed: false,
        ..target.clone()
    };
    assert!(missing_video.skip_reason(&opts).is_some());
    let missing_sec = ZhsVideoTarget {
        video_sec: 0,
        completed: false,
        ..target
    };
    assert!(missing_sec.skip_reason(&opts).is_some());
}

#[test]
fn build_video_payload_matches_the_verified_layout() {
    let target = ZhsVideoTarget {
        recruit_id: 463667,
        course_id: 1000011214,
        chapter_id: 1000116293,
        lesson_id: 1000337351,
        lesson_video_id: 1000244446,
        video_id: 70622143,
        video_sec: 468,
        label: "x".to_string(),
        completed: false,
    };
    let payload = build_video_payload(&target, "abcdefgh", 13_191_360_047).expect("build payload");

    let sdsew = payload["sdsew"].as_str().expect("sdsew string");
    assert_eq!(
        xor_decode(sdsew, "zzpttjd").expect("decode sdsew"),
        "463667;1000337351;1000244446;70622143;1000116293;0;468;468;00:07:48;abcdefghzhs"
    );
    assert_eq!(payload["ewssw"].as_str(), Some(watch_points(468).as_str()));
    assert_eq!(payload["zwsds"].as_str(), Some("MTMxOTEzNjAwNDc="));
    assert!(
        payload.get("courseId").is_none(),
        "save_interval adds courseId, the report payload itself does not"
    );
}

fn sample_detail() -> ZhsCourseDetail {
    ZhsCourseDetail {
        course: ZhsCourse {
            recruit_id: 463667,
            course_id: 1000011214,
            name: "军事理论".to_string(),
            ..ZhsCourse::default()
        },
        chapters: vec![ZhsChapter {
            chapter_id: Some(1000116293),
            name: "第一章".to_string(),
            lessons: vec![ZhsLesson {
                lesson_id: 1000337356,
                name: "第一节".to_string(),
                videos: vec![
                    ZhsVideo {
                        video_id: 71192505,
                        lesson_video_id: 1000244477,
                        video_sec: 826,
                        is_studied: Some(1),
                        name: String::new(),
                    },
                    ZhsVideo {
                        video_id: 74150643,
                        lesson_video_id: 1000244476,
                        video_sec: 492,
                        is_studied: Some(0),
                        name: "小节二".to_string(),
                    },
                ],
                ..ZhsLesson::default()
            }],
            ..ZhsChapter::default()
        }],
    }
}

#[test]
fn plan_videos_flattens_marks_completion_and_respects_max() {
    let detail = sample_detail();
    let options = ZhsWatchOptions::default();
    let targets = plan_videos(&detail, &options);
    assert_eq!(targets.len(), 2);
    assert_eq!(targets[0].chapter_id, 1000116293);
    assert_eq!(targets[0].lesson_id, 1000337356);
    assert_eq!(targets[0].lesson_video_id, 1000244477);
    assert_eq!(targets[0].video_id, 71192505);
    assert_eq!(targets[0].video_sec, 826);
    assert!(targets[0].completed);
    assert!(!targets[1].completed);
    assert!(targets[0].label.contains("军事理论"));
    assert!(targets[0].label.contains("第一章"));
    assert!(targets[0].label.contains("第一节"));
    assert!(targets[0].label.contains("小节1"));
    assert!(targets[1].label.contains("小节二"));

    let limited = ZhsWatchOptions {
        max_videos: Some(1),
        ..ZhsWatchOptions::default()
    };
    assert_eq!(plan_videos(&detail, &limited).len(), 1);
    let unlimited_zero = ZhsWatchOptions {
        max_videos: Some(0),
        ..ZhsWatchOptions::default()
    };
    assert_eq!(plan_videos(&detail, &unlimited_zero).len(), 2);

    let detail = sample_detail();
    assert_eq!(detail.total_videos(), 2);
    assert_eq!(detail.completed_videos(), 1);
}

#[test]
fn parse_course_reference_accepts_every_supported_form() {
    let from_secret_url = parse_course_reference(
        "https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=4e5e5a5e435e4859454a585959445b425c",
    )
    .expect("secret URL");
    assert_eq!(from_secret_url.recruit_id, 463667);
    assert_eq!(from_secret_url.course_id, 1000011214);
    assert_eq!(
        from_secret_url.secret.as_deref(),
        Some(CAPTURED_COURSE_SECRET)
    );

    let from_ids_url = parse_course_reference(
        "https://studyvideoh5.zhihuishu.com/stuStudy?courseId=1000011214&recruitId=463667",
    )
    .expect("ids URL");
    assert_eq!(from_ids_url.recruit_id, 463667);
    assert_eq!(from_ids_url.course_id, 1000011214);
    assert!(from_ids_url.secret.is_none());

    let from_bare_secret = parse_course_reference(CAPTURED_COURSE_SECRET).expect("bare secret");
    assert_eq!(from_bare_secret.recruit_id, 463667);
    assert_eq!(from_bare_secret.course_id, 1000011214);

    let from_pairs = parse_course_reference("463667;1000011214").expect("id pair");
    assert_eq!(from_pairs.recruit_id, 463667);
    assert_eq!(from_pairs.course_id, 1000011214);

    let from_slash = parse_course_reference("463667/1000011214").expect("id slash");
    assert_eq!(from_slash.course_id, 1000011214);

    let inline = parse_course_reference(
        "stuStudy?recruitAndCourseId=4e5e5a5e435e4859454a585959445b425c&x=1",
    )
    .expect("inline secret");
    assert_eq!(inline.recruit_id, 463667);
    assert_eq!(inline.course_id, 1000011214);

    assert!(parse_course_reference("").is_none());
    assert!(parse_course_reference("   ").is_none());
    assert!(parse_course_reference("not-a-course-reference").is_none());
    assert!(parse_course_reference("https://example.com/?courseId=1").is_none());
}

#[test]
fn meet_progress_sorts_dedupes_and_computes_percent() {
    let progress = ZhsMeetProgress::new(120, vec![3, 1, 2, 2, 0]);
    assert_eq!(progress.total_minutes, 120);
    assert_eq!(progress.watched_minutes, vec![0, 1, 2, 3]);
    assert_eq!(progress.watched_count, 4);
    assert_eq!(progress.percent, 3, "4 / 120 rounds down to 3%");

    let empty = ZhsMeetProgress::new(0, vec![1, 2]);
    assert_eq!(empty.percent, 0);
    assert_eq!(empty.watched_minutes, vec![1, 2]);
}
