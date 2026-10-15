//! The meeting page's player. A recording is one WAV per minute and track; the page gets it
//! as a single WAV on `echomind-audio://localhost/<meetingId>` (`http://echomind-audio.localhost/…`
//! on Windows): both tracks mixed on the recording's timeline, pauses as silence, so transcript
//! times are playback times. It is made on the fly for each byte range the player asks for:
//! nothing is converted or written to disk, and seeking a long meeting stays instant.
//!
//! The capture writes 16-bit mono PCM (16 kHz). A file in any other layout plays as silence;
//! the transcriber, which converts them, still reads it.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::AppHandle;

use crate::storage;

pub const SCHEME: &str = "echomind-audio";
const HEADER_BYTES: u64 = 44;
/// The most one answer carries (about half a minute); the player asks again for more.
const CHUNK_BYTES: u64 = 1 << 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
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

/// One file's samples on the timeline.
struct Piece {
    start: u64,
    len: u64,
    path: PathBuf,
    /// Byte offset of the first sample.
    offset: u64,
}

/// A recording, both tracks laid on its timeline.
struct Mix {
    rate: u32,
    samples: u64,
    tracks: Vec<Vec<Piece>>,
}

const TRACKS: [&str; 2] = ["mic", "system"];

/// Each track's files and where they start (ms), as the capture's manifest lays them out.
fn layout(dir: &Path) -> [Vec<(u64, PathBuf)>; 2] {
    let mut tracks: [Vec<(u64, PathBuf)>; 2] = Default::default();
    let Some(manifest) = std::fs::read(dir.join("manifest.json")).ok().and_then(|b| serde_json::from_slice::<Manifest>(&b).ok()) else {
        // A capture that died before writing its manifest: the files end to end, a minute each.
        for index in 1..10_000u64 {
            let files = TRACKS.map(|t| dir.join(format!("{t}-{index:04}.wav")));
            if !files.iter().any(|f| f.is_file()) {
                break;
            }
            for (list, file) in tracks.iter_mut().zip(files) {
                list.push(((index - 1) * 60_000, file));
            }
        }
        return tracks;
    };
    for s in &manifest.segments {
        for (list, name) in tracks.iter_mut().zip([&s.mic, &s.system]) {
            // Plain names only: the manifest must not point outside the folder.
            if let Some(name) = name.as_deref().filter(|n| !n.is_empty() && !n.contains(['/', '\\']) && *n != "..") {
                list.push((s.start_ms, dir.join(name)));
            }
        }
    }
    // A capture that crashed leaves the file it was writing out of the manifest.
    if manifest.status.as_deref() != Some("stopped") {
        let last = manifest.segments.last();
        let index = last.map(|s| s.index + 1).unwrap_or(1);
        let mut start_ms = last.map(|s| s.end_ms).unwrap_or(0);
        if let Some(p) = manifest.paused.last().filter(|p| p.from_ms >= start_ms) {
            start_ms = p.to_ms.unwrap_or(p.from_ms);
        }
        for (list, track) in tracks.iter_mut().zip(TRACKS) {
            list.push((start_ms, dir.join(format!("{track}-{index:04}.wav"))));
        }
    }
    tracks
}

/// `(sample rate, byte offset of the samples, sample count)` of a 16-bit mono PCM WAV. The
/// capture refreshes the data size once a second, so a killed recording holds more than it says.
fn wav_samples(path: &Path) -> Option<(u32, u64, u64)> {
    let mut file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let mut riff = [0u8; 12];
    file.read_exact(&mut riff).ok()?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return None;
    }
    let mut rate = None;
    let mut pos = 12u64;
    loop {
        let mut head = [0u8; 8];
        file.read_exact(&mut head).ok()?;
        let size = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as u64;
        pos += 8;
        match &head[0..4] {
            b"fmt " => {
                let mut body = [0u8; 16];
                file.read_exact(&mut body).ok()?;
                let (format, channels, bits) = (u16::from_le_bytes([body[0], body[1]]), u16::from_le_bytes([body[2], body[3]]), u16::from_le_bytes([body[14], body[15]]));
                if (format, channels, bits) != (1, 1, 16) {
                    return None;
                }
                rate = Some(u32::from_le_bytes([body[4], body[5], body[6], body[7]]));
            }
            b"data" => {
                let rest = file_len.saturating_sub(pos);
                // Trusted only when another chunk follows it, or nothing does.
                let mut tail = [0u8; 4];
                let followed = size > 0
                    && size <= rest
                    && (rest - size < 8
                        || (file.seek(SeekFrom::Start(pos + size + (size & 1))).is_ok()
                            && file.read_exact(&mut tail).is_ok()
                            && tail.iter().all(|b| b.is_ascii_alphanumeric() || *b == b' ')));
                let data = if followed { size } else { rest };
                return Some((rate.filter(|r| *r > 0)?, pos, data / 2));
            }
            _ => {}
        }
        pos += size + (size & 1);
        file.seek(SeekFrom::Start(pos)).ok()?;
    }
}

impl Mix {
    fn open(dir: &Path) -> Option<Mix> {
        let mut rate = None;
        let mut tracks = Vec::new();
        for files in layout(dir) {
            let mut pieces = Vec::new();
            for (start_ms, path) in files {
                let Some((file_rate, offset, len)) = wav_samples(&path) else { continue };
                // The first file sets the rate; the capture never changes it mid-recording.
                if *rate.get_or_insert(file_rate) != file_rate || len == 0 {
                    continue;
                }
                pieces.push(Piece { start: start_ms * file_rate as u64 / 1000, len, path, offset });
            }
            pieces.sort_by_key(|p| p.start);
            // The timeline wins over a file that runs into the next one.
            for i in 1..pieces.len() {
                let next = pieces[i].start;
                let prev = &mut pieces[i - 1];
                prev.len = prev.len.min(next.saturating_sub(prev.start));
            }
            pieces.retain(|p| p.len > 0);
            tracks.push(pieces);
        }
        let samples = tracks.iter().flatten().map(|p| p.start + p.len).max()?;
        Some(Mix { rate: rate?, samples, tracks })
    }

    fn bytes(&self) -> u64 {
        HEADER_BYTES + self.samples * 2
    }

    fn header(&self) -> [u8; 44] {
        let data = (self.samples * 2).min(u32::MAX as u64 - 36) as u32;
        let mut h = [0u8; 44];
        h[0..4].copy_from_slice(b"RIFF");
        h[4..8].copy_from_slice(&(36 + data).to_le_bytes());
        h[8..16].copy_from_slice(b"WAVEfmt ");
        h[16..20].copy_from_slice(&16u32.to_le_bytes());
        h[20..22].copy_from_slice(&1u16.to_le_bytes());
        h[22..24].copy_from_slice(&1u16.to_le_bytes());
        h[24..28].copy_from_slice(&self.rate.to_le_bytes());
        h[28..32].copy_from_slice(&(self.rate * 2).to_le_bytes());
        h[32..34].copy_from_slice(&2u16.to_le_bytes());
        h[34..36].copy_from_slice(&16u16.to_le_bytes());
        h[36..40].copy_from_slice(b"data");
        h[40..44].copy_from_slice(&data.to_le_bytes());
        h
    }

    /// Samples `[from, to)`, the tracks added together. A file gone missing reads as silence.
    fn mixed(&self, from: u64, to: u64) -> Vec<i16> {
        let mut sum = vec![0i32; to.saturating_sub(from) as usize];
        for pieces in &self.tracks {
            let first = pieces.partition_point(|p| p.start + p.len <= from);
            for p in pieces[first..].iter().take_while(|p| p.start < to) {
                let (a, b) = (from.max(p.start), to.min(p.start + p.len));
                let Ok(mut file) = File::open(&p.path) else { continue };
                if file.seek(SeekFrom::Start(p.offset + (a - p.start) * 2)).is_err() {
                    continue;
                }
                let mut raw = vec![0u8; ((b - a) * 2) as usize];
                let n = read_up_to(&mut file, &mut raw);
                for (s, pair) in sum[(a - from) as usize..].iter_mut().zip(raw[..n].chunks_exact(2)) {
                    *s += i16::from_le_bytes([pair[0], pair[1]]) as i32;
                }
            }
        }
        sum.into_iter().map(|s| s.clamp(i16::MIN as i32, i16::MAX as i32) as i16).collect()
    }

    /// Bytes `[from, to]` of the WAV.
    fn read(&self, from: u64, to: u64) -> Vec<u8> {
        let mut out = Vec::with_capacity((to - from + 1) as usize);
        if from < HEADER_BYTES {
            out.extend_from_slice(&self.header()[from as usize..=(to.min(HEADER_BYTES - 1)) as usize]);
        }
        if to >= HEADER_BYTES {
            let (a, b) = (from.max(HEADER_BYTES) - HEADER_BYTES, to - HEADER_BYTES + 1);
            let samples = self.mixed(a / 2, b.div_ceil(2));
            let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
            let skip = (a % 2) as usize;
            out.extend_from_slice(&bytes[skip..skip + (b - a) as usize]);
        }
        out
    }
}

fn read_up_to(file: &mut File, buf: &mut [u8]) -> usize {
    let mut n = 0;
    while n < buf.len() {
        match file.read(&mut buf[n..]) {
            Ok(0) | Err(_) => break,
            Ok(k) => n += k,
        }
    }
    n
}

/// `Range: bytes=a-b` (or `a-`, or `-n` for the last n) as inclusive bounds within `len`.
fn byte_range(value: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let Some(spec) = value.and_then(|v| v.trim().strip_prefix("bytes=")) else { return Some((0, len.checked_sub(1)?)) };
    // Players ask for one range at a time; of several, the first is answered.
    let (a, b) = spec.split(',').next()?.trim().split_once('-')?;
    let (from, to) = match (a.trim(), b.trim()) {
        ("", n) => (len.saturating_sub(n.parse().ok()?), len.checked_sub(1)?),
        (a, "") => (a.parse().ok()?, len.checked_sub(1)?),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len.checked_sub(1)?)),
    };
    (from <= to).then_some((from, to))
}

/// What the player gets for one request of `dir`'s recording.
fn answer(dir: &Path, range: Option<&str>) -> Response<Vec<u8>> {
    let plain = |status: StatusCode| Response::builder().status(status).body(Vec::new()).unwrap();
    let Some(mix) = Mix::open(dir) else { return plain(StatusCode::NOT_FOUND) };
    let total = mix.bytes();
    let Some((from, to)) = byte_range(range, total) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(Vec::new())
            .unwrap();
    };
    let to = to.min(from + CHUNK_BYTES - 1);
    let body = mix.read(from, to);
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, "audio/wav")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {from}-{to}/{total}"))
        .header(header::CONTENT_LENGTH, body.len())
        .body(body)
        .unwrap()
}

/// `echomind-audio://localhost/<meetingId>`: the meeting's recording, for the player.
pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id = request.uri().path().trim_start_matches('/');
    let dir = storage::recordings_dir(app).ok().filter(|_| storage::valid_id(id)).map(|d| d.join(id));
    match dir {
        Some(dir) => answer(&dir, request.headers().get(header::RANGE).and_then(|v| v.to_str().ok())),
        None => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(path: &Path, samples: &[i16]) {
        let mix = Mix { rate: 16_000, samples: samples.len() as u64, tracks: Vec::new() };
        let mut bytes = mix.header().to_vec();
        bytes.extend(samples.iter().flat_map(|s| s.to_le_bytes()));
        std::fs::write(path, bytes).unwrap();
    }

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("echomind-playback-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn tracks_are_mixed_on_the_timeline_with_pauses_as_silence() {
        let dir = folder("mix");
        // Two one-second segments with a one-second pause between them.
        wav(&dir.join("mic-0001.wav"), &[100; 16_000]);
        wav(&dir.join("system-0001.wav"), &[20_000; 16_000]);
        wav(&dir.join("mic-0002.wav"), &[-300; 16_000]);
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"status":"stopped","segments":[
                {"index":1,"startMs":0,"endMs":1000,"mic":"mic-0001.wav","system":"system-0001.wav"},
                {"index":2,"startMs":2000,"endMs":3000,"mic":"mic-0002.wav","system":null}],
               "paused":[{"fromMs":1000,"toMs":2000}]}"#,
        )
        .unwrap();
        let mix = Mix::open(&dir).unwrap();
        assert_eq!(mix.samples, 48_000);
        assert_eq!(mix.mixed(15_999, 16_001), [20_100, 0]);
        assert_eq!(mix.mixed(31_999, 32_001), [0, -300]);

        // The WAV served in two odd ranges is the same as served whole.
        let whole = mix.read(0, mix.bytes() - 1);
        assert_eq!(&whole[..44], &mix.header());
        let mut parts = mix.read(0, 32_002);
        parts.extend(mix.read(32_003, mix.bytes() - 1));
        assert_eq!(parts, whole);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_capture_that_crashed_still_plays() {
        let dir = folder("crash");
        wav(&dir.join("mic-0001.wav"), &[1; 16_000]);
        wav(&dir.join("mic-0002.wav"), &[2; 8_000]);
        // Still "recording": the second file never made it into the manifest.
        std::fs::write(dir.join("manifest.json"), r#"{"status":"recording","segments":[{"index":1,"startMs":0,"endMs":1000,"mic":"mic-0001.wav"}]}"#).unwrap();
        let mix = Mix::open(&dir).unwrap();
        assert_eq!(mix.samples, 24_000);
        assert_eq!(mix.mixed(16_000, 16_001), [2]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ranges_are_read_as_players_send_them() {
        assert_eq!(byte_range(Some("bytes=0-1"), 100), Some((0, 1)));
        assert_eq!(byte_range(Some("bytes=50-"), 100), Some((50, 99)));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=90-500"), 100), Some((90, 99)));
        assert_eq!(byte_range(None, 100), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=100-"), 100), None);
        assert_eq!(byte_range(Some("items=0-1"), 100), Some((0, 99)));
    }
}
