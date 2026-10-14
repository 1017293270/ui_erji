//! The bridge to `echomind-capture`, the capture sidecar: Swift on macOS (native/macos-capture),
//! Rust on Windows (native/windows-capture). Both speak the same protocol.
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
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        Ok(())
    } else {
        Err("这个系统上还不能录音，目前只支持 macOS 和 Windows。".into())
    }
}

pub fn is_recording(app: &AppHandle) -> bool {
    app.state::<Capture>().child.lock().unwrap().is_some()
}

/// Why a recording did not start, or what it will miss: shown as an `error` event. `settings`
/// names the permission whose settings page the toast offers to open.
struct Problem {
    code: &'static str,
    message: String,
    settings: Option<&'static str>,
}

impl From<String> for Problem {
    fn from(message: String) -> Self {
        Self { code: "app", message, settings: None }
    }
}

fn show_problem(app: &AppHandle, problem: &Problem) {
    let _ = app.emit(EVENT, json!({ "type": "error", "code": problem.code, "message": problem.message, "settings": problem.settings }));
}

/// Starts `record` into a new folder under the app's data directory. A failure is also shown in
/// the windows, so callers need not report it.
pub async fn start(app: &AppHandle) -> Result<(), String> {
    begin(app).await.map_err(|problem| {
        show_problem(app, &problem);
        problem.message
    })
}

async fn begin(app: &AppHandle) -> Result<(), Problem> {
    supported()?;
    if is_recording(app) {
        return Err(Problem::from("已经在记录了".to_string()));
    }
    let warning = check_permissions(app).await?;

    let state = app.state::<Capture>();
    let mut slot = state.child.lock().unwrap();
    if slot.is_some() {
        return Err(Problem::from("已经在记录了".to_string()));
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
    if let Some(warning) = warning {
        // Started from the tray, the main window may be hidden; this needs reading now.
        crate::show_main(app);
        show_problem(app, &warning);
    }
    Ok(())
}

/// Asks for the permissions nobody has answered yet, so the prompts come before the recording and
/// not in the middle of it. Without the microphone there is nothing to record, so that refuses;
/// without system audio only the remote voices go missing, so that is a warning.
///
/// macOS never asks twice: once refused, a permission can only be turned on in System Settings.
/// An app rebuilt with a new ad hoc signature can also find its old switch on but not working.
async fn check_permissions(app: &AppHandle) -> Result<Option<Problem>, Problem> {
    // A sidecar that cannot answer fails again when recording starts, which reports it.
    let Ok(mut status) = query(app, &["permissions"]).await else { return Ok(None) };
    if status["microphone"] == "undetermined" {
        if let Ok(answered) = query(app, &["permissions", "--request-mic"]).await {
            status = answered;
        }
    }
    if status["systemAudio"] == "undetermined" {
        if let Ok(answered) = query(app, &["permissions", "--request-system-audio"]).await {
            status = answered;
        }
    }
    if matches!(status["microphone"].as_str(), Some("denied" | "restricted")) {
        let message = if cfg!(target_os = "windows") {
            "Windows 关闭了麦克风权限，录不到声音，所以没有开始记录。到「设置 → 隐私和安全性 → 麦克风」打开「麦克风访问权限」和「让桌面应用访问麦克风」，再开始记录。"
        } else {
            "EchoMind 没有麦克风权限，录不到声音，所以没有开始记录。到「系统设置 → 隐私与安全性 → 麦克风」打开 EchoMind（已经开着的话，关掉再打开一次），再开始记录。"
        };
        return Err(Problem { code: "mic_permission_denied", message: message.into(), settings: Some("microphone") });
    }
    Ok((status["systemAudio"] == "denied").then(|| Problem {
        code: "system_audio_denied",
        message: "EchoMind 没有「系统录音」权限：这次只录得到你这边的声音，线上会议里其他人的声音录不到。到「系统设置 → 隐私与安全性 → 屏幕与系统录音」打开 EchoMind 的「仅系统录音」（已经开着的话，关掉再打开一次），下次开始记录时生效。".into(),
        settings: Some("systemAudio"),
    }))
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
        // Top right of the screen the main window is on, inside the work area: below the macOS
        // menu bar, and clear of a Windows taskbar docked at the top or right.
        let monitor = app
            .get_webview_window("main")
            .and_then(|main| main.current_monitor().ok().flatten())
            .or_else(|| window.primary_monitor().ok().flatten());
        if let Some(monitor) = monitor {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let origin = area.position.to_logical::<f64>(scale);
            let size = area.size.to_logical::<f64>(scale);
            let width = window.outer_size().map(|s| s.to_logical::<f64>(scale).width).unwrap_or(360.0);
            let _ = window.set_position(LogicalPosition::new(origin.x + size.width - width - 12.0, origin.y + 12.0));
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
    start(&app).await
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

/// Shows the macOS microphone prompt if it has not been answered yet; on Windows, where desktop
/// apps get no prompt, opens the microphone privacy settings if access is off.
#[tauri::command]
pub async fn capture_request_mic(app: AppHandle) -> Result<Value, String> {
    query(&app, &["permissions", "--request-mic"]).await
}

/// Shows the macOS system audio recording prompt if it has not been answered yet. Windows needs
/// no permission for it.
#[tauri::command]
pub async fn capture_request_system_audio(app: AppHandle) -> Result<Value, String> {
    if cfg!(target_os = "windows") {
        return query(&app, &["permissions"]).await;
    }
    query(&app, &["permissions", "--request-system-audio"]).await
}

/// Opens the settings page where a permission is turned on: `microphone` or `systemAudio`.
#[tauri::command]
pub async fn open_privacy_settings(kind: String) -> Result<(), String> {
    let url = match (kind.as_str(), cfg!(target_os = "windows")) {
        ("microphone", true) => "ms-settings:privacy-microphone",
        ("microphone", false) => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        ("systemAudio", false) => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        _ => return Err(format!("没有「{kind}」对应的设置页面。")),
    };
    crate::open_external(url).map_err(|e| format!("打不开系统设置：{e}"))
}

#[tauri::command]
pub async fn reveal_recordings(app: AppHandle) -> Result<(), String> {
    reveal(&app)
}
