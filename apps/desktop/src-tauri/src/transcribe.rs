//! Local transcription through the `echomind-transcribe` sidecar (native/transcriber).
//!
//! It runs as its own process because onnxruntime aborts the whole process on a damaged
//! model. With `--json` it prints one event per line and stops when its stdin closes, so
//! the child handle is kept for as long as the work runs. Audio never leaves the machine.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Semaphore;

use crate::storage;

const SIDECAR: &str = "echomind-transcribe";
const PROGRESS: &str = "transcribe://progress";
const DOWNLOAD: &str = "transcribe://download";
const TRANSCRIPT_FILE: &str = "transcript.json";

pub struct Transcriber {
    /// Meetings being transcribed (or waiting their turn). The child is held so its stdin stays open.
    jobs: Mutex<HashMap<String, Option<CommandChild>>>,
    /// One meeting at a time: a run takes about half a gigabyte and every core.
    turn: Semaphore,
    downloading: AtomicBool,
}

impl Default for Transcriber {
    fn default() -> Self {
        Self { jobs: Mutex::default(), turn: Semaphore::new(1), downloading: AtomicBool::new(false) }
    }
}

/// The models shipped inside the app when it was packaged with them (apps/desktop/scripts/package.sh),
/// else the folder they are downloaded into. The sidecar still checks every pin before using them.
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(bundled) = app.path().resource_dir().map(|dir| dir.join("models")) {
        if ["asr", "vad", "segmentation", "embedding"].iter().all(|id| bundled.join(id).join(".ready").is_file()) {
            return Ok(bundled);
        }
    }
    Ok(storage::data_dir(app)?.join("models"))
}

fn sidecar(app: &AppHandle) -> Result<tauri_plugin_shell::process::Command, String> {
    app.shell().sidecar(SIDECAR).map_err(|e| format!("找不到本机转写模块：{e}。开发时先运行 native/transcriber/build.sh。"))
}

/// The sidecar's JSON events until it exits. `on_event` returns Some to finish with that result.
async fn follow(
    mut events: Receiver<CommandEvent>,
    mut on_event: impl FnMut(Value) -> Option<Result<Value, String>>,
) -> Result<Value, String> {
    let mut last_stderr = String::new();
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let Ok(value) = serde_json::from_slice::<Value>(bytes.trim_ascii()) else { continue };
                if let Some(result) = on_event(value) {
                    return result;
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    eprintln!("[{SIDECAR}] {line}");
                    last_stderr = line;
                }
            }
            CommandEvent::Error(message) => last_stderr = message,
            CommandEvent::Terminated(status) => {
                let how = status.code.map(|c| format!("退出码 {c}")).or(status.signal.map(|s| format!("信号 {s}"))).unwrap_or_default();
                let detail = if last_stderr.is_empty() { how } else { format!("{how}：{last_stderr}") };
                return Err(format!("本机转写模块意外退出（{detail}）。"));
            }
            _ => {}
        }
    }
    Err("本机转写模块意外退出。".into())
}

/// `{"type":"error","kind":…,"message":…}` from the sidecar, as the message to show.
fn sidecar_error(value: &Value) -> String {
    value["message"].as_str().unwrap_or("转写出错了。").to_string()
}

#[tauri::command]
pub async fn transcribe_models(app: AppHandle) -> Result<Value, String> {
    let output = sidecar(&app)?
        .args(["models", "--models-dir"])
        .arg(models_dir(&app)?)
        .output()
        .await
        .map_err(|e| format!("本机转写模块运行失败：{e}"))?;
    serde_json::from_slice(&output.stdout)
        .map_err(|_| format!("本机转写模块没有返回模型状态：{}", String::from_utf8_lossy(&output.stderr).trim()))
}

/// Downloads the speech models (about 200 MB, resumable), with progress on `transcribe://download`.
#[tauri::command]
pub async fn transcribe_download(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Transcriber>();
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err("模型已经在下载了。".into());
    }
    let result = async {
        let (events, child) = sidecar(&app)?
            .args(["download", "--json", "--models-dir"])
            .arg(models_dir(&app)?)
            .spawn()
            .map_err(|e| format!("本机转写模块启动失败：{e}"))?;
        let result = follow(events, |value| match value["type"].as_str() {
            Some("download") => {
                let _ = app.emit(DOWNLOAD, json!({ "received": value["received"], "total": value["total"] }));
                None
            }
            Some("done") => Some(Ok(Value::Null)),
            Some("error") => Some(Err(sidecar_error(&value))),
            _ => None,
        })
        .await;
        drop(child);
        result
    }
    .await;
    state.downloading.store(false, Ordering::SeqCst);
    result.map(drop)
}

/// Starts transcribing a recording folder and returns at once; the result comes on
/// `transcribe://progress` as `done` or `error`. Starting a meeting already underway is a no-op.
/// `scene` ("in-person" or "online") and `speakers` (how many people spoke) transcribe again
/// with what the user said; without them both are judged from the audio, and an earlier
/// finished run is reused.
#[tauri::command]
pub async fn transcribe_start(
    app: AppHandle,
    meeting_id: String,
    scene: Option<String>,
    speakers: Option<u32>,
) -> Result<(), String> {
    if !storage::valid_id(&meeting_id) {
        return Err(format!("会议编号「{meeting_id}」不合法。"));
    }
    if scene.as_deref().is_some_and(|s| s != "in-person" && s != "online") {
        return Err("会议场景只能是面对面或线上。".into());
    }
    if speakers.is_some_and(|n| !(1..=20).contains(&n)) {
        return Err("说话人数要在 1 到 20 之间。".into());
    }
    let mut hints = Vec::new();
    if let Some(scene) = scene {
        hints.extend(["--scene".to_string(), scene]);
    }
    if let Some(n) = speakers {
        hints.extend(["--speakers".to_string(), n.to_string()]);
    }
    let dir = storage::recordings_dir(&app)?.join(&meeting_id);
    if !dir.join("manifest.json").is_file() {
        return Err("找不到这场会议的录音文件。录音可能被移走或删除了。".into());
    }
    {
        let state = app.state::<Transcriber>();
        let mut jobs = state.jobs.lock().unwrap();
        if jobs.contains_key(&meeting_id) {
            return Ok(());
        }
        jobs.insert(meeting_id.clone(), None);
    }
    tauri::async_runtime::spawn(async move {
        let result = transcribe(&app, &meeting_id, &dir, &hints).await;
        app.state::<Transcriber>().jobs.lock().unwrap().remove(&meeting_id);
        let event = match result {
            Ok(transcript) => json!({ "meetingId": meeting_id, "stage": "done", "transcript": transcript }),
            Err((kind, message)) => json!({ "meetingId": meeting_id, "stage": "error", "kind": kind, "message": message }),
        };
        let _ = app.emit(PROGRESS, event);
    });
    Ok(())
}

/// A voiceprint per speaker of a transcribed meeting (`[{speakerId, seconds, vector}]`), worked
/// out from the recording and its transcript.json. Nothing is written; voices.rs decides where
/// they may go.
pub(crate) async fn meeting_voices(app: &AppHandle, meeting_id: &str) -> Result<Vec<Value>, String> {
    if !storage::valid_id(meeting_id) {
        return Err(format!("会议编号「{meeting_id}」不合法。"));
    }
    let dir = storage::recordings_dir(app)?.join(meeting_id);
    if !dir.join(TRANSCRIPT_FILE).is_file() {
        return Err("这场会议的录音或转写结果不在这台电脑上了，取不出声音。".into());
    }
    let (events, child) = sidecar(app)?
        .arg("voices")
        .arg(&dir)
        .args(["--json", "--models-dir"])
        .arg(models_dir(app)?)
        .spawn()
        .map_err(|e| format!("本机转写模块启动失败：{e}"))?;
    let result = follow(events, |mut value| match value["type"].as_str() {
        Some("done") => Some(Ok(value["voices"].take())),
        Some("error") => Some(Err(sidecar_error(&value))),
        _ => None,
    })
    .await;
    // Its stdin stays open until here: closing it means "cancel".
    drop(child);
    match result? {
        Value::Array(voices) => Ok(voices),
        _ => Err("本机转写模块没有返回声音。".into()),
    }
}

/// The transcript, from `transcript.json` if an earlier run heard someone (and nothing new
/// is asked for in `hints`), otherwise from the sidecar. A new run replaces the file only once
/// it succeeds.
async fn transcribe(app: &AppHandle, id: &str, dir: &Path, hints: &[String]) -> Result<Value, (String, String)> {
    let saved = dir.join(TRANSCRIPT_FILE);
    let earlier = hints.is_empty().then(|| std::fs::read(&saved).ok()).flatten();
    if let Some(transcript) = earlier.and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
        if transcript["segments"].as_array().is_some_and(|s| !s.is_empty()) {
            return Ok(transcript);
        }
    }
    let app_error = |message: String| ("app".to_string(), message);
    let progress = |stage: &Value, progress: &Value| {
        let _ = app.emit(PROGRESS, json!({ "meetingId": id, "stage": stage, "progress": progress }));
    };
    progress(&json!("prepare"), &json!(0));

    let state = app.state::<Transcriber>();
    let _turn = state.turn.acquire().await.map_err(|e| app_error(e.to_string()))?;
    let (events, child) = sidecar(app)
        .map_err(app_error)?
        .arg("run")
        .arg(dir)
        .args(hints)
        .arg("--out")
        .arg(&saved)
        .args(["--json", "--models-dir"])
        .arg(models_dir(app).map_err(app_error)?)
        .spawn()
        .map_err(|e| app_error(format!("本机转写模块启动失败：{e}")))?;
    state.jobs.lock().unwrap().insert(id.to_string(), Some(child));

    let mut kind = "app".to_string();
    follow(events, |mut value| match value["type"].as_str() {
        Some("progress") => {
            progress(&value["stage"], &value["progress"]);
            None
        }
        Some("done") => Some(Ok(value["transcript"].take())),
        Some("error") => {
            kind = value["kind"].as_str().unwrap_or("app").to_string();
            Some(Err(sidecar_error(&value)))
        }
        _ => None,
    })
    .await
    .map_err(|message| (kind, message))
}
