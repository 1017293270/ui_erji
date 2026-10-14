//! EchoMind's local speech-to-text. Audio never leaves the machine: sherpa-onnx runs
//! the models on the CPU, and only the transcript goes on to the minutes engine.
//!
//! The mic track is the person recording (`S1`); everything the computer played is
//! the system track, split into speakers `S2…` by diarization. All functions block;
//! run them on a worker thread and set `cancel` to stop early.

mod error;
mod models;
mod recording;
mod speakers;
mod speech;
mod text;
mod transcript;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

pub use error::{Error, ErrorKind};
pub use models::{ModelInfo, ModelStatus, MIRROR_ENV};
pub use transcript::{Segment, Speaker, Track, Transcript};

use recording::{Recording, SAMPLE_RATE};
use text::Unit;

/// The steps reported to `on_progress`, each going from 0 to 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Reading the manifest and audio files.
    Prepare,
    /// Finding where anyone speaks (VAD), both tracks.
    Speech,
    /// Telling the voices on the system track apart.
    Speakers,
    /// Speech recognition.
    Text,
}

impl Stage {
    /// The name used in the `transcribe://progress` event.
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Prepare => "prepare",
            Stage::Speech => "speech",
            Stage::Speakers => "speakers",
            Stage::Text => "text",
        }
    }
}

/// Which models are on disk and how much is left to download.
pub fn model_status(models_dir: &Path) -> ModelStatus {
    models::model_status(models_dir)
}

/// Downloads the missing models (about 200 MB) into `models_dir`, verifying each
/// against its pinned sha256. Interrupted downloads resume on the next call.
/// `on_progress(received, total)` is in bytes.
pub fn download_models(models_dir: &Path, cancel: &AtomicBool, on_progress: impl FnMut(u64, u64)) -> Result<(), Error> {
    models::download_models(models_dir, cancel, on_progress)
}

/// Transcribes a recording folder written by echomind-capture.
/// The meeting id is the folder name.
pub fn transcribe(
    recording_dir: &Path,
    models_dir: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(Stage, f32),
) -> Result<Transcript, Error> {
    let check = || if cancel.load(Ordering::Relaxed) { Err(Error::cancelled()) } else { Ok(()) };
    on_progress(Stage::Prepare, 0.0);
    models::ensure_ready(models_dir)?;
    let recording = Recording::open(recording_dir)?;
    let threads = threads();
    on_progress(Stage::Prepare, 1.0);

    check()?;
    on_progress(Stage::Speech, 0.0);
    let tracks: Vec<_> = [&recording.mic, &recording.system].into_iter().flatten().collect();
    let total: u64 = tracks.iter().flat_map(|t| t.runs()).map(|(a, b)| b - a).sum::<u64>().max(1);
    let mut scanned = 0;
    let mut regions = Vec::new();
    for track in &tracks {
        let base = scanned;
        let found = speech::detect(track, models_dir, cancel, &mut |n| {
            scanned = base + n;
            on_progress(Stage::Speech, scanned as f32 / total as f32);
        })?;
        regions.push((track.kind, found));
    }
    let regions_of = |kind: Track| regions.iter().find(|(k, _)| *k == kind).map(|(_, r)| r.as_slice()).unwrap_or(&[]);
    on_progress(Stage::Speech, 1.0);

    check()?;
    on_progress(Stage::Speakers, 0.0);
    let turns = match &recording.system {
        Some(system) => speakers::diarize(system, regions_of(Track::System), models_dir, threads, cancel, &mut |p| {
            on_progress(Stage::Speakers, p)
        })?,
        None => Vec::new(),
    };
    on_progress(Stage::Speakers, 1.0);

    check()?;
    on_progress(Stage::Text, 0.0);
    let mut units = text::mic_units(regions_of(Track::Mic), regions_of(Track::System));
    units.extend(text::system_units(&turns, regions_of(Track::System)));
    let work: u64 = units.iter().map(|u| u.end - u.start).sum::<u64>().max(1);
    let mut done = 0;
    if !units.is_empty() {
        let asr = text::Asr::new(models_dir, threads)?;
        // One unit at a time: batching pads every unit to the longest and was slower.
        for unit in &mut units {
            check()?;
            let track = match unit.track {
                Track::Mic => recording.mic.as_ref(),
                Track::System => recording.system.as_ref(),
            };
            let Some(track) = track else { continue };
            let (start, end) = unit.padded(track.end());
            let samples = track.read(start, end)?;
            let seconds = (unit.end - unit.start) as f32 / SAMPLE_RATE as f32;
            unit.text = text::clean(&asr.recognize(&samples), seconds).unwrap_or_default();
            done += unit.end - unit.start;
            on_progress(Stage::Text, done as f32 / work as f32);
        }
    }
    units.retain(|u| !u.text.is_empty());
    text::drop_echo(&mut units);
    on_progress(Stage::Text, 1.0);

    Ok(assemble(&recording, units))
}

fn assemble(recording: &Recording, mut units: Vec<Unit>) -> Transcript {
    units.sort_by_key(|u| (u.start, u.end, u.track == Track::System));

    let mut speakers = Vec::new();
    if recording.mic.is_some() {
        speakers.push(Speaker {
            id: "S1".into(),
            label: "我".into(),
            track: Track::Mic,
            person_id: None,
            source: "self".into(),
            confidence: None,
        });
    }
    // Remote voices are numbered after filtering, so no id is left without a segment.
    let mut remote: Vec<usize> = Vec::new();
    let segments = units
        .into_iter()
        .enumerate()
        .map(|(i, u)| {
            let speaker_id = match u.track {
                Track::Mic => "S1".to_string(),
                Track::System => {
                    let n = match remote.iter().position(|&s| s == u.speaker) {
                        Some(p) => p,
                        None => {
                            remote.push(u.speaker);
                            let n = remote.len() + 1;
                            speakers.push(Speaker {
                                id: format!("S{n}"),
                                label: format!("说话人 {n}"),
                                track: Track::System,
                                person_id: None,
                                source: "unknown".into(),
                                confidence: None,
                            });
                            remote.len() - 1
                        }
                    };
                    format!("S{}", n + 2)
                }
            };
            Segment {
                id: format!("seg-{:04}", i + 1),
                speaker_id,
                track: u.track,
                start: u.start * 1000 / SAMPLE_RATE as u64,
                end: u.end * 1000 / SAMPLE_RATE as u64,
                text: u.text,
            }
        })
        .collect();

    Transcript { meeting_id: recording.meeting_id.clone(), language: "zh".into(), speakers, segments }
}

/// Diagnostics on stderr when ECHOMIND_TRANSCRIBE_DEBUG is set.
pub(crate) fn debug(message: impl FnOnce() -> String) {
    if std::env::var_os("ECHOMIND_TRANSCRIBE_DEBUG").is_some() {
        eprintln!("[transcriber] {}", message());
    }
}

/// Half the cores, at most four: transcription runs while the user keeps working, and
/// on an M1 Pro more threads were slower (they spill onto efficiency cores).
fn threads() -> i32 {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (cores / 2).clamp(1, 4) as i32
}
