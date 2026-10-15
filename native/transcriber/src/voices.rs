//! Voiceprints of the speakers in a finished transcript, for recognising them in other
//! meetings: one CAM++ embedding per speaker, from up to a minute of their speech where
//! nobody else on the same track talks. The app asks the EchoMind server who they are,
//! and uploads someone's only once they have agreed; nothing here is written to disk.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sherpa_onnx::SpeakerEmbeddingExtractor;

use crate::error::{Error, Result};
use crate::models;
use crate::recording::{Recording, TrackAudio, SAMPLE_RATE};
use crate::speakers::{embedding_config, engine_error};
use crate::transcript::{Track, Transcript};

const SR: u64 = SAMPLE_RATE as u64;
const PER_MS: u64 = SR / 1000;
/// Speech used for one voiceprint, as in diarization.
const MAX_SPEECH: u64 = 60 * SR;
/// Stretches shorter than this, once overlaps are cut out, are mostly edges.
const MIN_STRETCH: u64 = SR / 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub speaker_id: String,
    /// Seconds of speech the voiceprint was taken from.
    pub seconds: f32,
    /// L2-normalised.
    pub vector: Vec<f32>,
}

/// A voiceprint for every speaker of `transcript` with enough audio for one.
pub fn voices(recording_dir: &Path, transcript: &Transcript, models_dir: &Path, cancel: &AtomicBool) -> Result<Vec<Voice>> {
    models::ensure(models_dir, &[&models::EMBEDDING])?;
    let recording = Recording::open(recording_dir)?;
    let extractor = SpeakerEmbeddingExtractor::create(&embedding_config(models_dir, crate::threads())).ok_or_else(|| engine_error("声纹"))?;

    let mut voices = Vec::new();
    for speaker in &transcript.speakers {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::cancelled());
        }
        let track = match speaker.track {
            Track::Mic => recording.mic.as_ref(),
            Track::System => recording.system.as_ref(),
        };
        let Some(track) = track else { continue };
        let ranges = |mine: bool| -> Vec<(u64, u64)> {
            transcript
                .segments
                .iter()
                .filter(|s| s.track == speaker.track && (s.speaker_id == speaker.id) == mine)
                .map(|s| (s.start * PER_MS, s.end * PER_MS))
                .collect()
        };
        if let Some(voice) = voiceprint(&extractor, track, &clean(&ranges(true), &ranges(false)))? {
            voices.push(Voice { speaker_id: speaker.id.clone(), seconds: voice.1, vector: voice.0 });
        }
    }
    Ok(voices)
}

/// `mine` minus `others`, longest stretches first.
fn clean(mine: &[(u64, u64)], others: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut clean = Vec::new();
    for &(start, end) in mine {
        let mut cursor = start;
        let mut overlaps: Vec<&(u64, u64)> = others.iter().filter(|o| o.1 > start && o.0 < end).collect();
        overlaps.sort();
        for o in overlaps {
            if o.0 > cursor {
                clean.push((cursor, o.0));
            }
            cursor = cursor.max(o.1);
        }
        if cursor < end {
            clean.push((cursor, end));
        }
    }
    clean.retain(|r| r.1 - r.0 >= MIN_STRETCH);
    clean.sort_by_key(|r| std::cmp::Reverse(r.1 - r.0));
    clean
}

/// The embedding and how many seconds went into it; None when there is too little audio.
fn voiceprint(extractor: &SpeakerEmbeddingExtractor, track: &TrackAudio, ranges: &[(u64, u64)]) -> Result<Option<(Vec<f32>, f32)>> {
    let Some(stream) = extractor.create_stream() else { return Ok(None) };
    let mut used = 0;
    for &(start, end) in ranges {
        let take = (end - start).min(MAX_SPEECH - used);
        stream.accept_waveform(SAMPLE_RATE as i32, &track.read(start, start + take)?);
        used += take;
        if used >= MAX_SPEECH {
            break;
        }
    }
    stream.input_finished();
    if used == 0 || !extractor.is_ready(&stream) {
        return Ok(None);
    }
    let Some(mut vector) = extractor.compute(&stream) else { return Ok(None) };
    let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return Ok(None);
    }
    vector.iter_mut().for_each(|x| *x /= norm);
    Ok(Some((vector, used as f32 / SR as f32)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_out_what_others_say_over_it() {
        let s = SR;
        // Mine: 0–10 s and 20–21 s; someone else talks over 4–6 s.
        let got = clean(&[(0, 10 * s), (20 * s, 21 * s)], &[(4 * s, 6 * s), (30 * s, 31 * s)]);
        assert_eq!(got, vec![(0, 4 * s), (6 * s, 10 * s), (20 * s, 21 * s)]);
        // A sliver left between two others is dropped.
        assert_eq!(clean(&[(0, s)], &[(0, s / 2), (s / 2 + 100, s)]), Vec::<(u64, u64)>::new());
    }
}
