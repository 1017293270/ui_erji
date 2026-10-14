import AVFoundation
import CoreAudio
import Foundation

/// Options of `echomind-capture record`.
struct RecordOptions: Sendable {
    var outDir: URL
    var segmentSeconds = 60
    var sampleRate = 16000
    var systemScope: SystemScope = .global
    var micDeviceUID: String?
    var mic = true
    var system = true
}

/// Runs `record`: owns the captures and wires them to the `Recorder` pipeline, stdin commands,
/// signals and device-change listeners.
///
/// Queues: `control` owns captures/listeners/commands; `pipeline` owns the `Recorder`;
/// each capture's IOProc runs on its own queue and only copies + mixes down before hopping to `pipeline`.
final class RecordSession: @unchecked Sendable {
    static func run(_ options: RecordOptions) -> Never {
        let session = RecordSession(options: options)
        session.control.async { session.begin() }
        dispatchMain()
    }

    private static let rebuildDebounce = DispatchTimeInterval.milliseconds(300)
    /// Upper bound on rebuild frequency per track, so a misbehaving device cannot cause a rebuild storm.
    private static let minRebuildIntervalNanos: UInt64 = 1_000_000_000

    private let options: RecordOptions
    private let sink: EventSink = StdoutSink.shared
    private let control = DispatchQueue(label: "echomind.control")
    private let pipeline = DispatchQueue(label: "echomind.pipeline", qos: .userInitiated)
    private let recorder: Recorder
    private var mic: MicCapture?
    private var system: SystemTapCapture?
    private var lastSystemOutput: AudioObjectID?
    private var globalListeners: [PropertyListener] = []
    private var micListeners: [PropertyListener] = []
    private var systemListeners: [PropertyListener] = []
    private var pendingChecks: [TrackKind: DispatchWorkItem] = [:]
    private var lastRebuild: [TrackKind: UInt64] = [:]
    private var timer: DispatchSourceTimer?
    private var signalSources: [DispatchSourceSignal] = []
    private var reportedErrors: Set<String> = []
    private var stopping = false

    private init(options: RecordOptions) {
        self.options = options
        var tracks: [TrackKind] = []
        if options.mic { tracks.append(.mic) }
        if options.system { tracks.append(.system) }
        recorder = Recorder(
            config: .init(
                outDir: options.outDir, sampleRate: options.sampleRate, segmentSeconds: options.segmentSeconds,
                tracks: tracks),
            sink: StdoutSink.shared)
    }

    // MARK: - Lifecycle (control queue)

    private func begin() {
        do {
            try FileManager.default.createDirectory(at: options.outDir, withIntermediateDirectories: true)
            guard FileManager.default.isWritableFile(atPath: options.outDir.path) else {
                throw WavError(description: "目录不可写")
            }
        } catch {
            sink.error("output_dir_unwritable", "无法写入输出目录 \(options.outDir.path)：\(error)")
            exit(1)
        }
        recorder.onFatalError = { [self] in
            control.async { self.stop(exitCode: 1) }
        }

        let t0 = HostClock.nowNanos()
        let startedAt = Date()
        pipeline.sync { recorder.start(t0Nanos: t0, startedAt: startedAt) }
        // Handlers run on `control`, so a signal arriving while devices start is handled right after.
        installSignalHandlers()

        let micDevice = options.mic ? resolveMicDevice() : nil
        let output = AudioDevices.defaultDevice(input: false)
        sink.emit([
            "type": "started",
            "startedAt": .string(recorder.startedAtISO),
            "sampleRate": .num(options.sampleRate),
            "segmentSeconds": .num(options.segmentSeconds),
            "out": .string(options.outDir.path),
            "mic": options.mic ? ["device": .optional(micDevice.map(AudioDevices.name))] : .null,
            "system": options.system
                ? ["scope": .string(options.systemScope.name), "device": .optional(output.map(AudioDevices.name))]
                : .null,
        ])

        if options.mic {
            startMic(micDevice)
            checkMicPermission()
        }
        if options.system { startSystem() }
        installGlobalListeners()
        startTimer()
        startStdinReader()
    }

    private func stop(exitCode: Int32) {
        guard !stopping else { return }
        stopping = true
        let now = HostClock.nowNanos()
        pendingChecks.values.forEach { $0.cancel() }
        globalListeners.forEach { $0.cancel() }
        globalListeners = []
        stopMic()
        stopSystem()
        timer?.cancel()
        pipeline.sync { recorder.stop(nowNanos: now) }
        exit(exitCode)
    }

    private func handle(_ command: String) {
        guard !stopping else { return }
        let now = HostClock.nowNanos()
        let recorder = self.recorder
        switch command {
        case "pause":
            pipeline.async { if !recorder.pause(nowNanos: now) { Log.info("忽略 pause：已经暂停") } }
        case "resume":
            pipeline.async { if !recorder.resume(nowNanos: now) { Log.info("忽略 resume：当前没有暂停") } }
        case "mark":
            pipeline.async { recorder.mark(nowNanos: now) }
        case "stop":
            stop(exitCode: 0)
        default:
            sink.error("unknown_command", "无法识别的控制指令“\(command)”，支持 pause / resume / mark / stop。")
        }
    }

    private func reportOnce(_ code: String, _ message: String) {
        guard reportedErrors.insert(code).inserted else { return }
        sink.error(code, message)
    }

    // MARK: - Microphone

    private func resolveMicDevice() -> AudioObjectID? {
        if let uid = options.micDeviceUID {
            if let id = AudioDevices.device(uid: uid), AudioDevices.channelCount(id, kAudioObjectPropertyScopeInput) > 0 {
                return id
            }
            Log.info("指定的麦克风 \(uid) 不可用，改用系统默认输入设备")
        }
        return AudioDevices.defaultDevice(input: true)
    }

    private func startMic(_ preferred: AudioObjectID?) {
        guard let device = preferred ?? resolveMicDevice() else {
            reportOnce("mic_unavailable", "没有可用的麦克风。接入麦克风后会自动继续录制，期间麦克风轨为静音。")
            return
        }
        let pipeline = self.pipeline
        let recorder = self.recorder
        do {
            let capture = try MicCapture(deviceID: device) { chunk in
                pipeline.async { recorder.ingest(chunk, into: .mic) }
            }
            try capture.start()
            mic = capture
            reportedErrors.subtract(["mic_unavailable", "mic_start_failed"])
            micListeners = [
                (kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal),
                (kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal),
                (kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput),
            ].compactMap { selector, scope in
                PropertyListener(device, selector, scope, queue: control) { [weak self] in self?.scheduleCheck(.mic) }
            }
        } catch {
            reportOnce("mic_start_failed", "无法启动麦克风“\(AudioDevices.name(device))”：\(error)")
        }
    }

    private func stopMic() {
        micListeners.forEach { $0.cancel() }
        micListeners = []
        mic?.stop()
        mic = nil
    }

    /// Re-targets the mic when the preferred/default input changes, dies, or changes format.
    private func micCheck() {
        guard options.mic, !stopping else { return }
        let desired = resolveMicDevice()
        let previous = mic?.deviceID
        if let current = mic {
            let healthy =
                AudioDevices.isAlive(current.deviceID)
                && AudioDevices.nominalSampleRate(current.deviceID) == current.layout.sampleRate
                && AudioDevices.channelCount(current.deviceID, kAudioObjectPropertyScopeInput) == current.inputChannels
            if desired == current.deviceID && healthy { return }
            stopMic()
        } else if desired == nil {
            return
        }
        lastRebuild[.mic] = HostClock.nowNanos()
        startMic(desired)
        guard let now = mic else { return }
        if now.deviceID != previous {
            sink.emit(["type": "device-changed", "track": "mic", "device": .string(now.deviceName)])
        } else {
            Log.info("麦克风格式变化，已在同一设备上重建采集")
        }
    }

    private func checkMicPermission() {
        let denied = "麦克风权限被拒绝，麦克风轨将是静音。请在“系统设置 → 隐私与安全性 → 麦克风”中允许 EchoMind（命令行测试时是所用的终端 App）。"
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .denied, .restricted:
            reportOnce("mic_permission_denied", denied)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [self] granted in
                control.async {
                    guard !self.stopping else { return }
                    if granted {
                        Log.info("已获得麦克风权限，重启麦克风采集")
                        self.stopMic()
                        self.startMic(nil)
                    } else {
                        self.reportOnce("mic_permission_denied", denied)
                    }
                }
            }
        default:
            break
        }
    }

    // MARK: - System audio

    private func startSystem() {
        let pipeline = self.pipeline
        let recorder = self.recorder
        let capture = SystemTapCapture(scope: options.systemScope) { chunk in
            pipeline.async { recorder.ingest(chunk, into: .system) }
        }
        do {
            try capture.start()
            system = capture
            lastSystemOutput = capture.outputDeviceID
            reportedErrors.subtract(["system_tap_failed", "system_pids_not_found"])
            systemListeners = [
                PropertyListener(capture.tapID, kAudioTapPropertyFormat, queue: control) { [weak self] in
                    self?.scheduleCheck(.system)
                },
                PropertyListener(capture.aggregateID, kAudioDevicePropertyDeviceIsAlive, queue: control) { [weak self] in
                    self?.scheduleCheck(.system)
                },
            ].compactMap { $0 }
        } catch CaptureError.noProcesses(let pids) {
            reportOnce(
                "system_pids_not_found",
                "指定的会议进程（PID \(pids.map(String.init).joined(separator: ","))）还没有使用音频，系统声音轨暂为静音；进程开始发声后会自动接上。")
        } catch {
            reportOnce(
                "system_tap_failed",
                "无法录制系统声音：\(error)。请确认 macOS 14.2 以上，并在“系统设置 → 隐私与安全性 → 屏幕与系统录音 → 仅系统录音”中允许 EchoMind。")
        }
    }

    private func stopSystem() {
        systemListeners.forEach { $0.cancel() }
        systemListeners = []
        system?.stop()
        system = nil
    }

    /// Rebuilds tap + aggregate when the default output, the tap format or the tapped PID set changes.
    private func systemCheck() {
        guard options.system, !stopping else { return }
        let output = AudioDevices.defaultDevice(input: false)
        if let current = system {
            var healthy = current.outputDeviceID == output && AudioDevices.isAlive(current.aggregateID)
            if healthy, let built = current.tapSampleRate, let now = current.currentTapLayout(),
                now.sampleRate != built
            {
                healthy = false
            }
            if healthy, case .pids(let pids) = options.systemScope,
                SystemTapCapture.resolveProcessObjects(pids) != current.processObjects
            {
                healthy = false
            }
            if healthy { return }
            stopSystem()
        }
        let previousOutput = lastSystemOutput
        lastRebuild[.system] = HostClock.nowNanos()
        startSystem()
        guard let now = system else { return }
        if let previousOutput, let device = now.outputDeviceID, device != previousOutput {
            sink.emit(["type": "device-changed", "track": "system", "device": .string(AudioDevices.name(device))])
        } else {
            Log.info("系统声音 tap 已重建")
        }
    }

    // MARK: - Device-change scheduling

    /// Debounces bursts of HAL notifications (e.g. AirPods connecting) into one check per track.
    private func scheduleCheck(_ track: TrackKind, after delay: DispatchTimeInterval = rebuildDebounce) {
        guard !stopping, track == .mic ? options.mic : options.system else { return }
        pendingChecks[track]?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.runCheck(track) }
        pendingChecks[track] = item
        control.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func runCheck(_ track: TrackKind) {
        if let last = lastRebuild[track] {
            let elapsed = HostClock.nowNanos() &- last
            if elapsed < Self.minRebuildIntervalNanos {
                scheduleCheck(track, after: .nanoseconds(Int(Self.minRebuildIntervalNanos - elapsed)))
                return
            }
        }
        switch track {
        case .mic: micCheck()
        case .system: systemCheck()
        }
    }

    // MARK: - Wiring

    private func installGlobalListeners() {
        func listen(_ selector: AudioObjectPropertySelector, _ action: @escaping @Sendable (RecordSession) -> Void) {
            if let listener = PropertyListener(CA.system, selector, queue: control, handler: { [weak self] in
                if let self { action(self) }
            }) {
                globalListeners.append(listener)
            }
        }
        listen(kAudioHardwarePropertyDefaultInputDevice) { $0.scheduleCheck(.mic) }
        // Device-list changes only matter for the mic (a --mic-device coming back); the system tap
        // watches the default output and its own aggregate, and creating that aggregate itself
        // changes the device list.
        listen(kAudioHardwarePropertyDevices) { $0.scheduleCheck(.mic) }
        listen(kAudioHardwarePropertyDefaultOutputDevice) { $0.scheduleCheck(.system) }
        if case .pids = options.systemScope {
            listen(kAudioHardwarePropertyProcessObjectList) { $0.scheduleCheck(.system) }
        }
    }

    private func startTimer() {
        let recorder = self.recorder
        let timer = DispatchSource.makeTimerSource(queue: pipeline)
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100), leeway: .milliseconds(5))
        timer.setEventHandler { recorder.tick(nowNanos: HostClock.nowNanos()) }
        timer.resume()
        self.timer = timer
    }

    private func installSignalHandlers() {
        for sig in [SIGINT, SIGTERM, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: control)
            source.setEventHandler { [weak self] in
                Log.info("收到信号 \(sig)，停止录音")
                self?.stop(exitCode: 0)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    /// Reads newline-terminated commands; EOF (parent gone) stops the recording.
    private func startStdinReader() {
        let thread = Thread { [self] in
            while let line = readLine(strippingNewline: true) {
                let command = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard !command.isEmpty else { continue }
                control.async { self.handle(command) }
            }
            control.async {
                Log.info("stdin 已关闭，停止录音")
                self.stop(exitCode: 0)
            }
        }
        thread.name = "echomind.stdin"
        thread.start()
    }
}
