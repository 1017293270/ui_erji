//! EchoMind desktop shell: two windows (the main app and the floating recorder),
//! a tray menu, the `echomind-capture` and `echomind-transcribe` sidecars, meeting
//! storage, and the proxies to Feishu and DeepSeek that keep secrets out of the webview.

mod capture;
mod config;
mod dates;
mod feishu;
mod feishu_api;
mod llm;
mod storage;
#[cfg(test)]
mod testing;
mod transcribe;
mod tray;

use std::ffi::OsStr;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

/// Opens a URL or folder with the system's default handler (browser, Finder, Explorer).
pub(crate) fn open_external(target: impl AsRef<OsStr>) -> std::io::Result<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(target).spawn().map(drop)
}

/// An error with its causes: reqwest alone says little more than "error sending request".
pub(crate) fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text = format!("{text}: {cause}");
        source = cause.source();
    }
    text
}

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(capture::Capture::default())
        .manage(feishu::Feishu::default())
        .manage(feishu_api::FeishuApi::default())
        .manage(transcribe::Transcriber::default())
        .invoke_handler(tauri::generate_handler![
            capture::capture_start,
            capture::capture_command,
            capture::capture_meetings,
            capture::capture_permissions,
            capture::capture_request_mic,
            capture::reveal_recordings,
            feishu::feishu_status,
            feishu::feishu_login,
            feishu::feishu_cancel,
            feishu::feishu_logout,
            feishu_api::feishu_directory,
            feishu_api::feishu_meeting_attendees,
            feishu_api::feishu_create_task,
            storage::meetings_list,
            storage::meeting_save,
            llm::llm_status,
            llm::llm_chat,
            transcribe::transcribe_models,
            transcribe::transcribe_download,
            transcribe::transcribe_start,
            show_main_window,
        ])
        .setup(|app| {
            tray::create(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window only hides it: a recording keeps going and the tray stays.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("EchoMind failed to start")
        .run(|app, event| match event {
            // Quitting mid-meeting: let the sidecar finish its last segment and manifest first.
            RunEvent::ExitRequested { api, .. } if capture::holds_exit(app) => {
                api.prevent_exit();
                capture::stop_then_exit(app);
            }
            // macOS: clicking the Dock icon brings the hidden main window back.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
