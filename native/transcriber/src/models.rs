//! The four models, pinned by sha256, and their download into `models_dir`.
//!
//! Layout: `models_dir/<id>/` holds the files the engine needs plus `.ready`: the
//! sha256 of the archive it came from, then the sha256 of each file taken out of it.
//! A model is ready when the first line matches the pinned hash, so changing a pin
//! here makes the app fetch it again. Before a transcription the files are hashed
//! again: onnxruntime aborts the whole process on a damaged model instead of
//! returning an error. Downloads go to `models_dir/.downloads/<file>.part` and
//! resume after a failure.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{Error, ErrorKind, Result};

const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
/// Base URL that replaces `RELEASES`, for a mirror reachable from mainland China.
/// It must serve the same `<tag>/<file>` paths; the sha256 pins still apply.
pub const MIRROR_ENV: &str = "ECHOMIND_MODEL_MIRROR";

pub(crate) struct Spec {
    pub id: &'static str,
    name: &'static str,
    release: &'static str,
    file: &'static str,
    bytes: u64,
    sha256: &'static str,
    /// Files kept from a .tar.bz2 (matched by file name, flattened into the model folder).
    /// Empty for a plain file, which is kept as is.
    keep: &'static [&'static str],
}

pub(crate) const ASR: Spec = Spec {
    id: "asr",
    name: "语音识别 SenseVoice-Small",
    release: "asr-models",
    file: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
    bytes: 163_002_883,
    sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
    keep: &["model.int8.onnx", "tokens.txt", "LICENSE", "README.md"],
};

pub(crate) const VAD: Spec = Spec {
    id: "vad",
    name: "人声检测 Silero VAD",
    release: "asr-models",
    file: "silero_vad.onnx",
    bytes: 643_854,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    keep: &[],
};

pub(crate) const SEGMENTATION: Spec = Spec {
    id: "segmentation",
    name: "说话人分段 pyannote-segmentation-3.0",
    release: "speaker-segmentation-models",
    file: "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    bytes: 6_958_444,
    sha256: "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
    keep: &["model.onnx", "LICENSE", "README.md"],
};

pub(crate) const EMBEDDING: Spec = Spec {
    id: "embedding",
    name: "声纹 3D-Speaker CAM++（中文）",
    // Sic: the tag is misspelled upstream.
    release: "speaker-recongition-models",
    file: "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
    bytes: 28_281_138,
    sha256: "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11",
    keep: &[],
};

pub(crate) const ALL: [&Spec; 4] = [&ASR, &VAD, &SEGMENTATION, &EMBEDDING];

impl Spec {
    fn dir(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(self.id)
    }

    /// The downloaded file itself, for models that are a single file.
    pub fn file_name(&self) -> &'static str {
        self.file
    }

    /// The file the engine loads.
    pub fn path(&self, models_dir: &Path, name: &str) -> String {
        self.dir(models_dir).join(name).to_string_lossy().into_owned()
    }

    fn required(&self) -> Vec<&'static str> {
        if self.keep.is_empty() {
            vec![self.file]
        } else {
            // LICENSE/README are kept for attribution but not needed to run.
            self.keep.iter().copied().filter(|f| f.ends_with(".onnx") || f.ends_with(".txt")).collect()
        }
    }

    fn is_ready(&self, models_dir: &Path) -> bool {
        let dir = self.dir(models_dir);
        let stamp = fs::read_to_string(dir.join(".ready")).unwrap_or_default();
        stamp.lines().next() == Some(self.sha256)
            && self.required().iter().all(|f| fs::metadata(dir.join(f)).map(|m| m.len() > 0).unwrap_or(false))
    }

    /// Re-hashes the installed files against what `.ready` recorded at install time.
    /// A damaged model loses `.ready`, so the status shows it and the next download replaces it.
    fn verify(&self, models_dir: &Path) -> bool {
        let dir = self.dir(models_dir);
        let stamp = fs::read_to_string(dir.join(".ready")).unwrap_or_default();
        let recorded: Vec<(&str, &str)> = stamp.lines().skip(1).filter_map(|l| l.split_once("  ")).collect();
        let intact = self.required().iter().all(|f| {
            recorded.iter().any(|(hash, name)| name == f && sha256_file(&dir.join(f)).is_ok_and(|h| h == *hash))
        });
        if !intact {
            let _ = fs::remove_file(dir.join(".ready"));
        }
        intact
    }

    fn part_path(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(".downloads").join(format!("{}.part", self.file))
    }

    fn url(&self) -> String {
        let base = std::env::var(MIRROR_ENV).ok().filter(|v| !v.trim().is_empty());
        let base = base.as_deref().unwrap_or(RELEASES).trim().trim_end_matches('/');
        format!("{base}/{}/{}", self.release, self.file)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    /// Download size.
    pub bytes: u64,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub ready: bool,
    /// What is left to download, net of partial downloads that will resume.
    pub download_bytes: u64,
    pub models: Vec<ModelInfo>,
}

pub fn model_status(models_dir: &Path) -> ModelStatus {
    let mut download_bytes = 0;
    let models: Vec<ModelInfo> = ALL
        .iter()
        .map(|spec| {
            let ready = spec.is_ready(models_dir);
            if !ready {
                let partial = fs::metadata(spec.part_path(models_dir)).map(|m| m.len()).unwrap_or(0);
                download_bytes += spec.bytes.saturating_sub(partial.min(spec.bytes));
            }
            ModelInfo { id: spec.id.into(), name: spec.name.into(), bytes: spec.bytes, ready }
        })
        .collect();
    ModelStatus { ready: models.iter().all(|m| m.ready), download_bytes, models }
}

/// All models present and intact (hashes about 270 MB, a fraction of a second).
pub(crate) fn ensure_ready(models_dir: &Path) -> Result<()> {
    ensure(models_dir, &ALL)
}

/// These models present and intact. Every one given is checked, so one download replaces all
/// the damaged ones.
pub(crate) fn ensure(models_dir: &Path, specs: &[&Spec]) -> Result<()> {
    if !specs.iter().all(|spec| spec.is_ready(models_dir)) {
        let mb = model_status(models_dir).download_bytes.div_ceil(1_000_000);
        return Err(Error::new(
            ErrorKind::ModelsMissing,
            format!("转写模型还没有下载完成：请先下载语音模型（约 {mb} MB），再开始转写。"),
        ));
    }
    let damaged: Vec<&str> = specs.iter().filter(|spec| !spec.verify(models_dir)).map(|spec| spec.name).collect();
    if damaged.is_empty() {
        return Ok(());
    }
    Err(Error::new(
        ErrorKind::ModelsMissing,
        format!("语音模型文件已损坏（{}）：请重新下载语音模型后再转写。", damaged.join("、")),
    ))
}

/// Downloads, verifies and unpacks every model that is not ready yet.
/// `on_progress(received, total)` counts bytes across all of them.
pub fn download_models(models_dir: &Path, cancel: &AtomicBool, mut on_progress: impl FnMut(u64, u64)) -> Result<()> {
    let pending: Vec<&Spec> = ALL.iter().copied().filter(|s| !s.is_ready(models_dir)).collect();
    let total: u64 = pending.iter().map(|s| s.bytes).sum();
    on_progress(0, total);
    if pending.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(models_dir.join(".downloads")).map_err(|e| Error::io("创建模型目录", e))?;

    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("EchoMind/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        // In the blocking client this bounds each read, not the whole body, so a slow
        // line can take as long as it needs while a stalled one still fails.
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| Error::new(ErrorKind::Download, format!("无法初始化下载：{e}")))?;

    let mut done = 0u64;
    for spec in pending {
        let archive = fetch(&client, spec, models_dir, cancel, &mut |received| on_progress(done + received, total))?;
        install(spec, &archive, models_dir)?;
        let _ = fs::remove_file(&archive);
        done += spec.bytes;
        on_progress(done, total);
    }
    let _ = fs::remove_dir(models_dir.join(".downloads"));
    Ok(())
}

/// Downloads one file (resuming a `.part`) and checks its size and sha256.
fn fetch(
    client: &reqwest::blocking::Client,
    spec: &Spec,
    models_dir: &Path,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64),
) -> Result<PathBuf> {
    let part = spec.part_path(models_dir);
    let mut have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have > spec.bytes {
        let _ = fs::remove_file(&part);
        have = 0;
    }

    if have < spec.bytes {
        let url = spec.url();
        let mut request = client.get(&url);
        if have > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let mut response = request.send().map_err(|e| network_error(spec, &e))?;
        let status = response.status();
        let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
        if !status.is_success() {
            return Err(Error::new(
                ErrorKind::Download,
                format!("下载{}失败（服务器返回 {}）。请稍后重试，或检查网络和镜像地址。", spec.name, status.as_u16()),
            ));
        }
        if !resumed {
            have = 0;
        }
        let mut out = fs::OpenOptions::new()
            .create(true)
            .append(resumed)
            .write(true)
            .truncate(!resumed)
            .open(&part)
            .map_err(|e| Error::io("写入模型文件", e))?;

        let mut buf = vec![0u8; 256 * 1024];
        let mut last = Instant::now();
        on_progress(have);
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::cancelled());
            }
            let n = match response.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    return Err(Error::new(
                        ErrorKind::Download,
                        format!("下载{}时网络中断（{e}），已下载的部分会保留，请重试继续下载。", spec.name),
                    ))
                }
            };
            out.write_all(&buf[..n]).map_err(|e| Error::io("写入模型文件", e))?;
            have += n as u64;
            if have > spec.bytes {
                break;
            }
            if last.elapsed() >= Duration::from_millis(100) {
                on_progress(have);
                last = Instant::now();
            }
        }
        out.sync_all().map_err(|e| Error::io("写入模型文件", e))?;
        on_progress(have.min(spec.bytes));
    }

    if have != spec.bytes || sha256_file(&part)? != spec.sha256 {
        let _ = fs::remove_file(&part);
        return Err(Error::new(
            ErrorKind::Download,
            format!("{}下载后校验失败（文件不完整或被修改），已删除，请重新下载。", spec.name),
        ));
    }
    Ok(part)
}

fn network_error(spec: &Spec, e: &reqwest::Error) -> Error {
    let detail = if e.is_connect() || e.is_timeout() { "无法连接到下载服务器" } else { "网络错误" };
    Error::new(ErrorKind::Download, format!("下载{}失败：{detail}（{e}）。请检查网络连接后重试。", spec.name))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|e| Error::io("读取模型文件", e))?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher).map_err(|e| Error::io("读取模型文件", e))?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Unpacks into `<id>.tmp`, then swaps it in, so a crash never leaves a half model marked ready.
fn install(spec: &Spec, archive: &Path, models_dir: &Path) -> Result<()> {
    let dir = spec.dir(models_dir);
    let tmp = models_dir.join(format!("{}.tmp", spec.id));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| Error::io("创建模型目录", e))?;

    if spec.keep.is_empty() {
        fs::copy(archive, tmp.join(spec.file)).map_err(|e| Error::io("安装模型", e))?;
    } else {
        let file = File::open(archive).map_err(|e| Error::io("读取模型文件", e))?;
        let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(io::BufReader::new(file)));
        let entries = tar.entries().map_err(|e| unpack_error(spec, e))?;
        for entry in entries {
            let mut entry = entry.map_err(|e| unpack_error(spec, e))?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry.path().map_err(|e| unpack_error(spec, e))?.into_owned();
            // Only flat, known names are written: archive paths never choose where files go.
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if path.components().count() > 2 || !spec.keep.contains(&name) {
                continue;
            }
            let mut out = File::create(tmp.join(name)).map_err(|e| Error::io("安装模型", e))?;
            io::copy(&mut entry, &mut out).map_err(|e| unpack_error(spec, e))?;
        }
    }

    let missing: Vec<_> = spec.required().into_iter().filter(|f| !tmp.join(f).is_file()).collect();
    if !missing.is_empty() {
        let _ = fs::remove_dir_all(&tmp);
        return Err(Error::new(ErrorKind::Download, format!("{}的压缩包里缺少 {}，请重新下载。", spec.name, missing.join("、"))));
    }
    let mut stamp = format!("{}\n", spec.sha256);
    for f in spec.required() {
        stamp += &format!("{}  {f}\n", sha256_file(&tmp.join(f))?);
    }
    fs::write(tmp.join(".ready"), stamp).map_err(|e| Error::io("安装模型", e))?;
    let _ = fs::remove_dir_all(&dir);
    fs::rename(&tmp, &dir).map_err(|e| Error::io("安装模型", e))?;
    Ok(())
}

fn unpack_error(spec: &Spec, e: io::Error) -> Error {
    if e.kind() == io::ErrorKind::StorageFull {
        return Error::io("解压模型", e);
    }
    Error::new(ErrorKind::Download, format!("解压{}失败（{e}），请重新下载。", spec.name))
}
