//! The Transcript as defined in packages/shared/src/meeting.ts (camelCase JSON).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    Mic,
    System,
}

impl Track {
    pub fn as_str(self) -> &'static str {
        match self {
            Track::Mic => "mic",
            Track::System => "system",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Speaker {
    pub id: String,
    pub label: String,
    pub track: Track,
    /// Always null here; the webview links speakers to people.
    pub person_id: Option<String>,
    /// "self" for the microphone, "unknown" for diarized voices.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub speaker_id: String,
    pub track: Track,
    /// Milliseconds from the start of the recording.
    pub start: u64,
    pub end: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub meeting_id: String,
    pub language: String,
    pub speakers: Vec<Speaker>,
    pub segments: Vec<Segment>,
}
