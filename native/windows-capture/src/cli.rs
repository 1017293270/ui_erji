use std::path::{Component, Path, PathBuf};

use crate::session::RecordOptions;

pub const USAGE: &str = "echomind-capture — EchoMind 的 Windows 音频采集 sidecar\n\n用法:\n  echomind-capture record --out <dir> [--segment-seconds 60] [--sample-rate 16000]\n                          [--mic-device <id>] [--no-system] [--no-mic]\n      stdout: JSON Lines 事件；stdin 指令: pause | resume | mark | stop\n  echomind-capture devices\n  echomind-capture meetings [--verbose]\n  echomind-capture permissions [--request-mic]\n  echomind-capture selftest --out <dir>\n";

pub enum Command {
    Record(RecordOptions), Devices, Meetings(bool), Permissions(bool), Selftest(PathBuf), Help,
}

struct Arguments { items: Vec<String> }

impl Arguments {
    fn new(args: &[String]) -> Self {
        let mut items = Vec::new();
        for arg in args {
            if let Some((flag, value)) = arg.split_once('=').filter(|_| arg.starts_with("--")) {
                items.extend([flag.to_owned(), value.to_owned()]);
            } else { items.push(arg.clone()); }
        }
        Self { items }
    }

    fn flag(&mut self, name: &str) -> bool {
        if let Some(i) = self.items.iter().position(|s| s == name) {
            self.items.remove(i);
            true
        } else { false }
    }

    fn value(&mut self, name: &str) -> Result<Option<String>, String> {
        let Some(i) = self.items.iter().position(|s| s == name) else { return Ok(None); };
        if i + 1 == self.items.len() || self.items[i + 1].starts_with("--") {
            return Err(format!("参数错误：{name} 需要一个值"));
        }
        let value = self.items.remove(i + 1);
        self.items.remove(i);
        Ok(Some(value))
    }

    fn int(&mut self, name: &str, min: u32, max: u32) -> Result<Option<u32>, String> {
        let Some(raw) = self.value(name)? else { return Ok(None); };
        match raw.parse::<u32>() {
            Ok(n) if (min..=max).contains(&n) => Ok(Some(n)),
            _ => Err(format!("参数错误：{name} 必须是 {min}…{max} 之间的整数，收到 {raw}")),
        }
    }

    fn finish(&self) -> Result<(), String> {
        match self.items.first() {
            Some(unknown) => Err(format!("参数错误：未知参数 {unknown}")), None => Ok(()),
        }
    }
}

pub fn parse(argv: &[String]) -> Result<Command, String> {
    let command = &argv[0];
    let mut args = Arguments::new(&argv[1..]);
    let result = match command.as_str() {
        "record" => {
            if args.items.iter().any(|s| s == "--system-pids") {
                return Err("Windows 版暂不支持 --system-pids。".into());
            }
            let out = args.value("--out")?.ok_or("参数错误：缺少 --out <dir>")?;
            Command::Record(RecordOptions {
                out_dir: absolute_path(&out)?,
                segment_seconds: args.int("--segment-seconds", 1, 3600)?.unwrap_or(60),
                sample_rate: args.int("--sample-rate", 8000, 48000)?.unwrap_or(16000),
                mic_device: args.value("--mic-device")?,
                mic: !args.flag("--no-mic"), system: !args.flag("--no-system"),
            })
        }
        "devices" => Command::Devices,
        "meetings" => Command::Meetings(args.flag("--verbose")),
        "permissions" => Command::Permissions(args.flag("--request-mic")),
        "selftest" => {
            let out = args.value("--out")?.ok_or("参数错误：缺少 --out <dir>")?;
            Command::Selftest(absolute_path(&out)?)
        }
        "help" | "--help" | "-h" => return Ok(Command::Help),
        _ => return Err(format!("参数错误：未知子命令 {command}")),
    };
    args.finish()?;
    Ok(result)
}

fn absolute_path(raw: &str) -> Result<PathBuf, String> {
    let path = if raw == "~" || raw.starts_with("~/") {
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        std::env::var_os(key).map(|base| PathBuf::from(base).join(raw.strip_prefix("~/").unwrap_or("")))
            .unwrap_or_else(|| PathBuf::from(raw))
    } else { PathBuf::from(raw) };
    let absolute = if path.is_absolute() { path } else {
        std::env::current_dir().map_err(|e| format!("参数错误：无法读取当前目录：{e}"))?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in Path::new(&absolute).components() {
        match component {
            Component::CurDir => {}, Component::ParentDir => { normalized.pop(); },
            _ => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized)
}
