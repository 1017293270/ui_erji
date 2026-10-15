# EchoMind

AI 会议纪要助手。开会时在电脑上同时录两路声音（麦克风 = 我，系统声音 = 其他参会人），会后生成带出处的纪要和待办，记录人确认后推送到飞书。大模型用 DeepSeek，数据留在国内。

## 目录

| 路径 | 内容 |
| --- | --- |
| `apps/desktop` | 桌面端（Tauri 2 + React 19 + Tailwind 4），界面和手绘插画都在这里；安卓 App 也从这里打包 |
| `apps/desktop/src-tauri` | Rust 外壳：主窗口、录音浮窗、菜单栏图标、两个 sidecar、会议存储、飞书与 DeepSeek 代理（密钥不进网页） |
| `apps/desktop/src-tauri/gen/android` | 安卓工程：录音前台服务、模型解包（Kotlin，`app/src/main/java/com/evanbyte/echomind`） |
| `native/macos-capture` | macOS 双轨采集命令行 `echomind-capture`（Swift，Core Audio Process Tap） |
| `native/transcriber` | 本机转写 `echomind-transcribe`（Rust + sherpa-onnx：SenseVoice、VAD、说话人分离），录音不出电脑 |
| `packages/minutes-engine` | 纪要引擎：DeepSeek 调用、证据校验、负责人与截止日期解析 |
| `packages/shared` | 数据结构（zod）、北京时间格式化、示例会议 |
| `packages/ui` | 设计 token、手绘插画引擎和全部插画 |
| `apps/web` | 早期的 Web 版设计稿 |

## 开发

需要 Node 24、pnpm 11、Rust（`rustup`）、Xcode Command Line Tools、macOS 14.2+。

```bash
pnpm install
pnpm capture:build       # 编译采集模块并放进 src-tauri/binaries（Tauri 打包前必须有）
pnpm transcriber:build   # 编译本机转写模块，同上
pnpm tauri dev           # 启动桌面端
```

只改界面时可以用 `pnpm dev`，在浏览器里打开 http://localhost:1420。浏览器里没有真实录音，会用模拟器生成音量和事件，多个标签页之间共享同一场“录音”。开发时可以打开 `#/art` 查看全部插画，打开 `#/welcome` 查看首次启动向导。

```bash
pnpm typecheck && pnpm test
```

## 手机端（安卓）

第一版只做面对面开会：手机放在桌上录音，在手机上转写，生成纪要，确认待办后推到飞书。手机上只有在这台手机上录的会议，录音和逐字稿不备份、不同步。界面和桌面端是同一套代码，手机上换成 `src/mobile` 里的页面；Rust 里手机专用的部分在 `src-tauri/src/mobile`。

需要 Android Studio（含 SDK 和 NDK 27）和 JDK 17（`brew install openjdk@17`）。

```bash
pnpm android:build             # 调试版，连着手机或模拟器时直接装上去
pnpm android:build --release   # 正式版，还没有签名，不能直接发给别人
```

- 语音模型（约 270 MB）打进安装包，第一次打开时解压到应用的数据目录。打包前 `src-tauri/resources/models` 里没有模型时，脚本会从这台 Mac 的 EchoMind 数据目录复制。
- 录音在前台服务里进行，锁屏、切到别的应用、从最近任务里划掉都不停（划掉后再打开，页面接着显示正在进行的录音）；来电占用麦克风时自动暂停，挂断后继续。录完后服务继续留在前台，直到转写和纪要做完，因为安卓会冻结后台应用、切断它的网络。
- 应用不在时结束的录音（从通知栏结束），或者被系统中途停掉的录音，下次打开 EchoMind 时自动补成会议并开始转写。
- 回放走应用自己在 127.0.0.1 上开的小服务（路径带随机口令），因为安卓的 WebView 不能用自定义协议按位置读取录音。
- 调试时可以在 Chrome 打开 `chrome://inspect` 查看手机里的页面。只改界面时，`pnpm dev` 加浏览器的手机尺寸模拟（User-Agent 要是安卓或 iPhone）就能看到手机版页面。

## 纪要引擎（DeepSeek）

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm minutes --fixture --out minutes-result.json
```

默认模型是 `deepseek-flash`；`deepseek-chat` 已停用。没有 key 时可以加 `--mock` 看输出格式。细节见 [packages/minutes-engine/README.md](packages/minutes-engine/README.md)。

## 现在能做什么

桌面应用里是真实数据，浏览器预览（`pnpm dev`）里是示例会议。

- **录音（macOS）**：保存在 `~/Library/Application Support/com.evanbyte.echomind/recordings/`，每场一个文件夹：WAV 分段、`manifest.json`、`meeting.json`（会议、纪要、待办）、`transcript.json`。
- **转写**：在本机完成。第一次使用要下载约 200 MB 模型（`models/`，可用 `ECHOMIND_MODEL_MIRROR` 换镜像）。
- **纪要**：转写后自动调用 DeepSeek 生成议题、纪要和待办，只发送文字稿。
- **飞书**：登录、读取通讯录、按日历找参会人和会议名、确认后把待办推送成飞书任务（外部待办推给记录人自己跟进）。
- **配置**：密钥写在 `apps/desktop/.env.local`（`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`DEEPSEEK_API_KEY`），只在 Rust 进程里读取。
- **还没做**：每日待办卡片、发到飞书群、声纹、导出；Windows 版的采集（WASAPI loopback）和转写模块。Windows 上可以看界面，开始录音时会提示「开发中」。

接口约定见 [docs/desktop-ipc.md](docs/desktop-ipc.md)。

## 插画

插画全部是代码画的 SVG（`packages/ui/src/art`），走 Claude 风格：墨色线条，陶土色 `#D97757` 是唯一的强调色，深色模式下变成粉笔效果。系统设置为「减少动态效果」时，插画直接显示画完的样子。应用图标的源文件在 `apps/desktop/src-tauri/icons/source/`，改完后运行 `pnpm tauri icon src-tauri/icons/source/app-icon.svg -o src-tauri/icons` 重新生成。安卓图标是浅米色底加 EchoMark（`android-bg.svg`、`android-fg.svg`，清单 `android.json`），用 `pnpm tauri icon $PWD/src-tauri/icons/source/android.json -o <临时目录>` 生成后，把其中的 `android/` 复制到 `src-tauri/gen/android/app/src/main/res`。
