//! Meetings on disk: one folder per recording under the app data directory, with the
//! Meeting as `meeting.json` next to the audio. The folder name is the meeting id.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::dates;

const MEETING_FILE: &str = "meeting.json";

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录 {}：{e}", dir.display()))?;
    Ok(dir)
}

pub fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建录音目录 {}：{e}", dir.display()))?;
    Ok(dir)
}

/// `^[A-Za-z0-9._-]{1,80}$`, and not `.` or `..`, so an id can only ever name a folder inside recordings/.
pub fn valid_id(id: &str) -> bool {
    (1..=80).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && id != "."
        && id != ".."
}

/// Writes a sibling temp file and renames it over `path`: a crash leaves the old file or the
/// new one, never half of either.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_with(path, bytes, false)
}

/// The same, readable by this user only (tokens).
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_with(path, bytes, true)
}

fn write_with(path: &Path, bytes: &[u8], private: bool) -> std::io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().ok_or(std::io::ErrorKind::InvalidInput)?.to_string_lossy();
    let temp = path.with_file_name(format!(".{name}.{}-{}.tmp", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    let written = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(not(unix))]
        let _ = private;
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// Every readable meeting, newest `startedAt` first. A folder that is still recording, was
/// never saved, or holds a damaged file is skipped rather than failing the whole list.
fn list_in(dir: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut meetings: Vec<(i64, Value)> = entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok().filter(|id| valid_id(id))?;
            let text = std::fs::read(entry.path().join(MEETING_FILE)).ok()?;
            let mut meeting = match serde_json::from_slice::<Value>(&text) {
                Ok(meeting @ Value::Object(_)) => meeting,
                _ => {
                    eprintln!("跳过无法解析的 {id}/{MEETING_FILE}");
                    return None;
                }
            };
            // The folder name is the id, even if the file was copied from another folder.
            meeting["id"] = Value::String(id);
            let started = meeting["startedAt"].as_str().and_then(dates::parse_iso_secs).unwrap_or(i64::MIN);
            Some((started, meeting))
        })
        .collect();
    meetings.sort_by(|a, b| b.0.cmp(&a.0));
    meetings.into_iter().map(|(_, meeting)| meeting).collect()
}

/// Recordings that never became a meeting, because the app was gone when they ended (on the
/// phone a recording outlives the app) or the system stopped them halfway: folders with saved
/// audio in manifest.json and no meeting.json, other than `live`, the one being recorded now.
/// Each as `{id, startedAt, durationMs, marks}`; one stopped halfway lasts to its last whole segment.
#[cfg(any(mobile, test))]
pub(crate) fn unsaved_in(dir: &Path, live: Option<&str>) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok().filter(|id| valid_id(id) && live != Some(id.as_str()))?;
            if entry.path().join(MEETING_FILE).exists() {
                return None;
            }
            let manifest: Value = serde_json::from_slice(&std::fs::read(entry.path().join("manifest.json")).ok()?).ok()?;
            let end = manifest["segments"].as_array()?.last()?["endMs"].as_u64()?;
            let marks: Vec<u64> = manifest["marks"].as_array().into_iter().flatten().filter_map(|m| m["atMs"].as_u64()).collect();
            Some(serde_json::json!({
                "id": id,
                "startedAt": manifest["startedAt"].as_str()?,
                "durationMs": manifest["durationMs"].as_u64().unwrap_or(end),
                "marks": marks,
            }))
        })
        .collect()
}

/// One meeting's meeting.json, if it is there and readable.
pub(crate) fn read_meeting(app: &AppHandle, id: &str) -> Option<Value> {
    if !valid_id(id) {
        return None;
    }
    let text = std::fs::read(recordings_dir(app).ok()?.join(id).join(MEETING_FILE)).ok()?;
    serde_json::from_slice(&text).ok()
}

fn save_in(dir: &Path, meeting: &Value) -> Result<(), String> {
    if !meeting.is_object() {
        return Err("会议数据格式不对，没有保存。".into());
    }
    let id = meeting["id"].as_str().unwrap_or_default();
    if !valid_id(id) {
        return Err(format!("会议编号「{id}」不合法，没有保存。"));
    }
    let folder = dir.join(id);
    std::fs::create_dir_all(&folder).map_err(|e| format!("无法创建会议文件夹：{e}"))?;
    let text = serde_json::to_vec_pretty(meeting).map_err(|e| e.to_string())?;
    write_atomic(&folder.join(MEETING_FILE), &text).map_err(|e| format!("保存会议失败：{e}"))
}

// File work runs on the blocking pool: a list can read many transcripts.

#[tauri::command]
pub async fn meetings_list(app: AppHandle) -> Result<Vec<Value>, String> {
    let dir = recordings_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_in(&dir)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn meeting_save(app: AppHandle, meeting: Value) -> Result<(), String> {
    let dir = recordings_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || save_in(&dir, &meeting)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            let mut bytes = [0u8; 8];
            getrandom::fill(&mut bytes).unwrap();
            let dir = std::env::temp_dir().join(format!("echomind-test-{}", u64::from_le_bytes(bytes)));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ids_stay_inside_recordings() {
        for ok in ["rec-1791884868281", "a", "A.b_c-9", &"x".repeat(80)] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "rec 1", "会议", "a\0", &"x".repeat(81)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn save_then_list() {
        let dir = TempDir::new();
        let meeting = |id: &str, started: &str| json!({ "id": id, "title": "周会", "startedAt": started, "participantIds": [] });
        save_in(&dir.0, &meeting("rec-1", "2026-10-13T01:00:00Z")).unwrap();
        save_in(&dir.0, &meeting("rec-2", "2026-10-13T10:00:00+08:00")).unwrap();
        save_in(&dir.0, &meeting("rec-3", "2026-10-12T23:00:00Z")).unwrap();
        // Saving again replaces the file and leaves no temp files behind.
        save_in(&dir.0, &json!({ "id": "rec-1", "title": "改过的标题", "startedAt": "2026-10-13T01:00:00Z" })).unwrap();
        let files: Vec<_> = std::fs::read_dir(dir.0.join("rec-1")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(files, vec![std::ffi::OsString::from("meeting.json")]);

        // Folders that should be skipped: still recording, damaged, not an object, a bad name.
        std::fs::create_dir_all(dir.0.join("rec-4")).unwrap();
        std::fs::create_dir_all(dir.0.join("rec-5")).unwrap();
        std::fs::write(dir.0.join("rec-5/meeting.json"), b"{ half").unwrap();
        std::fs::create_dir_all(dir.0.join("rec-6")).unwrap();
        std::fs::write(dir.0.join("rec-6/meeting.json"), b"[1]").unwrap();
        std::fs::create_dir_all(dir.0.join("bad name")).unwrap();
        std::fs::write(dir.0.join("bad name/meeting.json"), b"{}").unwrap();
        // A copied folder keeps its own name as the id.
        std::fs::create_dir_all(dir.0.join("rec-7")).unwrap();
        std::fs::write(dir.0.join("rec-7/meeting.json"), br#"{"id":"rec-1"}"#).unwrap();

        let list = list_in(&dir.0);
        let ids: Vec<_> = list.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["rec-2", "rec-1", "rec-3", "rec-7"]);
        assert_eq!(list[1]["title"], "改过的标题");
    }

    #[test]
    fn unsaved_recordings_are_found() {
        let dir = TempDir::new();
        let manifest = |id: &str, text: &str| {
            std::fs::create_dir_all(dir.0.join(id)).unwrap();
            std::fs::write(dir.0.join(id).join("manifest.json"), text).unwrap();
        };
        let segment = r#"{"index":1,"startMs":0,"endMs":60000,"mic":"mic-0001.wav"}"#;
        manifest("rec-1", &format!(r#"{{"startedAt":"2026-10-15T01:00:00Z","status":"stopped","durationMs":61000,"segments":[{segment}],"marks":[{{"atMs":500}}]}}"#));
        // Stopped halfway: no duration yet.
        manifest("rec-2", &format!(r#"{{"startedAt":"2026-10-15T02:00:00Z","status":"recording","durationMs":null,"segments":[{segment}]}}"#));
        // Not wanted: saved already, recording now, no audio (the microphone never opened), damaged.
        manifest("rec-3", &format!(r#"{{"startedAt":"2026-10-15T03:00:00Z","status":"stopped","segments":[{segment}]}}"#));
        std::fs::write(dir.0.join("rec-3/meeting.json"), b"{}").unwrap();
        manifest("rec-4", &format!(r#"{{"startedAt":"2026-10-15T04:00:00Z","status":"recording","segments":[{segment}]}}"#));
        manifest("rec-5", r#"{"startedAt":"2026-10-15T05:00:00Z","status":"stopped","durationMs":0,"segments":[]}"#);
        manifest("rec-6", "{ half");

        let mut found = unsaved_in(&dir.0, Some("rec-4"));
        found.sort_by_key(|r| r["id"].as_str().unwrap().to_string());
        assert_eq!(
            found,
            [
                json!({ "id": "rec-1", "startedAt": "2026-10-15T01:00:00Z", "durationMs": 61000, "marks": [500] }),
                json!({ "id": "rec-2", "startedAt": "2026-10-15T02:00:00Z", "durationMs": 60000, "marks": [] }),
            ]
        );
    }

    #[test]
    fn save_rejects_bad_ids() {
        let dir = TempDir::new();
        assert!(save_in(&dir.0, &json!({ "id": "../escape" })).is_err());
        assert!(save_in(&dir.0, &json!({ "id": ".." })).is_err());
        assert!(save_in(&dir.0, &json!({ "title": "no id" })).is_err());
        assert!(save_in(&dir.0, &json!("rec-1")).is_err());
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let path = dir.0.join("secret.json");
        write_private(&path, b"{}").unwrap();
        write_private(&path, b"{\"a\":1}").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"a\":1}");
    }
}
