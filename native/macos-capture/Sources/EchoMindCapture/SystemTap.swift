import CoreAudio
import Foundation

/// Which processes the system track taps.
enum SystemScope: Sendable, Equatable {
    /// Everything the Mac plays, except this process.
    case global
    /// Only these PIDs (e.g. the meeting app and its audio helpers).
    case pids([pid_t])

    var name: String {
        switch self {
        case .global: "global"
        case .pids: "pids"
        }
    }
}

/// System audio capture: a private Core Audio process tap (macOS 14.2+) wrapped in a private
/// aggregate device that contains only the tap, read with an IOProc. Destroys both on `stop()`.
final class SystemTapCapture: @unchecked Sendable {
    let scope: SystemScope
    private(set) var tapID = AudioObjectID(kAudioObjectUnknown)
    private(set) var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private(set) var layout: PCMLayout?
    /// Tap sample rate at build time; a different `kAudioTapPropertyFormat` later means rebuild.
    private(set) var tapSampleRate: Double?
    /// Default output device when the tap was built; a change triggers a rebuild.
    private(set) var outputDeviceID: AudioObjectID?
    /// Process objects included in a `.pids` tap.
    private(set) var processObjects: [AudioObjectID] = []
    private var procID: AudioDeviceIOProcID?
    private let onChunk: @Sendable (AudioChunk) -> Void
    private let ioQueue = DispatchQueue(label: "echomind.system.io", qos: .userInteractive)

    init(scope: SystemScope, onChunk: @escaping @Sendable (AudioChunk) -> Void) {
        self.scope = scope
        self.onChunk = onChunk
    }

    static func resolveProcessObjects(_ pids: [pid_t]) -> [AudioObjectID] {
        pids.compactMap(AudioProcesses.processObject(for:))
    }

    /// Creates tap → aggregate device → IOProc and starts IO. On failure everything created is destroyed.
    func start() throws {
        do {
            try build()
        } catch {
            stop()
            throw error
        }
    }

    /// Current tap format, used to detect sample-rate / channel changes.
    func currentTapLayout() -> PCMLayout? {
        guard tapID != kAudioObjectUnknown,
            let asbd = try? CA.value(tapID, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
        else { return nil }
        return PCMLayout(asbd)
    }

    /// Stops IO, destroys the IOProc, the aggregate device and the tap. Idempotent.
    func stop() {
        if let proc = procID {
            AudioDeviceStop(aggregateID, proc)
            AudioDeviceDestroyIOProcID(aggregateID, proc)
            procID = nil
            ioQueue.sync {}
        }
        if aggregateID != kAudioObjectUnknown {
            let status = AudioHardwareDestroyAggregateDevice(aggregateID)
            if status != noErr { Log.info("销毁聚合设备失败: \(CoreAudioError.render(status))") }
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            let status = AudioHardwareDestroyProcessTap(tapID)
            if status != noErr { Log.info("销毁 process tap 失败: \(CoreAudioError.render(status))") }
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    private func build() throws {
        outputDeviceID = AudioDevices.defaultDevice(input: false)

        let description: CATapDescription
        switch scope {
        case .global:
            let own = AudioProcesses.processObject(for: getpid()).map { [$0] } ?? []
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: own)
        case .pids(let pids):
            processObjects = Self.resolveProcessObjects(pids)
            guard !processObjects.isEmpty else { throw CaptureError.noProcesses(pids) }
            description = CATapDescription(stereoMixdownOfProcesses: processObjects)
        }
        description.name = "EchoMind System Audio"
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(description, &tap), "AudioHardwareCreateProcessTap")
        tapID = tap
        let tapUID = CA.string(tap, kAudioTapPropertyUID) ?? description.uuid.uuidString

        let composition: [String: Any] = [
            kAudioAggregateDeviceNameKey: "EchoMind System Tap",
            kAudioAggregateDeviceUIDKey: "com.evanbyte.echomind.capture.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceSubDeviceListKey: [] as [Any],
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: true]
            ],
        ]
        var aggregate = AudioObjectID(kAudioObjectUnknown)
        try check(
            AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggregate),
            "AudioHardwareCreateAggregateDevice")
        aggregateID = aggregate
        ensureTapAttached(tapUID)

        let streamFormat = AudioDevices.firstStreamFormat(aggregate, kAudioObjectPropertyScopeInput)
        let tapFormat = try? CA.value(tap, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
        guard let asbd = streamFormat ?? tapFormat, let layout = PCMLayout(asbd) else {
            throw CaptureError.unsupportedFormat("process tap")
        }
        tapSampleRate = tapFormat?.mSampleRate
        if let tapFormat, tapFormat.mSampleRate != asbd.mSampleRate {
            Log.info("tap 格式 \(tapFormat.mSampleRate) Hz 与聚合设备流 \(asbd.mSampleRate) Hz 不一致，按聚合设备流处理")
        }
        self.layout = layout

        let onChunk = self.onChunk
        var proc: AudioDeviceIOProcID?
        try check(
            AudioDeviceCreateIOProcIDWithBlock(&proc, aggregate, ioQueue) { _, inputData, inputTime, _, _ in
                let samples = layout.monoSamples(inputData)
                guard !samples.isEmpty else { return }
                let host: UInt64
                if inputTime.pointee.mFlags.contains(.hostTimeValid) {
                    host = HostClock.nanos(hostTime: inputTime.pointee.mHostTime)
                } else {
                    host = HostClock.nowNanos() &- UInt64(Double(samples.count) / layout.sampleRate * 1e9)
                }
                onChunk(AudioChunk(hostNanos: host, sampleRate: layout.sampleRate, samples: samples))
            },
            "AudioDeviceCreateIOProcIDWithBlock(tap)")
        guard let proc else { throw CoreAudioError(operation: "AudioDeviceCreateIOProcIDWithBlock(tap)", status: -1) }
        procID = proc
        try check(AudioDeviceStart(aggregate, proc), "AudioDeviceStart(tap)")

        let output = outputDeviceID.map(AudioDevices.name) ?? "无"
        Log.info("系统声音 tap 已启动: scope=\(scope.name) \(Int(layout.sampleRate)) Hz \(layout.channels) ch, 默认输出=\(output)")
    }

    /// Apple's sample adds the tap via kAudioAggregateDevicePropertyTapList; do the same if the
    /// composition key did not attach it.
    private func ensureTapAttached(_ tapUID: String) {
        var addr = CA.address(kAudioAggregateDevicePropertyTapList)
        var current: Unmanaged<CFArray>?
        var size = UInt32(MemoryLayout<Unmanaged<CFArray>?>.size)
        if AudioObjectGetPropertyData(aggregateID, &addr, 0, nil, &size, &current) == noErr,
            let list = current?.takeRetainedValue() as? [String],
            list.contains(where: { $0.caseInsensitiveCompare(tapUID) == .orderedSame })
        {
            return
        }
        let list = [tapUID] as CFArray
        var ref = Unmanaged.passUnretained(list)
        let status = withExtendedLifetime(list) {
            AudioObjectSetPropertyData(aggregateID, &addr, 0, nil, UInt32(MemoryLayout<CFArray>.size), &ref)
        }
        if status != noErr { Log.info("设置聚合设备 tap 列表失败: \(CoreAudioError.render(status))") }
    }
}
