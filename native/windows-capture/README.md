# echomind-capture（Windows 音频采集 sidecar）

EchoMind 桌面端在 Windows 上的录音进程。和 macOS 版（`native/macos-capture`，Swift）是同一个程序的两种实现：命令行参数、stdout 事件、stdin 指令、分段 WAV 和 manifest 都一样，桌面端不用区分平台。协议以 [macOS 版 README 的「CLI 协议」](../macos-capture/README.md#cli-协议) 为准，本文只写 Windows 上不同的地方。

- **mic 轨**：默认输入设备（Windows 声音设置里的「默认设备」），也可以用 `--mic-device` 指定。
- **system 轨**：默认播放设备的 loopback 录音，也就是电脑播放出来的所有声音。

两条轨都在 WASAPI 共享模式下按设备自己的格式采集，混成单声道后交给录音管线，由管线重采样成 16 kHz、16-bit 的 WAV。

## 目录

```
Cargo.toml          依赖；Windows 专用的 windows 库只在 Windows 上编译
.cargo/config.toml  Windows 上静态链接 C 运行库，不需要另装 VC++ 运行库
src/
  main.rs cli.rs            子命令和参数
  backend.rs                录音管线和采集层之间的接口
  session.rs                record 主循环：采集、stdin 指令、定时、Ctrl-C 都汇到一个 channel
  recorder.rs timeline.rs   对齐、切段（和 Swift 版的 Recorder、Timeline 一一对应）
  resampler.rs mix.rs       重采样、混成单声道
  wav.rs manifest.rs events.rs levels.rs
  selftest.rs               合成信号自测，不碰设备
  null_backend.rs clock.rs  空跑用的后端和时钟（--no-mic --no-system，以及非 Windows 平台）
  wasapi/                   只在 Windows 上编译
    mod.rs                  时钟（性能计数器）、后端、devices
    stream.rs               每条轨一个采集线程
    probe.rs                permissions、meetings
```

和平台无关的部分（录音管线、命令行、自测）在 macOS 上也能编译和测试；`wasapi/` 可以在 Mac 上用 `cargo check --target x86_64-pc-windows-msvc` 检查能否编译。

## 和 macOS 版的差别

**对齐的时钟**：用 Windows 的性能计数器（QPC）。WASAPI 给每个数据包标了第一帧被设备采到时的 QPC 时间，录音开始的 t0 也取 QPC，所以两条轨的对齐方式和 macOS 版完全相同（见 macOS 版 README 的「对齐原理」）。WASAPI 的时间戳已经是声音到达设备的时刻，不需要再扣输入延迟。

**没有声音时 system 轨不来数据**：loopback 在电脑没有播放任何声音时一个包都不给。这时由录音管线的看门狗补静音（超过 1 秒没数据就补到「当前时间 − 1 秒」），有声音后第一个包按时间戳放回原位。所以静音期间分段会晚 1 秒左右才结束，不影响内容。

**设备切换**：
- 设备被拔掉、禁用或者改了格式，读数据时会报错，采集线程随即重新打开设备。
- 没有用 `--mic-device` 指定麦克风时，每 300 ms 比较一次系统默认设备；连续两次都变了，就切到新的默认设备。
- 每条轨每秒最多重开一次。换到的设备和原来名字不同时输出 `device-changed`，重开期间的空档按时间补静音。
- 打不开设备时（没插麦克风、被别的程序独占等）报一次错，之后每秒重试一次，期间这条轨是静音，录音不中断。

**`--system-pids` 不支持**：Windows 版只录全部系统声音，传这个参数会报 `invalid_arguments`。

**`permissions`**：

```json
{"microphone":"granted","systemAudio":"granted","note":"……"}
```

- Windows 不会给桌面程序弹授权框。麦克风要么允许，要么在「设置 → 隐私和安全性 → 麦克风」里被关掉了。`microphone` 读这三个开关：本机的总开关、当前用户的开关、「让桌面应用访问麦克风」，任何一个关了就是 `denied`，否则是 `granted`，没有 `undetermined`。
- `permissions --request-mic` 在麦克风被关掉时打开上面那个设置页面。
- loopback 录音不需要任何权限，`systemAudio` 固定为 `granted`。
- 被关掉时录音照样开始，mic 轨是静音，并输出 `mic_permission_denied`。打开开关后，采集线程下一次重试就会自动恢复。

**`meetings`**：按可执行文件名找会议软件，再从每个音频设备的会话（audio session）里看哪些进程在用麦克风、在放声音。

```json
{"meetings":[{"app":"tencent","name":"腾讯会议","pid":812,"exe":"wemeetapp.exe",
              "usingMic":true,"playingAudio":true,"audioPids":[812,840]}]}
```

- 音频会话属于某个进程。飞书这类 Electron 应用的声音在子进程里，所以只要会话的进程或它的任一祖先进程是会议软件的可执行文件，就算这个软件的。
- 没有 macOS 版的 `bundleId`，改为 `exe`。
- `meetings --verbose` 会多列出所有音频会话（`sessions`），用来排查新软件的声音在哪个进程里。

| app | 可执行文件 | 核实情况 |
| --- | --- | --- |
| `tencent` | `wemeetapp.exe` | 未在真机核实 |
| `feishu` | `feishu.exe` | 未在真机核实 |
| `lark` | `lark.exe` | 未在真机核实 |
| `zoom` | `zoom.exe` | 未在真机核实 |

## 构建

在 Windows 上需要 Rust（MSVC 工具链）和 Visual Studio Build Tools：

```bash
cd native/windows-capture
cargo build --release
cp target/release/echomind-capture.exe ../../apps/desktop/src-tauri/binaries/echomind-capture-x86_64-pc-windows-msvc.exe
```

日常不用在本机构建：`.github/workflows/windows.yml` 会在 GitHub 的 Windows 机器上构建录音模块、转写模块和整个安装包，并跑自测。

## 测试

```bash
cargo test --release
./target/release/echomind-capture selftest --out <临时目录>
(sleep 2; echo mark; sleep 1; echo stop) | ./target/release/echomind-capture record --out <临时目录> --no-mic --no-system --segment-seconds 1
```

`selftest` 和 macOS 版是同样的两个场景（对齐、暂停加断流），在任何系统上都能跑。

**真机实测**只能在 Windows 电脑上由人来做，步骤和 macOS 版一样：

```powershell
.\echomind-capture.exe record --out $env:TEMP\echomind-test --segment-seconds 10
```

1. 开始后播放一段视频，或者进一个腾讯会议 / 飞书会议，同时自己说几句话。
2. 中途输入 `mark` 回车，再输入 `pause`，几秒后 `resume`。
3. 大约 30 秒后输入 `stop` 回车。
4. 打开 `manifest.json` 看分段；`mic-0001.wav` 应该是你的声音，`system-0001.wav` 应该是视频或对方的声音，同一编号的两个文件时长完全相等。
5. 再试一次：录音中途插拔耳机，看 `device-changed` 事件和录音是否继续。

开着会议软件运行 `.\echomind-capture.exe meetings --verbose`，可以核实上表里的可执行文件名。

## 已知限制

- **没有在真机上跑过**：采集层只在 Mac 上交叉编译检查过，CI 的 Windows 机器没有声卡，只能跑自测和空跑。第一次真机实测前，不要发给同事用。
- **会议软件的可执行文件名没有核实**，见上表。认错了只影响「发现会议时提醒我」，不影响录音。
- **没有回声消除**：外放时 mic 轨也会录到对方的声音，建议戴耳机。
- **全局 loopback 会录到所有声音**，包括通知音和音乐。
- 蓝牙耳机做麦克风时，Windows 会切到通话模式，音质变差、采样率变低，程序会自动适配新的采样率。
- 只支持 x64。ARM 版 Windows 在 x64 模拟下应该能跑，没有测过。
