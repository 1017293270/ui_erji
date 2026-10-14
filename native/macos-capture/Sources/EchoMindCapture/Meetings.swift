import AppKit
import CoreAudio
import Foundation

/// `meetings`: running meeting apps, joined with Core Audio process objects to tell whether each
/// one (including helper processes) is using the microphone or playing audio right now.
enum Meetings {
    struct KnownApp {
        let key: String
        let bundleIDs: [String]
    }

    /// Verified against installed bundles where possible (see README).
    static let known: [KnownApp] = [
        KnownApp(key: "tencent", bundleIDs: ["com.tencent.meeting", "com.tencent.tencentmeeting"]),
        KnownApp(key: "feishu", bundleIDs: ["com.electron.lark", "com.bytedance.macos.feishu"]),
        KnownApp(key: "lark", bundleIDs: ["com.larksuite.macos.lark"]),
        KnownApp(key: "zoom", bundleIDs: ["us.zoom.xos"]),
    ]

    /// `verbose` also lists every Core Audio process object (handy for finding a new app's audio helper).
    static func json(verbose: Bool = false) -> JSON {
        let processes = AudioProcesses.all()
        var meetings: [JSON] = []
        for app in NSWorkspace.shared.runningApplications {
            guard let bundleID = app.bundleIdentifier, let key = appKey(bundleID: bundleID, bundleURL: app.bundleURL)
            else { continue }
            let pid = app.processIdentifier
            let bundlePath = app.bundleURL?.standardizedFileURL.path
            let related = processes.filter { process in
                belongs(process, toApp: pid, bundleID: bundleID, bundlePath: bundlePath)
            }
            meetings.append([
                "app": .string(key),
                "name": .string(app.localizedName ?? bundleID),
                "pid": .int(Int64(pid)),
                "bundleId": .string(bundleID),
                "usingMic": .bool(related.contains { $0.runningInput }),
                "playingAudio": .bool(related.contains { $0.runningOutput }),
                "audioPids": .array(Set(related.map(\.pid)).sorted().map { .int(Int64($0)) }),
            ])
        }
        guard verbose else { return ["meetings": .array(meetings)] }
        let all: [JSON] = processes.map { p in
            [
                "pid": .int(Int64(p.pid)), "bundleId": .optional(p.bundleID),
                "path": .optional(executablePath(p.pid)), "runningInput": .bool(p.runningInput),
                "runningOutput": .bool(p.runningOutput),
            ]
        }
        return ["meetings": .array(meetings), "audioProcesses": .array(all)]
    }

    /// `com.electron.lark` is shipped by both Feishu (飞书) and older Lark builds; the bundle name decides.
    private static func appKey(bundleID: String, bundleURL: URL?) -> String? {
        guard let app = known.first(where: { $0.bundleIDs.contains(bundleID) }) else { return nil }
        if bundleID == "com.electron.lark", let url = bundleURL,
            let name = Bundle(url: url)?.object(forInfoDictionaryKey: "CFBundleName") as? String,
            !name.localizedCaseInsensitiveContains("feishu")
        {
            return "lark"
        }
        return app.key
    }

    /// A process counts for the app if it is the app, has a child bundle id, lives inside the app
    /// bundle (helpers, XPC services), or descends from the app process.
    private static func belongs(
        _ process: AudioProcesses.Info, toApp pid: pid_t, bundleID: String, bundlePath: String?
    ) -> Bool {
        if process.pid == pid { return true }
        if let id = process.bundleID, id == bundleID || id.hasPrefix(bundleID + ".") { return true }
        if let bundlePath, let path = executablePath(process.pid), path.hasPrefix(bundlePath + "/") { return true }
        return isDescendant(process.pid, of: pid)
    }

    private static func executablePath(_ pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        let path = String(decoding: buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return URL(fileURLWithPath: path).standardizedFileURL.path
    }

    private static func isDescendant(_ pid: pid_t, of ancestor: pid_t) -> Bool {
        var current = pid
        for _ in 0..<16 {
            guard let parent = parentPID(current), parent > 1 else { return false }
            if parent == ancestor { return true }
            current = parent
        }
        return false
    }

    private static func parentPID(_ pid: pid_t) -> pid_t? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return info.kp_eproc.e_ppid
    }
}
