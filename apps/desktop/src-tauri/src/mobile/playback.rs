//! The recording player on the phone. Android's WebView takes whatever a custom scheme hands
//! back as the whole file and applies the Range header to it itself, so `echomind-audio:`
//! (playback.rs) cannot serve a recording the player seeks in. Here the player streams it
//! from a small HTTP server on 127.0.0.1 instead, answered by playback.rs all the same. Other
//! apps on the phone can reach 127.0.0.1 too, so every path starts with a random token that
//! only this app's page is given, and the server answers a few connections at a time, each
//! within a time limit, so another app cannot tie it up.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::http::{header, Request};
use tauri::AppHandle;

use crate::{playback, storage};

/// `http://127.0.0.1:<port>/<token>`, once the server is up.
static BASE: Mutex<Option<String>> = Mutex::new(None);

/// Connections being answered. The player needs two or three at once; more are dropped.
static OPEN: AtomicUsize = AtomicUsize::new(0);
const MAX_OPEN: usize = 8;
/// For the request head, and for each write of the answer.
const TIME_LIMIT: Duration = Duration::from_secs(10);

/// Where the player finds a meeting's recording: `http://127.0.0.1:<port>/<token>/<meetingId>`.
#[tauri::command]
pub fn playback_url(app: AppHandle, meeting_id: String) -> Result<String, String> {
    if !storage::valid_id(&meeting_id) {
        return Err(format!("会议编号「{meeting_id}」不合法。"));
    }
    let mut base = BASE.lock().unwrap();
    if base.is_none() {
        *base = Some(start(app).map_err(|e| format!("无法准备录音播放：{e}"))?);
    }
    Ok(format!("{}/{meeting_id}", base.as_ref().unwrap()))
}

fn start(app: AppHandle) -> std::io::Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let prefix = format!("/{token}/");
    std::thread::Builder::new().name("playback".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            if OPEN.fetch_add(1, Ordering::SeqCst) >= MAX_OPEN {
                OPEN.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let (app, prefix) = (app.clone(), prefix.clone());
            let spawned = std::thread::Builder::new().spawn(move || {
                let _ = answer(&app, &prefix, stream);
                OPEN.fetch_sub(1, Ordering::SeqCst);
            });
            if spawned.is_err() {
                OPEN.fetch_sub(1, Ordering::SeqCst);
            }
        }
    })?;
    Ok(format!("http://127.0.0.1:{port}/{token}"))
}

/// One request per connection: the player opens a new one for each range it wants.
fn answer(app: &AppHandle, prefix: &str, stream: TcpStream) -> std::io::Result<()> {
    let deadline = Instant::now() + TIME_LIMIT;
    stream.set_read_timeout(Some(TIME_LIMIT))?;
    stream.set_write_timeout(Some(TIME_LIMIT))?;
    let mut head = BufReader::new(stream.try_clone()?.take(16 * 1024));
    let mut line = String::new();
    head.read_line(&mut line)?;
    let mut words = line.split_whitespace();
    let (method, path) = (words.next().unwrap_or_default(), words.next().unwrap_or_default());
    let mut range = None;
    loop {
        if Instant::now() > deadline {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        let mut field = String::new();
        if head.read_line(&mut field)? == 0 || field.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = field.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            }
        }
    }

    let request = path.strip_prefix(prefix).filter(|_| method == "GET" || method == "HEAD").and_then(|id| {
        let mut request = Request::builder().uri(format!("/{id}"));
        if let Some(range) = &range {
            request = request.header(header::RANGE, range);
        }
        request.body(Vec::new()).ok()
    });
    let response = match request {
        Some(request) => playback::serve(app, &request),
        None => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
    };

    let mut out = stream;
    let status = response.status();
    write!(out, "HTTP/1.1 {} {}\r\n", status.as_u16(), status.canonical_reason().unwrap_or("OK"))?;
    for (name, value) in response.headers() {
        write!(out, "{name}: ")?;
        out.write_all(value.as_bytes())?;
        out.write_all(b"\r\n")?;
    }
    if !response.headers().contains_key(header::CONTENT_LENGTH) {
        write!(out, "content-length: {}\r\n", response.body().len())?;
    }
    out.write_all(b"connection: close\r\n\r\n")?;
    if method != "HEAD" {
        out.write_all(response.body())?;
    }
    out.flush()
}
