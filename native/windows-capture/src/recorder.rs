use std::collections::BTreeMap;
use std::path::PathBuf;

use chrono::{DateTime, Local};
use serde_json::{json, Value};

use crate::backend::{AudioChunk, TrackKind};
use crate::events::{rounded, EventSink};
use crate::levels::LevelMeter;
use crate::manifest::{Manifest, SegmentEntry};
use crate::resampler::Resampler;
use crate::timeline::{Location, Timeline};
use crate::wav::WavWriter;

pub struct Config {
    pub out_dir: PathBuf,
    pub sample_rate: u32,
    pub segment_seconds: u32,
    pub tracks: Vec<TrackKind>,
}

#[derive(Default)]
struct TrackStats { chunks: u64, padded_frames: i64, dropped_frames: i64, resyncs: u64 }

struct Track {
    kind: TrackKind,
    cursor: i64,
    contiguous_end: Option<i64>,
    origin: i64,
    resampler: Option<Resampler>,
    writers: BTreeMap<usize, WavWriter>,
    meter: LevelMeter,
    stats: TrackStats,
}

impl Track {
    fn new(kind: TrackKind) -> Self {
        Self { kind, cursor: 0, contiguous_end: None, origin: 0, resampler: None,
            writers: BTreeMap::new(), meter: LevelMeter::default(), stats: TrackStats::default() }
    }
}

enum Source<'a> { Samples(&'a [f32]), Silence(i64) }

type Failure = (&'static str, String);

// All calls stay on the session's main thread.
pub struct Recorder<'a> {
    config: Config,
    sink: &'a dyn EventSink,
    timeline: Timeline,
    tracks: Vec<Track>,
    manifest: Manifest,
    t0: u64,
    now_frame: i64,
    stopped: bool,
    failed: bool,
}

impl<'a> Recorder<'a> {
    pub fn new(config: Config, sink: &'a dyn EventSink) -> Self {
        let tracks: Vec<_> = TrackKind::ALL.into_iter().filter(|t| config.tracks.contains(t)).map(Track::new).collect();
        let manifest = Manifest::new(Local::now(), config.sample_rate, config.segment_seconds,
            tracks.iter().map(|t| t.kind).collect());
        let timeline = Timeline::new(i64::from(config.sample_rate) * i64::from(config.segment_seconds));
        Self { config, sink, timeline, tracks, manifest, t0: 0, now_frame: 0, stopped: false, failed: false }
    }

    pub fn started_at_iso(&self) -> &str { &self.manifest.started_at }
    pub fn failed(&self) -> bool { self.failed }

    pub fn start(&mut self, t0_ns: u64, started_at: DateTime<Local>) {
        self.t0 = t0_ns;
        self.manifest = Manifest::new(started_at, self.config.sample_rate, self.config.segment_seconds,
            self.tracks.iter().map(|t| t.kind).collect());
        self.save_manifest();
    }

    pub fn ingest(&mut self, chunk: AudioChunk, kind: TrackKind) {
        if self.stopped || self.failed || chunk.samples.is_empty() { return; }
        let Some(i) = self.tracks.iter().position(|t| t.kind == kind) else { return; };
        let host_position = self.frame(chunk.host_ns);
        let threshold = i64::from(self.config.sample_rate) / 50;
        let future = host_position > self.now_frame + i64::from(self.config.sample_rate) * 5;
        let result = (|| -> Result<(), Failure> {
            let track = &mut self.tracks[i];
            track.stats.chunks += 1;
            if self.timeline.paused_from.is_none() { track.meter.add(&chunk.samples); }
            let mut position = host_position;
            let mut resync = false;
            if future {
                eprintln!("[echomind-capture] {} 轨时间戳异常（超前当前时间），按连续写入处理", kind.name());
                position = track.contiguous_end.unwrap_or(track.cursor);
            } else if let Some(contiguous) = track.contiguous_end {
                if (host_position - contiguous).abs() <= threshold { position = contiguous; }
                else {
                    resync = true;
                    track.stats.resyncs += 1;
                    eprintln!("[echomind-capture] {} 轨按主机时间重新对齐，偏差 {} ms", kind.name(),
                        (host_position - contiguous) * 1000 / i64::from(self.config.sample_rate));
                }
            }
            if resync || track.resampler.as_ref().map(|r| r.input_rate) != Some(chunk.sample_rate) {
                Self::drain_resampler(&self.config, &mut self.timeline, track)?;
                track.resampler = Some(Resampler::new(chunk.sample_rate, self.config.sample_rate)
                    .map_err(|e| ("resample_failed", e))?);
                track.origin = position;
            }
            let resampler = track.resampler.as_mut().unwrap();
            let at = track.origin + resampler.emitted_frames();
            let output = resampler.process(&chunk.samples).map_err(|e| ("resample_failed", e))?;
            track.contiguous_end = Some(track.origin + resampler.expected_frames());
            Self::place(&self.config, &mut self.timeline, track, &output, at).map_err(Self::write_error)
        })();
        if let Err((code, message)) = result { self.fail(code, &message); }
        self.finalize_ready_segments();
    }

    pub fn tick(&mut self, now_ns: u64) {
        if self.stopped || self.failed { return; }
        self.now_frame = self.now_frame.max(self.frame(now_ns));
        let limit = self.now_frame - i64::from(self.config.sample_rate);
        for i in 0..self.tracks.len() {
            let track = &mut self.tracks[i];
            if track.cursor < limit {
                let n = limit - track.cursor;
                track.stats.padded_frames += n;
                if let Err(e) = Self::advance(&self.config, &mut self.timeline, track, Source::Silence(n)) {
                    self.fail("write_failed", &Self::write_error(e).1);
                    return;
                }
            }
        }
        if self.tracks.is_empty() { self.timeline.locate(self.now_frame); }
        self.finalize_ready_segments();
        if self.failed { return; }
        let paused = self.timeline.paused_from.is_some();
        let mut levels = [Value::Null, Value::Null];
        for track in &mut self.tracks {
            let db = track.meter.take();
            levels[track.kind as usize] = rounded(if paused { LevelMeter::FLOOR_DB } else { db });
        }
        self.sink.emit(json!({ "type": "level", "t": self.ms_since_start(now_ns), "mic": levels[0], "system": levels[1] }));
    }

    pub fn mark(&mut self, now_ns: u64) {
        if self.stopped || self.failed { return; }
        let at = self.ms_since_start(now_ns);
        self.manifest.marks.push(at);
        self.save_manifest();
        if !self.failed { self.sink.emit(json!({ "type": "mark", "atMs": at })); }
    }

    pub fn pause(&mut self, now_ns: u64) -> bool {
        if self.stopped || self.failed { return false; }
        let p = self.frame(now_ns).max(self.max_cursor());
        if !self.timeline.pause(p) { return false; }
        self.manifest.paused.push((self.ms(p), None));
        self.save_manifest();
        if !self.failed { self.sink.emit(json!({ "type": "paused", "atMs": self.ms(p) })); }
        self.finalize_ready_segments();
        true
    }

    pub fn resume(&mut self, now_ns: u64) -> bool {
        if self.stopped || self.failed { return false; }
        let r = self.frame(now_ns).max(self.max_cursor());
        let Some(from) = self.timeline.resume(r) else { return false; };
        let at = self.ms(r.max(from));
        self.manifest.paused.last_mut().unwrap().1 = Some(at);
        self.save_manifest();
        if !self.failed { self.sink.emit(json!({ "type": "resumed", "atMs": at })); }
        true
    }

    pub fn stop(&mut self, now_ns: u64) {
        if self.stopped { return; }
        if !self.failed {
            for i in 0..self.tracks.len() {
                if let Err((code, message)) = Self::drain_resampler(&self.config, &mut self.timeline, &mut self.tracks[i]) {
                    self.fail(code, &message);
                    break;
                }
            }
        }
        let s = self.frame(now_ns).max(self.max_cursor()).max(self.timeline.paused_from.unwrap_or(0));
        if self.timeline.paused_from.is_some() { self.manifest.paused.last_mut().unwrap().1 = Some(self.ms(s)); }
        self.timeline.stop(s);
        if !self.failed {
            for i in 0..self.tracks.len() {
                let track = &mut self.tracks[i];
                if track.cursor < s {
                    let n = s - track.cursor;
                    track.stats.padded_frames += n;
                    if let Err(e) = Self::advance(&self.config, &mut self.timeline, track, Source::Silence(n)) {
                        self.fail("write_failed", &Self::write_error(e).1);
                        break;
                    }
                }
            }
            self.now_frame = self.now_frame.max(s);
            self.finalize_ready_segments();
        }
        for i in 0..self.tracks.len() {
            let writers = std::mem::take(&mut self.tracks[i].writers);
            for mut writer in writers.into_values() {
                if let Err(e) = writer.close() { self.fail("write_failed", &Self::write_error(e).1); }
            }
        }
        self.stopped = true;
        self.manifest.status = "stopped";
        self.manifest.duration_ms = Some(self.ms(s));
        self.save_manifest();
        eprintln!("[echomind-capture] 录音结束: {}", self.stats_json());
        self.sink.emit(json!({ "type": "stopped", "durationMs": self.ms(s), "segments": self.manifest.segments.len() }));
    }

    pub fn stats_json(&self) -> Value {
        let mut stats = json!({});
        for track in &self.tracks {
            stats[track.kind.name()] = json!({ "chunks": track.stats.chunks, "paddedMs": self.ms(track.stats.padded_frames),
                "droppedMs": self.ms(track.stats.dropped_frames), "resyncs": track.stats.resyncs });
        }
        stats
    }

    fn drain_resampler(config: &Config, timeline: &mut Timeline, track: &mut Track) -> Result<(), Failure> {
        if let Some(resampler) = track.resampler.as_mut() {
            let at = track.origin + resampler.emitted_frames();
            let tail = resampler.finish().map_err(|e| ("resample_failed", e))?;
            Self::place(config, timeline, track, &tail, at).map_err(Self::write_error)?;
        }
        Ok(())
    }

    fn place(config: &Config, timeline: &mut Timeline, track: &mut Track, samples: &[f32], position: i64) -> std::io::Result<()> {
        if samples.is_empty() { return Ok(()); }
        if position > track.cursor {
            let n = position - track.cursor;
            track.stats.padded_frames += n;
            Self::advance(config, timeline, track, Source::Silence(n))?;
        }
        let skip = (track.cursor - position).max(0).min(samples.len() as i64) as usize;
        track.stats.dropped_frames += skip as i64;
        Self::advance(config, timeline, track, Source::Samples(&samples[skip..]))
    }

    fn advance(config: &Config, timeline: &mut Timeline, track: &mut Track, source: Source<'_>) -> std::io::Result<()> {
        let mut remaining = match source { Source::Samples(s) => s.len() as i64, Source::Silence(n) => n };
        let mut consumed = 0;
        while remaining > 0 {
            let n = match timeline.locate(track.cursor) {
                Location::Segment(i) => {
                    let segment = &timeline.segments[i];
                    let n = remaining.min(segment.end - track.cursor);
                    if !track.writers.contains_key(&segment.index) {
                        let path = config.out_dir.join(file_name(track.kind, segment.index));
                        track.writers.insert(segment.index, WavWriter::new(&path, config.sample_rate)?);
                    }
                    let writer = track.writers.get_mut(&segment.index).unwrap();
                    match source {
                        Source::Samples(samples) => writer.append(&samples[consumed..consumed + n as usize])?,
                        Source::Silence(_) => writer.append_silence(n as usize)?,
                    }
                    if track.cursor + n == segment.end {
                        writer.close()?;
                        track.writers.remove(&segment.index);
                    }
                    n
                }
                Location::Gap(until) => until.map_or(remaining, |end| remaining.min(end - track.cursor)),
            };
            track.cursor += n;
            consumed += n as usize;
            remaining -= n;
        }
        Ok(())
    }

    fn finalize_ready_segments(&mut self) {
        if self.failed { return; }
        let reached = self.tracks.iter().map(|t| t.cursor).min().unwrap_or(self.now_frame);
        while let Some(i) = self.timeline.first_open_index() {
            if self.timeline.segments[i].end > reached { break; }
            let segment = &self.timeline.segments[i];
            let index = segment.index;
            let start_ms = self.ms(segment.start);
            let end_ms = self.ms(segment.end);
            let mut files = [None, None];
            for t in 0..self.tracks.len() {
                let track = &mut self.tracks[t];
                if let Some(mut writer) = track.writers.remove(&index) {
                    if let Err(e) = writer.close() {
                        self.fail("write_failed", &Self::write_error(e).1);
                        return;
                    }
                }
                files[track.kind as usize] = Some(file_name(track.kind, index));
            }
            self.timeline.segments[i].finalized = true;
            let [mic, system] = files;
            let mic_path = mic.as_ref().map(|f| self.config.out_dir.join(f).display().to_string());
            let system_path = system.as_ref().map(|f| self.config.out_dir.join(f).display().to_string());
            self.manifest.segments.push(SegmentEntry { index, start_ms, end_ms, mic, system });
            self.save_manifest();
            if self.failed { return; }
            self.sink.emit(json!({ "type": "segment", "index": index, "startMs": start_ms, "endMs": end_ms,
                "mic": mic_path, "system": system_path }));
        }
    }

    fn save_manifest(&mut self) {
        if let Err(e) = self.manifest.write(&self.config.out_dir) { self.fail("write_failed", &format!("写入 manifest.json 失败：{e}")); }
    }

    fn fail(&mut self, code: &str, message: &str) {
        if self.failed { return; }
        self.failed = true;
        self.sink.error(code, message);
    }

    fn write_error(error: std::io::Error) -> Failure { ("write_failed", format!("写入录音文件失败：{error}")) }
    fn max_cursor(&self) -> i64 { self.tracks.iter().map(|t| t.cursor).max().unwrap_or(self.now_frame) }
    fn frame(&self, ns: u64) -> i64 { ((ns.wrapping_sub(self.t0) as i64) as f64 * f64::from(self.config.sample_rate) / 1e9).round() as i64 }
    fn ms(&self, frames: i64) -> i64 { frames * 1000 / i64::from(self.config.sample_rate) }
    fn ms_since_start(&self, ns: u64) -> i64 { (ns.wrapping_sub(self.t0) as i64) / 1_000_000 }
}

pub fn file_name(kind: TrackKind, index: usize) -> String { format!("{}-{index:04}.wav", kind.name()) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::MemorySink;
    use crate::wav;
    use std::fs;

    #[test]
    fn different_rates_and_rate_changes_preserve_alignment() {
        let dir = crate::selftest::test_dir("rate-change");
        fs::create_dir_all(&dir).unwrap();
        let sink = MemorySink::default();
        let mut recorder = Recorder::new(Config { out_dir: dir.clone(), sample_rate: 16000,
            segment_seconds: 1, tracks: TrackKind::ALL.to_vec() }, &sink);
        let t0 = 1_000_000_000_000;
        recorder.start(t0, Local::now());
        let starts = [0.3, 0.995, 1.3];
        for i in 0..200 {
            for kind in TrackKind::ALL {
                let rate = match kind {
                    TrackKind::System => 44100,
                    TrackKind::Mic if i < 70 => 48000,
                    TrackKind::Mic if i < 130 => 44100,
                    TrackKind::Mic => 16000,
                };
                let samples = (0..rate / 100).map(|f| {
                    let t = i as f64 / 100.0 + f64::from(f) / f64::from(rate);
                    starts.iter().rev().find(|&&s| s <= t).map_or(0.0, |&s| {
                        if t >= s + 0.1 { 0.0 } else { (2.0 * std::f64::consts::PI * 440.0 * (t - s)).sin() as f32 * 0.5 }
                    })
                }).collect();
                recorder.ingest(AudioChunk { host_ns: t0 + i * 10_000_000, sample_rate: rate, samples }, kind);
            }
            if i % 10 == 9 { recorder.tick(t0 + (i + 1) * 10_000_000); }
        }
        recorder.stop(t0 + 2_000_000_000);
        assert!(!recorder.failed());
        let mut tracks = [Vec::new(), Vec::new()];
        for kind in TrackKind::ALL {
            for index in 1..=2 {
                let samples = wav::read(&dir.join(file_name(kind, index))).unwrap().samples;
                assert_eq!(samples.len(), 16000);
                tracks[kind as usize].extend(samples);
            }
        }
        for start in starts {
            let expected = (start * 16000.0) as usize;
            let onset = |samples: &[i16]| {
                let a = expected.saturating_sub(160);
                a + samples[a..expected + 160].iter().position(|&s| i32::from(s).abs() > 3277).unwrap()
            };
            let mic = onset(&tracks[0]);
            let system = onset(&tracks[1]);
            assert!(mic.abs_diff(system) <= 160, "{mic} / {system}");
            assert!(mic.abs_diff(expected) <= 160 && system.abs_diff(expected) <= 160);
        }
        assert_eq!(recorder.stats_json()["mic"]["resyncs"], 0);
        assert_eq!(sink.events().iter().filter(|e| e["type"] == "segment").count(), 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn every_track_must_reach_the_cut_and_stalled_tracks_are_padded() {
        let dir = crate::selftest::test_dir("watchdog");
        fs::create_dir_all(&dir).unwrap();
        let sink = MemorySink::default();
        let mut recorder = Recorder::new(Config { out_dir: dir.clone(), sample_rate: 16000,
            segment_seconds: 1, tracks: TrackKind::ALL.to_vec() }, &sink);
        let t0 = 1_000_000_000_000;
        recorder.start(t0, Local::now());
        recorder.ingest(AudioChunk { host_ns: t0, sample_rate: 16000, samples: vec![0.5; 16000] }, TrackKind::Mic);
        assert!(!sink.events().iter().any(|e| e["type"] == "segment"));
        recorder.ingest(AudioChunk { host_ns: t0, sample_rate: 16000, samples: vec![0.25; 8000] }, TrackKind::System);
        recorder.tick(t0 + 2_100_000_000);
        assert_eq!(sink.events().iter().filter(|e| e["type"] == "segment").count(), 1);
        let system = wav::read(&dir.join("system-0001.wav")).unwrap().samples;
        assert!(system[..8000].iter().all(|&s| s > 0));
        assert!(system[8000..].iter().all(|&s| s == 0));
        recorder.ingest(AudioChunk { host_ns: t0 + 20_000_000_000, sample_rate: 16000, samples: vec![1.0; 160] }, TrackKind::Mic);
        assert_eq!(recorder.stats_json()["mic"]["resyncs"], 0);
        recorder.stop(t0 + 2_100_000_000);
        assert_eq!(sink.events().last().unwrap()["durationMs"], 2100);
        fs::remove_dir_all(dir).unwrap();
    }
}
