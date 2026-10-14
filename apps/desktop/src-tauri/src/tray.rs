//! The menu-bar icon on macOS, the notification-area icon on Windows: start or stop a recording
//! without opening the app, and the elapsed time while recording.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::{capture, show_main};

const TRAY: &str = "echomind";

/// The item that reads 开始记录 or 结束记录.
struct Toggle(MenuItem<Wry>);

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "开始记录", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "打开 EchoMind", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "打开录音文件夹", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 EchoMind", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&toggle, &PredefinedMenuItem::separator(app)?, &open, &folder, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    app.manage(Toggle(toggle));

    // macOS tints the black template glyph to suit the menu bar; the Windows taskbar shows icons
    // as drawn, so it gets the app icon, and a left click opens the app as it does elsewhere there.
    let builder = if cfg!(target_os = "macos") {
        TrayIconBuilder::with_id(TRAY).icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?).icon_as_template(true)
    } else {
        TrayIconBuilder::with_id(TRAY)
            .icon(Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_main(tray.app_handle());
                }
            })
    };
    builder
        .tooltip("EchoMind")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                "toggle" => {
                    tauri::async_runtime::spawn(async move {
                        if capture::is_recording(&app) {
                            if let Err(message) = capture::send(&app, "stop") {
                                show_main(&app);
                                capture::report(&app, message);
                            }
                        } else if capture::start(&app).await.is_err() {
                            // start has already shown why, in the main window.
                            show_main(&app);
                        }
                    });
                }
                "open" => show_main(&app),
                "folder" => {
                    if let Err(message) = capture::reveal(&app) {
                        capture::report(&app, message);
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

pub fn set_recording(app: &AppHandle, on: bool) {
    if let Some(Toggle(item)) = app.try_state::<Toggle>().as_deref() {
        let _ = item.set_text(if on { "结束记录" } else { "开始记录" });
    }
    if !on {
        set_elapsed(app, None);
    }
}

/// 12:34 next to the menu-bar icon (macOS); the tooltip elsewhere.
pub fn set_elapsed(app: &AppHandle, ms: Option<u64>) {
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    let _ = tray.set_title(ms.map(clock));
    let _ = tray.set_tooltip(Some(match ms {
        Some(ms) => format!("EchoMind · 正在记录 {}", clock(ms)),
        None => "EchoMind".into(),
    }));
}

fn clock(ms: u64) -> String {
    let s = ms / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}
