import Darwin
import Foundation

/// The “System Audio Recording” permission (kTCCServiceAudioCapture), which the process tap needs.
///
/// macOS has no public API to read or ask for it: a denied tap just delivers silence. This uses the
/// private TCC functions that other audio-capture apps use, looked up at run time, so if a macOS
/// release drops them the status reads `unknown` instead of crashing. Like the microphone, the
/// permission belongs to the responsible app (EchoMind when run as its sidecar).
enum SystemAudioPermission {
    private typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int32
    private typealias Request = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void

    private static var service: CFString { "kTCCServiceAudioCapture" as CFString }

    private static func function<T>(_ name: String, as type: T.Type) -> T? {
        guard let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
            let pointer = dlsym(tcc, name)
        else { return nil }
        return unsafeBitCast(pointer, to: type)
    }

    /// granted | denied | undetermined, or unknown when the private API is missing.
    static func status() -> String {
        guard let preflight = function("TCCAccessPreflight", as: Preflight.self) else { return "unknown" }
        switch preflight(service, nil) {
        case 0: return "granted"
        case 1: return "denied"
        default: return "undetermined"
        }
    }

    /// Shows the prompt if the question is still open, otherwise answers at once. False when the
    /// private API is missing (and `done` is never called).
    static func request(_ done: @escaping @Sendable (Bool) -> Void) -> Bool {
        guard let request = function("TCCAccessRequest", as: Request.self) else { return false }
        request(service, nil) { granted in done(granted) }
        return true
    }
}
