//! The seam between the recording pipeline and an audio backend (WASAPI on Windows).
//!
//! A backend captures on its own threads and sends everything to the session as `Input`s over
//! one channel, so the recorder runs on a single thread, like the Swift version's serial queue.
//! The stdin reader, the 100 ms timer and the Ctrl-C handler feed the same channel.

use std::sync::mpsc::Sender;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TrackKind {
    Mic,
    System,
}

impl TrackKind {
    pub const ALL: [TrackKind; 2] = [TrackKind::Mic, TrackKind::System];

    /// The name used in events, file names and the manifest.
    pub fn name(self) -> &'static str {
        match self {
            TrackKind::Mic => "mic",
            TrackKind::System => "system",
        }
    }
}

/// One captured buffer, mixed down to mono and stamped with the host time of its first frame.
pub struct AudioChunk {
    /// On the clock `Clock::now_ns` reads.
    pub host_ns: u64,
    /// The device's rate; the recorder resamples to the recording rate.
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

pub enum Input {
    Chunk(TrackKind, AudioChunk),
    /// A track moved to another device (the default one changed, or it was unplugged).
    DeviceChanged { track: TrackKind, device: String },
    /// Reported as an `error` event. Recording goes on; the watchdog fills the track with silence.
    Error { code: &'static str, message: String },
    /// One stdin line, trimmed.
    Command(String),
    StdinClosed,
    /// Ctrl-C, Ctrl-Break, closing the console, or SIGTERM/SIGHUP elsewhere.
    Signal,
    /// Every 100 ms: level events and the watchdog.
    Tick,
}

pub struct BackendOptions {
    pub mic: bool,
    pub system: bool,
    /// A device id from `devices`; the default input device when absent or gone.
    pub mic_device: Option<String>,
}

/// What the `started` event says about each track. None when the track is off.
pub struct Started {
    pub mic: Option<MicInfo>,
    pub system: Option<SystemInfo>,
}

pub struct MicInfo {
    /// None when no input device could be opened (an `Input::Error` says why).
    pub device: Option<String>,
}

pub struct SystemInfo {
    /// "global": everything the computer plays.
    pub scope: &'static str,
    pub device: Option<String>,
}

/// The host clock that both `AudioChunk::host_ns` and the session's t0 are read from.
pub trait Clock: Send + Sync {
    fn now_ns(&self) -> u64;
}

pub trait Backend {
    /// Opens the enabled tracks and starts sending `Input`s. Never fails: a track that cannot
    /// start sends an `Input::Error` and keeps retrying, and the recording continues without it.
    fn start(&mut self, options: &BackendOptions, inputs: Sender<Input>) -> Started;
    /// Stops capturing and releases the devices. No `Input` is sent after it returns.
    fn stop(&mut self);
}
