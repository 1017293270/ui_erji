//! EchoMind's app shell. On the desktop: two windows (the main app and the floating recorder),
//! a tray menu, the `echomind-capture` and `echomind-transcribe` sidecars. On a phone the same
//! commands go through Android instead (mobile/). Both keep meetings on the device and call
//! Feishu and DeepSeek through the EchoMind server, which keeps secrets out of the webview and
//! out of the app.

#[cfg(desktop)]
mod capture;
mod config;
mod dates;
mod feishu;
mod feishu_api;
mod llm;
#[cfg(mobile)]
mod mobile;
mod net;
mod playback;
mod server;
mod storage;
#[cfg(test)]
mod testing;
#[cfg(desktop)]
mod transcribe;
// A phone runs the transcriber inside the app, behind the same commands.
#[cfg(mobile)]
#[path = "mobile/transcribe.rs"]
mod transcribe;
#[cfg(desktop)]
mod tray;
mod voiceprints;

#[cfg(desktop)]
use std::ffi::OsStr;

use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;

/// Opens a URL or folder with the system's default handler (browser, Finder, Explorer).
#[cfg(desktop)]
pub(crate) fn open_external(target: impl AsRef<OsStr>) -> std::io::Result<()> {
    let target = target.as_ref();
    let mut command = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(target_os = "windows") {
        // Explorer opens folders; URLs go to the default browser through the URL handler, which
        // takes them verbatim (no shell between, so `&` in a query string is safe).
        let url = target.to_str().is_some_and(|t| t.starts_with("https://") || t.starts_with("http://"));
        let mut command = std::process::Command::new(if url { "rundll32.exe" } else { "explorer.exe" });
        if url {
            command.arg("url.dll,FileProtocolHandler");
        }
        command
    } else {
        std::process::Command::new("xdg-open")
    };
    command.arg(target).spawn().map(drop)
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
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    // A phone app has one window, in front whenever someone is using it.
    #[cfg(mobile)]
    let _ = app;
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

/// The commands both platforms have, after the platform's own.
macro_rules! handler {
    ($($own:path),* $(,)?) => {
        tauri::generate_handler![
            $($own,)*
            feishu::feishu_status,
            feishu::feishu_login,
            feishu::feishu_cancel,
            feishu::feishu_logout,
            feishu::feishu_forget_company,
            server::companies_list,
            server::companies_add,
            server::companies_update,
            server::companies_replace_secret,
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
            voiceprints::voiceprints_list,
            voiceprints::voiceprint_ask,
            voiceprints::voiceprint_delete,
            voiceprints::voiceprint_remember,
            voiceprints::voices_match,
            show_main_window,
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(mobile)]
    net::init();

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        // First, so a second launch hands over to this one before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        .manage(capture::Capture::default())
        .invoke_handler(handler![
            capture::capture_start,
            capture::capture_command,
            capture::capture_meetings,
            capture::capture_permissions,
            capture::capture_request_mic,
            capture::capture_request_system_audio,
            capture::open_privacy_settings,
            capture::reveal_recordings,
        ])
        .on_window_event(|window, event| {
            // Closing the main window only hides it: a recording keeps going and the tray stays.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });
    #[cfg(mobile)]
    let builder = builder.plugin(mobile::init()).invoke_handler(handler![
        mobile::capture_start,
        mobile::capture_command,
        mobile::capture_status,
        mobile::capture_permissions,
        mobile::capture_request_mic,
        mobile::open_privacy_settings,
        mobile::keep_working,
        mobile::unsaved_recordings,
        mobile::playback::playback_url,
    ]);

    let app = builder
        .manage(feishu::Feishu::default())
        .manage(feishu_api::FeishuApi::default())
        .manage(transcribe::Transcriber::default())
        // The meeting page's player; reading a range of a long recording stays off the main thread.
        .register_asynchronous_uri_scheme_protocol(playback::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || responder.respond(playback::serve(&app, &request)));
        })
        .setup(|app| {
            #[cfg(desktop)]
            tray::create(app.handle())?;
            voiceprints::start_sending(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("EchoMind failed to start");

    #[cfg(desktop)]
    app.run(|app, event| match event {
        // Quitting mid-meeting: let the sidecar finish its last segment and manifest first.
        tauri::RunEvent::ExitRequested { api, .. } if capture::holds_exit(app) => {
            api.prevent_exit();
            capture::stop_then_exit(app);
        }
        // macOS: clicking the Dock icon brings the hidden main window back.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
    // Swiping the app away destroys its window, and with the last window gone the app would quit,
    // ending a recording or a meeting being processed in RecorderService. The process stays,
    // until Android ends it once nothing keeps it in the foreground, and opened again it shows
    // the page in the new activity.
    #[cfg(mobile)]
    app.run(|app, event| match event {
        tauri::RunEvent::Ready => mobile::reopen_pages(app),
        tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        _ => {}
    });
}
