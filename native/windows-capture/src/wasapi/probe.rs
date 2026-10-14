//! `permissions` and `meetings` on Windows.
//!
//! Desktop apps get no permission prompt on Windows: the microphone is either allowed or turned
//! off in Settings → Privacy & security → Microphone, which these registry values mirror. Loopback
//! capture needs no permission at all.
//!
//! Meeting apps are found by executable name. A Windows audio session belongs to a process id,
//! and apps like 飞书 play and record from child processes, so a session counts for an app when
//! its process or one of its ancestors is that app's executable.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS};
use windows::Win32::Media::Audio::{
    eCapture, eRender, AudioSessionStateActive, EDataFlow, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::CLSCTX_ALL;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

use super::{enumerator, Com};

const CONSENT: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

const NOTE: &str = "Windows 上录系统声音不需要授权。麦克风在 设置 → 隐私和安全性 → 麦克风 里管理，需要同时打开「麦克风访问权限」和「让桌面应用访问麦克风」。";

/// `{"microphone":"granted"|"denied","systemAudio":"granted","note":…}`. With `request_mic`, a
/// blocked microphone opens the Settings page where it is turned on (Windows has no prompt).
pub fn permissions(request_mic: bool) -> Value {
    // The device-wide switch (set by an administrator), the user's switch, and the one for desktop apps.
    let denied = [(HKEY_LOCAL_MACHINE, CONSENT.to_string()), (HKEY_CURRENT_USER, CONSENT.to_string()), (HKEY_CURRENT_USER, format!(r"{CONSENT}\NonPackaged"))]
        .iter()
        .any(|(root, key)| registry_string(*root, key, "Value").as_deref() == Some("Deny"));
    if request_mic && denied {
        let _ = std::process::Command::new("explorer.exe").arg("ms-settings:privacy-microphone").spawn();
    }
    json!({ "microphone": if denied { "denied" } else { "granted" }, "systemAudio": "granted", "note": NOTE })
}

fn registry_string(root: HKEY, key: &str, value: &str) -> Option<String> {
    let key: Vec<u16> = key.encode_utf16().chain([0]).collect();
    let value: Vec<u16> = value.encode_utf16().chain([0]).collect();
    let mut buffer = [0u16; 64];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(root, PCWSTR(key.as_ptr()), PCWSTR(value.as_ptr()), RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut size))
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..len]))
}

struct MeetingApp {
    app: &'static str,
    name: &'static str,
    /// Lowercase executable names.
    exes: &'static [&'static str],
}

/// Executable names from the vendors' Windows installers; not yet checked on a real machine.
const APPS: &[MeetingApp] = &[
    MeetingApp { app: "tencent", name: "腾讯会议", exes: &["wemeetapp.exe"] },
    MeetingApp { app: "feishu", name: "飞书", exes: &["feishu.exe"] },
    MeetingApp { app: "lark", name: "Lark", exes: &["lark.exe"] },
    MeetingApp { app: "zoom", name: "Zoom", exes: &["zoom.exe"] },
];

struct Process {
    parent: u32,
    exe: String,
}

struct Session {
    pid: u32,
    flow: &'static str,
    active: bool,
}

/// `{"meetings":[{"app","name","pid","exe","usingMic","playingAudio","audioPids"}]}`; `verbose`
/// adds every audio session, to find out where a new app's audio lives.
pub fn meetings(verbose: bool) -> Result<Value, (&'static str, String)> {
    let _com = Com::init();
    let processes = processes().map_err(|e| ("internal_error", format!("读取进程列表失败：{e}")))?;
    let enumerator = enumerator().map_err(|e| ("internal_error", format!("读取音频设备失败：{e}")))?;
    let mut all = sessions(&enumerator, eCapture, "input");
    all.extend(sessions(&enumerator, eRender, "output"));
    let sessions = all;

    let mut found = Vec::new();
    for app in APPS {
        let owns = |pid: u32| lineage(&processes, pid).any(|p| app.exes.contains(&p.exe.as_str()));
        // The app's top process: one of its executables whose parent is not also one.
        let Some(&pid) = processes
            .iter()
            .filter(|(_, p)| app.exes.contains(&p.exe.as_str()))
            .filter(|(_, p)| processes.get(&p.parent).is_none_or(|parent| !app.exes.contains(&parent.exe.as_str())))
            .map(|(pid, _)| pid)
            .min()
        else {
            continue;
        };
        let mine: Vec<&Session> = sessions.iter().filter(|s| owns(s.pid)).collect();
        let audio_pids: Vec<u32> = mine.iter().map(|s| s.pid).collect::<HashSet<_>>().into_iter().collect();
        found.push(json!({
            "app": app.app,
            "name": app.name,
            "pid": pid,
            "exe": processes[&pid].exe,
            "usingMic": mine.iter().any(|s| s.active && s.flow == "input"),
            "playingAudio": mine.iter().any(|s| s.active && s.flow == "output"),
            "audioPids": audio_pids,
        }));
    }

    let mut out = json!({ "meetings": found });
    if verbose {
        out["sessions"] = sessions
            .iter()
            .map(|s| {
                let exe = processes.get(&s.pid).map(|p| p.exe.as_str()).unwrap_or("");
                json!({ "pid": s.pid, "exe": exe, "flow": s.flow, "active": s.active })
            })
            .collect();
    }
    Ok(out)
}

/// The process and its ancestors, nearest first. Bounded, since parent ids can be reused.
fn lineage(processes: &HashMap<u32, Process>, pid: u32) -> impl Iterator<Item = &Process> {
    let mut next = Some(pid);
    std::iter::from_fn(move || {
        let process = processes.get(&next?)?;
        next = (process.parent != 0).then_some(process.parent);
        Some(process)
    })
    .take(16)
}

fn processes() -> windows::core::Result<HashMap<u32, Process>> {
    let mut out = HashMap::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
            out.insert(entry.th32ProcessID, Process { parent: entry.th32ParentProcessID, exe });
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    Ok(out)
}

/// Every audio session on every active device of one direction. Devices that fail are skipped.
fn sessions(enumerator: &IMMDeviceEnumerator, flow: EDataFlow, name: &'static str) -> Vec<Session> {
    let mut out = Vec::new();
    let Ok(devices) = (unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) }) else { return out };
    for i in 0..unsafe { devices.GetCount() }.unwrap_or(0) {
        let list = unsafe {
            devices
                .Item(i)
                .and_then(|device| device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None))
                .and_then(|manager| manager.GetSessionEnumerator())
        };
        let Ok(list) = list else { continue };
        for j in 0..unsafe { list.GetCount() }.unwrap_or(0) {
            let Ok(control) = (unsafe { list.GetSession(j) }) else { continue };
            let active = unsafe { control.GetState() }.is_ok_and(|s| s == AudioSessionStateActive);
            // A session shared by several processes reports AUDCLNT_S_NO_SINGLE_PROCESS and pid 0.
            let pid = control.cast::<IAudioSessionControl2>().ok().and_then(|c| unsafe { c.GetProcessId() }.ok()).unwrap_or(0);
            if pid != 0 {
                out.push(Session { pid, flow: name, active });
            }
        }
    }
    out
}
