//! The phone side of the app. What the desktop does with sidecars and system tools goes through
//! Android here (gen/android/app/src/main/java/com/evanbyte/echomind, EchoMindPlugin.kt):
//! recording in a foreground service, the speech models copied out of the package, links
//! opened in the browser. The commands keep the desktop's names and events (capture.rs), so
//! the page drives both the same way.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::storage::recordings_dir;

pub mod playback;

const EVENT: &str = "capture://event";

struct Native(PluginHandle<Wry>);

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("echomind")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            app.manage(Native(_api.register_android_plugin("com.evanbyte.echomind", "EchoMindPlugin")?));
            #[cfg(target_os = "ios")]
            return Err("EchoMind 的 iPhone 版还没有做。".into());
            #[allow(unreachable_code)]
            Ok(())
        })
        .build()
}

async fn call<T: DeserializeOwned>(app: &AppHandle, command: &str, payload: Value) -> Result<T, String> {
    // Swiped away, the app has no activity for the call to run on, and wry would panic.
    if app.webview_windows().is_empty() {
        return Err("EchoMind 的页面已经关了。".into());
    }
    let native = app.try_state::<Native>().ok_or("手机功能还没有准备好，请重新打开 EchoMind。")?;
    native.0.run_mobile_plugin_async(command, payload).await.map_err(|e| match e {
        tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r) => r.message.unwrap_or_else(|| "手机上的操作失败了。".into()),
        other => other.to_string(),
    })
}

/// A channel Android sends JSON objects into; each arrives here parsed.
fn channel(on_message: impl Fn(Value) + Send + Sync + 'static) -> Channel {
    Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            if let Ok(value) = serde_json::from_str(&json) {
                on_message(value);
            }
        }
        Ok(())
    })
}

/// Recording events, sent on as `capture://event` like the desktop's sidecar's.
fn capture_events(app: &AppHandle) -> Channel {
    let app = app.clone();
    channel(move |event| {
        let _ = app.emit(EVENT, event);
    })
}

/// Swiped away mid-recording, the app keeps running without a page (lib.rs); opened again,
/// Android gives it a new activity, and the page opens in that.
pub fn reopen_pages(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while call::<Value>(&app, "nextActivity", json!({})).await.is_ok() {
            if !app.webview_windows().is_empty() {
                continue;
            }
            let Some(config) = app.config().app.windows.first().cloned() else { break };
            if let Err(e) = tauri::WebviewWindowBuilder::from_config(&app, &config).and_then(|page| page.build()) {
                eprintln!("无法重新打开页面：{e}");
            }
        }
    });
}

/// Opens a link in the phone's browser.
pub(crate) async fn open_url(app: &AppHandle, url: &str) -> Result<(), String> {
    call::<Value>(app, "openUrl", json!({ "url": url })).await.map(drop)
}

/// Copies the speech models out of the app package into `dest`; `on_progress(received, total)` in bytes.
pub(crate) async fn install_models(app: &AppHandle, dest: &Path, on_progress: impl Fn(u64, u64) + Send + Sync + 'static) -> Result<(), String> {
    let progress = channel(move |p| on_progress(p["received"].as_u64().unwrap_or(0), p["total"].as_u64().unwrap_or(0)));
    call::<Value>(app, "installModels", json!({ "dest": dest, "progress": progress })).await.map(drop)
}

/// Starts a recording into a new folder under recordings/, after asking for the microphone.
/// Failures are also shown as an `error` event, as on the desktop.
#[tauri::command]
pub async fn capture_start(app: AppHandle) -> Result<(), String> {
    let result = begin(&app).await;
    if let Err(message) = &result {
        let _ = app.emit(EVENT, json!({ "type": "error", "code": "app", "message": message }));
    }
    result
}

async fn begin(app: &AppHandle) -> Result<(), String> {
    let answer: Value = call(app, "recordingPermissions", json!({})).await?;
    if answer["microphone"] != "granted" {
        return Err("EchoMind 没有麦克风权限，录不到声音，所以没有开始记录。到手机的「设置 → 应用 → EchoMind → 权限」打开麦克风，再开始记录。".into());
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    let out = recordings_dir(app)?.join(format!("rec-{stamp}"));
    call::<Value>(app, "record", json!({ "out": out, "events": capture_events(app) })).await.map(drop)
}

#[tauri::command]
pub async fn capture_command(app: AppHandle, command: String) -> Result<(), String> {
    if !matches!(command.as_str(), "pause" | "resume" | "mark" | "stop") {
        return Err(format!("未知指令：{command}"));
    }
    call::<Value>(&app, "control", json!({ "command": command })).await.map(drop)
}

/// The recording that is running, if any: `{recording, startedAt, out, elapsedMs, paused}`. It
/// carries on while the app is closed; a page that opens meanwhile asks here, and the events
/// come to it from then on.
#[tauri::command]
pub async fn capture_status(app: AppHandle) -> Result<Value, String> {
    call(&app, "status", json!({ "events": capture_events(&app) })).await
}

/// In the desktop's shape. A phone records no system audio.
#[tauri::command]
pub async fn capture_permissions(app: AppHandle) -> Result<Value, String> {
    let states: Value = call(&app, "checkPermissions", json!({})).await?;
    let microphone = match states["microphone"].as_str() {
        Some("granted") => "granted",
        Some("denied") => "denied",
        _ => "undetermined",
    };
    Ok(json!({ "microphone": microphone, "systemAudio": "unknown" }))
}

#[tauri::command]
pub async fn capture_request_mic(app: AppHandle) -> Result<(), String> {
    call::<Value>(&app, "recordingPermissions", json!({})).await.map(drop)
}

/// Recordings that ended while the app was closed, or were cut short, and have no meeting yet
/// (storage.rs); `live` is the folder name of the one recording now.
#[tauri::command]
pub async fn unsaved_recordings(app: AppHandle, live: Option<String>) -> Result<Vec<Value>, String> {
    let dir = recordings_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || crate::storage::unsaved_in(&dir, live.as_deref())).await.map_err(|e| e.to_string())
}

/// Whether a meeting is being transcribed or summarised: while one is, Android is asked to keep
/// the app running and online in the background (RecorderService.kt).
#[tauri::command]
pub async fn keep_working(app: AppHandle, active: bool) -> Result<(), String> {
    call::<Value>(&app, "keepWorking", json!({ "active": active })).await.map(drop)
}

/// The app's page in the phone's settings, where its permissions are.
#[tauri::command]
pub async fn open_privacy_settings(app: AppHandle, kind: String) -> Result<(), String> {
    let _ = kind;
    call::<Value>(&app, "openSettings", json!({})).await.map(drop)
}
