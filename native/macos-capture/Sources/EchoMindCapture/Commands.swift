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

/// `permissions [--request-mic]`.
enum PermissionsCommand {
    static let systemAudioNote =
        "macOS 没有查询“系统录音”(kTCCServiceAudioCapture) 授权状态的公开 API，所以 systemAudio 固定为 unknown。首次开始录制系统声音时系统会弹窗；若被拒绝，tap 只会收到静音，需要到“系统设置 → 隐私与安全性 → 屏幕与系统录音 → 仅系统录音”中开启。权限归属于启动本程序的 App（作为 sidecar 时是 EchoMind，命令行测试时是终端）。"

    static func json() -> JSON {
        [
            "microphone": .string(micStatus()),
            "systemAudio": "unknown",
            "note": .string(systemAudioNote),
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

    /// Shows the microphone prompt (if undetermined), then prints the resulting status.
    static func requestMicrophone() -> Never {
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            StdoutSink.shared.emit(json())
            exit(0)
        }
        dispatchMain()
    }
}
