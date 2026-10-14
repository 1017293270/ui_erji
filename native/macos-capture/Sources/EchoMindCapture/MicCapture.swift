import CoreAudio
import Foundation

enum CaptureError: Error, CustomStringConvertible {
    case unsupportedFormat(String)
    case noProcesses([pid_t])

    var description: String {
        switch self {
        case .unsupportedFormat(let what): "不支持的音频格式：\(what)"
        case .noProcesses(let pids): "这些 PID 没有 Core Audio 进程对象：\(pids.map(String.init).joined(separator: ","))"
        }
    }
}

/// Microphone capture through a HAL IOProc on one input device.
///
/// Chunks are stamped with the IO buffer's input host time minus the device + stream input latency,
/// i.e. roughly when the sound reached the microphone.
final class MicCapture: @unchecked Sendable {
    let deviceID: AudioObjectID
    let deviceName: String
    let layout: PCMLayout
    let inputChannels: Int
    private let latencyNanos: UInt64
    private let onChunk: @Sendable (AudioChunk) -> Void
    private let ioQueue = DispatchQueue(label: "echomind.mic.io", qos: .userInteractive)
    private var procID: AudioDeviceIOProcID?

    init(deviceID: AudioObjectID, onChunk: @escaping @Sendable (AudioChunk) -> Void) throws {
        self.deviceID = deviceID
        self.onChunk = onChunk
        deviceName = AudioDevices.name(deviceID)
        inputChannels = AudioDevices.channelCount(deviceID, kAudioObjectPropertyScopeInput)
        guard inputChannels > 0 else { throw CaptureError.unsupportedFormat("\(deviceName) 没有输入通道") }
        guard var asbd = AudioDevices.firstStreamFormat(deviceID, kAudioObjectPropertyScopeInput) else {
            throw CaptureError.unsupportedFormat("无法读取 \(deviceName) 的输入格式")
        }
        if let nominal = AudioDevices.nominalSampleRate(deviceID), nominal > 0 { asbd.mSampleRate = nominal }
        guard let layout = PCMLayout(asbd) else {
            throw CaptureError.unsupportedFormat("\(deviceName): \(asbd.mBitsPerChannel) bit, flags \(asbd.mFormatFlags)")
        }
        self.layout = layout
        let latencyFrames = AudioDevices.inputLatencyFrames(deviceID)
        latencyNanos = UInt64(Double(latencyFrames) / layout.sampleRate * 1e9)
    }

    func start() throws {
        let layout = self.layout
        let latency = latencyNanos
        let onChunk = self.onChunk
        var proc: AudioDeviceIOProcID?
        try check(
            AudioDeviceCreateIOProcIDWithBlock(&proc, deviceID, ioQueue) { _, inputData, inputTime, _, _ in
                let samples = layout.monoSamples(inputData)
                guard !samples.isEmpty else { return }
                let host: UInt64
                if inputTime.pointee.mFlags.contains(.hostTimeValid) {
                    host = HostClock.nanos(hostTime: inputTime.pointee.mHostTime)
                } else {
                    host = HostClock.nowNanos() &- UInt64(Double(samples.count) / layout.sampleRate * 1e9)
                }
                onChunk(AudioChunk(hostNanos: host &- latency, sampleRate: layout.sampleRate, samples: samples))
            },
            "AudioDeviceCreateIOProcIDWithBlock(mic)")
        guard let proc else { throw CoreAudioError(operation: "AudioDeviceCreateIOProcIDWithBlock(mic)", status: -1) }
        procID = proc
        do {
            try check(AudioDeviceStart(deviceID, proc), "AudioDeviceStart(\(deviceName))")
        } catch {
            stop()
            throw error
        }
        Log.info("麦克风已启动: \(deviceName) \(Int(layout.sampleRate)) Hz, \(inputChannels) ch, 延迟补偿 \(latency / 1_000_000) ms")
    }

    /// Stops IO and waits for in-flight callbacks. Idempotent.
    func stop() {
        guard let proc = procID else { return }
        AudioDeviceStop(deviceID, proc)
        AudioDeviceDestroyIOProcID(deviceID, proc)
        procID = nil
        ioQueue.sync {}
    }
}
