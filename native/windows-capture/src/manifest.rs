use std::fs;
use std::io;
use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Local, SecondsFormat};
use serde_json::{json, Value};

use crate::backend::TrackKind;

pub struct SegmentEntry {
    pub index: usize,
    pub start_ms: i64,
    pub end_ms: i64,
    pub mic: Option<String>,
    pub system: Option<String>,
}

impl SegmentEntry {
    pub fn json(&self) -> Value {
        json!({ "index": self.index, "startMs": self.start_ms, "endMs": self.end_ms,
            "mic": self.mic, "system": self.system })
    }
}

pub struct Manifest {
    pub started_at: String,
    pub sample_rate: u32,
    pub segment_seconds: u32,
    pub tracks: Vec<TrackKind>,
    pub status: &'static str,
    pub duration_ms: Option<i64>,
    pub segments: Vec<SegmentEntry>,
    pub marks: Vec<i64>,
    pub paused: Vec<(i64, Option<i64>)>,
}

impl Manifest {
    pub fn new(started_at: DateTime<Local>, sample_rate: u32, segment_seconds: u32, tracks: Vec<TrackKind>) -> Self {
        Self { started_at: started_at.to_rfc3339_opts(SecondsFormat::Millis, false), sample_rate,
            segment_seconds, tracks, status: "recording", duration_ms: None,
            segments: Vec::new(), marks: Vec::new(), paused: Vec::new() }
    }

    pub fn json(&self) -> Value {
        json!({ "version": 1, "startedAt": self.started_at, "sampleRate": self.sample_rate,
            "segmentSeconds": self.segment_seconds,
            "tracks": self.tracks.iter().map(|t| t.name()).collect::<Vec<_>>(),
            "status": self.status, "durationMs": self.duration_ms,
            "segments": self.segments.iter().map(SegmentEntry::json).collect::<Vec<_>>(),
            "marks": self.marks.iter().map(|at| json!({ "atMs": at })).collect::<Vec<_>>(),
            "paused": self.paused.iter().map(|(from, to)| json!({ "fromMs": from, "toMs": to })).collect::<Vec<_>>() })
    }

    pub fn write(&self, dir: &Path) -> io::Result<()> {
        let tmp = dir.join("manifest.json.tmp");
        fs::write(&tmp, format!("{}\n", self.json()))?;
        let attempts = if cfg!(windows) { 5 } else { 1 };
        for attempt in 0..attempts {
            match fs::rename(&tmp, dir.join("manifest.json")) {
                Ok(()) => return Ok(()),
                Err(_) if attempt + 1 < attempts => std::thread::sleep(Duration::from_millis(20)),
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_manifest_is_atomically_replaced() {
        let dir = crate::selftest::test_dir("manifest");
        fs::create_dir_all(&dir).unwrap();
        let mut m = Manifest::new(Local::now(), 16000, 60, vec![TrackKind::Mic]);
        m.paused.push((70000, None));
        m.marks.push(12345);
        m.segments.push(SegmentEntry { index: 1, start_ms: 0, end_ms: 60000,
            mic: Some("mic-0001.wav".into()), system: None });
        let keys = m.json().as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys, ["version", "startedAt", "sampleRate", "segmentSeconds", "tracks", "status", "durationMs", "segments", "marks", "paused"]);
        assert!(DateTime::parse_from_rfc3339(&m.started_at).is_ok());
        assert!(!m.started_at.ends_with('Z'));
        m.write(&dir).unwrap();
        let recording: Value = serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        assert!(recording["paused"][0]["toMs"].is_null());
        assert!(recording["segments"][0]["system"].is_null());
        m.paused[0].1 = Some(75000);
        m.status = "stopped";
        m.duration_ms = Some(180000);
        m.write(&dir).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(dir.join("manifest.json")).unwrap()).unwrap(), m.json());
        assert!(!dir.join("manifest.json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
