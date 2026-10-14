//! Who speaks on the system track.
//!
//! sherpa-onnx's diarizer (pyannote segmentation + CAM++ embeddings + clustering) wants
//! the whole waveform in memory and clusters every 10 s window's embedding at once,
//! which grows quadratically with meeting length. So it runs on blocks of at most ten
//! minutes of speech (silences cut out), and the speakers it finds in each block are
//! linked across blocks by voiceprint: one CAM++ embedding from up to a minute of each
//! block speaker's clean speech, clustered with average linkage. Memory stays at one
//! block, and the ids are consistent over a two-hour meeting.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};

use crate::error::{Error, ErrorKind, Result};
use crate::models;
use crate::recording::{TrackAudio, SAMPLE_RATE};
use crate::speech::Region;

const SR: u64 = SAMPLE_RATE as u64;
/// Context kept around each speech region when silences are cut out.
const PAD: u64 = SR / 4;
const BLOCK: u64 = 10 * 60 * SR;
/// Speech used for one block speaker's voiceprint.
const VOICEPRINT_MAX: u64 = 60 * SR;
/// Block speakers with less clean speech than this only join existing speakers.
const RELIABLE_SECONDS: f32 = 2.0;
/// Cosine similarity at which two block speakers are taken to be the same person.
/// A split person costs the user one rename; two people merged into one id cannot be
/// fixed in the UI, so this errs towards splitting.
const LINK_THRESHOLD: f32 = 0.5;
/// Two voices the diarizer told apart inside one block compared over many windows,
/// a better test than one voiceprint each; only a much closer match overrules it.
const SAME_BLOCK_THRESHOLD: f32 = 0.7;
/// Below this a short block speaker becomes a new speaker instead of joining one.
const ATTACH_THRESHOLD: f32 = 0.3;

/// A stretch of one voice, timeline samples. `speaker` counts from 0 in order of
/// first appearance. Turns can overlap where two people talk at once.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Turn {
    pub start: u64,
    pub end: u64,
    pub speaker: usize,
}

/// Where a stretch of a block's compacted audio sits on the timeline.
struct Span {
    compact: u64,
    timeline: u64,
    len: u64,
}

struct BlockSpeaker {
    block: usize,
    /// L2-normalised voiceprint; None when there was too little audio for one.
    voiceprint: Option<Vec<f32>>,
    seconds: f32,
}

pub(crate) fn diarize(
    track: &TrackAudio,
    regions: &[Region],
    models_dir: &Path,
    threads: i32,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(f32),
) -> Result<Vec<Turn>> {
    let blocks = plan_blocks(regions, track.end());
    if blocks.is_empty() {
        return Ok(Vec::new());
    }
    let diarizer = create_diarizer(models_dir, threads)?;
    let extractor = SpeakerEmbeddingExtractor::create(&embedding_config(models_dir, threads))
        .ok_or_else(|| engine_error("声纹"))?;

    let total: u64 = blocks.iter().flatten().map(Region::len).sum();
    let mut done = 0;
    let mut speakers: Vec<BlockSpeaker> = Vec::new();
    // (timeline start, end, index into `speakers`)
    let mut pieces: Vec<(u64, u64, usize)> = Vec::new();

    for (block_index, block) in blocks.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::cancelled());
        }
        let (audio, spans) = load(track, block)?;
        let result = diarizer
            .process(&audio)
            .ok_or_else(|| Error::new(ErrorKind::Engine, "说话人分离失败，请重试；如果反复出现，请重新下载语音模型。"))?;

        let mut local: BTreeMap<i32, (usize, Vec<(u64, u64)>)> = BTreeMap::new();
        crate::debug(|| format!("block: {:.1} s, {} speakers", audio.len() as f32 / SR as f32, result.num_speakers()));
        for seg in result.sort_by_start_time() {
            let start = ((seg.start.max(0.0) as f64 * SR as f64) as u64).min(audio.len() as u64);
            let end = ((seg.end.max(0.0) as f64 * SR as f64) as u64).min(audio.len() as u64);
            if end <= start {
                continue;
            }
            let entry = local.entry(seg.speaker).or_insert_with(|| {
                speakers.push(BlockSpeaker { block: block_index, voiceprint: None, seconds: 0.0 });
                (speakers.len() - 1, Vec::new())
            });
            entry.1.push((start, end));
            for span in &spans {
                let from = start.max(span.compact);
                let to = end.min(span.compact + span.len);
                if from < to {
                    pieces.push((span.timeline + from - span.compact, span.timeline + to - span.compact, entry.0));
                }
            }
        }

        for (&speaker, (index, ranges)) in &local {
            let others: Vec<(u64, u64)> = local
                .iter()
                .filter(|(&s, _)| s != speaker)
                .flat_map(|(_, (_, r))| r.iter().copied())
                .collect();
            let (voiceprint, seconds) = voiceprint(&extractor, &audio, ranges, &others);
            speakers[*index].voiceprint = voiceprint;
            speakers[*index].seconds = seconds;
        }

        done += block.iter().map(Region::len).sum::<u64>();
        on_progress(done as f32 / total as f32);
    }

    let labels = link(&speakers, &pieces);
    crate::debug(|| {
        let mut out = String::from("block speakers (seconds, label, similarities):");
        for (i, a) in speakers.iter().enumerate() {
            let sims: Vec<String> = speakers
                .iter()
                .map(|b| match (&a.voiceprint, &b.voiceprint) {
                    (Some(x), Some(y)) => format!("{:.2}", dot(x, y)),
                    _ => "-".into(),
                })
                .collect();
            out += &format!("\n  #{i} {:.1}s -> {} [{}]", a.seconds, labels[i], sims.join(" "));
        }
        out
    });
    // Number people by when they first speak.
    let mut first: Vec<(u64, usize)> = Vec::new();
    for &(start, _, s) in &pieces {
        let label = labels[s];
        match first.iter_mut().find(|(_, l)| *l == label) {
            Some(f) => f.0 = f.0.min(start),
            None => first.push((start, label)),
        }
    }
    first.sort();
    let order = |label: usize| first.iter().position(|&(_, l)| l == label).unwrap_or(0);

    let mut turns: Vec<Turn> =
        pieces.iter().map(|&(start, end, s)| Turn { start, end, speaker: order(labels[s]) }).collect();
    turns.sort_by_key(|t| (t.start, t.end));
    Ok(turns)
}

/// Pads the speech regions, merges what touches, and packs them into blocks.
fn plan_blocks(regions: &[Region], track_end: u64) -> Vec<Vec<Region>> {
    let mut padded: Vec<Region> = Vec::new();
    for r in regions {
        let r = Region { start: r.start.saturating_sub(PAD), end: (r.end + PAD).min(track_end) };
        match padded.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => padded.push(r),
        }
    }
    let mut blocks: Vec<Vec<Region>> = Vec::new();
    let mut size = 0;
    for r in padded {
        if blocks.is_empty() || size + r.len() > BLOCK {
            blocks.push(Vec::new());
            size = 0;
        }
        size += r.len();
        blocks.last_mut().unwrap().push(r);
    }
    blocks
}

fn load(track: &TrackAudio, block: &[Region]) -> Result<(Vec<f32>, Vec<Span>)> {
    let mut audio = Vec::with_capacity(block.iter().map(|r| r.len() as usize).sum());
    let mut spans = Vec::with_capacity(block.len());
    for r in block {
        spans.push(Span { compact: audio.len() as u64, timeline: r.start, len: r.len() });
        audio.extend(track.read(r.start, r.end)?);
    }
    Ok((audio, spans))
}

fn engine_error(what: &str) -> Error {
    Error::new(ErrorKind::Engine, format!("{what}模型加载失败，模型文件可能已损坏：请删除后重新下载语音模型。"))
}

fn embedding_config(models_dir: &Path, threads: i32) -> SpeakerEmbeddingExtractorConfig {
    SpeakerEmbeddingExtractorConfig {
        model: Some(models::EMBEDDING.path(models_dir, models::EMBEDDING.file_name())),
        num_threads: threads,
        debug: false,
        provider: Some("cpu".into()),
    }
}

fn create_diarizer(models_dir: &Path, threads: i32) -> Result<OfflineSpeakerDiarization> {
    let config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(models::SEGMENTATION.path(models_dir, "model.onnx")),
                // 10 s windows every 2.5 s instead of every 1 s: a quarter of the
                // embedding work, and block-level linking makes up for the coarser view.
                window_shift_ratio: 0.25,
            },
            num_threads: threads,
            debug: false,
            provider: Some("cpu".into()),
        },
        embedding: embedding_config(models_dir, threads),
        clustering: FastClusteringConfig { num_clusters: -1, threshold: 0.5, compute_confidence: false },
        min_duration_on: 0.3,
        min_duration_off: 0.5,
    };
    OfflineSpeakerDiarization::create(&config).ok_or_else(|| engine_error("说话人分离"))
}

/// One voiceprint from a block speaker's longest stretches, leaving out overlap with
/// the other speakers of the block.
fn voiceprint(
    extractor: &SpeakerEmbeddingExtractor,
    audio: &[f32],
    ranges: &[(u64, u64)],
    others: &[(u64, u64)],
) -> (Option<Vec<f32>>, f32) {
    let mut clean = Vec::new();
    for &(start, end) in ranges {
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
    clean.retain(|r| r.1 - r.0 >= SR / 4);
    if clean.iter().map(|r| r.1 - r.0).sum::<u64>() < SR / 2 {
        clean = ranges.to_vec();
    }
    clean.sort_by_key(|r| std::cmp::Reverse(r.1 - r.0));

    let Some(stream) = extractor.create_stream() else { return (None, 0.0) };
    let mut used = 0;
    for (start, end) in clean {
        let take = (end - start).min(VOICEPRINT_MAX - used);
        stream.accept_waveform(SAMPLE_RATE as i32, &audio[start as usize..(start + take) as usize]);
        used += take;
        if used >= VOICEPRINT_MAX {
            break;
        }
    }
    stream.input_finished();
    let seconds = used as f32 / SR as f32;
    if !extractor.is_ready(&stream) {
        return (None, seconds);
    }
    let voiceprint = extractor.compute(&stream).and_then(|mut v| {
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if !norm.is_finite() || norm == 0.0 {
            return None;
        }
        v.iter_mut().for_each(|x| *x /= norm);
        Some(v)
    });
    (voiceprint, seconds)
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Maps block speakers to people. Returns a label per block speaker.
fn link(speakers: &[BlockSpeaker], pieces: &[(u64, u64, usize)]) -> Vec<usize> {
    let n = speakers.len();
    let vp = |i: usize| speakers[i].voiceprint.as_deref();
    let mut seeds: Vec<usize> = (0..n).filter(|&i| vp(i).is_some() && speakers[i].seconds >= RELIABLE_SECONDS).collect();
    if seeds.is_empty() {
        seeds = (0..n).filter(|&i| vp(i).is_some()).collect();
    }

    let mut sim = vec![vec![0f32; n]; n];
    for &i in &seeds {
        for &j in &seeds {
            sim[i][j] = dot(vp(i).unwrap(), vp(j).unwrap());
        }
    }
    let average = |a: &[usize], b: &[usize]| {
        a.iter().flat_map(|&i| b.iter().map(move |&j| (i, j))).map(|(i, j)| sim[i][j]).sum::<f32>()
            / (a.len() * b.len()) as f32
    };
    let threshold = |a: &[usize], b: &[usize]| {
        let same_block = a.iter().any(|&i| b.iter().any(|&j| speakers[i].block == speakers[j].block));
        if same_block {
            SAME_BLOCK_THRESHOLD
        } else {
            LINK_THRESHOLD
        }
    };
    let mut clusters: Vec<Vec<usize>> = seeds.iter().map(|&i| vec![i]).collect();
    loop {
        let mut best: Option<(f32, usize, usize)> = None;
        for a in 0..clusters.len() {
            for b in a + 1..clusters.len() {
                let s = average(&clusters[a], &clusters[b]);
                if s >= threshold(&clusters[a], &clusters[b]) && best.is_none_or(|(top, _, _)| s > top) {
                    best = Some((s, a, b));
                }
            }
        }
        let Some((_, a, b)) = best else { break };
        let merged = clusters.remove(b);
        clusters[a].extend(merged);
    }

    let mut labels: Vec<Option<usize>> = vec![None; n];
    for (c, members) in clusters.iter().enumerate() {
        for &i in members {
            labels[i] = Some(c);
        }
    }
    let mut next = clusters.len();
    for i in 0..n {
        let Some(v) = vp(i).filter(|_| labels[i].is_none()) else { continue };
        let best = clusters
            .iter()
            .enumerate()
            .map(|(c, members)| (c, members.iter().map(|&j| dot(v, vp(j).unwrap())).sum::<f32>() / members.len() as f32))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        labels[i] = Some(match best {
            Some((c, s)) if s >= ATTACH_THRESHOLD => c,
            _ => {
                next += 1;
                next - 1
            }
        });
    }

    // No voiceprint at all (a fraction of a second): take the voice closest in time.
    for i in 0..n {
        if labels[i].is_some() {
            continue;
        }
        let mine: Vec<&(u64, u64, usize)> = pieces.iter().filter(|p| p.2 == i).collect();
        let nearest = pieces
            .iter()
            .filter(|p| labels[p.2].is_some())
            .min_by_key(|p| mine.iter().map(|m| gap(m, p)).min().unwrap_or(u64::MAX))
            .and_then(|p| labels[p.2]);
        labels[i] = Some(nearest.unwrap_or_else(|| {
            next += 1;
            next - 1
        }));
    }
    labels.into_iter().map(|l| l.unwrap_or(0)).collect()
}

fn gap(a: &(u64, u64, usize), b: &(u64, u64, usize)) -> u64 {
    if a.1 < b.0 {
        b.0 - a.1
    } else {
        a.0.saturating_sub(b.1)
    }
}
