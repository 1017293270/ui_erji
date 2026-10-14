#[cfg_attr(not(windows), allow(dead_code))]
mod backend;
mod cli;
mod clock;
mod events;
mod levels;
mod manifest;
mod mix;
mod null_backend;
mod recorder;
mod resampler;
mod selftest;
mod session;
mod timeline;
mod wav;
#[cfg(windows)]
mod wasapi;

use std::process::ExitCode;

use cli::Command;
use events::{EventSink, StdoutSink};

fn main() -> ExitCode {
    let argv: Vec<_> = std::env::args().skip(1).collect();
    if argv.is_empty() { eprint!("{}", cli::USAGE); return ExitCode::from(2); }
    let command = match cli::parse(&argv) {
        Ok(command) => command,
        Err(message) => {
            StdoutSink.error("invalid_arguments", &message);
            eprint!("{}", cli::USAGE);
            return ExitCode::from(2);
        }
    };
    let code = match command {
        Command::Help => { print!("{}", cli::USAGE); 0 }
        Command::Selftest(out) => selftest::run(&out, &StdoutSink),
        Command::Record(options) => {
            if !options.mic && !options.system {
                session::run(options, null_backend::NullBackend, clock::MonotonicClock::new(), &StdoutSink)
            } else {
                #[cfg(windows)]
                { session::run(options, wasapi::WasapiBackend::new(), wasapi::QpcClock::new(), &StdoutSink) }
                #[cfg(not(windows))]
                { unsupported_platform() }
            }
        }
        #[cfg(windows)]
        Command::Devices => query(wasapi::devices()),
        #[cfg(windows)]
        Command::Meetings(verbose) => query(wasapi::meetings(verbose)),
        #[cfg(windows)]
        Command::Permissions(request_mic) => { StdoutSink.emit(wasapi::permissions(request_mic)); 0 }
        #[cfg(not(windows))]
        Command::Devices => unsupported_platform(),
        #[cfg(not(windows))]
        Command::Meetings(verbose) | Command::Permissions(verbose) => { let _ = verbose; unsupported_platform() }
    };
    ExitCode::from(code)
}

#[cfg(not(windows))]
fn unsupported_platform() -> u8 {
    StdoutSink.error("unsupported_platform", "当前平台不支持 Windows 音频采集；空跑请使用 --no-mic --no-system。");
    2
}

#[cfg(windows)]
fn query(result: Result<serde_json::Value, (&'static str, String)>) -> u8 {
    match result {
        Ok(value) => { StdoutSink.emit(value); 0 }
        Err((code, message)) => { StdoutSink.error(code, &message); 1 }
    }
}
