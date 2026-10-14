use std::io::{self, Write};
use std::sync::Mutex;

use serde_json::{json, Value};

pub trait EventSink {
    fn emit(&self, event: Value);

    fn error(&self, code: &str, message: &str) {
        self.emit(json!({ "type": "error", "code": code, "message": message }));
        eprintln!("[echomind-capture] 错误 {code}：{message}");
    }
}

pub struct StdoutSink;

impl EventSink for StdoutSink {
    fn emit(&self, event: Value) {
        let mut out = io::stdout().lock();
        let _ = writeln!(out, "{event}");
        let _ = out.flush();
    }
}

#[derive(Default)]
pub struct MemorySink {
    events: Mutex<Vec<Value>>,
}

impl MemorySink {
    pub fn events(&self) -> Vec<Value> {
        self.events.lock().unwrap().clone()
    }
}

impl EventSink for MemorySink {
    fn emit(&self, event: Value) {
        self.events.lock().unwrap().push(event);
    }
}

pub fn rounded(value: f64) -> Value {
    json!((value * 10.0).round() / 10.0)
}
