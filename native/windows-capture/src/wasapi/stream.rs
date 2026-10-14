//! One track's capture thread.
//!
//! Shared-mode WASAPI in the device's own mix format: the microphone directly, the system track
//! as loopback capture of the default output device. Packets are drained every 10 ms out of a
//! 200 ms buffer, so a late wake-up loses nothing. Each packet carries the performance-counter
//! time of its first frame, which is what the recorder aligns on.
//!
//! The stream is reopened when the device goes away (unplugged, disabled, format changed) and,
//! unless a specific microphone was asked for, when the default device changes. A track that
//! cannot open reports why once and retries every second; the recorder pads it with silence.
//!
//! Loopback capture delivers nothing while nothing plays. That is fine: the recorder's watchdog
//! fills the gap, and the first packet after it is placed by its timestamp.

use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::core::HRESULT;
use windows::Win32::Foundation::E_ACCESSDENIED;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_E_DEVICE_IN_USE, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM,
};
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::{CoTaskMemFree, CLSCTX_ALL};

use super::{device_id, device_name, enumerator, Com, QpcClock};
use crate::backend::{AudioChunk, Clock, Input, TrackKind};
use crate::mix::mix_to_mono;

/// 200 ms, in the 100 ns units WASAPI counts in.
const BUFFER_DURATION: i64 = 2_000_000;
const POLL: Duration = Duration::from_millis(10);
const RETRY: Duration = Duration::from_secs(1);
/// How often the default device is compared with the one in use. A change is acted on once two
/// checks in a row see it, which debounces the bursts Windows sends while switching.
const DEFAULT_CHECK: Duration = Duration::from_millis(300);
/// No track reopens more than once a second.
const MIN_REOPEN_GAP: Duration = Duration::from_secs(1);
/// The device is missing, as opposed to failing (HRESULT_FROM_WIN32(ERROR_NOT_FOUND)).
const E_NOTFOUND: HRESULT = HRESULT(0x8007_0490_u32 as i32);

/// Starts the thread and waits up to 3 s for its first device, for the `started` event.
pub fn spawn(track: TrackKind, preferred: Option<String>, stop: Arc<AtomicBool>, inputs: Sender<Input>) -> (JoinHandle<()>, Option<String>) {
    let (first_tx, first_rx) = mpsc::channel();
    let thread = thread::Builder::new()
        .name(format!("capture-{}", track.name()))
        .spawn(move || run(track, preferred.as_deref(), &stop, &inputs, first_tx))
        .expect("could not start a capture thread");
    let device = first_rx.recv_timeout(Duration::from_secs(3)).ok().flatten();
    (thread, device)
}

fn run(track: TrackKind, preferred: Option<&str>, stop: &AtomicBool, inputs: &Sender<Input>, first: Sender<Option<String>>) {
    let _com = Com::init();
    let clock = QpcClock::new();
    let mut first = Some(first);
    let mut current: Option<String> = None;
    let mut failing = false;
    let mut last_open: Option<Instant> = None;

    while !stop.load(Ordering::SeqCst) {
        if let Some(gap) = last_open.map(|t| MIN_REOPEN_GAP.saturating_sub(t.elapsed())).filter(|g| !g.is_zero()) {
            sleep(gap, stop);
            continue;
        }
        last_open = Some(Instant::now());

        let stream = match Stream::open(track, preferred) {
            Ok(stream) => stream,
            Err(failure) => {
                if let Some(tx) = first.take() {
                    let _ = tx.send(None);
                }
                if !failing {
                    eprintln!("[{}] {}", track.name(), failure.message);
                    let _ = inputs.send(Input::Error { code: failure.code, message: failure.message });
                    failing = true;
                }
                sleep(RETRY, stop);
                continue;
            }
        };
        failing = false;
        if let Some(tx) = first.take() {
            let _ = tx.send(Some(stream.name.clone()));
        } else if current.as_deref() != Some(stream.name.as_str()) {
            eprintln!("[{}] 换到了 {}", track.name(), stream.name);
            let _ = inputs.send(Input::DeviceChanged { track, device: stream.name.clone() });
        }
        current = Some(stream.name.clone());

        match stream.capture(stop, inputs, &clock) {
            End::Stopped => break,
            End::Reopen => {}
            End::Lost(e) => {
                // Unplugged or reconfigured: reopen quietly. Anything else is worth a line on stderr.
                if e.code() != AUDCLNT_E_DEVICE_INVALIDATED {
                    eprintln!("[{}] 采集中断：{e}", track.name());
                }
            }
        }
    }
}

/// Sleeps in short steps so `stop` is noticed promptly.
fn sleep(total: Duration, stop: &AtomicBool) {
    let until = Instant::now() + total;
    while !stop.load(Ordering::SeqCst) {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        thread::sleep(left.min(Duration::from_millis(50)));
    }
}

struct Failure {
    code: &'static str,
    message: String,
}

impl Failure {
    fn missing(track: TrackKind) -> Self {
        match track {
            TrackKind::Mic => Self {
                code: "mic_unavailable",
                message: "没有可用的麦克风。接入麦克风后会自动继续录制，期间麦克风轨为静音。".into(),
            },
            TrackKind::System => Self {
                code: "system_tap_failed",
                message: "没有找到播放设备，录不到其他参会人的声音。接上耳机或音箱后会自动继续录制。".into(),
            },
        }
    }

    fn from(track: TrackKind, e: &windows::core::Error) -> Self {
        let code = e.code();
        if code == E_NOTFOUND {
            return Self::missing(track);
        }
        match track {
            TrackKind::Mic if code == E_ACCESSDENIED => Self {
                code: "mic_permission_denied",
                message: "Windows 不允许 EchoMind 使用麦克风，麦克风轨为静音。请到 设置 → 隐私和安全性 → 麦克风，打开「麦克风访问权限」和「让桌面应用访问麦克风」，打开后会自动继续录制。".into(),
            },
            TrackKind::Mic if code == AUDCLNT_E_DEVICE_IN_USE => Self {
                code: "mic_start_failed",
                message: "麦克风被其他程序独占了，麦克风轨暂时为静音。关掉那个程序的独占模式后会自动继续录制。".into(),
            },
            TrackKind::Mic => Self { code: "mic_start_failed", message: format!("麦克风启动失败：{e}。每秒重试一次，期间麦克风轨为静音。") },
            TrackKind::System => Self {
                code: "system_tap_failed",
                message: format!("录不到电脑播放的声音：{e}。每秒重试一次，期间其他参会人的声音录不下来。"),
            },
        }
    }

    fn format(track: TrackKind) -> Self {
        let what = if track == TrackKind::Mic { "麦克风" } else { "播放设备" };
        let code = if track == TrackKind::Mic { "mic_start_failed" } else { "system_tap_failed" };
        Self { code, message: format!("{what}的音频格式不受支持，这条轨会是静音。换一个设备试试。") }
    }
}

enum End {
    Stopped,
    /// The default device changed.
    Reopen,
    /// The device went away or failed mid-stream.
    Lost(windows::core::Error),
}

struct Stream {
    track: TrackKind,
    client: IAudioClient,
    capture: IAudioCaptureClient,
    format: Format,
    name: String,
    /// Set when following the default device rather than one asked for by id.
    follows: Option<(IMMDeviceEnumerator, String)>,
}

impl Stream {
    fn open(track: TrackKind, preferred: Option<&str>) -> Result<Self, Failure> {
        let fail = |e: windows::core::Error| Failure::from(track, &e);
        let enumerator = enumerator().map_err(fail)?;
        let (device, follows_default) = pick(&enumerator, track, preferred).map_err(fail)?;
        let id = device_id(&device).map_err(fail)?;
        let name = device_name(&device);

        let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(fail)?;
        let mix = unsafe { client.GetMixFormat() }.map_err(fail)?;
        let format = unsafe { Format::read(mix) };
        let flags = if track == TrackKind::System { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
        let initialized = unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER_DURATION, 0, mix, None) };
        unsafe { CoTaskMemFree(Some(mix as *const _)) };
        let format = format.ok_or_else(|| Failure::format(track))?;
        initialized.map_err(fail)?;
        let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(fail)?;
        unsafe { client.Start() }.map_err(fail)?;

        let follows = follows_default.then_some((enumerator, id));
        Ok(Self { track, client, capture, format, name, follows })
    }

    fn capture(&self, stop: &AtomicBool, inputs: &Sender<Input>, clock: &QpcClock) -> End {
        let mut next_check = Instant::now() + DEFAULT_CHECK;
        let mut moved = false;
        loop {
            if stop.load(Ordering::SeqCst) {
                return End::Stopped;
            }
            thread::sleep(POLL);
            loop {
                match unsafe { self.capture.GetNextPacketSize() } {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(e) => return End::Lost(e),
                }
                let chunk = match unsafe { self.read_packet(clock) } {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => break,
                    Err(e) => return End::Lost(e),
                };
                if inputs.send(Input::Chunk(self.track, chunk)).is_err() {
                    return End::Stopped;
                }
            }
            if let Some((enumerator, id)) = &self.follows {
                if Instant::now() >= next_check {
                    next_check = Instant::now() + DEFAULT_CHECK;
                    let flow = if self.track == TrackKind::Mic { eCapture } else { eRender };
                    let now = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole) }.ok().and_then(|d| device_id(&d).ok());
                    // No default at all is handled when the device itself goes away.
                    let differs = now.is_some_and(|now| &now != id);
                    if differs && moved {
                        return End::Reopen;
                    }
                    moved = differs;
                }
            }
        }
    }

    /// One packet as a mono chunk; None when the packet was empty.
    unsafe fn read_packet(&self, clock: &QpcClock) -> windows::core::Result<Option<AudioChunk>> {
        let mut data = ptr::null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        let mut qpc = 0u64;
        self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))?;
        let frames = frames as usize;
        let channels = self.format.channels;
        let interleaved = if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
            vec![0.0; frames * channels]
        } else {
            let bytes = std::slice::from_raw_parts(data, frames * self.format.block_align);
            self.format.to_f32(bytes)
        };
        self.capture.ReleaseBuffer(frames as u32)?;
        if frames == 0 {
            return Ok(None);
        }
        let rate = self.format.rate;
        let host_ns = if flags & (AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32) != 0 || qpc == 0 {
            clock.now_ns().saturating_sub(frames as u64 * 1_000_000_000 / rate as u64)
        } else {
            // 100 ns units of the same performance counter QpcClock reads.
            qpc.saturating_mul(100)
        };
        Ok(Some(AudioChunk { host_ns, sample_rate: rate, samples: mix_to_mono(&interleaved, channels) }))
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let _ = unsafe { self.client.Stop() };
    }
}

/// The asked-for microphone if it is there, else the default device. True when it is the default.
fn pick(enumerator: &IMMDeviceEnumerator, track: TrackKind, preferred: Option<&str>) -> windows::core::Result<(IMMDevice, bool)> {
    if let Some(id) = preferred.filter(|_| track == TrackKind::Mic) {
        let wide: Vec<u16> = id.encode_utf16().chain([0]).collect();
        if let Ok(device) = unsafe { enumerator.GetDevice(windows::core::PCWSTR(wide.as_ptr())) } {
            if unsafe { device.GetState() }.is_ok_and(|s| s == DEVICE_STATE_ACTIVE) {
                return Ok((device, false));
            }
        }
        eprintln!("[mic] 指定的麦克风 {id} 不可用，改用系统默认输入设备");
    }
    let flow = if track == TrackKind::Mic { eCapture } else { eRender };
    Ok((unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole)? }, true))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Sample {
    F32,
    I16,
    I24,
    I32,
}

/// The shared-mode mix format: almost always 32-bit float, but integer PCM is handled too.
struct Format {
    rate: u32,
    channels: usize,
    sample: Sample,
    block_align: usize,
}

impl Format {
    /// None for a format we cannot convert. WAVEFORMATEX is packed, hence the unaligned reads.
    unsafe fn read(wave: *const WAVEFORMATEX) -> Option<Self> {
        let header = ptr::read_unaligned(wave);
        let tag = u32::from(header.wFormatTag);
        let float = if tag == WAVE_FORMAT_IEEE_FLOAT {
            true
        } else if tag == WAVE_FORMAT_PCM {
            false
        } else if tag == WAVE_FORMAT_EXTENSIBLE {
            let sub = ptr::read_unaligned(wave as *const WAVEFORMATEXTENSIBLE).SubFormat;
            if sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
                true
            } else if sub == KSDATAFORMAT_SUBTYPE_PCM {
                false
            } else {
                return None;
            }
        } else {
            return None;
        };
        let sample = match (float, header.wBitsPerSample) {
            (true, 32) => Sample::F32,
            (false, 16) => Sample::I16,
            (false, 24) => Sample::I24,
            (false, 32) => Sample::I32,
            _ => return None,
        };
        let channels = usize::from(header.nChannels);
        let block_align = usize::from(header.nBlockAlign);
        let width = match sample {
            Sample::I16 => 2,
            Sample::I24 => 3,
            Sample::F32 | Sample::I32 => 4,
        };
        if header.nSamplesPerSec == 0 || channels == 0 || block_align != channels * width {
            return None;
        }
        Some(Self { rate: header.nSamplesPerSec, channels, sample, block_align })
    }

    /// Interleaved samples as f32 in [-1, 1].
    fn to_f32(&self, bytes: &[u8]) -> Vec<f32> {
        match self.sample {
            Sample::F32 => bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect(),
            Sample::I16 => bytes.as_chunks::<2>().0.iter().map(|b| f32::from(i16::from_le_bytes(*b)) / 32_768.0).collect(),
            Sample::I24 => bytes.as_chunks::<3>().0.iter().map(|b| (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0).collect(),
            Sample::I32 => bytes.as_chunks::<4>().0.iter().map(|b| i32::from_le_bytes(*b) as f32 / 2_147_483_648.0).collect(),
        }
    }
}
