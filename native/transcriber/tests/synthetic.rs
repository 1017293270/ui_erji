//! End to end on synthetic meetings from scripts/make-fixture.sh (macOS `say`), checked
//! through the JSON the app will read. Needs the models (`echomind-transcribe download`),
//! so it only runs when asked:
//!
//!   cargo test --release --test synthetic -- --ignored
//!
//! scripts/check-transcript.py prints the same measurements in more detail.

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

use echomind_transcriber::{model_status, transcribe, voices, Hints, Scene, Transcript};
use serde_json::Value;

fn models_dir() -> PathBuf {
    match std::env::var_os("ECHOMIND_MODELS_DIR") {
        Some(dir) => dir.into(),
        None => PathBuf::from(std::env::var_os("HOME").unwrap())
            .join("Library/Application Support/com.evanbyte.echomind/models"),
    }
}

/// A fresh fixture under the temp dir (removed when the test passes), never near the real recordings.
fn fixture(name: &str, args: &[&str]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("echomind-transcriber-test-{}", std::process::id())).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/make-fixture.sh");
    let status = Command::new(script).arg(&dir).args(args).status().expect("make-fixture.sh");
    assert!(status.success(), "make-fixture.sh failed");
    dir
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
    // The per-run parent goes once the last test has removed its fixture.
    let _ = std::fs::remove_dir(dir.parent().unwrap());
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn run(dir: &Path, hints: Hints) -> Value {
    let models = models_dir();
    assert!(model_status(&models).ready, "models not downloaded: cargo run --release -- download");
    let transcript = transcribe(dir, &models, hints, &AtomicBool::new(false), |_, _| {}).unwrap_or_else(|e| panic!("{e}"));
    serde_json::to_value(&transcript).unwrap()
}

fn ms(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or_else(|| panic!("{key} is not an integer: {v}"))
}

fn overlap(a: &Value, b: &Value) -> i64 {
    (ms(a, "end").min(ms(b, "end")) - ms(a, "start").max(ms(b, "start"))).max(0)
}

fn chars(text: &str) -> Vec<char> {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn cer(reference: &[char], hypothesis: &[char]) -> f64 {
    let mut row: Vec<usize> = (0..=hypothesis.len()).collect();
    for (i, x) in reference.iter().enumerate() {
        let mut diag = row[0];
        row[0] = i + 1;
        for (j, y) in hypothesis.iter().enumerate() {
            let next = (row[j + 1] + 1).min(row[j] + 1).min(diag + usize::from(x != y));
            diag = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[hypothesis.len()] as f64 / reference.len().max(1) as f64
}

fn track_cer(utterances: &[Value], segments: &[Value], track: &str) -> f64 {
    let text = |items: &[Value]| -> Vec<char> {
        items.iter().filter(|v| v["track"] == track).flat_map(|v| chars(v["text"].as_str().unwrap())).collect()
    };
    cer(&text(utterances), &text(segments))
}

/// The contract in packages/shared/src/meeting.ts.
fn check_shape(t: &Value, meeting_id: &str, scene: &str) {
    let keys: Vec<&str> = t.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys.len(), 5, "top-level keys {keys:?}");
    assert_eq!(t["meetingId"], meeting_id);
    assert_eq!(t["language"], "zh");
    assert_eq!(t["scene"], scene);
    let speakers = t["speakers"].as_array().unwrap();
    for (n, s) in speakers.iter().enumerate() {
        assert_eq!(s["id"], format!("S{}", n + 1));
        if s["source"] == "self" {
            assert_eq!(n, 0, "only S1 can be the person recording: {s}");
            assert_eq!((&s["label"], &s["track"]), (&"我".into(), &"mic".into()));
        } else {
            assert_eq!(s["label"], format!("说话人 {}", n + 1));
            assert_eq!(s["source"], "unknown");
        }
        assert!(s["personId"].is_null(), "personId must be present and null: {s}");
    }
    let mut previous = 0;
    for (i, seg) in t["segments"].as_array().unwrap().iter().enumerate() {
        assert_eq!(seg.as_object().unwrap().len(), 6, "segment keys {seg}");
        assert_eq!(seg["id"], format!("seg-{:04}", i + 1));
        let speaker = speakers.iter().find(|s| s["id"] == seg["speakerId"]).expect("segment speaker is listed");
        assert_eq!(speaker["track"], seg["track"]);
        let (start, end) = (ms(seg, "start"), ms(seg, "end"));
        assert!(previous <= start && start < end, "{seg}: not sorted or empty");
        assert!(end - start <= 20_500, "{seg}: longer than 20 s");
        assert!(!seg["text"].as_str().unwrap().trim().is_empty());
        previous = start;
    }
}

const ROOM_VOICES: &str = "Tingting,Eddy (Chinese (China mainland)),Grandma (Chinese (China mainland))";

fn ids(t: &Value) -> Vec<&str> {
    t["speakers"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect()
}

/// On one track: how many ids the voices mostly landed on, and the share of speech that
/// went to each voice's own id.
fn purity(utterances: &[Value], segments: &[Value], track: &str) -> (usize, f64) {
    let mut seconds: HashMap<(&str, &str), i64> = HashMap::new();
    for u in utterances.iter().filter(|u| u["track"] == track) {
        for s in segments.iter().filter(|s| s["track"] == track) {
            *seconds.entry((u["voice"].as_str().unwrap(), s["speakerId"].as_str().unwrap())).or_default() += overlap(u, s);
        }
    }
    let mut best: HashMap<&str, (&str, i64)> = HashMap::new();
    for (&(voice, id), &n) in &seconds {
        let entry = best.entry(voice).or_insert((id, 0));
        if n > entry.1 {
            *entry = (id, n);
        }
    }
    let mut owners: Vec<&str> = best.values().map(|&(id, _)| id).collect();
    owners.sort();
    owners.dedup();
    let total: i64 = seconds.values().sum();
    let pure: i64 = best.values().map(|&(_, n)| n).sum();
    (owners.len(), pure as f64 / total.max(1) as f64)
}

#[test]
#[ignore = "needs the downloaded models and macOS `say`"]
fn two_remote_voices_and_a_pause() {
    let dir = fixture("rec-default", &[]);
    let t = run(&dir, Hints { scene: Some(Scene::Online), people: None });
    check_shape(&t, "rec-default", "online");
    let utterances = read_json(&dir.join("expected.json"))["utterances"].as_array().unwrap().clone();
    let segments = t["segments"].as_array().unwrap();

    let mic = track_cer(&utterances, segments, "mic");
    let system = track_cer(&utterances, segments, "system");
    println!("CER mic {mic:.3}, system {system:.3}");
    // System is the robotic Eddy voice half the time (~14% alone); Meijia is ~1%.
    assert!(mic < 0.03 && system < 0.12, "CER mic {mic:.3}, system {system:.3}");

    // Each remote voice lands on its own id, and nearly all of its speech there.
    assert_eq!(ids(&t), ["S1", "S2", "S3"]);
    assert_eq!(t["speakers"][0]["source"], "self");
    let (owners, pure) = purity(&utterances, segments, "system");
    assert_eq!(owners, 2, "both voices went to the same id");
    assert!(pure >= 0.95, "diarization purity {pure:.3}");

    // Times are on the recording's clock, the 10 s pause included.
    let paused = &read_json(&dir.join("manifest.json"))["paused"][0];
    let mut worst = 0;
    for u in &utterances {
        let first = segments.iter().filter(|s| s["track"] == u["track"] && overlap(u, s) > 0).min_by_key(|s| ms(s, "start"));
        let Some(first) = first else { continue };
        let delta = ms(first, "start") - ms(u, "start");
        // Otherwise the utterance continues a segment that began with an earlier one.
        if delta.abs() < 1500 {
            worst = worst.max(delta.abs());
        }
    }
    assert!(worst <= 300, "a segment starts {worst} ms away from its utterance");
    let (from, to) = (ms(paused, "fromMs"), ms(paused, "toMs"));
    for s in segments {
        assert!(ms(s, "end") <= from || ms(s, "start") >= to, "{s} falls inside the pause {paused}");
    }
    cleanup(&dir);
}

#[test]
#[ignore = "needs the downloaded models and macOS `say`"]
fn echo_from_speakers_is_dropped() {
    let dir = fixture("rec-echo", &["--echo"]);
    let t = run(&dir, Hints { scene: Some(Scene::Online), people: None });
    check_shape(&t, "rec-echo", "online");
    let utterances = read_json(&dir.join("expected.json"))["utterances"].as_array().unwrap().clone();
    let segments = t["segments"].as_array().unwrap();

    let mic = track_cer(&utterances, segments, "mic");
    assert!(mic < 0.03, "CER mic {mic:.3}");
    let leaked: Vec<&Value> = segments
        .iter()
        .filter(|s| s["track"] == "mic" && !utterances.iter().any(|u| u["track"] == "mic" && overlap(u, s) > 0))
        .collect();
    assert!(leaked.is_empty(), "echo kept as the user's speech: {leaked:?}");
    cleanup(&dir);
}

#[test]
#[ignore = "needs the downloaded models and macOS `say`"]
fn three_people_around_a_table() {
    // Not Meijia: next to Tingting the voiceprint model hears one person (see the README).
    let dir = fixture("rec-room", &["--in-person", "--voices", ROOM_VOICES]);
    // Nothing comes from the computer, so the scene is judged to be in person.
    let t = run(&dir, Hints::default());
    check_shape(&t, "rec-room", "in-person");
    let utterances = read_json(&dir.join("expected.json"))["utterances"].as_array().unwrap().clone();
    let segments = t["segments"].as_array().unwrap();

    let mic = track_cer(&utterances, segments, "mic");
    println!("CER {mic:.3}");
    assert!(mic < 0.12, "CER {mic:.3}");
    assert_eq!(ids(&t), ["S1", "S2", "S3"]);
    assert!(t["speakers"].as_array().unwrap().iter().all(|s| s["source"] == "unknown" && s["track"] == "mic"));
    let (owners, pure) = purity(&utterances, segments, "mic");
    assert_eq!(owners, 3, "two voices went to the same id");
    assert!(pure >= 0.9, "diarization purity {pure:.3}");
    cleanup(&dir);
}

#[test]
#[ignore = "needs the downloaded models and macOS `say`"]
fn the_number_of_people_splits_voices_found_as_one() {
    // On their own, Tingting and Sandy come out as one voice.
    let voices = "Tingting,Eddy (Chinese (China mainland)),Sandy (Chinese (China mainland))";
    let dir = fixture("rec-room-count", &["--in-person", "--voices", voices]);
    let t = run(&dir, Hints { scene: None, people: Some(3) });
    check_shape(&t, "rec-room-count", "in-person");
    let utterances = read_json(&dir.join("expected.json"))["utterances"].as_array().unwrap().clone();
    let segments = t["segments"].as_array().unwrap();

    assert_eq!(ids(&t), ["S1", "S2", "S3"]);
    let (owners, pure) = purity(&utterances, segments, "mic");
    assert_eq!(owners, 3, "two voices went to the same id");
    assert!(pure >= 0.8, "diarization purity {pure:.3}");
    cleanup(&dir);
}

#[test]
#[ignore = "needs the downloaded models and macOS `say`"]
fn a_call_taken_for_a_room_takes_nobody_for_me() {
    let dir = fixture("rec-call", &["--echo"]);
    let t = run(&dir, Hints { scene: Some(Scene::InPerson), people: None });
    check_shape(&t, "rec-call", "in-person");
    let utterances = read_json(&dir.join("expected.json"))["utterances"].as_array().unwrap().clone();
    let segments = t["segments"].as_array().unwrap();

    assert_eq!(ids(&t), ["S1", "S2", "S3"]);
    // The one voice on the mic is the person recording, but in a room that is not assumed.
    assert_eq!((&t["speakers"][0]["source"], &t["speakers"][0]["label"]), (&"unknown".into(), &"说话人 1".into()));
    let mic = track_cer(&utterances, segments, "mic");
    assert!(mic < 0.03, "CER mic {mic:.3}");
    let leaked = segments
        .iter()
        .filter(|s| s["track"] == "mic" && !utterances.iter().any(|u| u["track"] == "mic" && overlap(u, s) > 0))
        .count();
    assert_eq!(leaked, 0, "echo kept as the user's speech");
    cleanup(&dir);
}

/// The voice that says most of what a speaker id says.
fn voice_of<'a>(utterances: &'a [Value], segments: &[Value], speaker: &str) -> &'a str {
    let mine: Vec<&Value> = segments.iter().filter(|s| s["speakerId"] == speaker).collect();
    utterances
        .iter()
        .max_by_key(|u| mine.iter().map(|s| overlap(u, s)).sum::<i64>())
        .and_then(|u| u["voice"].as_str())
        .unwrap()
}

#[test]
#[ignore = "needs the downloaded models and macOS `say`"]
fn voices_are_recognised_in_another_meeting() {
    // The same three people, seated (and so numbered) differently.
    let a = fixture("rec-voices-a", &["--in-person", "--voices", ROOM_VOICES]);
    let b = fixture("rec-voices-b", &["--in-person", "--voices", "Grandma (Chinese (China mainland)),Tingting,Eddy (Chinese (China mainland))"]);
    let models = models_dir();
    let mut found = Vec::new();
    for dir in [&a, &b] {
        // Telling the voices apart is not what this checks.
        let value = run(dir, Hints { scene: None, people: Some(3) });
        let transcript: Transcript = serde_json::from_value(value.clone()).unwrap();
        let utterances = read_json(&dir.join("expected.json"))["utterances"].as_array().unwrap().clone();
        let segments = value["segments"].as_array().unwrap().clone();
        let vs = voices(dir, &transcript, &models, &AtomicBool::new(false)).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(vs.len(), 3);
        let named: Vec<(String, Vec<f32>, f32)> =
            vs.into_iter().map(|v| (voice_of(&utterances, &segments, &v.speaker_id).to_string(), v.vector, v.seconds)).collect();
        found.push(named);
    }
    // As the server decides (apps/server/src/voiceprints.ts): the closest voiceprint, at a cosine
    // similarity of 0.6 or more and 0.05 ahead of the next. Eddy and Grandma, two voices of one
    // speech synthesizer, come out at about 0.7 to each other, so the margin is what tells them apart.
    for (name_b, vb, _) in &found[1] {
        let mut scores: Vec<(&str, f32)> =
            found[0].iter().map(|(name_a, va, _)| (name_a.as_str(), va.iter().zip(vb).map(|(x, y)| x * y).sum())).collect();
        scores.sort_by(|x, y| y.1.total_cmp(&x.1));
        println!("{name_b}: {scores:.2?}");
        let (best, top) = scores[0];
        assert_eq!(best, name_b, "{name_b} taken for {best}");
        assert!(top >= 0.6 && top - scores[1].1 >= 0.05, "{name_b} not recognised clearly: {scores:.2?}");
    }
    cleanup(&a);
    cleanup(&b);
}
