# echomind-capture（macOS 音频采集 sidecar）

EchoMind 桌面端（Tauri 2）的原生录音进程。会议进行时录制两条时间对齐的音轨：

- **mic 轨**：本机用户的麦克风（HAL IOProc 直接读输入设备）。
- **system 轨**：Mac 播放出来的所有声音，也就是远端参会人的声音。用 Core Audio Process Tap（macOS 14.2+）实现：`CATapDescription` → `AudioHardwareCreateProcessTap` → 只包含这个 tap 的私有聚合设备 → IOProc。默认是排除本进程的全局立体声 tap，也可以用 `--system-pids` 只录指定进程。

两条轨都重采样成单声道 16-bit PCM WAV（默认 16 kHz，方便 ASR），按固定时长切段，两条轨的切点完全相同。

## 目录

```
Package.swift            SwiftPM 清单（Swift 6 语言模式，macOS 14.2，链接时嵌入 Info.plist）
Info.plist               嵌入到二进制 __TEXT,__info_plist 的 bundle id 和权限说明
build.sh                 构建 + ad-hoc 签名 + 复制到 Tauri sidecar 目录
Sources/EchoMindCapture/
  main.swift / CLI.swift       子命令解析
  RecordSession.swift          record：采集、stdin 指令、信号、设备切换
  MicCapture.swift             麦克风 HAL IOProc
  SystemTap.swift              process tap + 私有聚合设备
  AudioChunk.swift             IO 缓冲 → 单声道 Float32（混音）
  Recorder.swift               对齐、重采样、切段、写 WAV、电平、manifest、事件（record 和 selftest 共用）
  Timeline.swift               共享时间轴上的分段表（滚动 / 暂停 / 停止）
  Resampler.swift              AVAudioConverter 流式重采样
  WavWriter.swift              WAV 写入（每秒刷新文件头）和 selftest 用的读取
  Levels.swift / Manifest.swift / Events.swift / CoreAudioSupport.swift
  Meetings.swift / Commands.swift / SelfTest.swift
```

## 构建

只需要 Command Line Tools（不需要 Xcode）：

```bash
cd native/macos-capture
./build.sh
```

- `swift build --arch arm64 --arch x86_64` 依赖完整 Xcode 里的 XCBuild，用 Command Line Tools 会报错。所以 `build.sh` 分别用 `--triple arm64-apple-macosx14.2` 和 `--triple x86_64-apple-macosx14.2` 构建，再用 `lipo` 合成 universal。x86_64 构建失败时退回只出 arm64。
- 产物：`.build/dist/echomind-capture`（universal，ad-hoc 签名，identifier `com.evanbyte.echomind.capture`），并复制到 `apps/desktop/src-tauri/binaries/`：
  - `echomind-capture-aarch64-apple-darwin`（arm64 单架构）
  - `echomind-capture-x86_64-apple-darwin`（x86_64 单架构）
  - `echomind-capture-universal-apple-darwin`（给 `tauri build --target universal-apple-darwin` 用）
- 只做开发调试的话 `swift build -c release` 就够了，产物在 `.build/release/echomind-capture`。

## CLI 协议

机器可读的输出全部是 stdout 上的 JSON Lines（一行一个对象，立即刷新）；给人看的日志在 stderr。参数错误时输出 `{"type":"error","code":"invalid_arguments",...}`，退出码 2。

### `record`

```
echomind-capture record --out <dir> [--segment-seconds 60] [--sample-rate 16000]
                        [--system-pids 1,2] [--mic-device <deviceUID>] [--no-system] [--no-mic]
```

- 写出 `<dir>/mic-0001.wav`、`<dir>/system-0001.wav`……单声道、16-bit PCM、`--sample-rate` Hz。每 `--segment-seconds` 秒换一个新编号。同一编号的 mic 和 system 覆盖同一段时间，样本数完全相等。
- `--no-mic --no-system` 是不碰任何设备的空跑模式，事件、stdin 指令和 manifest 照常工作，适合调试 Tauri 侧协议（不会弹权限）。
- 退出码：正常停止为 0，致命错误（输出目录不可写、磁盘写满）为 1。

stdout 事件（字段顺序固定，`type` 总在最前）：

```jsonc
{"type":"started","startedAt":"2026-10-13T10:00:00.123+08:00","sampleRate":16000,"segmentSeconds":60,"out":"/abs/dir",
 "mic":{"device":"MacBook Pro Microphone"},"system":{"scope":"global","device":"MacBook Pro Speakers"}}  // 被禁用的轨为 null
{"type":"level","t":1200,"mic":-23.4,"system":-41.0}       // 每 100 ms 一次；RMS dBFS，下限 -90；暂停时为 -90；禁用的轨为 null
{"type":"segment","index":1,"startMs":0,"endMs":60000,"mic":"/abs/dir/mic-0001.wav","system":"/abs/dir/system-0001.wav"}
{"type":"mark","atMs":12345}
{"type":"paused","atMs":70000}
{"type":"resumed","atMs":75000}
{"type":"device-changed","track":"mic","device":"AirPods Pro"}       // track 为 system 时 device 是新的默认输出设备
{"type":"error","code":"mic_permission_denied","message":"麦克风权限被拒绝……"}
{"type":"stopped","durationMs":180000,"segments":3}               // 总是最后一行
```

`error.code` 的取值：`invalid_arguments`、`output_dir_unwritable`、`write_failed`、`resample_failed`、`mic_unavailable`、`mic_start_failed`、`mic_permission_denied`、`system_tap_failed`、`system_pids_not_found`、`unknown_command`、`internal_error`。只有 `output_dir_unwritable`、`write_failed`、`resample_failed` 会让录音停止；其余错误发生时录音继续，出问题的那条轨写静音。

stdin 控制（一行一个指令，不区分大小写）：`pause`、`resume`、`mark`、`stop`。收到 SIGINT、SIGTERM、SIGHUP 或 stdin EOF（父进程退出）时也会正常停止：补齐 WAV 文件头和 manifest，销毁 tap 和聚合设备，最后输出 `stopped`。**父进程必须一直保持 stdin 打开**，否则 EOF 会立刻停止录音。

`<dir>/manifest.json` 在每个分段结束、mark、pause、resume、stop 时以原子方式重写：

```json
{"version":1,"startedAt":"2026-10-13T10:00:00.123+08:00","sampleRate":16000,"segmentSeconds":60,
 "tracks":["mic","system"],"status":"recording","durationMs":null,
 "segments":[{"index":1,"startMs":0,"endMs":60000,"mic":"mic-0001.wav","system":"system-0001.wav"}],
 "marks":[{"atMs":12345}],"paused":[{"fromMs":70000,"toMs":75000}]}
```

`status`、`durationMs` 是附加字段（停止后为 `"stopped"` 和总时长）。正在暂停时最后一项 `paused` 的 `toMs` 为 `null`。

**暂停语义**：暂停期间什么都不写，时间轴照常走。`pause` 会在暂停点切断当前分段，`resume` 从恢复点开一个新编号的分段。因此每个文件内部都是连续时间，换算公式始终是 `时间轴毫秒 = startMs + 文件内偏移`；分段之间在暂停处不连续，暂停前后的分段也可能短于 `segmentSeconds`。

### `devices`

```json
{"inputs":[{"uid":"BuiltInMicrophoneDevice","name":"MacBook Pro Microphone","isDefault":true,"transport":"builtin"}],
 "outputs":[{"uid":"BuiltInSpeakerDevice","name":"MacBook Pro Speakers","isDefault":true,"transport":"builtin"}]}
```

`uid` 可直接传给 `--mic-device`。`transport` 是附加字段，取值 builtin/usb/bluetooth/virtual/aggregate/display/airplay/thunderbolt/continuity/unknown。

### `meetings`

```json
{"meetings":[{"app":"tencent","name":"腾讯会议","pid":812,"bundleId":"com.tencent.meeting",
              "usingMic":true,"playingAudio":true,"audioPids":[812,840]}]}
```

先用 NSWorkspace 按 bundle id 找到正在运行的会议 App，再和 Core Audio 进程对象（`kAudioHardwarePropertyProcessObjectList`）合并。满足以下任一条件的音频进程都算这个 App 的：PID 相同；bundle id 相同或以 `<bundleId>.` 开头；可执行文件位于 App bundle 内（helper、XPC）；是 App 进程的子孙进程。`usingMic` / `playingAudio` 来自这些进程的 `kAudioProcessPropertyIsRunningInput/Output`，`audioPids` 可以直接传给 `--system-pids`。`meetings --verbose` 会额外列出所有 Core Audio 进程对象，用来排查新 App 的音频到底在哪个进程。

| app | bundle id | 核实情况 |
| --- | --- | --- |
| `tencent` | `com.tencent.meeting`（腾讯会议）、`com.tencent.tencentmeeting`（VooV Meeting） | 本机 /Applications 已核实 |
| `feishu` | `com.electron.lark` | 本机核实：CFBundleName/可执行文件为 Feishu，中文名“飞书”，英文显示名为 Lark |
| `feishu` | `com.bytedance.macos.feishu` | 未核实，作为候选保留 |
| `lark` | `com.larksuite.macos.lark`（LarkSuite.app，国际版） | 本机已核实 |
| `zoom` | `us.zoom.xos` | 公开资料，本机未安装 |

`com.electron.lark` 也出现在早期 Lark 国际版上，所以只有 bundle 的 CFBundleName 不含 “Feishu” 时才报告为 `lark`。

### `permissions`

```json
{"microphone":"granted","systemAudio":"undetermined","note":"……"}
```

- `microphone` 取值 `granted|denied|undetermined|restricted`（AVCaptureDevice）。
- `systemAudio` 取值 `granted|denied|undetermined|unknown`。“系统录音”权限（kTCCServiceAudioCapture）没有公开 API，这里用的是 TCC 的私有函数 `TCCAccessPreflight` / `TCCAccessRequest`（运行时用 dlopen 查找，见 `SystemAudioPermission.swift`）。将来的 macOS 去掉了这两个函数时，值为 `unknown`，程序不会崩溃。
- `permissions --request-mic` 弹出麦克风授权框，`permissions --request-system-audio` 弹出系统录音授权框，等用户选择后输出同样的 JSON。已经回答过的权限不会再弹框，立刻输出当前状态。

桌面端在每次开始录音前先查一遍：没问过的先弹框；麦克风被拒绝就不开始录，并提示去系统设置打开；系统录音被拒绝照常录（线下会议用不到它），但提示线上其他人的声音录不到。

### `selftest`

```
echomind-capture selftest --out <dir>
```

不需要任何权限，也不碰任何设备。用模拟的主机时钟，把合成的 48 kHz Float32 正弦波送进和 `record` 相同的代码路径：PCMLayout 混音 → Recorder 对齐 → AVAudioConverter 重采样 → Timeline 切段 → WavWriter → Manifest。然后重新读出文件做校验。

- **aligned**（文件直接写在 `<dir>`）：`--segment-seconds 2`，录 5 秒（2.5 段）。mic 是 440 Hz 单声道，从 t0 开始；system 是 660 Hz 交错立体声（和 tap 的格式一样），故意晚 250 ms 开始。两条轨在相同时刻有 100 ms 的音爆，其中一个跨过分段边界。校验 WAV 头、采样率、每段样本数、两条轨的切点一致、manifest 和事件，并检查 system 开头补了 250 ms 静音、共同音爆的起点偏差不超过 10 ms、跨段音爆是连续的、频率正确。
- **pause-dropout**（`<dir>/pause-dropout`）：mic 中断 500 ms（模拟换设备），在 0.5 s 打 mark，2.5 s 暂停，3.5 s 恢复。校验分段为 0–2000、2000–2500、3500–5000，中断期间补的是静音，恢复后立刻有声音，manifest 里的 marks 和 paused 都正确。

输出一行 `{"type":"selftest","ok":true,...}`，失败时退出码为 1。

## 对齐原理

1. 开始录音的那一刻取主机时钟作为 t0（`AudioGetCurrentHostTime` 换算成纳秒），时间轴从这里开始。
2. 每个 IO 缓冲带着它第一帧的主机时间（IOProc 的 `inInputTime.mHostTime`）。mic 再减去设备和流的输入延迟（`kAudioDevicePropertyLatency` + `kAudioStreamPropertyLatency`，本机内建麦克风约 30 ms），所以 mic 的时间接近声音到达麦克风的时刻。
3. 某条轨的第一个缓冲放在 `(hostTime − t0) × sampleRate` 这个位置：晚到的轨前面补静音，早于 t0 的帧丢掉。两条轨都用同一个主机时钟，所以开头能逐样本对齐，精度取决于时间戳本身（远小于 10 ms）。
4. 之后的缓冲首尾相接地写入。只有当主机时间算出的位置和连续写入的位置相差超过 20 ms 时（掉帧、换设备、时钟漂移），才按主机时间重新对齐：落后就补静音，超前就丢掉重叠的样本。所以两条轨在整场会议中始终保持 20 ms 以内的对齐。
5. 看门狗：某条轨超过 1 秒没有数据（设备拔掉、tap 停止回调），就用静音把它补到“当前时间 − 1 秒”，保证分段能按时结束。
6. 分段表（Timeline）是两条轨共享的：每个样本写到哪个文件由时间轴位置决定，所以切点完全一致。一个分段要等所有轨都写过它的终点才算完成，完成时输出 `segment` 事件并重写 manifest。

## 设备切换

- 监听默认输入设备、设备列表，以及当前麦克风的存活状态、采样率和通道配置。发生变化时（防抖 300 ms，每条轨每秒最多重建一次）在新的默认设备上重建 IOProc（如果指定了 `--mic-device` 并且它还在，则优先用它），然后输出 `device-changed`。重建期间的空档按主机时间补静音，录音不中断。
- 监听默认输出设备、tap 的格式（`kAudioTapPropertyFormat`）和聚合设备的存活状态。发生变化时先销毁再重建 tap 和聚合设备；默认输出设备变了会输出 `device-changed`（track 为 system）。`--system-pids` 模式下还会监听进程对象列表：指定的 PID 出现或消失时自动重建，所以可以先开始录音、后启动会议。
- 无论正常退出还是出错退出，都会停止 IOProc 并销毁聚合设备和 tap。两者都是 private 的，进程崩溃时 coreaudiod 也会自动回收。

## 权限

macOS 会弹出两个授权框：

1. **麦克风**：首次开始录音时弹出。设置位置：系统设置 → 隐私与安全性 → 麦克风。
2. **系统录音**：第一次启动包含 tap 的聚合设备时弹出。设置位置：系统设置 → 隐私与安全性 → 屏幕与系统录音 → **仅系统录音**（System Audio Recording Only）。如果被拒绝，tap 只会收到静音，而且没有任何报错，`permissions` 也查不出来。

TCC 把权限记在“负责进程”名下：

- 在终端里测试时，弹框和设置项里显示的是 **终端 App**（Terminal / iTerm 等）。iTerm 有时不会弹框，需要先去设置里手动打开，系统自带的“终端”一定会弹。
- `pnpm tauri dev` 启动的开发版也一样：权限记在启动它的终端名下。比如在 Claude 桌面版的终端面板里运行时，用的是 Claude 的麦克风和系统录音权限，不会以 EchoMind 的名义弹框。要测试 EchoMind 自己的授权流程，用打包好的 App。
- 作为 sidecar 运行时，权限归 **EchoMind.app**。所以 Tauri App 自己的 Info.plist 也必须包含 `NSMicrophoneUsageDescription` 和 `NSAudioCaptureUsageDescription`。如果 App 开启了 hardened runtime，还需要 `com.apple.security.device.audio-input` entitlement。

二进制里嵌入的 Info.plist（`CFBundleIdentifier` 为 `com.evanbyte.echomind.capture`，带上述两条中文说明）在本程序自己是负责进程时生效，可以用 `launchctl plist __TEXT,__info_plist <binary>` 查看。

授权框出现时录音已经开始了，期间对应的轨是静音。麦克风授权后会自动重启采集。系统录音刚授权的那一次如果还是静音，`stop` 后重新开始即可。

## 自己做一次 30 秒实测

```bash
cd native/macos-capture
./build.sh                      # 或者 swift build -c release
./.build/release/echomind-capture selftest --out /tmp/echomind-selftest | python3 -m json.tool

# 用系统自带的“终端”运行（第一次会弹出麦克风和系统录音两个授权框）
./.build/release/echomind-capture record --out /tmp/echomind-test --segment-seconds 10 | grep --line-buffered -v '"level"'
```

1. 开始后播放一段 YouTube 视频，或者进入一个腾讯会议 / 飞书会议，同时自己说几句话。
2. 中途输入 `mark` 回车，再试一次 `pause` 回车，几秒后输入 `resume` 回车。
3. 大约 30 秒后输入 `stop` 回车。用了管道时不要按 Ctrl-C，否则 grep 会一起退出，`stopped` 那一行就看不到了（文件仍会正常收尾）。
4. 检查结果：

```bash
python3 -m json.tool /tmp/echomind-test/manifest.json
afinfo /tmp/echomind-test/mic-0001.wav | grep -E 'duration|Data format'
afplay /tmp/echomind-test/mic-0001.wav       # 应该是你的声音
afplay /tmp/echomind-test/system-0001.wav    # 应该是视频或会议里对方的声音
```

同一编号的 mic 和 system 时长应该完全相等。把两个文件拖进 Audacity 并排查看，可以直观地检查对齐。

想先确认会议 App 能不能被识别：开着腾讯会议再运行 `./.build/release/echomind-capture meetings`。只录会议 App 的声音：`record --out ... --system-pids <audioPids>`。

## 已知限制

- **实机采集没有自动化测试**：麦克风和 system tap 的 IO 需要授权弹框，所以只能由人来跑上面的实测。selftest 覆盖的是它们下游的全部代码。
- **没有回声消除**：外放时，mic 轨也会录到远端参会人的声音，建议戴耳机。之后可以用 system 轨做参考信号来做 AEC。
- **全局 tap 会录到所有声音**，包括通知音和音乐。需要只录会议时用 `--system-pids`。该模式只录指定的 PID 本身，不会自动包含子进程，请传 `meetings` 返回的 `audioPids`。会议 App 重启后 PID 会变，需要重新开始录音。
- system 轨的时间是进程把音频交给系统的时刻，不包含输出设备的延迟。用蓝牙耳机时，用户实际听到的时间大约还要晚 100–250 ms。mic 轨已经扣除了输入延迟。
- 时钟漂移靠超过 20 ms 时的重新对齐来纠正，每次会产生几十毫秒的插入静音或丢弃，对 ASR 基本没有影响。设备切换期间（约 0.3–1 秒）对应的轨是静音。
- 用 AirPods 等蓝牙耳机做麦克风时，系统会切到 HFP，音质变差、采样率变低。这是 macOS 的行为，程序会自动适配新的采样率。
- “系统录音”权限的状态靠私有 API 查询，没有官方保证。查不到时（`unknown`）被拒绝的 system 轨只是静音。
- 用 ad-hoc 签名重新打包后，macOS 可能认为是另一个 App：设置里的开关看起来开着，实际不生效。这时把开关关掉再打开一次。
- 需要 macOS 14.2 以上。x86_64 版本只在 Rosetta 下跑过 selftest。
- WAV 文件头每秒刷新一次，进程被强杀时最多丢失最后约 1 秒。

## 实现说明

- Swift 6 语言模式，严格并发检查下零警告。各个队列独占自己的状态，相关类型标为 `@unchecked Sendable`：`control` 队列管采集和监听，`pipeline` 队列管 Recorder，IOProc 在采集自己的队列上运行，只做拷贝和混音。
- 聚合设备只包含 tap，没有子设备，做法与 Apple 示例 “Capturing system audio with Core Audio taps” 相同。这样不会把带麦克风的输出设备（比如 USB 耳机）的输入流也混进来。`tapautostart` 设为 0，IO 立即启动，不等 tap 收到第一段音频。如果没有声音时 tap 不回调，看门狗也会补静音。
- Core Audio 属性监听用的是函数指针加 context 的 API（`AudioObjectAddPropertyListener`），而不是 block 版本。原因是 Swift 闭包桥接成 block 后不能保证对象是同一个，可能导致无法移除监听。
