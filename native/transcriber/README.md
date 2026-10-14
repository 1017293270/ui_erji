# echomind-transcriber（本地语音转写）

把 echomind-capture 录下的会议文件夹转成 `Transcript`（`packages/shared/src/meeting.ts` 里的结构）。全部在用户电脑上用 CPU 跑，音频不出本机，只有转写出的文字之后才交给 DeepSeek。

- **mic 轨** = 录音的人自己：说话人 `S1`（`label: "我"`，`source: "self"`）。
- **system 轨** = 电脑播放出来的所有人：做说话人分离，按第一次出现的顺序编号 `S2、S3…`（`说话人 2`…，`source: "unknown"`）。
- 时间是从开始录音算起的毫秒，暂停留下的空档原样保留，不平移。

## 流程

1. **prepare**：读 `manifest.json`，把每条轨的 `mic-NNNN.wav` / `system-NNNN.wav` 按 `startMs` 放回时间轴（暂停处是空档；某条轨缺失就跳过；manifest 缺失或录音中途崩溃时按文件编号兜底）。非 16 kHz 单声道的 WAV 先转成临时文件。逐个校验模型文件的 sha256（约 0.2 秒）。
2. **speech**：Silero VAD 流式扫两条轨，得到说话的区间。内存不随会议长度增长。
3. **speakers**：system 轨去掉静音后，每 10 分钟语音为一块交给 sherpa-onnx 的说话人分离（pyannote segmentation 3.0 + CAM++ 声纹）。每块里的每个说话人再取最多 60 秒干净语音算一个声纹，跨块用平均链接聚类，所以 2 小时会议里同一个人的编号保持一致，而内存只占一块（约 40 MB 音频）。同一块里分离器已经分开的两个人，只有声纹非常接近（≥ 0.7）才会被合并。
4. **text**：mic 轨按 VAD 切段；system 轨按说话人分段，再在停顿处切开，每段不超过 20 秒。SenseVoice 逐段识别，自带标点和数字规整（ITN）。丢掉空段和纯语气词（嗯、啊…）。
   - **回声**：不戴耳机时麦克风会录到扬声器里对方的声音。mic 轨会在 system 轨有人说话的边界处切开，凡是录在对方说话期间、且文字和 system 轨同时段内容大部分重复（最长公共子序列 ≥ 60%）的 mic 段，当作回声丢掉；用户自己的话不受影响。
5. 两条轨合并，按开始时间排序，编号 `seg-0001…`。

## 模型（共下载约 199 MB，解压后约 274 MB）

全部来自 k2-fsa/sherpa-onnx 的 GitHub Releases，每个文件都用代码里写死的 sha256 校验。

| id | 模型 | 下载 | 磁盘 | 许可 |
| --- | --- | --- | --- | --- |
| `asr` | SenseVoice-Small int8（`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`） | 163 MB | 239 MB | 见下 |
| `vad` | Silero VAD（`silero_vad.onnx`） | 0.6 MB | 0.6 MB | MIT |
| `segmentation` | pyannote segmentation-3.0（`sherpa-onnx-pyannote-segmentation-3-0`，用 fp32 的 `model.onnx`） | 7 MB | 6 MB | MIT |
| `embedding` | 3D-Speaker CAM++ 中文 20 万说话人（`3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`） | 28 MB | 28 MB | Apache-2.0 |

**SenseVoice 的许可要注意**：压缩包里的 LICENSE 和 Hugging Face 上的模型卡指向 *FunASR Model Open Source License v1.1*：允许使用、复制、修改、分发（没有禁止商用），但**必须注明出处和作者并保留模型名称**；条款里还有“仅供参考和学习”的免责声明、阿里巴巴可单方修订协议、以及“诋毁 FunASR 会自动失去授权”的条款。ModelScope 上同一个模型标的是 Apache-2.0，两处不一致。卖给企业前请法务确认，并在 App 的“关于 / 开源许可”里写明：SenseVoice-Small（FunAudioLLM / 阿里巴巴通义实验室，https://github.com/FunAudioLLM/SenseVoice）。

为什么选这些：

- **ASR 选 SenseVoice-Small**：中文准确率在开源小模型里属第一梯队（X-ASR 公布的 WenetSpeech 对比里 test_meeting 6.47% CER，好于同体量的 X-ASR、接近 Qwen3-ASR-0.6B，而后者 int8 也要 879 MB），非自回归，CPU 上很快；一个模型同时给出标点和 ITN，中英混说（iOS、API、SDK、React）能正确输出。对比过：
  - Paraformer-zh int8（2025-10-07，228 MB）准确率相近，但没有标点，还得再加 65 MB 的标点模型，许可同样是 FunASR 协议。
  - Fun-ASR-Nano 的 CTC 版（`sense-voice-funasr-nano-int8-2025-12-17`，188 MB，Apache-2.0）许可更干净，但在测试音频上 CER 4.9% 对 SenseVoice 3.1%，没有标点，英文词（iOS → “os”，API → “ak”）明显更差。完整的 Fun-ASR-Nano / Qwen3-ASR / FireRedASR2 都在 500 MB–1.3 GB，超出预算，CPU 上也慢得多。
  - 语言固定为 `zh` 而不是 `auto`：测试上两者准确率一样，固定后免得短句被误判成粤语或日语。
- **声纹选 CAM++ zh-cn 16k-common**：3D-Speaker 自己的说话人分离方案用的就是它；20 万中文说话人训练；比 ERes2Net-base 快 3 倍、比 ERes2NetV2 快 6 倍，在测试里区分度和它们相当。
- **分段模型** pyannote 3.0 是 sherpa-onnx 支持的唯一可商用选项（reverb-diarization 是非商用许可）。

## 链接方式：静态，一个二进制

用官方的 `sherpa-onnx` crate（1.13.8，k2-fsa 维护，Apache-2.0）。默认的 `static` feature 在构建时从 GitHub Releases 下载预编译的静态库（macOS arm64 约 21 MB 的 `sherpa-onnx-v1.13.8-osx-arm64-static-lib.tar.bz2`），把 sherpa-onnx 和 onnxruntime 一起静态链进来：

- **不需要 cmake**，不需要打包任何 dylib/DLL。macOS 产物只依赖系统自带的库（libc++、Foundation、CoreFoundation、Security、SystemConfiguration、libiconv，`otool -L` 可查）。
- release 版 CLI 约 28 MB。
- 构建机不能访问 GitHub 时：先把对应的 `-lib.tar.bz2` 放到一个目录，设 `SHERPA_ONNX_ARCHIVE_DIR=<目录>`；或者设 `SHERPA_ONNX_LIB_DIR` 指向已解压的 `lib/`。构建脚本下载时不校验哈希，CI 里建议走这条路并自己核对：
  - `osx-arm64-static-lib`：`9091bf160dc7fdacedbc906b212badf53c2993f4e5277a0e03998e96c31d60da`
  - `osx-x64-static-lib`：`a3f88da3e54c850a12d61431e73f8affcd1f13738b75b768847dd79541835b4b`
  - `win-x64-static-MT-Release-lib`（123 MB）：`56ffcf3c454c1f14f7bc9887286cc8143e7e542dc632804e1c447d5f8d534eaf`
- 预编译静态库里也带了 TTS 用的 espeak-ng（GPL-3.0）。链接器只取用到的目标文件，release 产物里查不到任何 espeak 符号（`nm -U <二进制> | grep -E '_espeak|espeak_ng'` 为空），只剩 MIT 许可的 piper-phonemize 的静态初始化。**最终 App 也请照这个命令查一遍**；如果出现了，改用 no-tts 的静态库（通过 `SHERPA_ONNX_LIB_DIR`）。
- universal 包（`tauri build --target universal-apple-darwin`）：两个架构分别构建，构建脚本会各自下载 osx-x64 / osx-arm64 的静态库，不需要额外处理。

**Windows x64**（还没在 Windows 上构建过，以下要实测）：

- 预编译库是 `/MT`（静态 CRT）编译的，Rust 默认是 `/MD`。在 `apps/desktop/src-tauri/.cargo/config.toml` 加上
  ```toml
  [target.x86_64-pc-windows-msvc]
  rustflags = ["-C", "target-feature=+crt-static"]
  ```
  不加会出现 LIBCMT / MSVCRT 冲突的链接错误。这也是 Tauri 推荐的做法（顺便省掉 VC++ 运行库）。
- 模型目录在 `%APPDATA%\com.evanbyte.echomind\models`，用户名可能是中文。sherpa-onnx 1.13.8 在 Windows 上会把 UTF-8 路径转成宽字符再打开模型文件，理论上没问题，但请用中文用户名实测一次。

## 命令行

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd native/transcriber
cargo build --release

./target/release/echomind-transcribe models                 # 模型状态（JSON）
./target/release/echomind-transcribe download               # 下载缺的模型，断点续传；Ctrl-C 取消
./target/release/echomind-transcribe run <录音文件夹> --out transcript.json
```

- 模型目录默认就是 App 用的 `~/Library/Application Support/com.evanbyte.echomind/models/`，可以用 `--models-dir` 或 `ECHOMIND_MODELS_DIR` 改。
- `ECHOMIND_MODEL_MIRROR=<镜像地址>` 替换 `https://github.com/k2-fsa/sherpa-onnx/releases/download`，镜像要提供同样的 `<tag>/<文件名>` 路径；sha256 照样校验。
- `ECHOMIND_TRANSCRIBE_DEBUG=1` 在 stderr 打印每块的说话人数和跨块声纹相似度，调说话人分离时用。
- `--json`：给 sidecar 用的机器模式，stdout 每行一个事件，stdin 收到 `cancel` 或 EOF 就停止（和 echomind-capture 一样，父进程要一直开着 stdin）：
  ```jsonc
  {"type":"progress","stage":"speech","progress":0.42}
  {"type":"download","received":1048576,"total":198886319}
  {"type":"done","transcript":{…}}            // download 时是 {"type":"done","status":{…}}
  {"type":"error","kind":"models_missing","message":"转写模型还没有下载完成：…"}
  ```
  `kind`：`cancelled`、`models_missing`、`download`、`recording`、`engine`、`io`。

## App 怎么接

库的接口（全部是阻塞调用，放到工作线程里跑，`cancel` 置 true 就会尽快返回 `ErrorKind::Cancelled`）：

```rust
pub fn model_status(models_dir: &Path) -> ModelStatus;
pub fn download_models(models_dir: &Path, cancel: &AtomicBool, on_progress: impl FnMut(u64, u64)) -> Result<(), Error>;
pub fn transcribe(recording_dir: &Path, models_dir: &Path, cancel: &AtomicBool,
                  on_progress: impl FnMut(Stage, f32)) -> Result<Transcript, Error>;
```

- `ModelStatus` 序列化后就是 `transcribe_models` 的返回值；`download_models` 的回调直接转成 `transcribe://download { received, total }`；`Transcript` 序列化后符合 shared 的 schema，写到 `recordings/<id>/transcript.json`。
- `Stage::as_str()` 是事件里的 `stage`。**每个阶段的 progress 各自从 0 走到 1**，UI 要显示一根总进度条可以按耗时加权（2 小时会议实测）：speech 7%、speakers 31%、text 62%，prepare 可忽略。
- `Error` 的 `message` 是可以直接给用户看的中文句子；`kind` 用来决定 UI 怎么反应（`models_missing` 显示下载按钮，`cancelled` 不提示）。
- **建议以 sidecar 方式运行**（`echomind-transcribe run <dir> --json`，像 echomind-capture 一样放进 `binaries/`）：onnxruntime 遇到损坏的模型等内部错误会抛 C++ 异常直接 abort 整个进程。库已经在开始前逐个校验模型的 sha256 来避开最常见的情况，但只有单独进程才能保证 App 不被带崩；结束后内存也能完整还给系统。直接链接库也可以：在 `src-tauri/Cargo.toml` 里 `echomind-transcriber = { path = "../../../native/transcriber" }`，用 `std::thread::spawn` 或 `tauri::async_runtime::spawn_blocking` 调用（`download_models` 内部用了 reqwest 的 blocking 客户端，不能在 async 任务里直接调）。
- 内存：峰值约 550 MB（主要是 SenseVoice 模型本身），2 小时会议和 2 分钟会议一样。
- 线程：用一半核心、最多 4 个。M1 Pro 上 4 线程最快，6、8 线程反而变慢。

## 测试

只用合成音频，绝不读用户的 `recordings/`。

```bash
scripts/make-fixture.sh /tmp/echomind-fx/rec-test                 # 约 2.5 分钟：mic=Tingting，system=Eddy（男）+ Meijia（女）
scripts/make-fixture.sh /tmp/echomind-fx/rec-echo --echo          # 把 system 轨以 -12 dB、80 ms 延迟漏进 mic，模拟外放
scripts/make-fixture.sh /tmp/echomind-fx/rec-2h --repeat 50       # 会议重复 50 遍，约 2 小时，测跨块、速度和内存
cargo run --release --bin echomind-transcribe -- run /tmp/echomind-fx/rec-test --out /tmp/echomind-fx/rec-test.json
python3 scripts/check-transcript.py /tmp/echomind-fx/rec-test /tmp/echomind-fx/rec-test.json
cargo test --release --lib                                        # 切段、重叠、漏检补回、回声的单元测试
cargo test --release -- --ignored                                 # 端到端：生成 fixture、转写、检查 JSON、字错率、说话人和时间（需要已下载模型）
```

fixture 按 echomind-capture 的格式生成：60 秒一个分段文件，中间暂停 10 秒（暂停期间没有文件），带 `manifest.json`，另附 `expected.json` 记录每句话的说话人、位置和原文。`check-transcript.py` 检查 JSON 结构（字段、id、排序、说话人和轨道对应），算各轨字错率、system 轨声音到说话人编号的对应、每句开头的时间偏差。

在 M1 Pro（8 核，macOS 26，4 个线程，机器上同时开着别的程序）上的结果：

| fixture | 时长 | 字错率 mic / system | 说话人分离 | 段首时间偏差 | 用时 / RTF |
| --- | --- | --- | --- | --- | --- |
| 默认（Tingting / Eddy+Meijia） | 2.5 分钟 | 0% / 6.9% | 2 个声音 → S2、S3，纯度 100% | 平均 −4 ms，最大 98 ms | 10.5 s / 0.070 |
| `--echo` 外放回声 | 2.5 分钟 | 0% / 6.9%，没有回声被当成“我” | 同上 | 平均 −10 ms，最大 98 ms | 13.7 s / 0.092 |
| `--repeat 50` | 2 小时 1 分 | 0% / 5.9% | 7 块共 14 个块内说话人，跨块正确连成 S2、S3，纯度 100% | 平均 −11 ms，95% 在 89 ms 内 | 532 s / 0.073，峰值内存 545 MB |

system 轨的错字几乎都来自 Eddy：macOS 的 Eddy/Shelley/Flo 等是机械感很重的合成音，SenseVoice 对 Meijia、Tingting 这类自然音色的字错率是 0–0.6%。

## 已知限制

- **相似的声音会被并成一个人**。Tingting 和 Meijia 两个女声在所有声纹模型下的相似度都有 0.6–0.74（真实的不同人通常低于 0.3–0.4），pyannote 在 10 秒窗口里分不开，所以 system 轨用这两个声音时只得到一个编号。没有为这种情况调阈值：调到能分开它们，会把真实会议里同一个人切成好几个编号。阈值需要用真实会议录音再校准（`speakers.rs` 顶部的常量）。之后可以让 App 传入参会人数（飞书日程里的人数）作为说话人数的上限。
- **同时说话**：重叠的部分归给先开口的人，后插话的人在重叠里的话只会出现在前者那段里（或丢失）。
- **回声**只按“和对方同时说的内容大部分重复”来判断：用户和对方同时说话、又开着外放时，用户那段可能混入回声文字。最好的办法仍然是戴耳机；以后可以用 system 轨做参考信号做真正的回声消除。
- 2 小时会议在 M1 Pro 上约 9 分钟（speech 39 s、speakers 164 s、text 329 s）。单线程 RTF 约 0.18，四核的 Windows 笔记本预计 RTF 0.15–0.3，也就是 2 小时会议要 20–35 分钟。
- 说话人分离那一步每块（≤ 10 分钟语音）内部不能中途取消，取消最多要等一块跑完（M1 Pro 上约 25 秒）。
- 非常短的孤立语气词（“嗯”“啊”）会被当作无内容丢掉；单独的“好。”“对。”会保留。
