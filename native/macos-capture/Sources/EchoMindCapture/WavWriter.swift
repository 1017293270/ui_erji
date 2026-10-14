import Foundation

struct WavError: Error, CustomStringConvertible {
    let description: String
}

/// Mono 16-bit PCM WAV writer. The header is patched on every flush, so a file cut short by a
/// crash is still playable up to the last second written.
final class WavWriter {
    let url: URL
    let sampleRate: Int
    private(set) var frames: Int64 = 0
    private var fd: Int32
    private var pending: [Int16] = []
    private let flushThreshold: Int

    init(url: URL, sampleRate: Int) throws {
        self.url = url
        self.sampleRate = sampleRate
        self.flushThreshold = sampleRate
        fd = open(url.path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { throw WavError(description: "无法创建 \(url.path): \(String(cString: strerror(errno)))") }
        pending.reserveCapacity(flushThreshold)
        try writeHeader(patch: false)
    }

    deinit {
        if fd >= 0 { Darwin.close(fd) }
    }

    func append<C: Collection>(_ samples: C) throws where C.Element == Float {
        for s in samples {
            let clamped = max(-1, min(1, s))
            pending.append(Int16((clamped * 32767).rounded()))
        }
        frames += Int64(samples.count)
        if pending.count >= flushThreshold { try flush() }
    }

    func appendSilence(_ count: Int) throws {
        pending.append(contentsOf: repeatElement(0, count: count))
        frames += Int64(count)
        if pending.count >= flushThreshold { try flush() }
    }

    func close() throws {
        guard fd >= 0 else { return }
        try flush()
        Darwin.close(fd)
        fd = -1
    }

    private func flush() throws {
        guard fd >= 0 else { throw WavError(description: "文件已关闭: \(url.lastPathComponent)") }
        if !pending.isEmpty {
            let ok = pending.withUnsafeBytes { raw in Self.writeFully(fd, raw.baseAddress!, raw.count, at: nil) }
            guard ok else { throw WavError(description: "写入 \(url.lastPathComponent) 失败: \(String(cString: strerror(errno)))") }
            pending.removeAll(keepingCapacity: true)
        }
        try writeHeader(patch: true)
    }

    /// Appends the header at creation; afterwards rewrites it in place with `pwrite`.
    private func writeHeader(patch: Bool) throws {
        let header = WavFormat.header(sampleRate: sampleRate, dataBytes: UInt32(clamping: frames * 2))
        let ok = header.withUnsafeBytes { raw in
            Self.writeFully(fd, raw.baseAddress!, raw.count, at: patch ? 0 : nil)
        }
        guard ok else { throw WavError(description: "写入 WAV 头失败: \(url.lastPathComponent)") }
    }

    private static func writeFully(_ fd: Int32, _ base: UnsafeRawPointer, _ count: Int, at offset: off_t?) -> Bool {
        var done = 0
        while done < count {
            let n = offset.map { pwrite(fd, base + done, count - done, $0 + off_t(done)) }
                ?? write(fd, base + done, count - done)
            if n > 0 {
                done += n
            } else if n < 0 && errno == EINTR {
                continue
            } else {
                return false
            }
        }
        return true
    }
}

/// RIFF/WAVE header layout plus a small reader used by `selftest` to verify written files.
enum WavFormat {
    static let headerSize = 44

    static func header(sampleRate: Int, dataBytes: UInt32) -> [UInt8] {
        var h: [UInt8] = []
        h.reserveCapacity(headerSize)
        func u32(_ v: UInt32) { h += withUnsafeBytes(of: v.littleEndian, Array.init) }
        func u16(_ v: UInt16) { h += withUnsafeBytes(of: v.littleEndian, Array.init) }
        h += Array("RIFF".utf8); u32(36 + dataBytes)
        h += Array("WAVE".utf8)
        h += Array("fmt ".utf8); u32(16)
        u16(1)  // PCM
        u16(1)  // mono
        u32(UInt32(sampleRate))
        u32(UInt32(sampleRate * 2))
        u16(2)
        u16(16)
        h += Array("data".utf8); u32(dataBytes)
        return h
    }

    struct Contents {
        let formatTag: UInt16
        let channels: UInt16
        let sampleRate: UInt32
        let byteRate: UInt32
        let blockAlign: UInt16
        let bitsPerSample: UInt16
        let riffSizeMatches: Bool
        let samples: [Int16]
    }

    static func read(_ url: URL) throws -> Contents {
        let data = try Data(contentsOf: url)
        func u32(_ o: Int) -> UInt32 { data[o..<o + 4].reversed().reduce(0) { $0 << 8 | UInt32($1) } }
        func u16(_ o: Int) -> UInt16 { UInt16(data[o]) | UInt16(data[o + 1]) << 8 }
        func tag(_ o: Int) -> String { String(decoding: data[o..<o + 4], as: UTF8.self) }

        guard data.count >= 12, tag(0) == "RIFF", tag(8) == "WAVE" else {
            throw WavError(description: "\(url.lastPathComponent) 不是 RIFF/WAVE 文件")
        }
        var offset = 12
        var fmt: (UInt16, UInt16, UInt32, UInt32, UInt16, UInt16)?
        var samples: [Int16]?
        while offset + 8 <= data.count {
            let id = tag(offset)
            let size = Int(u32(offset + 4))
            let body = offset + 8
            guard body + size <= data.count else { throw WavError(description: "\(url.lastPathComponent) 的 \(id) 块越界") }
            if id == "fmt " {
                fmt = (u16(body), u16(body + 2), u32(body + 4), u32(body + 8), u16(body + 12), u16(body + 14))
            } else if id == "data" {
                samples = stride(from: body, to: body + size - 1, by: 2).map { Int16(bitPattern: u16($0)) }
            }
            offset = body + size + (size & 1)
        }
        guard let fmt, let samples else { throw WavError(description: "\(url.lastPathComponent) 缺少 fmt 或 data 块") }
        return Contents(
            formatTag: fmt.0, channels: fmt.1, sampleRate: fmt.2, byteRate: fmt.3, blockAlign: fmt.4,
            bitsPerSample: fmt.5, riffSizeMatches: Int(u32(4)) + 8 == data.count, samples: samples)
    }
}
