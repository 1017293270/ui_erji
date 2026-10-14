//! A recording folder written by echomind-capture: `manifest.json` plus one WAV per
//! segment and track. Each track becomes a list of pieces on the recording's timeline
//! (16 kHz samples from the start); pauses are gaps that read as silence, and times
//! are never shifted.

use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;

use crate::error::{Error, ErrorKind, Result};
use crate::transcript::Track;

pub(crate) const SAMPLE_RATE: u32 = 16_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    tracks: Option<Vec<String>>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    segments: Vec<ManifestSegment>,
    #[serde(default)]
    paused: Vec<Paused>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSegment {
    index: u32,
    start_ms: u64,
    end_ms: u64,
    mic: Option<String>,
    system: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Paused {
    from_ms: u64,
    to_ms: Option<u64>,
}

struct Piece {
    /// Timeline position of the first sample.
    start: u64,
    len: u64,
    /// 16 kHz mono s16le samples start at this byte offset.
    path: PathBuf,
    offset: u64,
}

pub(crate) struct TrackAudio {
    pub kind: Track,
    pieces: Vec<Piece>,
}

pub(crate) struct Recording {
    pub meeting_id: String,
    pub mic: Option<TrackAudio>,
    pub system: Option<TrackAudio>,
    /// Holds 16 kHz copies of WAVs recorded at other rates; removed on drop.
    _scratch: Option<Scratch>,
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn recording_error(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::Recording, message)
}

impl Recording {
    pub fn open(dir: &Path) -> Result<Self> {
        if !dir.is_dir() {
            return Err(recording_error(format!("找不到录音文件夹 {}，可能已被移动或删除。", dir.display())));
        }
        let meeting_id = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();

        let layout = match fs::read(dir.join("manifest.json")) {
            Ok(bytes) => {
                let manifest: Manifest = serde_json::from_slice(&bytes)
                    .map_err(|_| recording_error("录音清单 manifest.json 已损坏，无法转写这场会议。"))?;
                layout_from_manifest(dir, &manifest)
            }
            // A capture that died before its first manifest write: lay the files end to end.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => layout_from_files(dir),
            Err(e) => return Err(Error::io("读取录音清单", e)),
        };

        let mut scratch = None;
        let mut tracks = [None, None];
        for (slot, (kind, files)) in tracks.iter_mut().zip(layout) {
            let Some(files) = files else { continue };
            let mut pieces = Vec::new();
            for (start_ms, path) in files {
                let Some(piece) = open_piece(&path, start_ms * SAMPLE_RATE as u64 / 1000, &mut scratch)? else { continue };
                pieces.push(piece);
            }
            pieces.sort_by_key(|p| p.start);
            // Never let one file overlap the next: the timeline wins over a long file.
            for i in 1..pieces.len() {
                let next_start = pieces[i].start;
                let prev = &mut pieces[i - 1];
                prev.len = prev.len.min(next_start.saturating_sub(prev.start));
            }
            pieces.retain(|p| p.len > 0);
            *slot = Some(TrackAudio { kind, pieces });
        }
        let [mic, system] = tracks;

        let total: u64 = [&mic, &system].iter().filter_map(|t| t.as_ref()).map(|t| t.pieces.len() as u64).sum();
        if total == 0 {
            return Err(recording_error("录音文件夹里没有可用的录音文件（WAV），无法转写。"));
        }
        Ok(Self { meeting_id, mic, system, _scratch: scratch })
    }
}

type Layout = [(Track, Option<Vec<(u64, PathBuf)>>); 2];

fn layout_from_manifest(dir: &Path, manifest: &Manifest) -> Layout {
    let declared = |track: Track| {
        manifest.tracks.as_ref().map(|t| t.iter().any(|s| s == track.as_str())).unwrap_or(true)
    };
    let mut mic = Vec::new();
    let mut system = Vec::new();
    for seg in &manifest.segments {
        if let Some(name) = seg.mic.as_deref().and_then(safe_name) {
            mic.push((seg.start_ms, dir.join(name)));
        }
        if let Some(name) = seg.system.as_deref().and_then(safe_name) {
            system.push((seg.start_ms, dir.join(name)));
        }
    }

    // A capture that crashed leaves the segment it was writing out of the manifest.
    if manifest.status.as_deref() != Some("stopped") {
        let last = manifest.segments.last();
        let index = last.map(|s| s.index + 1).unwrap_or(1);
        let mut start_ms = last.map(|s| s.end_ms).unwrap_or(0);
        if let Some(p) = manifest.paused.last() {
            if p.from_ms >= start_ms {
                start_ms = p.to_ms.unwrap_or(p.from_ms);
            }
        }
        for (list, track) in [(&mut mic, Track::Mic), (&mut system, Track::System)] {
            let path = dir.join(format!("{}-{index:04}.wav", track.as_str()));
            if declared(track) && path.is_file() {
                list.push((start_ms, path));
            }
        }
    }

    [
        (Track::Mic, (declared(Track::Mic) || !mic.is_empty()).then_some(mic)),
        (Track::System, (declared(Track::System) || !system.is_empty()).then_some(system)),
    ]
}

fn layout_from_files(dir: &Path) -> Layout {
    let mut tracks: Layout = [(Track::Mic, None), (Track::System, None)];
    let mut start_ms = 0;
    for index in 1..10_000 {
        let paths = [Track::Mic, Track::System].map(|t| dir.join(format!("{}-{index:04}.wav", t.as_str())));
        if !paths.iter().any(|p| p.is_file()) {
            break;
        }
        let mut longest = 0;
        for ((_, list), path) in tracks.iter_mut().zip(paths) {
            if let Ok(info) = wav_info(&path) {
                longest = longest.max(info.frames * 1000 / info.sample_rate as u64);
                list.get_or_insert_with(Vec::new).push((start_ms, path));
            }
        }
        start_ms += longest;
    }
    tracks
}

/// Only plain file names from the manifest: it must not point outside the folder.
fn safe_name(name: &str) -> Option<&str> {
    let ok = !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != "..";
    ok.then_some(name)
}

impl TrackAudio {
    pub fn end(&self) -> u64 {
        self.pieces.last().map(|p| p.start + p.len).unwrap_or(0)
    }

    /// Stretches with audio and no gap inside (gaps are pauses or missing files).
    pub fn runs(&self) -> Vec<(u64, u64)> {
        let mut runs: Vec<(u64, u64)> = Vec::new();
        for p in &self.pieces {
            match runs.last_mut() {
                // 10 ms of slack: two files of one run can be a few samples apart.
                Some(last) if p.start <= last.1 + 160 => last.1 = last.1.max(p.start + p.len),
                _ => runs.push((p.start, p.start + p.len)),
            }
        }
        runs
    }

    /// Samples `[start, end)` of the timeline as f32 in [-1, 1]; gaps read as silence.
    pub fn read(&self, start: u64, end: u64) -> Result<Vec<f32>> {
        let mut out = vec![0f32; end.saturating_sub(start) as usize];
        let first = self.pieces.partition_point(|p| p.start + p.len <= start);
        for p in &self.pieces[first..] {
            if p.start >= end {
                break;
            }
            let from = start.max(p.start);
            let to = end.min(p.start + p.len);
            let mut file = File::open(&p.path).map_err(|e| Error::io(format!("读取录音文件 {}", file_label(&p.path)), e))?;
            file.seek(SeekFrom::Start(p.offset + (from - p.start) * 2))
                .map_err(|e| Error::io(format!("读取录音文件 {}", file_label(&p.path)), e))?;
            let mut bytes = vec![0u8; ((to - from) * 2) as usize];
            let n = read_full(&mut file, &mut bytes).map_err(|e| Error::io(format!("读取录音文件 {}", file_label(&p.path)), e))?;
            let dst = &mut out[(from - start) as usize..];
            for (d, s) in dst.iter_mut().zip(bytes[..n].chunks_exact(2)) {
                *d = i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0;
            }
        }
        Ok(out)
    }
}

fn read_full(file: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match file.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn file_label(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

struct WavInfo {
    format: u16,
    channels: u16,
    sample_rate: u32,
    bits: u16,
    data_offset: u64,
    frames: u64,
}

/// Reads the header. Tolerates a stale data size: the capture refreshes it once a
/// second, so a recording that was killed has more samples than the header says.
fn wav_info(path: &Path) -> std::result::Result<WavInfo, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut riff = [0u8; 12];
    file.read_exact(&mut riff).map_err(|_| "文件太短".to_string())?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err("不是 WAV 文件".into());
    }
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    let mut pos = 12u64;
    loop {
        let mut head = [0u8; 8];
        if file.read_exact(&mut head).is_err() {
            return Err("缺少音频数据".into());
        }
        let size = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as u64;
        pos += 8;
        match &head[0..4] {
            b"fmt " => {
                let mut body = vec![0u8; size.min(64) as usize];
                file.read_exact(&mut body).map_err(|_| "格式信息不完整".to_string())?;
                if body.len() < 16 {
                    return Err("格式信息不完整".into());
                }
                let mut format = u16::from_le_bytes([body[0], body[1]]);
                if format == 0xFFFE && body.len() >= 26 {
                    format = u16::from_le_bytes([body[24], body[25]]);
                }
                fmt = Some((
                    format,
                    u16::from_le_bytes([body[2], body[3]]),
                    u32::from_le_bytes([body[4], body[5], body[6], body[7]]),
                    u16::from_le_bytes([body[14], body[15]]),
                ));
                pos += size + (size & 1);
                file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
            }
            b"data" => {
                let (format, channels, sample_rate, bits) = fmt.ok_or("缺少格式信息")?;
                if channels == 0 || sample_rate == 0 || !matches!((format, bits), (1, 16) | (1, 24) | (1, 32) | (3, 32)) {
                    return Err(format!("不支持的编码（format {format}, {bits} bit）"));
                }
                let rest = file_len.saturating_sub(pos);
                let mut tail = [0u8; 4];
                let header_ok = size > 0 && size <= rest;
                // Trust the header only when something that looks like another chunk follows it.
                let followed_by_chunk = header_ok
                    && rest - size >= 8
                    && file.seek(SeekFrom::Start(pos + size + (size & 1))).is_ok()
                    && file.read_exact(&mut tail).is_ok()
                    && tail.iter().all(|b| b.is_ascii_alphanumeric() || *b == b' ');
                let data = if followed_by_chunk || (header_ok && rest - size < 8) { size } else { rest };
                let frame = channels as u64 * bits as u64 / 8;
                return Ok(WavInfo { format, channels, sample_rate, bits, data_offset: pos, frames: data / frame });
            }
            _ => {
                pos += size + (size & 1);
                file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
            }
        }
    }
}

fn open_piece(path: &Path, start: u64, scratch: &mut Option<Scratch>) -> Result<Option<Piece>> {
    if !path.is_file() {
        // A missing file is a gap: the rest of the meeting can still be transcribed.
        return Ok(None);
    }
    let info = wav_info(path)
        .map_err(|why| recording_error(format!("录音文件 {} 无法读取：{why}。", file_label(path))))?;
    if info.frames == 0 {
        return Ok(None);
    }
    if info.format == 1 && info.bits == 16 && info.channels == 1 && info.sample_rate == SAMPLE_RATE {
        return Ok(Some(Piece { start, len: info.frames, path: path.to_path_buf(), offset: info.data_offset }));
    }

    // Other rates or layouts (e.g. `record --sample-rate 48000`) are converted once into
    // a temporary 16 kHz mono file, so reading stays a plain seek.
    if scratch.is_none() {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("echomind-transcribe-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).map_err(|e| Error::io("创建临时目录", e))?;
        *scratch = Some(Scratch(dir));
    }
    let out_path = scratch.as_ref().unwrap().0.join(format!("{}.pcm", file_label(path)));
    let len = convert(path, &info, &out_path)?;
    Ok(Some(Piece { start, len, path: out_path, offset: 0 }))
}

fn convert(path: &Path, info: &WavInfo, out_path: &Path) -> Result<u64> {
    let read_err = |e| Error::io(format!("读取录音文件 {}", file_label(path)), e);
    let mut file = File::open(path).map_err(read_err)?;
    file.seek(SeekFrom::Start(info.data_offset)).map_err(read_err)?;
    let mut out = BufWriter::new(File::create(out_path).map_err(|e| Error::io("写入临时文件", e))?);
    let resampler = if info.sample_rate != SAMPLE_RATE {
        Some(
            sherpa_onnx::LinearResampler::create(info.sample_rate as i32, SAMPLE_RATE as i32)
                .ok_or_else(|| Error::new(ErrorKind::Engine, "无法创建重采样器。"))?,
        )
    } else {
        None
    };

    let bytes_per_sample = info.bits as usize / 8;
    let frame = bytes_per_sample * info.channels as usize;
    let mut buf = vec![0u8; frame * 16_384];
    let mut left = info.frames;
    let mut written = 0u64;
    while left > 0 {
        let want = (left.min(16_384) as usize) * frame;
        let n = read_full(&mut file, &mut buf[..want]).map_err(read_err)?;
        let frames = n / frame;
        left = if frames == 0 { 0 } else { left - frames as u64 };
        let mono: Vec<f32> = buf[..frames * frame]
            .chunks_exact(frame)
            .map(|f| {
                let sum: f32 = f.chunks_exact(bytes_per_sample).map(|s| sample(s, info.format)).sum();
                sum / info.channels as f32
            })
            .collect();
        let samples = match &resampler {
            Some(r) => r.resample(&mono, left == 0),
            None => mono,
        };
        for s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            out.write_all(&v.to_le_bytes()).map_err(|e| Error::io("写入临时文件", e))?;
            written += 1;
        }
    }
    out.flush().map_err(|e| Error::io("写入临时文件", e))?;
    Ok(written)
}

fn sample(s: &[u8], format: u16) -> f32 {
    match (format, s.len()) {
        (3, 4) => f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
        (_, 2) => i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0,
        (_, 3) => (i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8) as f32 / 8_388_608.0,
        (_, 4) => i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32 / 2_147_483_648.0,
        _ => 0.0,
    }
}
