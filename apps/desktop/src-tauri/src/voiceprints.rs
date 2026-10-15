//! Voiceprints, kept by the EchoMind server with each person's consent
//! (apps/server/src/voiceprints.ts, docs/voiceprints.md).
//!
//! A meeting's voices are worked out on this computer by the transcriber (transcribe.rs). They
//! go to the server only to ask who is speaking (the server compares and forgets them), or to
//! add to the voiceprint of someone who has agreed. The webview never sees them. While a
//! colleague has not answered their consent card, voice-pending.json notes which meeting and
//! speaker the sample comes from (no audio, no voiceprint); once they agree, the sample is
//! worked out again and sent, if the meeting still gives that speaker their name.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::server::{self, Failure};
use crate::{storage, transcribe};

const PENDING_FILE: &str = "voice-pending.json";
/// How long a sample waits for an answer to the consent card.
const PENDING_SECONDS: u64 = 30 * 24 * 3600;
/// The server keeps no shorter sample (MIN_SAMPLE_SECONDS there).
const MIN_SAMPLE_SECONDS: f64 = 5.0;
/// Voices with less speech than this are not worth asking about.
const MIN_MATCH_SECONDS: f64 = 3.0;
/// While the app runs, samples waiting for consent are tried this often.
const SEND_EVERY: Duration = Duration::from_secs(5 * 60);
/// Tells the page a sample went out in the background.
const CHANGED: &str = "voiceprints://changed";

/// A sample to send once its person agrees.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Pending {
    open_id: String,
    meeting_id: String,
    speaker_id: String,
    /// Who named the speaker. Open ids are per company app, so this is also the company: only
    /// that sign-in sends the sample, or decides it will never go.
    named_by: String,
    /// Unix seconds.
    since: u64,
}

/// One change to voice-pending.json at a time.
static PENDING: Mutex<()> = Mutex::const_new(());
/// One round of sending at a time, so no sample goes twice.
static SENDING: Mutex<()> = Mutex::const_new(());

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn pending_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(storage::data_dir(app)?.join(PENDING_FILE))
}

fn load_pending(app: &AppHandle) -> Vec<Pending> {
    pending_path(app).ok().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_pending(app: &AppHandle, pending: &[Pending]) {
    let Ok(path) = pending_path(app) else { return };
    if pending.is_empty() {
        let _ = std::fs::remove_file(path);
    } else if let Ok(text) = serde_json::to_vec(pending) {
        let _ = storage::write_atomic(&path, &text);
    }
}

async fn change_pending(app: &AppHandle, change: impl FnOnce(&mut Vec<Pending>)) {
    let _turn = PENDING.lock().await;
    let mut pending = load_pending(app);
    change(&mut pending);
    save_pending(app, &pending);
}

/// A colleague's id from the page, before it goes into a URL path.
fn open_id(id: &str) -> Result<&str, String> {
    let ok = id.len() <= 64 && id.starts_with("ou_") && id.len() > 3 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if ok {
        Ok(id)
    } else {
        Err("通讯录里没有这个人。".into())
    }
}

/// Everyone in the company with a voiceprint, or a consent card out.
async fn list(app: &AppHandle) -> Result<Vec<Value>, Failure> {
    let reply = server::call(app, Method::GET, "/v1/voiceprints", &[], None).await?;
    Ok(reply["voiceprints"].as_array().cloned().unwrap_or_default())
}

fn status_of<'a>(list: &'a [Value], open_id: &str) -> Option<&'a str> {
    list.iter().find(|v| v["openId"] == open_id).and_then(|v| v["status"].as_str())
}

/// One speaker's voice in a meeting.
async fn voice_of(app: &AppHandle, meeting_id: &str, speaker_id: &str) -> Result<Value, String> {
    transcribe::meeting_voices(app, meeting_id)
        .await?
        .into_iter()
        .find(|v| v["speakerId"] == speaker_id)
        .ok_or_else(|| "这位说话人在这场会里说得太少了，取不出声纹。".into())
}

async fn send_sample(app: &AppHandle, open_id: &str, voice: &Value) -> Result<Value, Failure> {
    let body = json!({ "vector": voice["vector"], "seconds": voice["seconds"] });
    server::call(app, Method::POST, &format!("/v1/voiceprints/{open_id}/samples"), &[], Some(&body)).await
}

/// Whether the meeting still gives the speaker that person's name. Named someone else since,
/// or the speakers worked out again (their names start over): not that person's voice.
fn still_named(meeting: &Value, speaker_id: &str, open_id: &str) -> bool {
    meeting["transcript"]["speakers"].as_array().into_iter().flatten().any(|s| s["id"] == speaker_id && s["personId"] == open_id)
}

/// Sends the samples named under the current sign-in whose people have agreed since, and drops
/// the ones that will never go. Other sign-ins' samples wait for theirs.
async fn send_pending(app: &AppHandle) {
    // A round already going sends whatever this one would.
    let Ok(_round) = SENDING.try_lock() else { return };
    let pending = {
        let _turn = PENDING.lock().await;
        load_pending(app)
    };
    let Some(me) = server::signed_in_open_id(app) else { return };
    if !pending.iter().any(|p| p.named_by == me) {
        return;
    }
    let Ok(list) = list(app).await else { return };
    // Sent, or never to be sent. Samples noted while this runs are left alone.
    let mut done = Vec::new();
    let mut sent = false;
    for p in pending {
        let fresh = p.since + PENDING_SECONDS > now();
        // Another sign-in's sample, or someone else signed in while this ran: left for that
        // sign-in, unless it is too old to matter.
        if p.named_by != me || server::signed_in_open_id(app).as_deref() != Some(me.as_str()) {
            if !fresh {
                done.push(p);
            }
            continue;
        }
        match status_of(&list, &p.open_id) {
            Some("agreed") => {
                let named = storage::read_meeting(app, &p.meeting_id).is_some_and(|m| still_named(&m, &p.speaker_id, &p.open_id));
                // A recording deleted since: nothing to send.
                let voice = if named { voice_of(app, &p.meeting_id, &p.speaker_id).await.ok() } else { None };
                if let Some(voice) = voice {
                    match send_sample(app, &p.open_id, &voice).await {
                        Ok(_) => sent = true,
                        // Tried again next round.
                        Err(failure) if failure.offline() => continue,
                        // A refusal: the voice is someone else's, or they took their consent back.
                        Err(failure) => eprintln!("[voiceprints] sample for a colleague not kept: {}", String::from(failure)),
                    }
                }
                done.push(p);
            }
            Some("asked") if fresh => {}
            // Declined, deleted, or never answered.
            _ => done.push(p),
        }
    }
    if !done.is_empty() {
        change_pending(app, |pending| pending.retain(|p| !done.contains(p))).await;
    }
    if sent {
        let _ = app.emit(CHANGED, ());
    }
}

/// Started with the app: a sample goes out within minutes of its person agreeing, whether or
/// not anyone opens 「人员与声纹」.
pub fn start_sending(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SEND_EVERY).await;
            send_pending(&app).await;
        }
    });
}

/// Everyone in the company with a voiceprint or a consent card out. Samples waiting for
/// consent go out in the background.
#[tauri::command]
pub async fn voiceprints_list(app: AppHandle) -> Result<Value, String> {
    let voiceprints = list(&app).await?;
    let background = app.clone();
    tauri::async_runtime::spawn(async move { send_pending(&background).await });
    Ok(Value::Array(voiceprints))
}

/// Sends a colleague the consent card. `meeting` names where their voice was heard.
#[tauri::command]
pub async fn voiceprint_ask(app: AppHandle, open_id: String, meeting: Option<String>) -> Result<Value, String> {
    let path = format!("/v1/voiceprints/{}/ask", self::open_id(&open_id)?);
    Ok(server::call(&app, Method::POST, &path, &[], Some(&json!({ "meeting": meeting }))).await?)
}

/// Deletes a voiceprint and the consent behind it.
#[tauri::command]
pub async fn voiceprint_delete(app: AppHandle, open_id: String) -> Result<(), String> {
    let path = format!("/v1/voiceprints/{}", self::open_id(&open_id)?);
    server::call(&app, Method::DELETE, &path, &[], None).await?;
    change_pending(&app, |pending| pending.retain(|p| p.open_id != open_id)).await;
    Ok(())
}

/// After a speaker was named `open_id` with 「记住声音」 ticked. `status` says what happened:
/// `saved` (added to their voiceprint; naming yourself is your consent), `asked` (consent card
/// sent, the sample waits here), `waiting` (a card went out earlier; the sample waits too), or
/// `declined` (they said no, nothing kept).
#[tauri::command]
pub async fn voiceprint_remember(
    app: AppHandle,
    meeting_id: String,
    speaker_id: String,
    open_id: String,
    meeting_title: Option<String>,
) -> Result<Value, String> {
    let open_id = self::open_id(&open_id)?.to_string();
    let me = server::signed_in_open_id(&app).ok_or("请先用飞书登录。")?;
    let list = list(&app).await?;
    let status = if open_id == me { Some("agreed") } else { status_of(&list, &open_id) };
    if status == Some("declined") {
        return Ok(json!({ "status": "declined" }));
    }
    // Worked out before asking: a voice too short to keep should not cost anyone a card.
    let voice = voice_of(&app, &meeting_id, &speaker_id).await?;
    if voice["seconds"].as_f64().unwrap_or(0.0) < MIN_SAMPLE_SECONDS {
        return Err(format!("这位说话人在这场会里说得太少了（不到 {MIN_SAMPLE_SECONDS} 秒），记不住声音。"));
    }
    if status == Some("agreed") {
        let voiceprint = send_sample(&app, &open_id, &voice).await?;
        return Ok(json!({ "status": "saved", "voiceprint": voiceprint }));
    }

    // The card before the note: a round of sending in between would drop a note whose card is
    // not out yet as never answered.
    let path = format!("/v1/voiceprints/{open_id}/ask");
    let outcome = match server::call(&app, Method::POST, &path, &[], Some(&json!({ "meeting": meeting_title }))).await {
        // They answered while this ran.
        Ok(voiceprint) if voiceprint["status"] == "agreed" => {
            let voiceprint = send_sample(&app, &open_id, &voice).await?;
            return Ok(json!({ "status": "saved", "voiceprint": voiceprint }));
        }
        Ok(voiceprint) if voiceprint["status"] == "declined" => return Ok(json!({ "status": "declined" })),
        Ok(voiceprint) => json!({ "status": "asked", "voiceprint": voiceprint }),
        Err(Failure::Refused { code, .. }) if code == "asked_recently" => json!({ "status": "waiting" }),
        Err(failure) => return Err(failure.into()),
    };
    let waiting = Pending { open_id, meeting_id, speaker_id, named_by: me, since: now() };
    change_pending(&app, move |list| {
        // The newest sample of a person replaces an older one.
        list.retain(|p| p.open_id != waiting.open_id);
        list.push(waiting);
    })
    .await;
    Ok(outcome)
}

/// Who the voices of a transcribed meeting belong to: `[{speakerId, openId, score}]`. Without
/// any voiceprint in the company the voices are not even worked out.
#[tauri::command]
pub async fn voices_match(app: AppHandle, meeting_id: String) -> Result<Value, String> {
    if !list(&app).await?.iter().any(|v| v["enrolled"] == true) {
        return Ok(json!([]));
    }
    let voices: Vec<Value> = transcribe::meeting_voices(&app, &meeting_id)
        .await?
        .into_iter()
        .filter(|v| v["seconds"].as_f64().unwrap_or(0.0) >= MIN_MATCH_SECONDS)
        .collect();
    if voices.is_empty() {
        return Ok(json!([]));
    }
    let reply = server::call(&app, Method::POST, "/v1/voiceprints/match", &[], Some(&json!({ "voices": voices }))).await?;
    Ok(reply["matches"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_open_ids_go_into_paths() {
        assert_eq!(open_id("ou_7d8a6e6df7621556ce0d21922b676706"), Ok("ou_7d8a6e6df7621556ce0d21922b676706"));
        for bad in ["", "ou_", "../me", "ou_a/b", "p-wang", &format!("ou_{}", "a".repeat(70))] {
            assert!(open_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_sample_goes_only_while_its_speaker_keeps_the_name() {
        let meeting = json!({ "transcript": { "speakers": [
            { "id": "S1", "personId": "ou_me" },
            { "id": "S2", "personId": "ou_b" },
            { "id": "S3", "personId": null },
        ] } });
        assert!(still_named(&meeting, "S2", "ou_b"));
        // S2 was named ou_a when the card went out, and renamed ou_b since.
        assert!(!still_named(&meeting, "S2", "ou_a"));
        // Speakers worked out again: names start over.
        assert!(!still_named(&meeting, "S3", "ou_a"));
        assert!(!still_named(&meeting, "S9", "ou_a"));
        assert!(!still_named(&json!({}), "S2", "ou_b"));
    }
}
