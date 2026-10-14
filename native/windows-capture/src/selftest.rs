use std::fs;
use std::path::Path;

use chrono::Local;
use serde_json::{json, Value};

use crate::backend::{AudioChunk, TrackKind};
use crate::events::{rounded, EventSink, MemorySink};
use crate::mix::mix_to_mono;
use crate::recorder::{file_name, Config, Recorder};
use crate::wav;

const SAMPLE_RATE: u32 = 16000;
const SEGMENT_SECONDS: u32 = 2;
const TOLERANCE_FRAMES: usize = 160;
type ExpectedSegment = (usize, i64, i64);

pub fn run(out_dir: &Path, sink: &dyn EventSink) -> u8 {
    let aligned = run_aligned(out_dir);
    let pause = run_pause_dropout(&out_dir.join("pause-dropout"));
    let ok = aligned.ok() && pause.ok();
    sink.emit(json!({ "type": "selftest", "ok": ok, "out": out_dir.display().to_string(),
        "sampleRate": SAMPLE_RATE, "segmentSeconds": SEGMENT_SECONDS, "scenarios": [aligned.json(), pause.json()] }));
    u8::from(!ok)
}

fn run_aligned(dir: &Path) -> Report {
    let mut report = Report::new("aligned");
    let mic_bursts = vec![0.0, 1.0, 1.95, 3.0];
    let system_bursts = vec![0.25, 1.0, 1.95, 3.0];
    let streams = [
        SyntheticStream { track: TrackKind::Mic, tone: Tone { frequency: 440.0, amplitude: 0.5,
            starts: mic_bursts.clone(), length: 0.1 }, channels: 1, start: 0.0, buffer_frames: 480, dropout: None },
        SyntheticStream { track: TrackKind::System, tone: Tone { frequency: 660.0, amplitude: 0.5,
            starts: system_bursts.clone(), length: 0.1 }, channels: 2, start: 0.25, buffer_frames: 512, dropout: None },
    ];
    let Some(sim) = simulate(dir, &streams, &[(1.5, "mark")], 5.0, &mut report) else { return report; };
    let expected = [(1, 0, 2000), (2, 2000, 4000), (3, 4000, 5000)];
    let [mic, system] = verify_segments(dir, &expected, &mut report);
    verify_manifest(dir, &expected, &[1500], &[], &mut report);
    verify_events(&sim.sink, expected.len(), &mut report);
    if mic.is_empty() || system.is_empty() { return report; }

    let mic_found = bursts(&mic);
    let system_found = bursts(&system);
    let mic_onsets: Vec<_> = mic_found.iter().map(|b| b.0).collect();
    let system_onsets: Vec<_> = system_found.iter().map(|b| b.0).collect();
    let expected_mic: Vec<_> = mic_bursts.iter().map(|t| (t * f64::from(SAMPLE_RATE)) as usize).collect();
    let expected_system: Vec<_> = system_bursts.iter().map(|t| (t * f64::from(SAMPLE_RATE)) as usize).collect();
    report.check("mic 音爆起点误差不超过 10 ms", close(&mic_onsets, &expected_mic), format!("{mic_onsets:?} / {expected_mic:?}"));
    report.check("system 音爆起点及 250 ms 静音", close(&system_onsets, &expected_system), format!("{system_onsets:?} / {expected_system:?}"));
    for found in [&mic_found, &system_found] {
        let lengths: Vec<_> = found.iter().map(|&(a, b)| b - a).collect();
        report.check("音爆长 100 ms，跨段保持连续", lengths.iter().all(|&n| n.abs_diff(1600) <= TOLERANCE_FRAMES), format!("{lengths:?}"));
    }
    let skew = if mic_onsets.len() == 4 && system_onsets.len() == 4 {
        (1..4).map(|i| mic_onsets[i].abs_diff(system_onsets[i])).max().unwrap()
    } else { usize::MAX };
    report.check("共同音爆偏差不超过 10 ms", skew <= TOLERANCE_FRAMES, format!("{skew} 帧"));
    let mic_hz = mic_found.first().map_or(0.0, |&(a, b)| frequency(&mic[a..b]));
    let system_hz = system_found.first().map_or(0.0, |&(a, b)| frequency(&system[a..b]));
    report.check("mic 频率约 440 Hz", (mic_hz - 440.0).abs() < 22.0, mic_hz.to_string());
    report.check("system 频率约 660 Hz", (system_hz - 660.0).abs() < 33.0, system_hz.to_string());
    report.extra = vec![
        ("systemLeadInMs", rounded(system_onsets.first().map_or(-1.0, |&n| n as f64) * 1000.0 / f64::from(SAMPLE_RATE))),
        ("expectedLeadInMs", json!(250)), ("maxSharedBurstSkewMs", rounded(skew as f64 * 1000.0 / f64::from(SAMPLE_RATE))),
        ("micOnsetsMs", onset_ms(&mic_onsets)), ("systemOnsetsMs", onset_ms(&system_onsets)),
        ("micHz", rounded(mic_hz)), ("systemHz", rounded(system_hz)), ("stats", sim.stats),
    ];
    report
}

fn run_pause_dropout(dir: &Path) -> Report {
    let mut report = Report::new("pause-dropout");
    let streams = [
        SyntheticStream { track: TrackKind::Mic, tone: Tone { frequency: 440.0, amplitude: 0.3,
            starts: vec![0.0], length: 10.0 }, channels: 1, start: 0.0, buffer_frames: 480, dropout: Some((1.2, 1.7)) },
        SyntheticStream { track: TrackKind::System, tone: Tone { frequency: 660.0, amplitude: 0.3,
            starts: vec![0.0], length: 10.0 }, channels: 2, start: 0.0, buffer_frames: 512, dropout: None },
    ];
    let Some(sim) = simulate(dir, &streams, &[(0.5, "mark"), (2.5, "pause"), (3.5, "resume")], 5.0, &mut report) else { return report; };
    let expected = [(1, 0, 2000), (2, 2000, 2500), (3, 3500, 5000)];
    verify_segments(dir, &expected, &mut report);
    verify_manifest(dir, &expected, &[500], &[(2500, 3500)], &mut report);
    verify_events(&sim.sink, expected.len(), &mut report);
    let types: Vec<_> = sim.sink.events().iter().filter_map(|e| e["type"].as_str().map(str::to_owned)).collect();
    report.check("paused/resumed 事件", types.iter().any(|t| t == "paused") && types.iter().any(|t| t == "resumed"), format!("{types:?}"));
    match (wav::read(&dir.join("mic-0001.wav")), wav::read(&dir.join("system-0001.wav")), wav::read(&dir.join("mic-0003.wav"))) {
        (Ok(mic1), Ok(sys1), Ok(mic3)) => {
            let gap = rms(window(&mic1.samples, 1.22, 1.68));
            let before = rms(window(&mic1.samples, 0.5, 1.15));
            let after = rms(window(&mic1.samples, 1.75, 1.95));
            let system_during = rms(window(&sys1.samples, 1.22, 1.68));
            let resumed = rms(window(&mic3.samples, 0.0, 0.1));
            report.check("mic 中断期间补静音", gap < 1e-4, format!("rms {gap}"));
            report.check("mic 中断前后有声音", before > 0.1 && after > 0.1, format!("rms {before} / {after}"));
            report.check("system 不受 mic 中断影响", system_during > 0.1, format!("rms {system_during}"));
            report.check("resume 后立刻有声音", resumed > 0.1, format!("rms {resumed}"));
            report.extra = vec![("micDropoutRms", json!(gap)),
                ("micRmsAroundDropout", json!([(before * 1000.0).round() / 1000.0, (after * 1000.0).round() / 1000.0])),
                ("stats", sim.stats)];
        }
        _ => report.fail("重新读取 pause-dropout 文件失败".into()),
    }
    report
}

struct Tone { frequency: f64, amplitude: f32, starts: Vec<f64>, length: f64 }

impl Tone {
    fn value(&self, t: f64) -> f32 {
        let Some(&start) = self.starts.iter().rev().find(|&&s| s <= t) else { return 0.0; };
        if t >= start + self.length { return 0.0; }
        self.amplitude * (2.0 * std::f64::consts::PI * self.frequency * (t - start)).sin() as f32
    }
}

struct SyntheticStream {
    track: TrackKind,
    tone: Tone,
    channels: usize,
    start: f64,
    buffer_frames: usize,
    dropout: Option<(f64, f64)>,
}

impl SyntheticStream {
    fn chunks(&self, end: f64, t0: u64) -> Vec<(f64, AudioChunk)> {
        let rate = 48000.0;
        let mut result = Vec::new();
        let mut frame = 0;
        loop {
            let buffer_start = self.start + frame as f64 / rate;
            let delivered_at = self.start + (frame + self.buffer_frames) as f64 / rate;
            frame += self.buffer_frames;
            if delivered_at > end + 1e-9 { break; }
            if self.dropout.is_some_and(|(a, b)| (a..b).contains(&buffer_start)) { continue; }
            let mut interleaved = Vec::with_capacity(self.buffer_frames * self.channels);
            for i in 0..self.buffer_frames {
                let value = self.tone.value(buffer_start + i as f64 / rate);
                interleaved.extend(std::iter::repeat_n(value, self.channels));
            }
            result.push((delivered_at, AudioChunk { host_ns: t0 + (buffer_start * 1e9).round() as u64,
                sample_rate: 48000, samples: mix_to_mono(&interleaved, self.channels) }));
        }
        result
    }
}

struct Simulation { sink: MemorySink, stats: Value }
enum Step { Chunk(TrackKind, AudioChunk), Command(&'static str), Tick }

fn simulate(dir: &Path, streams: &[SyntheticStream], commands: &[(f64, &'static str)], stop_at: f64, report: &mut Report) -> Option<Simulation> {
    if let Err(e) = prepare(dir) { report.fail(format!("准备 {} 失败：{e}", dir.display())); return None; }
    let t0 = 1_000_000_000_000;
    let sink = MemorySink::default();
    let mut recorder = Recorder::new(Config { out_dir: dir.to_owned(), sample_rate: SAMPLE_RATE,
        segment_seconds: SEGMENT_SECONDS, tracks: TrackKind::ALL.to_vec() }, &sink);
    recorder.start(t0, Local::now());
    let mut steps = Vec::new();
    for stream in streams {
        steps.extend(stream.chunks(stop_at, t0).into_iter().map(|(at, chunk)| (at, 0, Step::Chunk(stream.track, chunk))));
    }
    steps.extend(commands.iter().map(|&(at, cmd)| (at, 1, Step::Command(cmd))));
    steps.extend((1..=(stop_at * 10.0) as usize).map(|n| (n as f64 / 10.0, 2, Step::Tick)));
    steps.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    for (at, _, step) in steps {
        let now = t0 + (at * 1e9).round() as u64;
        match step {
            Step::Chunk(track, chunk) => recorder.ingest(chunk, track),
            Step::Tick => recorder.tick(now),
            Step::Command("mark") => recorder.mark(now),
            Step::Command("pause") => { recorder.pause(now); }
            Step::Command("resume") => { recorder.resume(now); }
            Step::Command(_) => {},
        }
    }
    recorder.stop(t0 + (stop_at * 1e9).round() as u64);
    let stats = recorder.stats_json();
    drop(recorder);
    Some(Simulation { sink, stats })
}

fn prepare(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "manifest.json" || (name.ends_with(".wav") && (name.starts_with("mic-") || name.starts_with("system-"))) {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

struct Report {
    name: &'static str,
    passed: usize,
    failures: Vec<String>,
    segments: Vec<Value>,
    extra: Vec<(&'static str, Value)>,
}

impl Report {
    fn new(name: &'static str) -> Self {
        Self { name, passed: 0, failures: Vec::new(), segments: Vec::new(), extra: Vec::new() }
    }
    fn ok(&self) -> bool { self.failures.is_empty() && self.passed > 0 }
    fn check(&mut self, what: &str, condition: bool, detail: String) {
        if condition { self.passed += 1; } else { self.fail(format!("{what}：{detail}")); }
    }
    fn fail(&mut self, what: String) { self.failures.push(what); }
    fn json(&self) -> Value {
        let mut value = json!({ "name": self.name, "ok": self.ok(), "checksPassed": self.passed,
            "failures": self.failures, "segments": self.segments });
        for (key, extra) in &self.extra { value[*key] = extra.clone(); }
        value
    }
}

fn verify_segments(dir: &Path, expected: &[ExpectedSegment], report: &mut Report) -> [Vec<i16>; 2] {
    let mut joined = [Vec::new(), Vec::new()];
    for &(index, start_ms, end_ms) in expected {
        let expected_frames = ((end_ms - start_ms) * i64::from(SAMPLE_RATE) / 1000) as usize;
        let mut frames = json!({});
        for track in TrackKind::ALL {
            let name = file_name(track, index);
            let wav = match wav::read(&dir.join(&name)) {
                Ok(wav) => wav, Err(e) => { report.fail(format!("读取 {name} 失败：{e}")); continue; }
            };
            let header_ok = wav.format_tag == 1 && wav.channels == 1 && wav.sample_rate == SAMPLE_RATE
                && wav.bits_per_sample == 16 && wav.block_align == 2 && wav.byte_rate == SAMPLE_RATE * 2 && wav.riff_size_matches;
            report.check(&format!("{name} WAV 头"), header_ok, "需要单声道 16-bit PCM 16000 Hz".into());
            report.check(&format!("{name} 样本数"), wav.samples.len() == expected_frames, format!("{} / {expected_frames}", wav.samples.len()));
            frames[track.name()] = json!(wav.samples.len());
            joined[track as usize].extend(wav.samples);
        }
        report.segments.push(json!({ "index": index, "startMs": start_ms, "endMs": end_ms, "frames": frames }));
    }
    let count = fs::read_dir(dir).map(|entries| entries.filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".wav")).count()).unwrap_or(0);
    report.check("没有多余分段文件", count == expected.len() * 2, format!("{count} 个 WAV"));
    joined
}

fn verify_manifest(dir: &Path, expected: &[ExpectedSegment], marks: &[i64], paused: &[(i64, i64)], report: &mut Report) {
    let manifest = fs::read(dir.join("manifest.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let Some(m) = manifest else { report.fail("解析 manifest.json 失败".into()); return; };
    let segments: Vec<_> = expected.iter().map(|&(i, a, b)| json!({ "index": i, "startMs": a, "endMs": b,
        "mic": file_name(TrackKind::Mic, i), "system": file_name(TrackKind::System, i) })).collect();
    report.check("manifest 分段", m["segments"] == json!(segments), m["segments"].to_string());
    let header = m["version"] == 1 && m["sampleRate"] == SAMPLE_RATE && m["segmentSeconds"] == SEGMENT_SECONDS
        && m["status"] == "stopped" && m["tracks"] == json!(["mic", "system"]) && m["startedAt"].is_string();
    report.check("manifest 头", header, m.to_string());
    let want_marks: Vec<_> = marks.iter().map(|at| json!({ "atMs": at })).collect();
    report.check("manifest 标记", m["marks"] == json!(want_marks), m["marks"].to_string());
    let want_paused: Vec<_> = paused.iter().map(|(a, b)| json!({ "fromMs": a, "toMs": b })).collect();
    report.check("manifest 暂停", m["paused"] == json!(want_paused), m["paused"].to_string());
}

fn verify_events(sink: &MemorySink, segments: usize, report: &mut Report) {
    let events = sink.events();
    let count = events.iter().filter(|e| e["type"] == "segment").count();
    report.check("segment 事件", count == segments, count.to_string());
    let stopped = events.last();
    report.check("最后一行是 stopped", stopped.is_some_and(|e| e["type"] == "stopped" && e["segments"] == segments), format!("{stopped:?}"));
    let levels = events.iter().filter(|e| e["type"] == "level").count();
    report.check("每 100 ms 的 level 事件", levels >= 45, levels.to_string());
}

fn bursts(samples: &[i16]) -> Vec<(usize, usize)> {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (i, _) in samples.iter().enumerate().filter(|(_, s)| i32::from(**s).abs() > 3277) {
        if let Some(last) = runs.last_mut().filter(|last| i - last.1 <= SAMPLE_RATE as usize / 200) { last.1 = i + 1; }
        else { runs.push((i, i + 1)); }
    }
    runs
}

fn close(found: &[usize], expected: &[usize]) -> bool {
    found.len() == expected.len() && found.iter().zip(expected).all(|(&a, &b)| a.abs_diff(b) <= TOLERANCE_FRAMES)
}

fn onset_ms(onsets: &[usize]) -> Value {
    json!(onsets.iter().map(|&n| rounded(n as f64 * 1000.0 / f64::from(SAMPLE_RATE))).collect::<Vec<_>>())
}

fn frequency(samples: &[i16]) -> f64 {
    let crossings: Vec<_> = samples.windows(2).enumerate().filter(|(_, p)| (p[0] < 0) != (p[1] < 0)).map(|(i, _)| i + 1).collect();
    match (crossings.first(), crossings.last()) {
        (Some(&a), Some(&b)) if b > a => (crossings.len() - 1) as f64 / 2.0 / ((b - a) as f64 / f64::from(SAMPLE_RATE)),
        _ => 0.0,
    }
}

fn window(samples: &[i16], from: f64, to: f64) -> &[i16] {
    samples.get((from * f64::from(SAMPLE_RATE)) as usize..(to * f64::from(SAMPLE_RATE)) as usize).unwrap_or_default()
}

fn rms(samples: &[i16]) -> f64 {
    if samples.is_empty() { return 0.0; }
    (samples.iter().map(|&s| f64::from(s).powi(2)).sum::<f64>() / samples.len() as f64).sqrt() / 32768.0
}

#[cfg(test)]
pub fn test_dir(name: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!("echomind-{name}-{}-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selftest_runs_both_scenarios_through_the_real_pipeline() {
        let dir = test_dir("selftest");
        let sink = MemorySink::default();
        let code = run(&dir, &sink);
        let events = sink.events();
        assert_eq!(code, 0, "{}", events[0]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["scenarios"][0]["checksPassed"], 27);
        assert_eq!(events[0]["scenarios"][1]["checksPassed"], 25);
        fs::remove_dir_all(dir).unwrap();
    }
}
