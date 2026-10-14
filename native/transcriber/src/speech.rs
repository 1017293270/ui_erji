//! Where people speak: Silero VAD over a whole track, streamed so memory stays flat.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};

use crate::error::{Error, ErrorKind, Result};
use crate::models;
use crate::recording::{TrackAudio, SAMPLE_RATE};

/// A stretch of speech on the timeline, in 16 kHz samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Region {
    pub start: u64,
    pub end: u64,
}

impl Region {
    pub fn len(&self) -> u64 {
        self.end - self.start
    }
}

/// Silero looks at 512-sample windows; feeding exactly one per call keeps segment
/// edges at window precision (sherpa-onnx decides speech per call, not per window).
const WINDOW: usize = 512;
const CHUNK: u64 = 10 * SAMPLE_RATE as u64;

fn create(models_dir: &Path) -> Result<VoiceActivityDetector> {
    let config = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(models::VAD.path(models_dir, models::VAD.file_name())),
            threshold: 0.5,
            // Short, so long monologues have many pauses to cut at; text.rs decides
            // which pauses end a segment.
            min_silence_duration: 0.3,
            // Not the usual 0.25 s: a lone "好，" before a pause is shorter, and anything
            // VAD misses is cut out before diarization and never transcribed.
            min_speech_duration: 0.1,
            window_size: WINDOW as i32,
            // Above this sherpa-onnx raises the threshold until it finds a cut.
            max_speech_duration: 20.0,
        },
        sample_rate: SAMPLE_RATE as i32,
        num_threads: 1,
        provider: Some("cpu".into()),
        debug: false,
        ..Default::default()
    };
    VoiceActivityDetector::create(&config, 60.0)
        .ok_or_else(|| Error::new(ErrorKind::Engine, "人声检测模型加载失败，模型文件可能已损坏：请删除后重新下载语音模型。"))
}

/// Speech regions of `track`, sorted. `on_samples` gets the number of samples scanned so far.
pub(crate) fn detect(
    track: &TrackAudio,
    models_dir: &Path,
    cancel: &AtomicBool,
    on_samples: &mut dyn FnMut(u64),
) -> Result<Vec<Region>> {
    let mut regions = Vec::new();
    let mut scanned = 0;
    for (run_start, run_end) in track.runs() {
        // A fresh detector per run: its sample counter starts at the run, and state
        // never carries across a pause.
        let vad = create(models_dir)?;
        let mut pos = run_start;
        while pos < run_end {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::cancelled());
            }
            let end = (pos + CHUNK).min(run_end);
            let mut samples = track.read(pos, end)?;
            if end == run_end && samples.len() % WINDOW != 0 {
                samples.resize(samples.len().div_ceil(WINDOW) * WINDOW, 0.0);
            }
            for window in samples.chunks(WINDOW) {
                vad.accept_waveform(window);
            }
            drain(&vad, run_start, run_end, &mut regions);
            scanned += end - pos;
            on_samples(scanned);
            pos = end;
        }
        vad.flush();
        drain(&vad, run_start, run_end, &mut regions);
    }
    regions.sort_by_key(|r| r.start);
    Ok(regions)
}

fn drain(vad: &VoiceActivityDetector, run_start: u64, run_end: u64, out: &mut Vec<Region>) {
    while let Some(segment) = vad.front() {
        let start = run_start + segment.start().max(0) as u64;
        let end = (start + segment.n().max(0) as u64).min(run_end);
        if end > start {
            out.push(Region { start, end });
        }
        vad.pop();
    }
}
