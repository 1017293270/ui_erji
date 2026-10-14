/// Segment schedule on the shared timeline, in output frames since t0.
///
/// Segments roll every `segmentFrames`. `pause` cuts the open segment at the pause point, `resume`
/// opens a new segment at the resume point, `stop` cuts the open segment. Frames that fall between
/// segments (pauses, after stop) belong to no file. Every track asks the same schedule where a
/// frame goes, which is what guarantees identical cut points across tracks.
struct Timeline {
    enum EndReason { case nominal, pause, stop }

    struct Segment {
        let index: Int
        let start: Int64
        var end: Int64
        var endReason: EndReason
        var finalized = false
    }

    enum Location {
        case segment(Int)
        case gap(until: Int64?)
    }

    let segmentFrames: Int64
    private(set) var segments: [Segment]
    private(set) var pausedFrom: Int64?
    private(set) var stopped = false

    init(segmentFrames: Int64) {
        self.segmentFrames = segmentFrames
        segments = [Segment(index: 1, start: 0, end: segmentFrames, endReason: .nominal)]
    }

    /// Where frame `p` belongs; rolls nominal segments forward lazily.
    mutating func locate(_ p: Int64) -> Location {
        guard let i = segments.lastIndex(where: { $0.start <= p }) else {
            return .gap(until: segments.first?.start)
        }
        if p < segments[i].end { return .segment(i) }
        if i == segments.count - 1 {
            guard segments[i].endReason == .nominal else { return .gap(until: nil) }
            roll(through: p)
            return .segment(segments.count - 1)
        }
        return .gap(until: segments[i + 1].start)
    }

    var firstOpenIndex: Int? { segments.firstIndex(where: { !$0.finalized }) }

    mutating func markFinalized(_ i: Int) { segments[i].finalized = true }

    mutating func pause(at p: Int64) -> Bool {
        guard pausedFrom == nil, !stopped else { return false }
        cut(at: p, reason: .pause)
        pausedFrom = p
        return true
    }

    /// Returns the pause start, or nil when not paused.
    mutating func resume(at r: Int64) -> Int64? {
        guard let from = pausedFrom, !stopped else { return nil }
        let index = (segments.last?.index ?? 0) + 1
        segments.append(Segment(index: index, start: max(r, from), end: max(r, from) + segmentFrames, endReason: .nominal))
        pausedFrom = nil
        return from
    }

    mutating func stop(at s: Int64) {
        guard !stopped else { return }
        if pausedFrom == nil { cut(at: s, reason: .stop) }
        stopped = true
    }

    private mutating func roll(through p: Int64) {
        while let last = segments.last, last.endReason == .nominal, last.end <= p {
            segments.append(
                Segment(index: last.index + 1, start: last.end, end: last.end + segmentFrames, endReason: .nominal))
        }
    }

    private mutating func cut(at p: Int64, reason: EndReason) {
        roll(through: p)
        guard let i = segments.lastIndex(where: { $0.start <= p && p < $0.end }) else { return }
        if segments[i].start == p {
            segments.remove(at: i)
            if i > 0 { segments[i - 1].endReason = reason }
        } else {
            segments[i].end = p
            segments[i].endReason = reason
        }
    }
}
