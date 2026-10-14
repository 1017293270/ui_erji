import Foundation

enum TrackKind: String, Sendable, CaseIterable {
    case mic
    case system
}

/// `<dir>/manifest.json`: segment list, marks and pause ranges; rewritten atomically on every change.
struct Manifest {
    struct SegmentEntry {
        let index: Int
        let startMs: Int64
        let endMs: Int64
        let files: [TrackKind: String]
    }

    let startedAt: Date
    let sampleRate: Int
    let segmentSeconds: Int
    let tracks: [TrackKind]
    var status = "recording"
    var durationMs: Int64?
    var segments: [SegmentEntry] = []
    var marks: [Int64] = []
    var paused: [(fromMs: Int64, toMs: Int64?)] = []

    func json() -> JSON {
        [
            "version": 1,
            "startedAt": .string(Manifest.iso8601(startedAt)),
            "sampleRate": .num(sampleRate),
            "segmentSeconds": .num(segmentSeconds),
            "tracks": .array(tracks.map { .string($0.rawValue) }),
            "status": .string(status),
            "durationMs": durationMs.map(JSON.int) ?? .null,
            "segments": .array(segments.map { s in
                .object(
                    [("index", .num(s.index)), ("startMs", .int(s.startMs)), ("endMs", .int(s.endMs))]
                        + TrackKind.allCases.map { ($0.rawValue, JSON.optional(s.files[$0])) })
            }),
            "marks": .array(marks.map { ["atMs": .int($0)] }),
            "paused": .array(paused.map { ["fromMs": .int($0.fromMs), "toMs": $0.toMs.map(JSON.int) ?? .null] }),
        ]
    }

    func write(to dir: URL) throws {
        let data = Data((json().serialized() + "\n").utf8)
        try data.write(to: dir.appendingPathComponent("manifest.json"), options: .atomic)
    }

    static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = .current
        return formatter.string(from: date)
    }
}
