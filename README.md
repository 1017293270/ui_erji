# EchoMind

AI 会议纪要助手。开会时在电脑上同时录两路声音（麦克风 = 我，系统声音 = 其他参会人），会后生成带出处的纪要和待办，记录人确认后推送到飞书。大模型用 DeepSeek，数据留在国内。

## 目录

| 路径 | 内容 |
| --- | --- |
| `apps/desktop` | 桌面端（Tauri 2 + React 19 + Tailwind 4），界面和手绘插画都在这里 |
| `apps/desktop/src-tauri` | Rust 外壳：主窗口、录音浮窗、菜单栏图标、两个 sidecar、会议存储、飞书与 DeepSeek 代理（密钥不进网页） |
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

插画全部是代码画的 SVG（`packages/ui/src/art`），走 Claude 风格：墨色线条，陶土色 `#D97757` 是唯一的强调色，深色模式下变成粉笔效果。系统设置为「减少动态效果」时，插画直接显示画完的样子。应用图标的源文件在 `apps/desktop/src-tauri/icons/source/`，改完后运行 `pnpm tauri icon src-tauri/icons/source/app-icon.svg -o src-tauri/icons` 重新生成。
