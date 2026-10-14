//! The bridge to `echomind-capture`, the macOS capture sidecar.
//!
//! `record` runs for the whole meeting: it prints one JSON event per line, which
//! goes to every window as `capture://event`, and reads `pause | resume | mark |
//! stop` on stdin. The other subcommands print one JSON object and exit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

use crate::storage::recordings_dir;
use crate::tray;

const SIDECAR: &str = "echomind-capture";
const EVENT: &str = "capture://event";

#[derive(Default)]
pub struct Capture {
    child: Mutex<Option<CommandChild>>,
    /// The recorder window is placed once; after that it stays where it was dragged.
    placed: AtomicBool,
    /// Set while quitting waits for the recording to close its files.
    quitting: AtomicBool,
}

fn supported() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        Ok(())
    } else {
        Err("Windows 版的录音模块还在开发中，目前只能在 macOS 上录音。".into())
    }
}

pub fn is_recording(app: &AppHandle) -> bool {
    app.state::<Capture>().child.lock().unwrap().is_some()
}

/// Starts `record` into a new folder under the app's data directory.
pub fn start(app: &AppHandle) -> Result<(), String> {
    supported()?;
    let state = app.state::<Capture>();
    let mut slot = state.child.lock().unwrap();
    if slot.is_some() {
        return Err("已经在记录了".into());
    }

    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    let out = recordings_dir(app)?.join(format!("rec-{stamp}"));
    let (events, child) = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| format!("找不到录音模块：{e}"))?
        .arg("record")
        .arg("--out")
        .arg(&out)
        .spawn()
        .map_err(|e| format!("录音模块启动失败：{e}"))?;
    *slot = Some(child);
    drop(slot);

    show_recorder(app);
    tray::set_recording(app, true);
    tauri::async_runtime::spawn(forward(app.clone(), events));
    Ok(())
}

/// Writes one stdin command to the running recording.
pub fn send(app: &AppHandle, command: &str) -> Result<(), String> {
    if !matches!(command, "pause" | "resume" | "mark" | "stop") {
        return Err(format!("未知指令：{command}"));
    }
    let state = app.state::<Capture>();
    let mut slot = state.child.lock().unwrap();
    let child = slot.as_mut().ok_or("现在没有在记录")?;
    child.write(format!("{command}\n").as_bytes()).map_err(|e| format!("发送指令失败：{e}"))
}

/// Shows a failure the same way the sidecar's own errors are shown: a toast in the main window.
pub fn report(app: &AppHandle, message: String) {
    let _ = app.emit(EVENT, json!({ "type": "error", "code": "app", "message": message }));
}

/// Relays the sidecar's events until it exits, then puts the windows and tray back.
async fn forward(app: AppHandle, mut events: Receiver<CommandEvent>) {
    let mut stopped = false;
    let mut elapsed = 0u64;
    let mut last_stderr = String::new();
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let Ok(value) = serde_json::from_slice::<Value>(bytes.trim_ascii()) else { continue };
                match value["type"].as_str() {
                    Some("level") => {
                        let t = value["t"].as_u64().unwrap_or(elapsed);
                        if t / 1000 != elapsed / 1000 {
                            tray::set_elapsed(&app, Some(t));
                        }
                        elapsed = t;
                    }
                    Some("stopped") => stopped = true,
                    _ => {}
                }
                let _ = app.emit(EVENT, value);
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    eprintln!("{line}");
                    last_stderr = line;
                }
            }
            CommandEvent::Error(message) => last_stderr = message,
            CommandEvent::Terminated(status) => {
                // Crashed or killed before `stopped`: tell the windows, and end the recording there too.
                if !stopped {
                    let message = format!("录音模块意外退出（{}）。已经写完的分段还在录音文件夹里。", describe(&status, &last_stderr));
                    let _ = app.emit(EVENT, json!({ "type": "error", "code": "sidecar_exited", "message": message }));
                    let _ = app.emit(EVENT, json!({ "type": "stopped", "durationMs": elapsed, "segments": 0 }));
                }
                break;
            }
            _ => {}
        }
    }
    app.state::<Capture>().child.lock().unwrap().take();
    hide_recorder(&app);
    tray::set_recording(&app, false);
}

fn describe(status: &TerminatedPayload, stderr: &str) -> String {
    let how = match (status.code, status.signal) {
        (Some(code), _) => format!("退出码 {code}"),
        (None, Some(signal)) => format!("信号 {signal}"),
        _ => "原因未知".into(),
    };
    if stderr.is_empty() {
        how
    } else {
        format!("{how}：{stderr}")
    }
}

/// Lets a recording close its last segment and manifest before the app goes away.
pub fn holds_exit(app: &AppHandle) -> bool {
    is_recording(app) && !app.state::<Capture>().quitting.load(Ordering::Relaxed)
}

pub fn stop_then_exit(app: &AppHandle) {
    app.state::<Capture>().quitting.store(true, Ordering::Relaxed);
    let _ = send(app, "stop");
    let app = app.clone();
    std::thread::spawn(move || {
        // The sidecar needs well under a second; after 5 s give up (stdin closing stops it anyway).
        for _ in 0..50 {
            if !is_recording(&app) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        app.exit(0);
    });
}

fn show_recorder(app: &AppHandle) {
    let Some(window) = app.get_webview_window("recorder") else { return };
    if !app.state::<Capture>().placed.swap(true, Ordering::Relaxed) {
        // Top right of the screen the main window is on, below the menu bar.
        let monitor = app
            .get_webview_window("main")
            .and_then(|main| main.current_monitor().ok().flatten())
            .or_else(|| window.primary_monitor().ok().flatten());
        if let Some(monitor) = monitor {
            let scale = monitor.scale_factor();
            let origin = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            let width = window.outer_size().map(|s| s.to_logical::<f64>(scale).width).unwrap_or(360.0);
            let _ = window.set_position(LogicalPosition::new(origin.x + size.width - width - 12.0, origin.y + 36.0));
        }
    }
    let _ = window.show();
}

fn hide_recorder(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("recorder") {
        let _ = window.hide();
    }
}

/// Runs a one-shot subcommand and returns the JSON object it printed.
async fn query(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    supported()?;
    let output = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| format!("找不到录音模块：{e}"))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("录音模块运行失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .ok_or_else(|| format!("录音模块没有输出：{}", String::from_utf8_lossy(&output.stderr).trim()))?;
    let value: Value = serde_json::from_str(line).map_err(|e| format!("录音模块的输出无法解析：{e}"))?;
    if value["type"] == "error" {
        return Err(value["message"].as_str().unwrap_or("录音模块出错").to_string());
    }
    Ok(value)
}

pub fn reveal(app: &AppHandle) -> Result<(), String> {
    let dir = recordings_dir(app)?;
    crate::open_external(&dir).map_err(|e| format!("无法打开录音文件夹：{e}"))
}

// Async so they run off the main thread: they touch windows and the tray menu.

#[tauri::command]
pub async fn capture_start(app: AppHandle) -> Result<(), String> {
    start(&app)
}

#[tauri::command]
pub async fn capture_command(app: AppHandle, command: String) -> Result<(), String> {
    send(&app, &command)
}

/// Meeting apps that are running (腾讯会议, 飞书, Lark, Zoom) and whether they hold the mic.
#[tauri::command]
pub async fn capture_meetings(app: AppHandle) -> Result<Value, String> {
    Ok(query(&app, &["meetings"]).await?.get("meetings").cloned().unwrap_or_else(|| json!([])))
}

#[tauri::command]
pub async fn capture_permissions(app: AppHandle) -> Result<Value, String> {
    query(&app, &["permissions"]).await
}

/// Shows the macOS microphone prompt if it has not been answered yet.
#[tauri::command]
pub async fn capture_request_mic(app: AppHandle) -> Result<Value, String> {
    query(&app, &["permissions", "--request-mic"]).await
}

#[tauri::command]
pub async fn reveal_recordings(app: AppHandle) -> Result<(), String> {
    reveal(&app)
}
