use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufRead};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Local;
use serde_json::json;

use crate::backend::{Backend, BackendOptions, Clock, Input, TrackKind};
use crate::events::EventSink;
use crate::recorder::{Config, Recorder};

pub struct RecordOptions {
    pub out_dir: PathBuf,
    pub segment_seconds: u32,
    pub sample_rate: u32,
    pub mic_device: Option<String>,
    pub mic: bool,
    pub system: bool,
}

pub fn run(options: RecordOptions, mut backend: impl Backend, clock: impl Clock, sink: &dyn EventSink) -> u8 {
    let prepare = || -> io::Result<()> {
        fs::create_dir_all(&options.out_dir)?;
        File::create(options.out_dir.join("manifest.json.tmp"))?;
        Ok(())
    };
    if let Err(e) = prepare() {
        sink.error("output_dir_unwritable", &format!("无法写入输出目录 {}：{e}", options.out_dir.display()));
        return 1;
    }
    let tracks = TrackKind::ALL.into_iter().filter(|t| match t {
        TrackKind::Mic => options.mic, TrackKind::System => options.system,
    }).collect();
    let mut recorder = Recorder::new(Config { out_dir: options.out_dir.clone(), sample_rate: options.sample_rate,
        segment_seconds: options.segment_seconds, tracks }, sink);
    recorder.start(clock.now_ns(), Local::now());
    if recorder.failed() { recorder.stop(clock.now_ns()); return 1; }

    let (inputs, receiver) = mpsc::channel();
    let signals = inputs.clone();
    if let Err(e) = ctrlc::set_handler(move || { let _ = signals.send(Input::Signal); }) {
        sink.error("internal_error", &format!("无法安装停止信号处理器：{e}"));
    }
    let started = backend.start(&BackendOptions { mic: options.mic, system: options.system, mic_device: options.mic_device }, inputs.clone());
    sink.emit(json!({ "type": "started", "startedAt": recorder.started_at_iso(), "sampleRate": options.sample_rate,
        "segmentSeconds": options.segment_seconds, "out": options.out_dir.display().to_string(),
        "mic": started.mic.map(|m| json!({ "device": m.device })),
        "system": started.system.map(|s| json!({ "scope": s.scope, "device": s.device })) }));

    let done = Arc::new(AtomicBool::new(false));
    let timer_done = done.clone();
    let timer_inputs = inputs.clone();
    let timer = thread::spawn(move || {
        let interval = Duration::from_millis(100);
        let mut next = Instant::now() + interval;
        loop {
            thread::sleep(next.saturating_duration_since(Instant::now()));
            if timer_done.load(Ordering::Relaxed) || timer_inputs.send(Input::Tick).is_err() { break; }
            next += interval;
        }
    });
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break; };
            let command = line.trim().to_lowercase();
            if !command.is_empty() && inputs.send(Input::Command(command)).is_err() { return; }
        }
        let _ = inputs.send(Input::StdinClosed);
    });

    let mut reported_errors = HashSet::new();
    let mut exit_code = 0;
    while let Ok(input) = receiver.recv() {
        let now = clock.now_ns();
        match input {
            Input::Chunk(track, chunk) => {
                if !chunk.samples.is_empty() { clear_track_errors(&mut reported_errors, track); }
                recorder.ingest(chunk, track);
            }
            Input::DeviceChanged { track, device } => {
                clear_track_errors(&mut reported_errors, track);
                sink.emit(json!({ "type": "device-changed", "track": track.name(), "device": device }));
            }
            Input::Error { code, message } => {
                if reported_errors.insert(code) { sink.error(code, &message); }
                if matches!(code, "output_dir_unwritable" | "write_failed" | "resample_failed") { exit_code = 1; break; }
            }
            Input::Tick => recorder.tick(now),
            Input::StdinClosed | Input::Signal => break,
            Input::Command(command) => match command.trim().to_lowercase().as_str() {
                "pause" => { if !recorder.pause(now) { eprintln!("[echomind-capture] 忽略 pause：已经暂停"); } }
                "resume" => { if !recorder.resume(now) { eprintln!("[echomind-capture] 忽略 resume：当前没有暂停"); } }
                "mark" => recorder.mark(now),
                "stop" => break,
                "" => {},
                unknown => sink.error("unknown_command", &format!("无法识别的控制指令“{unknown}”，支持 pause / resume / mark / stop。")),
            },
        }
        if recorder.failed() { exit_code = 1; break; }
    }
    let now = clock.now_ns();
    done.store(true, Ordering::Relaxed);
    backend.stop();
    let _ = timer.join();
    recorder.stop(now);
    if recorder.failed() { 1 } else { exit_code }
}

fn clear_track_errors(reported: &mut HashSet<&'static str>, track: TrackKind) {
    let prefix = match track { TrackKind::Mic => "mic_", TrackKind::System => "system_" };
    reported.retain(|code| !code.starts_with(prefix));
}
