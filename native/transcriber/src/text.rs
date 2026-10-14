//! From voices to text: cut each track into readable units, run SenseVoice on each,
//! and clean up what comes back.

use std::path::Path;

use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig};

use crate::error::{Error, ErrorKind, Result};
use crate::models;
use crate::recording::SAMPLE_RATE;
use crate::speakers::Turn;
use crate::speech::Region;
use crate::transcript::Track;

const SR: u64 = SAMPLE_RATE as u64;
/// Pauses up to this long stay inside one segment; longer ones end it.
const MERGE_GAP: u64 = SR;
/// Segments stay readable and within what SenseVoice handles well.
const MAX_UNIT: u64 = 20 * SR;
/// Long segments are not cut closer than this to either end.
const MIN_PIECE: u64 = 2 * SR;
/// Audio added on both sides before recognition, so word edges are not clipped.
const PAD: u64 = SR / 10;
/// Shorter leftovers of overlapping turns are dropped.
const MIN_TURN: u64 = SR * 3 / 10;
/// How long the speakers' sound can linger in the microphone after the other side stops
/// (output latency plus room echo).
const ECHO_TAIL: u64 = SR * 3 / 10;

#[derive(Debug, Clone)]
pub(crate) struct Unit {
    pub track: Track,
    /// 0 on the mic track; diarized speaker on the system track.
    pub speaker: usize,
    pub start: u64,
    pub end: u64,
    pub text: String,
    /// Mic audio recorded while the other side was talking: may be their echo.
    pub suspect: bool,
}

impl Unit {
    fn new(track: Track, speaker: usize, (start, end): (u64, u64)) -> Self {
        Self { track, speaker, start, end, text: String::new(), suspect: false }
    }

    pub fn padded(&self, track_end: u64) -> (u64, u64) {
        (self.start.saturating_sub(PAD), (self.end + PAD).min(track_end.max(self.end)))
    }
}

/// `system` is the speech on the system track. Mic speech is cut where it starts and
/// stops, so that if the user has no headphones the echo of the other side ends up in
/// segments of its own, which `drop_echo` can remove without taking the user's words.
pub(crate) fn mic_units(regions: &[Region], system: &[Region]) -> Vec<Unit> {
    let mut zones: Vec<(u64, u64)> = Vec::new();
    for r in system {
        match zones.last_mut() {
            Some(last) if r.start <= last.1 => last.1 = last.1.max(r.end + ECHO_TAIL),
            _ => zones.push((r.start, r.end + ECHO_TAIL)),
        }
    }

    // (start, end, suspect)
    let mut pieces: Vec<(u64, u64, bool)> = Vec::new();
    for r in regions {
        let mut cursor = r.start;
        let first = zones.partition_point(|z| z.1 <= r.start);
        for z in zones[first..].iter().take_while(|z| z.0 < r.end) {
            if z.0 > cursor {
                pieces.push((cursor, z.0, false));
            }
            let end = z.1.min(r.end);
            if end > cursor.max(z.0) {
                pieces.push((cursor.max(z.0), end, true));
            }
            cursor = cursor.max(end);
        }
        if cursor < r.end {
            pieces.push((cursor, r.end, false));
        }
    }
    // Slivers are edge effects of the cut, not a change of who is talking.
    let mut kept: Vec<(u64, u64, bool)> = Vec::new();
    for p in pieces {
        match kept.last_mut() {
            Some(last) if p.0 <= last.1 && (p.1 - p.0 < MIN_TURN || last.1 - last.0 < MIN_TURN) => {
                if last.1 - last.0 < p.1 - p.0 {
                    last.2 = p.2;
                }
                last.1 = p.1;
            }
            _ => kept.push(p),
        }
    }

    let mut spans: Vec<(u64, u64, bool)> = Vec::new();
    for p in kept {
        match spans.last_mut() {
            Some(last) if last.2 == p.2 && p.0 <= last.1 + MERGE_GAP => last.1 = last.1.max(p.1),
            _ => spans.push(p),
        }
    }
    spans
        .into_iter()
        .flat_map(|(start, end, suspect)| {
            split((start, end), regions).into_iter().map(move |s| Unit { suspect, ..Unit::new(Track::Mic, 0, s) })
        })
        .collect()
}

pub(crate) fn system_units(turns: &[Turn], regions: &[Region]) -> Vec<Unit> {
    // Speech the diarizer left out (it drops turns under 0.3 s, like a lone "好，" before
    // a pause) goes to the nearest voice, so no words are lost.
    let mut turns = turns.to_vec();
    let mut extra = Vec::new();
    for r in regions {
        let mut cursor = r.start;
        for t in turns.iter().filter(|t| t.end > r.start && t.start < r.end) {
            if t.start > cursor {
                extra.push((cursor, t.start));
            }
            cursor = cursor.max(t.end);
        }
        if cursor < r.end {
            extra.push((cursor, r.end));
        }
    }
    for (start, end) in extra {
        if end - start < MIN_TURN / 2 {
            continue;
        }
        let nearest = turns.iter().min_by_key(|t| if t.end <= start { start - t.end } else { t.start.saturating_sub(end) });
        let speaker = nearest.map(|t| t.speaker).unwrap_or(0);
        turns.push(Turn { start, end, speaker });
    }
    turns.sort_by_key(|t| (t.start, t.end));

    // Where two people overlap, the overlap stays with whoever was already talking:
    // recognising the same mixed audio twice would only duplicate the text.
    let mut flat: Vec<Turn> = Vec::new();
    let mut covered = 0;
    for t in &turns {
        let start = t.start.max(covered);
        if t.end > start && (start == t.start || t.end >= start + MIN_TURN) {
            flat.push(Turn { start, ..*t });
        }
        covered = covered.max(t.end);
    }

    let mut merged: Vec<Turn> = Vec::new();
    for t in flat {
        match merged.last_mut() {
            Some(last) if last.speaker == t.speaker && t.start <= last.end + MERGE_GAP => last.end = last.end.max(t.end),
            _ => merged.push(t),
        }
    }
    merged
        .into_iter()
        .flat_map(|t| split((t.start, t.end), regions).into_iter().map(move |s| Unit::new(Track::System, t.speaker, s)))
        .collect()
}

/// Cuts a span at pauses longer than MERGE_GAP, then halves anything longer than
/// MAX_UNIT at its longest pause.
fn split(span: (u64, u64), regions: &[Region]) -> Vec<(u64, u64)> {
    let first = regions.partition_point(|r| r.end <= span.0);
    let inside: Vec<(u64, u64)> = regions[first..]
        .iter()
        .take_while(|r| r.start < span.1)
        .map(|r| (r.start.max(span.0), r.end.min(span.1)))
        .collect();
    let gaps: Vec<(u64, u64)> = inside.windows(2).map(|w| (w[0].1, w[1].0)).filter(|g| g.1 > g.0).collect();

    let mut pieces = Vec::new();
    let mut start = span.0;
    for &(a, b) in gaps.iter().filter(|g| g.1 - g.0 > MERGE_GAP) {
        pieces.push((start, a));
        start = b;
    }
    pieces.push((start, span.1));

    let mut out = Vec::new();
    for piece in pieces {
        halve(piece, &gaps, &mut out);
    }
    out.retain(|p| p.1 > p.0);
    out
}

fn halve(piece: (u64, u64), gaps: &[(u64, u64)], out: &mut Vec<(u64, u64)>) {
    if piece.1 - piece.0 <= MAX_UNIT {
        out.push(piece);
        return;
    }
    let inside = |lo: u64, hi: u64| gaps.iter().copied().filter(move |g| g.0 > lo && g.1 < hi);
    let cut = inside(piece.0 + MIN_PIECE, piece.1 - MIN_PIECE)
        .max_by_key(|g| g.1 - g.0)
        .or_else(|| inside(piece.0, piece.1).max_by_key(|g| g.1 - g.0));
    let (left_end, right_start) = match cut {
        Some(g) => g,
        // Talking without a single pause for 20 s: cut in the middle.
        None => {
            let mid = piece.0 + (piece.1 - piece.0) / 2;
            (mid, mid)
        }
    };
    halve((piece.0, left_end), gaps, out);
    halve((right_start, piece.1), gaps, out);
}

pub(crate) struct Asr {
    recognizer: OfflineRecognizer,
}

impl Asr {
    pub fn new(models_dir: &Path, threads: i32) -> Result<Self> {
        let mut config = OfflineRecognizerConfig::default();
        config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
            model: Some(models::ASR.path(models_dir, "model.int8.onnx")),
            // Meetings are Mandarin. "auto" scored the same in testing, and fixing the
            // language takes away the chance of a short utterance being read as
            // Cantonese or Japanese; English terms inside Chinese still come out.
            language: Some("zh".into()),
            // Punctuation and numbers as digits come from SenseVoice itself.
            use_itn: true,
        };
        config.model_config.tokens = Some(models::ASR.path(models_dir, "tokens.txt"));
        config.model_config.num_threads = threads;
        config.model_config.provider = Some("cpu".into());
        config.model_config.debug = false;
        let recognizer = OfflineRecognizer::create(&config).ok_or_else(|| {
            Error::new(ErrorKind::Engine, "语音识别模型加载失败，模型文件可能已损坏：请删除后重新下载语音模型。")
        })?;
        Ok(Self { recognizer })
    }

    pub fn recognize(&self, samples: &[f32]) -> String {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(SAMPLE_RATE as i32, samples);
        self.recognizer.decode(&stream);
        stream.get_result().map(|r| r.text).unwrap_or_default()
    }
}

/// Tidies SenseVoice output; None when nothing worth keeping is left.
pub(crate) fn clean(raw: &str, seconds: f32) -> Option<String> {
    let text = raw.trim();
    let text = text.trim_start_matches(|c: char| is_punct(c) || c.is_whitespace()).trim_end();
    let content: String = text.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    if content.is_empty() {
        return None;
    }
    const FILLERS: [&str; 12] = ["嗯", "啊", "呃", "额", "哦", "唔", "嗯嗯", "啊啊", "呃呃", "哼", "嗯哼", "唉"];
    if FILLERS.contains(&content.as_str()) {
        return None;
    }
    // Noise and breathing sometimes come back as one short English word.
    const NOISE: [&str; 10] = ["the", "i", "a", "yeah", "oh", "uh", "um", "hmm", "mm", "ah"];
    if seconds < 1.5 && NOISE.contains(&content.as_str()) {
        return None;
    }
    Some(text.to_string())
}

fn is_punct(c: char) -> bool {
    c.is_ascii_punctuation() || "，。！？、；：“”‘’（）《》【】…—·".contains(c)
}

/// Without headphones the microphone also records the other side from the speakers.
/// A mic segment recorded while they talked, whose words mostly repeat what the system
/// track said at the same time, is that echo, not the user.
pub(crate) fn drop_echo(units: &mut Vec<Unit>) {
    let system: Vec<(u64, u64, Vec<char>)> = units
        .iter()
        .filter(|u| u.track == Track::System)
        .map(|u| (u.start, u.end, content_chars(&u.text)))
        .collect();
    let slack = SR;
    units.retain(|u| {
        if !u.suspect {
            return true;
        }
        let mine = content_chars(&u.text);
        if mine.len() < 2 {
            return true;
        }
        let heard: Vec<char> = system
            .iter()
            .filter(|s| s.0 < u.end + slack && s.1 + slack > u.start)
            .flat_map(|s| s.2.iter().copied())
            .collect();
        if heard.is_empty() {
            return true;
        }
        lcs(&mine, &heard) * 10 < mine.len() * 6
    });
}

fn content_chars(text: &str) -> Vec<char> {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn lcs(a: &[char], b: &[char]) -> usize {
    let mut row = vec![0usize; b.len() + 1];
    for &x in a {
        let mut diag = 0;
        for (j, &y) in b.iter().enumerate() {
            let up = row[j + 1];
            row[j + 1] = if x == y { diag + 1 } else { up.max(row[j]) };
            diag = up;
        }
    }
    row[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(a: f32, b: f32) -> Region {
        Region { start: (a * SR as f32) as u64, end: (b * SR as f32) as u64 }
    }

    #[test]
    fn short_pauses_stay_in_one_segment() {
        let units = mic_units(&[r(1.0, 3.0), r(3.6, 6.0), r(8.0, 9.0)], &[]);
        let spans: Vec<_> = units.iter().map(|u| (u.start / SR, u.end / SR)).collect();
        assert_eq!(spans, vec![(1, 6), (8, 9)]);
    }

    #[test]
    fn long_speech_is_cut_at_the_longest_pause() {
        let regions = [r(0.0, 8.0), r(8.4, 15.0), r(15.9, 24.0), r(24.3, 30.0)];
        let units = mic_units(&regions, &[]);
        assert!(units.iter().all(|u| u.end - u.start <= MAX_UNIT));
        assert_eq!(units[0].end, r(15.0, 15.0).start);
        assert_eq!(units[1].start, r(15.9, 15.9).start);
    }

    #[test]
    fn overlapping_turns_are_not_recognised_twice() {
        let turns = [
            Turn { start: 0, end: 10 * SR, speaker: 0 },
            Turn { start: 4 * SR, end: 6 * SR, speaker: 1 },
            Turn { start: 9 * SR, end: 14 * SR, speaker: 1 },
        ];
        let units = system_units(&turns, &[r(0.0, 14.0)]);
        let spans: Vec<_> = units.iter().map(|u| (u.speaker, u.start / SR, u.end / SR)).collect();
        assert_eq!(spans, vec![(0, 0, 10), (1, 10, 14)]);
    }

    #[test]
    fn mic_speech_is_cut_where_the_other_side_talks() {
        // The other side talks 0–5 s; the mic hears their echo, then the user answers.
        let units = mic_units(&[r(0.1, 9.0)], &[r(0.0, 5.0)]);
        let spans: Vec<_> = units.iter().map(|u| (u.start * 10 / SR, u.end * 10 / SR, u.suspect)).collect();
        assert_eq!(spans, vec![(1, 53, true), (53, 90, false)]);
    }

    #[test]
    fn speech_the_diarizer_missed_goes_to_the_nearest_voice() {
        // "好，" at 10.0–10.4 s, then a pause, then the turn the diarizer found.
        let turns = [Turn { start: 2 * SR, end: 8 * SR, speaker: 0 }, Turn { start: 11 * SR, end: 15 * SR, speaker: 1 }];
        let units = system_units(&turns, &[r(2.0, 8.0), r(10.0, 10.4), r(11.0, 15.0)]);
        let spans: Vec<_> = units.iter().map(|u| (u.speaker, u.start * 10 / SR, u.end * 10 / SR)).collect();
        assert_eq!(spans, vec![(0, 20, 80), (1, 100, 150)]);
    }

    #[test]
    fn echo_of_the_other_side_is_dropped() {
        let unit = |track, start, end, text: &str, suspect| Unit { track, speaker: 0, start, end, text: text.into(), suspect };
        let mut units = vec![
            unit(Track::System, 0, 5 * SR, "我们下周三之前把方案定下来。", false),
            unit(Track::Mic, SR / 5, 5 * SR, "我们下周三之前把方案定下来", true),
            unit(Track::Mic, 3 * SR, 5 * SR, "好的，我来跟进。", true),
            unit(Track::Mic, 6 * SR, 8 * SR, "把方案定下来。", false),
        ];
        drop_echo(&mut units);
        let left: Vec<_> = units.iter().map(|u| u.text.as_str()).collect();
        assert_eq!(left, vec!["我们下周三之前把方案定下来。", "好的，我来跟进。", "把方案定下来。"]);
    }

    #[test]
    fn fillers_and_punctuation_are_dropped() {
        assert_eq!(clean("嗯。", 0.5), None);
        assert_eq!(clean("。", 0.5), None);
        assert_eq!(clean("Yeah.", 0.6), None);
        assert_eq!(clean("。好的。", 0.6).as_deref(), Some("好的。"));
    }
}
