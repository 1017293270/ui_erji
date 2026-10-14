use std::fmt;

use serde::Serialize;

/// What went wrong, for callers that react differently (offer the model download,
/// stay quiet after a cancel). The message is always a Chinese sentence for the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Cancelled,
    /// Models are missing or damaged: download them first.
    ModelsMissing,
    /// Download failed (network, mirror, checksum).
    Download,
    /// The recording folder is missing, unreadable or empty.
    Recording,
    /// sherpa-onnx refused a model or failed while running it.
    Engine,
    Io,
}

#[derive(Debug, Clone)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    pub(crate) fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }

    pub(crate) fn cancelled() -> Self {
        Self::new(ErrorKind::Cancelled, "已取消。")
    }

    pub(crate) fn io(what: impl fmt::Display, err: std::io::Error) -> Self {
        let hint = match err.kind() {
            std::io::ErrorKind::PermissionDenied => "没有权限，请检查文件夹权限",
            std::io::ErrorKind::NotFound => "文件不存在",
            std::io::ErrorKind::StorageFull => "磁盘空间不足，请清理后重试",
            _ => "请重试",
        };
        Self::new(ErrorKind::Io, format!("{what}失败（{err}）：{hint}。"))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<Error> for String {
    fn from(e: Error) -> Self {
        e.message
    }
}

pub type Result<T> = std::result::Result<T, Error>;
