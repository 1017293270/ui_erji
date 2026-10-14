import AVFoundation
import CoreAudio
import Foundation

/// `devices`: input and output devices with their UIDs (pass an input UID to `--mic-device`).
enum DevicesCommand {
    static func json() -> JSON {
        let devices = AudioDevices.all()
        let defaultInput = AudioDevices.defaultDevice(input: true)
        let defaultOutput = AudioDevices.defaultDevice(input: false)
        func entry(_ d: AudioDeviceInfo, isDefault: Bool) -> JSON {
            [
                "uid": .string(d.uid), "name": .string(d.name), "isDefault": .bool(isDefault),
                "transport": .string(d.transport),
            ]
        }
        return [
            "inputs": .array(devices.filter { $0.inputChannels > 0 }.map { entry($0, isDefault: $0.id == defaultInput) }),
            "outputs": .array(devices.filter { $0.outputChannels > 0 }.map { entry($0, isDefault: $0.id == defaultOutput) }),
        ]
    }
}

/// `permissions [--request-mic | --request-system-audio]`.
enum PermissionsCommand {
    static let note =
        "麦克风在“系统设置 → 隐私与安全性 → 麦克风”中管理，系统录音在“系统设置 → 隐私与安全性 → 屏幕与系统录音 → 仅系统录音”中管理。被拒绝过的权限不会再弹窗，只能到设置里打开。权限归属于启动本程序的 App（作为 sidecar 时是 EchoMind，命令行测试时是终端）。系统录音的状态靠 macOS 的私有接口查询，查不到时为 unknown。"

    static func json() -> JSON {
        [
            "microphone": .string(micStatus()),
            "systemAudio": .string(SystemAudioPermission.status()),
            "note": .string(note),
        ]
    }

    static func micStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: "granted"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "undetermined"
        @unknown default: "undetermined"
        }
    }

    /// How long a prompt may stay unanswered (or never appear) before the status is printed anyway,
    /// so the app waiting on it can go on recording.
    static let promptTimeout: DispatchTimeInterval = .seconds(90)

    /// Shows the microphone prompt (if undetermined), then prints the resulting status.
    static func requestMicrophone() -> Never {
        AVCaptureDevice.requestAccess(for: .audio) { _ in finish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + promptTimeout) { finish() }
        dispatchMain()
    }

    /// Shows the system audio recording prompt (if undetermined), then prints the resulting status.
    static func requestSystemAudio() -> Never {
        guard SystemAudioPermission.request({ _ in finish() }) else { finish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + promptTimeout) { finish() }
        dispatchMain()
    }

    private static func finish() -> Never {
        StdoutSink.shared.emit(json())
        exit(0)
    }
}
