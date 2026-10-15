//! Local transcription on a phone, with the same commands and events as the desktop's sidecar
//! bridge (transcribe.rs). A phone app cannot start other programs, so the transcriber runs
//! inside the app on a blocking thread. onnxruntime aborts the process on a damaged model,
//! so every model is checked against its pin before a run, and the recording is already on
//! disk by then. Audio never leaves the phone.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use echomind_transcriber::{Error, Hints, Scene, Transcript};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

use crate::storage;

const PROGRESS: &str = "transcribe://progress";
const DOWNLOAD: &str = "transcribe://download";
const TRANSCRIPT_FILE: &str = "transcript.json";

pub struct Transcriber {
    /// Meetings being transcribed (or waiting their turn).
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// One meeting at a time: a run takes about half a gigabyte and every core.
    turn: Semaphore,
}

impl Default for Transcriber {
    fn default() -> Self {
        Self { jobs: Mutex::default(), turn: Semaphore::new(1) }
    }
}

/// Where the models are unpacked from the app package (see `transcribe_download`).
pub(crate) fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(storage::data_dir(app)?.join("models"))
}

fn error_event(error: &Error) -> (String, String) {
    let kind = serde_json::to_value(error.kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "app".into());
    (kind, error.message.clone())
}

#[tauri::command]
pub async fn transcribe_models(app: AppHandle) -> Result<Value, String> {
    let dir = models_dir(&app)?;
    let status = tauri::async_runtime::spawn_blocking(move || echomind_transcriber::model_status(&dir)).await.map_err(|e| e.to_string())?;
    serde_json::to_value(status).map_err(|e| e.to_string())
}

/// The models come inside the app package; this unpacks them (about 270 MB) into the app's
/// data folder, with progress on `transcribe://download` like the desktop's download.
#[tauri::command]
pub async fn transcribe_download(app: AppHandle) -> Result<(), String> {
    let dest = models_dir(&app)?;
    let emitter = app.clone();
    crate::mobile::install_models(&app, &dest, move |received, total| {
        let _ = emitter.emit(DOWNLOAD, json!({ "received": received, "total": total }));
    })
    .await?;
    let status = echomind_transcriber::model_status(&dest);
    if status.ready {
        Ok(())
    } else {
        Err("语音模型没有装好：安装包里的模型不完整。请重新安装 EchoMind。".into())
    }
}

/// Starts transcribing a recording folder and returns at once; the result comes on
/// `transcribe://progress` as `done` or `error`. Same arguments as on the desktop.
#[tauri::command]
pub async fn transcribe_start(app: AppHandle, meeting_id: String, scene: Option<String>, speakers: Option<u32>) -> Result<(), String> {
    if !storage::valid_id(&meeting_id) {
        return Err(format!("会议编号「{meeting_id}」不合法。"));
    }
    let scene = match scene.as_deref() {
        None => None,
        Some(s) => Some(Scene::parse(s).ok_or("会议场景只能是面对面或线上。")?),
    };
    if speakers.is_some_and(|n| !(1..=20).contains(&n)) {
        return Err("说话人数要在 1 到 20 之间。".into());
    }
    let hints = Hints { scene, people: speakers.map(|n| n as usize) };
    let dir = storage::recordings_dir(&app)?.join(&meeting_id);
    if !dir.join("manifest.json").is_file() {
        return Err("找不到这场会议的录音文件。录音可能被移走或删除了。".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<Transcriber>();
        let mut jobs = state.jobs.lock().unwrap();
        if jobs.contains_key(&meeting_id) {
            return Ok(());
        }
        jobs.insert(meeting_id.clone(), cancel.clone());
    }
    tauri::async_runtime::spawn(async move {
        let result = transcribe(&app, &meeting_id, &dir, hints, cancel).await;
        app.state::<Transcriber>().jobs.lock().unwrap().remove(&meeting_id);
        let event = match result {
            Ok(transcript) => json!({ "meetingId": meeting_id, "stage": "done", "transcript": transcript }),
            Err((kind, message)) => json!({ "meetingId": meeting_id, "stage": "error", "kind": kind, "message": message }),
        };
        let _ = app.emit(PROGRESS, event);
    });
    Ok(())
}

/// The transcript, from `transcript.json` if an earlier run heard someone and nothing new is
/// asked for, otherwise from a new run, which replaces the file only once it succeeds.
async fn transcribe(app: &AppHandle, id: &str, dir: &Path, hints: Hints, cancel: Arc<AtomicBool>) -> Result<Value, (String, String)> {
    let saved = dir.join(TRANSCRIPT_FILE);
    let asked = hints.scene.is_some() || hints.people.is_some();
    if !asked {
        if let Some(transcript) = std::fs::read(&saved).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            if transcript["segments"].as_array().is_some_and(|s| !s.is_empty()) {
                return Ok(transcript);
            }
        }
    }
    let app_error = |message: String| ("app".to_string(), message);
    let _ = app.emit(PROGRESS, json!({ "meetingId": id, "stage": "prepare", "progress": 0 }));

    let state = app.state::<Transcriber>();
    let _turn = state.turn.acquire().await.map_err(|e| app_error(e.to_string()))?;
    let models = models_dir(app).map_err(app_error)?;
    let (emitter, meeting, dir) = (app.clone(), id.to_string(), dir.to_path_buf());
    let transcript = tauri::async_runtime::spawn_blocking(move || {
        echomind_transcriber::transcribe(&dir, &models, hints, &cancel, |stage, progress| {
            let _ = emitter.emit(PROGRESS, json!({ "meetingId": meeting, "stage": stage.as_str(), "progress": progress }));
        })
    })
    .await
    .map_err(|e| app_error(e.to_string()))?
    .map_err(|e| error_event(&e))?;

    let bytes = serde_json::to_vec_pretty(&transcript).map_err(|e| app_error(e.to_string()))?;
    storage::write_atomic(&saved, &bytes).map_err(|e| ("io".to_string(), format!("保存转写结果失败：{e}")))?;
    serde_json::to_value(&transcript).map_err(|e| app_error(e.to_string()))
}

/// A voiceprint per speaker of a transcribed meeting (`[{speakerId, seconds, vector}]`), from
/// the recording and its transcript.json. Nothing is written; voiceprints.rs decides where
/// they may go.
pub(crate) async fn meeting_voices(app: &AppHandle, meeting_id: &str) -> Result<Vec<Value>, String> {
    if !storage::valid_id(meeting_id) {
        return Err(format!("会议编号「{meeting_id}」不合法。"));
    }
    let dir = storage::recordings_dir(app)?.join(meeting_id);
    let unreadable = "这场会议的录音或转写结果不在这台手机上了，取不出声音。";
    let bytes = std::fs::read(dir.join(TRANSCRIPT_FILE)).map_err(|_| unreadable)?;
    let transcript: Transcript = serde_json::from_slice(&bytes).map_err(|_| "读不到这场会议的转写结果：请重新转写这场会议。")?;
    let models = models_dir(app)?;
    let voices = tauri::async_runtime::spawn_blocking(move || {
        echomind_transcriber::voices(&dir, &transcript, &models, &AtomicBool::new(false))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.message)?;
    voices.into_iter().map(|v| serde_json::to_value(v).map_err(|e| e.to_string())).collect()
}
