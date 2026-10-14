import Foundation

struct ArgumentError: Error {
    let message: String
}

/// Minimal `--flag value` / `--flag=value` reader that rejects unknown arguments.
struct Arguments {
    private var items: [String]

    init(_ args: [String]) {
        items = args.flatMap { arg -> [String] in
            guard arg.hasPrefix("--"), let eq = arg.firstIndex(of: "=") else { return [arg] }
            return [String(arg[..<eq]), String(arg[arg.index(after: eq)...])]
        }
    }

    mutating func flag(_ name: String) -> Bool {
        guard let i = items.firstIndex(of: name) else { return false }
        items.remove(at: i)
        return true
    }

    mutating func value(_ name: String) throws -> String? {
        guard let i = items.firstIndex(of: name) else { return nil }
        guard i + 1 < items.count, !items[i + 1].hasPrefix("--") else {
            throw ArgumentError(message: "\(name) 需要一个值")
        }
        let value = items[i + 1]
        items.removeSubrange(i...i + 1)
        return value
    }

    mutating func int(_ name: String, in range: ClosedRange<Int>) throws -> Int? {
        guard let raw = try value(name) else { return nil }
        guard let n = Int(raw), range.contains(n) else {
            throw ArgumentError(message: "\(name) 必须是 \(range.lowerBound)…\(range.upperBound) 之间的整数，收到 \(raw)")
        }
        return n
    }

    func finish() throws {
        if let unknown = items.first { throw ArgumentError(message: "未知参数 \(unknown)") }
    }
}

/// Subcommand dispatch.
enum CLI {
    static let usage = """
        echomind-capture — EchoMind 的 macOS 音频采集 sidecar

        用法:
          echomind-capture record --out <dir> [--segment-seconds 60] [--sample-rate 16000]
                                  [--system-pids 1,2] [--mic-device <uid>] [--no-system] [--no-mic]
              stdout: JSON Lines 事件；stdin 指令: pause | resume | mark | stop
          echomind-capture devices
          echomind-capture meetings [--verbose]
          echomind-capture permissions [--request-mic]
          echomind-capture selftest --out <dir>

        """

    static func main(_ argv: [String]) -> Never {
        guard let command = argv.first else {
            writeAll(fd: STDERR_FILENO, usage)
            exit(2)
        }
        var args = Arguments(Array(argv.dropFirst()))
        do {
            switch command {
            case "record":
                let options = try parseRecord(&args)
                RecordSession.run(options)
            case "devices":
                try args.finish()
                StdoutSink.shared.emit(DevicesCommand.json())
            case "meetings":
                let verbose = args.flag("--verbose")
                try args.finish()
                StdoutSink.shared.emit(Meetings.json(verbose: verbose))
            case "permissions":
                let request = args.flag("--request-mic")
                try args.finish()
                if request { PermissionsCommand.requestMicrophone() }
                StdoutSink.shared.emit(PermissionsCommand.json())
            case "selftest":
                guard let out = try args.value("--out") else { throw ArgumentError(message: "缺少 --out <dir>") }
                try args.finish()
                exit(SelfTest.run(outDir: absoluteURL(out)))
            case "help", "--help", "-h":
                writeAll(fd: STDOUT_FILENO, usage)
            default:
                throw ArgumentError(message: "未知子命令 \(command)")
            }
        } catch let error as ArgumentError {
            StdoutSink.shared.error("invalid_arguments", "参数错误：\(error.message)")
            writeAll(fd: STDERR_FILENO, usage)
            exit(2)
        } catch {
            StdoutSink.shared.error("internal_error", "内部错误：\(error)")
            exit(1)
        }
        exit(0)
    }

    private static func parseRecord(_ args: inout Arguments) throws -> RecordOptions {
        guard let out = try args.value("--out") else { throw ArgumentError(message: "缺少 --out <dir>") }
        var options = RecordOptions(outDir: absoluteURL(out))
        if let n = try args.int("--segment-seconds", in: 1...3600) { options.segmentSeconds = n }
        if let n = try args.int("--sample-rate", in: 8000...48000) { options.sampleRate = n }
        if let raw = try args.value("--system-pids") {
            let pids = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            let parsed = pids.compactMap { pid_t($0) }.filter { $0 > 0 }
            guard !parsed.isEmpty, parsed.count == pids.count else {
                throw ArgumentError(message: "--system-pids 需要逗号分隔的 PID，收到 \(raw)")
            }
            options.systemScope = .pids(parsed)
        }
        options.micDeviceUID = try args.value("--mic-device")
        options.mic = !args.flag("--no-mic")
        options.system = !args.flag("--no-system")
        try args.finish()
        return options
    }

    private static func absoluteURL(_ path: String) -> URL {
        let expanded = (path as NSString).expandingTildeInPath
        return URL(fileURLWithPath: expanded).standardizedFileURL
    }
}
