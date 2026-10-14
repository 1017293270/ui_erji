//! Windows audio through WASAPI: the microphone, and everything the computer plays through
//! loopback capture of the default output device. Also the `devices` subcommand.
//!
//! Each track runs on its own thread (stream.rs), which opens the device, drains it every
//! 10 ms and reopens it when the device goes away or the default device changes.

mod probe;
mod stream;

pub use probe::{meetings, permissions};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread::JoinHandle;

use serde_json::{json, Value};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, EDataFlow, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

use crate::backend::{Backend, BackendOptions, Clock, Input, MicInfo, Started, SystemInfo, TrackKind};

/// The performance counter, which WASAPI also stamps its packets with.
pub struct QpcClock {
    frequency: u64,
}

impl QpcClock {
    pub fn new() -> Self {
        let mut frequency = 0i64;
        // Never fails on Windows XP and later.
        let _ = unsafe { QueryPerformanceFrequency(&mut frequency) };
        Self { frequency: frequency.max(1) as u64 }
    }
}

impl Default for QpcClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for QpcClock {
    fn now_ns(&self) -> u64 {
        let mut counter = 0i64;
        let _ = unsafe { QueryPerformanceCounter(&mut counter) };
        (counter.max(0) as u128 * 1_000_000_000 / self.frequency as u128) as u64
    }
}

pub struct WasapiBackend {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl WasapiBackend {
    pub fn new() -> Self {
        Self { stop: Arc::new(AtomicBool::new(false)), threads: Vec::new() }
    }
}

impl Default for WasapiBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl Backend for WasapiBackend {
    fn start(&mut self, options: &BackendOptions, inputs: Sender<Input>) -> Started {
        let mut started = Started { mic: None, system: None };
        if options.mic {
            let (thread, device) = stream::spawn(TrackKind::Mic, options.mic_device.clone(), self.stop.clone(), inputs.clone());
            self.threads.push(thread);
            started.mic = Some(MicInfo { device });
        }
        if options.system {
            let (thread, device) = stream::spawn(TrackKind::System, None, self.stop.clone(), inputs);
            self.threads.push(thread);
            started.system = Some(SystemInfo { scope: "global", device });
        }
        started
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

/// `devices`: the active inputs and outputs. `uid` can be passed to `record --mic-device`.
pub fn devices() -> Result<Value, (&'static str, String)> {
    let _com = Com::init();
    let fail = |e: windows::core::Error| ("internal_error", format!("读取音频设备列表失败：{e}"));
    let enumerator = enumerator().map_err(fail)?;
    let list = |flow: EDataFlow| -> windows::core::Result<Vec<Value>> {
        let default = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole) }.ok().and_then(|d| device_id(&d).ok());
        let collection = unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)? };
        let mut out = Vec::new();
        for i in 0..unsafe { collection.GetCount()? } {
            let device = unsafe { collection.Item(i)? };
            let uid = device_id(&device)?;
            let is_default = default.as_deref() == Some(uid.as_str());
            out.push(json!({ "uid": uid, "name": device_name(&device), "isDefault": is_default }));
        }
        Ok(out)
    };
    Ok(json!({ "inputs": list(eCapture).map_err(fail)?, "outputs": list(eRender).map_err(fail)? }))
}

/// COM on the current thread, in the multithreaded apartment, until dropped.
struct Com {
    owned: bool,
}

impl Com {
    fn init() -> Self {
        Self { owned: unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok() }
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.owned {
            unsafe { CoUninitialize() };
        }
    }
}

fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

fn device_id(device: &IMMDevice) -> windows::core::Result<String> {
    unsafe {
        let id = device.GetId()?;
        let text = id.to_string().unwrap_or_default();
        CoTaskMemFree(Some(id.0 as *const _));
        Ok(text)
    }
}

/// What Windows shows in the sound settings, e.g. "麦克风 (Realtek(R) Audio)".
fn device_name(device: &IMMDevice) -> String {
    unsafe { device.OpenPropertyStore(STGM_READ).and_then(|store| store.GetValue(&PKEY_Device_FriendlyName)) }
        .map(|value| value.to_string())
        .unwrap_or_default()
}
