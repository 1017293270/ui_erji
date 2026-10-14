import Foundation

/// A JSON value whose objects keep insertion order, so event lines read `{"type":...}` first.
enum JSON: Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSON])
    case object([(String, JSON)])

    static func num(_ value: Int) -> JSON { .int(Int64(value)) }
    static func optional(_ value: String?) -> JSON { value.map(JSON.string) ?? .null }

    /// Rounds to one decimal place (used for dBFS and diagnostics).
    static func rounded(_ value: Double) -> JSON { .double((value * 10).rounded() / 10) }

    subscript(key: String) -> JSON? {
        guard case .object(let pairs) = self else { return nil }
        return pairs.first(where: { $0.0 == key })?.1
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var intValue: Int64? {
        switch self {
        case .int(let i): return i
        case .double(let d): return Int64(d)
        default: return nil
        }
    }

    func serialized() -> String {
        var out = ""
        write(to: &out)
        return out
    }

    private func write(to out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .double(let d): out += d.isFinite ? String(d) : "null"
        case .string(let s): JSON.writeString(s, to: &out)
        case .array(let items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                item.write(to: &out)
            }
            out += "]"
        case .object(let pairs):
            out += "{"
            for (i, (key, value)) in pairs.enumerated() {
                if i > 0 { out += "," }
                JSON.writeString(key, to: &out)
                out += ":"
                value.write(to: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ s: String, to out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20:
                out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByFloatLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral,
    ExpressibleByNilLiteral
{
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int64) { self = .int(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(floatLiteral value: Double) { self = .double(value) }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSON)...) { self = .object(elements) }
    init(nilLiteral: ()) { self = .null }
}

/// Receives machine-readable events: JSON Lines on stdout in production, memory in `selftest`.
protocol EventSink: AnyObject, Sendable {
    func emit(_ event: JSON)
}

extension EventSink {
    func error(_ code: String, _ message: String) {
        emit(["type": "error", "code": .string(code), "message": .string(message)])
        Log.info("error \(code): \(message)")
    }
}

/// Writes one JSON object per line to stdout with an immediate, unbuffered `write(2)`.
final class StdoutSink: EventSink, @unchecked Sendable {
    static let shared = StdoutSink()
    private let lock = NSLock()

    func emit(_ event: JSON) {
        let line = event.serialized() + "\n"
        lock.lock()
        defer { lock.unlock() }
        writeAll(fd: STDOUT_FILENO, line)
    }
}

/// Collects events in memory (selftest).
final class MemorySink: EventSink, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [JSON] = []

    var events: [JSON] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func emit(_ event: JSON) {
        lock.lock()
        defer { lock.unlock() }
        storage.append(event)
    }
}

/// Human-readable diagnostics on stderr.
enum Log {
    private static let lock = NSLock()

    static func info(_ message: String) {
        lock.lock()
        defer { lock.unlock() }
        writeAll(fd: STDERR_FILENO, "[echomind-capture] \(message)\n")
    }
}

/// Writes the whole string, retrying on EINTR; silently gives up if the pipe is gone.
func writeAll(fd: Int32, _ string: String) {
    var bytes = Array(string.utf8)
    var offset = 0
    while offset < bytes.count {
        let n = bytes.withUnsafeMutableBytes { raw in
            write(fd, raw.baseAddress! + offset, raw.count - offset)
        }
        if n > 0 {
            offset += n
        } else if n < 0 && errno == EINTR {
            continue
        } else {
            return
        }
    }
}
