//! The transcriber as a command: for trying it by hand, and as a sidecar the app can
//! run so that a crash inside onnxruntime cannot take the app down with it.
//!
//!   echomind-transcribe models   [--models-dir DIR]
//!   echomind-transcribe download [--models-dir DIR] [--json]
//!   echomind-transcribe run <recording_dir> [--scene in-person|online] [--speakers N] [--out transcript.json]
//!                           [--models-dir DIR] [--json]
//!   echomind-transcribe voices <recording_dir> [--transcript transcript.json] [--models-dir DIR] [--json]
//!
//! Without --json, results go to stdout (or --out) and progress to stderr for people.
//! With --json, stdout carries one JSON object per line (`progress`, `download`, then
//! `done` or `error`), and a `cancel` line or EOF on stdin stops the work, like
//! echomind-capture: the parent must keep stdin open.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use echomind_transcriber::{download_models, model_status, transcribe, voices, Error, ErrorKind, Hints, Scene, Transcript};
use serde_json::{json, Value};

const USAGE: &str = "用法：
  echomind-transcribe models   [--models-dir DIR]
  echomind-transcribe download [--models-dir DIR] [--json]
  echomind-transcribe run <录音文件夹> [--scene in-person|online] [--speakers N] [--out transcript.json]
                         [--models-dir DIR] [--json]
  echomind-transcribe voices <录音文件夹> [--transcript transcript.json] [--models-dir DIR] [--json]

--scene：in-person 是面对面开会，麦克风录到的每个人都按声音区分；online 是线上会议，麦克风只算你本人。
--speakers：有几个人说话。面对面时是现场所有人（包括你），线上时是对方（不包括你）。
这两项不写就根据录音自动判断。
voices：按转写结果给每个说话人算一份声纹（不写入文件），--transcript 默认是录音文件夹里的 transcript.json。
模型目录默认是应用数据目录下的 models/，也可以用环境变量 ECHOMIND_MODELS_DIR 指定。
ECHOMIND_MODEL_MIRROR 可以把下载地址换成镜像（替换 https://github.com/k2-fsa/sherpa-onnx/releases/download）。
--json：stdout 每行一个 JSON 事件；stdin 收到 cancel 或 EOF 时停止。";

/// Same folder the app uses: Tauri's app_data_dir for com.evanbyte.echomind.
fn default_models_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ECHOMIND_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let base = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default()
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"))
    };
    base.join("com.evanbyte.echomind").join("models")
}

fn emit(event: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut positional = Vec::new();
    let mut models_dir = None;
    let mut out = None;
    let mut transcript_path = None;
    let mut hints = Hints::default();
    let mut machine = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--models-dir" => models_dir = it.next().map(PathBuf::from),
            "--out" => out = it.next().map(PathBuf::from),
            "--transcript" => transcript_path = it.next().map(PathBuf::from),
            "--scene" => match it.next().and_then(|s| Scene::parse(s)) {
                Some(s) => hints.scene = Some(s),
                None => {
                    eprintln!("--scene 只能是 in-person 或 online\n\n{USAGE}");
                    return ExitCode::from(2);
                }
            },
            "--speakers" => match it.next().and_then(|n| n.parse().ok()).filter(|n| (1..=20).contains(n)) {
                Some(n) => hints.people = Some(n),
                None => {
                    eprintln!("--speakers 是 1 到 20 之间的人数\n\n{USAGE}");
                    return ExitCode::from(2);
                }
            },
            "--json" => machine = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            _ => positional.push(arg.clone()),
        }
    }
    let models_dir = models_dir.unwrap_or_else(default_models_dir);

    let cancel = Arc::new(AtomicBool::new(false));
    if machine {
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                match line {
                    Ok(l) if l.trim().eq_ignore_ascii_case("cancel") => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            cancel.store(true, Ordering::SeqCst);
        });
    } else {
        install_ctrl_c(cancel.clone());
    }

    let result = match positional.first().map(String::as_str) {
        Some("models") => {
            println!("{}", serde_json::to_string_pretty(&model_status(&models_dir)).unwrap());
            Ok(())
        }
        Some("download") => download(&models_dir, &cancel, machine),
        Some("run") if positional.len() == 2 => run(Path::new(&positional[1]), &models_dir, hints, out, &cancel, machine),
        Some("voices") if positional.len() == 2 => {
            let dir = Path::new(&positional[1]);
            print_voices(dir, &transcript_path.unwrap_or_else(|| dir.join("transcript.json")), &models_dir, &cancel, machine)
        }
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            if machine {
                emit(json!({ "type": "error", "kind": e.kind, "message": e.message }));
            } else {
                eprintln!("\n错误：{e}");
            }
            ExitCode::FAILURE
        }
    }
}

fn download(models_dir: &Path, cancel: &AtomicBool, machine: bool) -> Result<(), Error> {
    if !machine {
        eprintln!("模型目录：{}", models_dir.display());
    }
    let started = Instant::now();
    let mut last = u64::MAX;
    download_models(models_dir, cancel, |received, total| {
        let percent = if total == 0 { 100 } else { received * 100 / total };
        if percent == last && received != total {
            return;
        }
        last = percent;
        if machine {
            emit(json!({ "type": "download", "received": received, "total": total }));
        } else {
            eprint!("\r下载 {:.1} / {:.1} MB（{percent}%）", received as f64 / 1e6, total as f64 / 1e6);
            let _ = std::io::stderr().flush();
        }
    })?;
    let status = model_status(models_dir);
    if machine {
        emit(json!({ "type": "done", "status": status }));
    } else {
        eprintln!("\n完成，用时 {:.0} 秒", started.elapsed().as_secs_f64());
        println!("{}", serde_json::to_string_pretty(&status).unwrap());
    }
    Ok(())
}

fn run(
    dir: &Path,
    models_dir: &Path,
    hints: Hints,
    out: Option<PathBuf>,
    cancel: &AtomicBool,
    machine: bool,
) -> Result<(), Error> {
    let started = Instant::now();
    let mut stage_started = Instant::now();
    let mut current = None;
    let mut last_report = Instant::now();
    let transcript = transcribe(dir, models_dir, hints, cancel, |stage, progress| {
        let changed = current != Some(stage);
        if changed && !machine {
            if let Some(prev) = current {
                eprintln!("\r{:<9} 100%  {:.1} s", prev.as_str(), stage_started.elapsed().as_secs_f64());
            }
            stage_started = Instant::now();
        }
        current = Some(stage);
        if !changed && progress < 1.0 && last_report.elapsed().as_millis() < 200 {
            return;
        }
        last_report = Instant::now();
        if machine {
            emit(json!({ "type": "progress", "stage": stage, "progress": progress }));
        } else {
            eprint!("\r{:<9} {:>3.0}%", stage.as_str(), progress * 100.0);
            let _ = std::io::stderr().flush();
        }
    })?;

    if let Some(path) = &out {
        let json = serde_json::to_string_pretty(&transcript).unwrap() + "\n";
        std::fs::write(path, json)
            .map_err(|e| Error { kind: ErrorKind::Io, message: format!("写入 {} 失败：{e}", path.display()) })?;
    }
    if machine {
        emit(json!({ "type": "done", "transcript": transcript }));
        return Ok(());
    }

    if let Some(prev) = current {
        eprintln!("\r{:<9} 100%  {:.1} s", prev.as_str(), stage_started.elapsed().as_secs_f64());
    }
    let elapsed = started.elapsed().as_secs_f64();
    // The recording's length as the capture wrote it (pauses included).
    let manifest: Value =
        std::fs::read(dir.join("manifest.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let audio = manifest["durationMs"].as_u64().or_else(|| transcript.segments.iter().map(|s| s.end).max()).unwrap_or(0)
        as f64
        / 1000.0;
    eprintln!(
        "{}，{} 段，{} 位说话人，用时 {elapsed:.1} s，录音 {audio:.1} s，RTF {:.3}",
        if transcript.scene == Scene::InPerson { "面对面" } else { "线上" },
        transcript.segments.len(),
        transcript.speakers.len(),
        if audio > 0.0 { elapsed / audio } else { 0.0 }
    );
    if out.is_none() {
        println!("{}", serde_json::to_string_pretty(&transcript).unwrap());
    }
    Ok(())
}

/// The first Ctrl-C sets the cancel flag, so the library's cancel path can be tried by
/// hand; a second one exits. On other platforms Ctrl-C just ends the process.
fn install_ctrl_c(cancel: Arc<AtomicBool>) {
    #[cfg(unix)]
    {
        static FLAG: std::sync::OnceLock<Arc<AtomicBool>> = std::sync::OnceLock::new();
        extern "C" {
            fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
            fn _exit(code: i32) -> !;
        }
        extern "C" fn on_sigint(_: i32) {
            if let Some(flag) = FLAG.get() {
                if flag.swap(true, Ordering::SeqCst) {
                    unsafe { _exit(130) }
                }
            }
        }
        let _ = FLAG.set(cancel);
        unsafe {
            signal(2, on_sigint);
        }
    }
    #[cfg(not(unix))]
    let _ = cancel;
}

fn print_voices(dir: &Path, transcript: &Path, models_dir: &Path, cancel: &AtomicBool, machine: bool) -> Result<(), Error> {
    let unreadable = || Error { kind: ErrorKind::Recording, message: "读不到这场会议的转写结果：请重新转写这场会议。".into() };
    let bytes = std::fs::read(transcript).map_err(|_| unreadable())?;
    let transcript: Transcript = serde_json::from_slice(&bytes).map_err(|_| unreadable())?;
    let voices = voices(dir, &transcript, models_dir, cancel)?;
    if machine {
        emit(json!({ "type": "done", "voices": voices }));
    } else {
        for v in &voices {
            eprintln!("{}  {:.1} s", v.speaker_id, v.seconds);
        }
        println!("{}", serde_json::to_string(&voices).unwrap());
    }
    Ok(())
}
