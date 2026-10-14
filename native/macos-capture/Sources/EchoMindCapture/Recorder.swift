import Foundation

/// The recording pipeline shared by `record` and `selftest`: alignment, resampling, segmenting,
/// WAV writing, levels, manifest and events.
///
/// Alignment: t0 is the host time at which recording started. Each chunk carries the host time of
/// its first frame, so its timeline position is (hostTime − t0) × sampleRate. A track's first chunk is
/// placed exactly there: a late track gets leading silence, frames from before t0 are dropped. Later
/// chunks are appended back to back unless their host-time position drifts more than
/// `resyncThresholdSeconds` from that contiguous position (dropout, device rebuild, clock drift);
/// then the gap is filled with silence or the overlap is dropped. A watchdog pads tracks that stop
/// delivering for longer than `stallSeconds`, so segments keep closing during device outages.
///
/// Not thread-safe: confine every call to one serial queue.
final class Recorder: @unchecked Sendable {
    struct Config: Sendable {
        var outDir: URL
        var sampleRate: Int
        var segmentSeconds: Int
        var tracks: [TrackKind]
    }

    struct TrackStats {
        var chunks = 0
        var paddedFrames: Int64 = 0
        var droppedFrames: Int64 = 0
        var resyncs = 0
    }

    static let resyncThresholdSeconds = 0.020
    static let stallSeconds = 1.0
    /// Host times further ahead of the last tick than this are treated as bogus.
    static let futureLimitSeconds = 5.0

    let config: Config
    /// Called once when the recording cannot continue (e.g. disk full); the owner should stop.
    var onFatalError: (@Sendable () -> Void)?

    private let sink: EventSink
    private var timeline: Timeline
    private let tracks: [Track]
    private var manifest: Manifest
    private var t0: UInt64 = 0
    private var nowFrame: Int64 = 0
    private(set) var isStopped = false
    private var failed = false

    init(config: Config, sink: EventSink) {
        self.config = config
        self.sink = sink
        timeline = Timeline(segmentFrames: Int64(config.segmentSeconds * config.sampleRate))
        tracks = TrackKind.allCases.filter(config.tracks.contains).map(Track.init)
        manifest = Manifest(
            startedAt: Date(), sampleRate: config.sampleRate, segmentSeconds: config.segmentSeconds,
            tracks: tracks.map(\.kind))
    }

    var startedAtISO: String { Manifest.iso8601(manifest.startedAt) }

    func start(t0Nanos: UInt64, startedAt: Date) {
        t0 = t0Nanos
        manifest = Manifest(
            startedAt: startedAt, sampleRate: config.sampleRate, segmentSeconds: config.segmentSeconds,
            tracks: tracks.map(\.kind))
        saveManifest()
    }

    func ingest(_ chunk: AudioChunk, into kind: TrackKind) {
        guard !isStopped, !failed, !chunk.samples.isEmpty, let track = track(kind) else { return }
        track.stats.chunks += 1
        if timeline.pausedFrom == nil { track.meter.add(chunk.samples) }

        if track.resampler?.inputRate != chunk.sampleRate {
            guard let resampler = Resampler(inputRate: chunk.sampleRate, outputRate: Double(config.sampleRate)) else {
                fail("resample_failed", "无法创建 \(Int(chunk.sampleRate)) Hz → \(config.sampleRate) Hz 的重采样器。")
                return
            }
            track.resampler = resampler
        }
        let output = track.resampler!.process(chunk.samples)
        guard !output.isEmpty else { return }

        let hostPosition = frame(atNanos: chunk.hostNanos)
        var position = hostPosition
        if hostPosition > nowFrame + Int64(Recorder.futureLimitSeconds * Double(config.sampleRate)) {
            Log.info("\(kind.rawValue) 轨时间戳异常（超前当前时间），按连续写入处理")
            position = track.contiguousEnd ?? track.cursor
        } else if let contiguous = track.contiguousEnd {
            if abs(hostPosition - contiguous) <= resyncFrames {
                position = contiguous
            } else {
                track.stats.resyncs += 1
                Log.info("\(kind.rawValue) 轨按主机时间重新对齐，偏差 \(ms(hostPosition - contiguous)) ms")
            }
        }
        place(output, at: position, in: track)
        track.contiguousEnd = position + Int64(output.count)
        finalizeReadySegments()
    }

    /// Runs every 100 ms: stall watchdog, segment rolling, level event.
    func tick(nowNanos: UInt64) {
        guard !isStopped, !failed else { return }
        nowFrame = max(nowFrame, frame(atNanos: nowNanos))
        let limit = nowFrame - Int64(Recorder.stallSeconds * Double(config.sampleRate))
        for track in tracks where track.cursor < limit {
            track.stats.paddedFrames += limit - track.cursor
            advance(track, .silence(limit - track.cursor))
        }
        if tracks.isEmpty { _ = timeline.locate(nowFrame) }
        finalizeReadySegments()

        let paused = timeline.pausedFrom != nil
        var event: [(String, JSON)] = [("type", "level"), ("t", .int(msSinceStart(nowNanos)))]
        for kind in TrackKind.allCases {
            if let track = track(kind) {
                let db = track.meter.take()
                event.append((kind.rawValue, .rounded(paused ? LevelMeter.floorDB : db)))
            } else {
                event.append((kind.rawValue, .null))
            }
        }
        sink.emit(.object(event))
    }

    func mark(nowNanos: UInt64) {
        guard !isStopped else { return }
        let at = msSinceStart(nowNanos)
        manifest.marks.append(at)
        saveManifest()
        sink.emit(["type": "mark", "atMs": .int(at)])
    }

    @discardableResult
    func pause(nowNanos: UInt64) -> Bool {
        guard !isStopped else { return false }
        let p = max(frame(atNanos: nowNanos), maxCursor)
        guard timeline.pause(at: p) else { return false }
        manifest.paused.append((ms(p), nil))
        saveManifest()
        sink.emit(["type": "paused", "atMs": .int(ms(p))])
        finalizeReadySegments()
        return true
    }

    @discardableResult
    func resume(nowNanos: UInt64) -> Bool {
        guard !isStopped else { return false }
        let r = max(frame(atNanos: nowNanos), maxCursor)
        guard let from = timeline.resume(at: r) else { return false }
        let at = ms(max(r, from))
        manifest.paused[manifest.paused.count - 1].toMs = at
        saveManifest()
        sink.emit(["type": "resumed", "atMs": .int(at)])
        return true
    }

    /// Pads every track to the stop point, finalizes all segments and the manifest, emits `stopped`.
    func stop(nowNanos: UInt64) {
        guard !isStopped else { return }
        let s = max(frame(atNanos: nowNanos), maxCursor, timeline.pausedFrom ?? 0)
        if timeline.pausedFrom != nil { manifest.paused[manifest.paused.count - 1].toMs = ms(s) }
        timeline.stop(at: s)
        if !failed {
            for track in tracks where track.cursor < s {
                track.stats.paddedFrames += s - track.cursor
                advance(track, .silence(s - track.cursor))
            }
            nowFrame = max(nowFrame, s)
            finalizeReadySegments()
        }
        for track in tracks {
            for writer in track.writers.values { try? writer.close() }
            track.writers.removeAll()
        }
        isStopped = true
        manifest.status = "stopped"
        manifest.durationMs = ms(s)
        saveManifest()
        Log.info("录音结束: \(statsJSON().serialized())")
        sink.emit(["type": "stopped", "durationMs": .int(ms(s)), "segments": .num(manifest.segments.count)])
    }

    /// Per-track alignment statistics (diagnostics / selftest).
    func statsJSON() -> JSON {
        .object(tracks.map { t in
            (t.kind.rawValue, [
                "chunks": .num(t.stats.chunks),
                "paddedMs": .int(ms(t.stats.paddedFrames)),
                "droppedMs": .int(ms(t.stats.droppedFrames)),
                "resyncs": .num(t.stats.resyncs),
            ])
        })
    }

    // MARK: - Track writing

    private final class Track {
        let kind: TrackKind
        var cursor: Int64 = 0
        var contiguousEnd: Int64?
        var resampler: Resampler?
        var writers: [Int: WavWriter] = [:]
        var meter = LevelMeter()
        var stats = TrackStats()

        init(kind: TrackKind) { self.kind = kind }
    }

    private enum Source {
        case samples(ArraySlice<Float>)
        case silence(Int64)

        var count: Int64 {
            switch self {
            case .samples(let s): Int64(s.count)
            case .silence(let n): n
            }
        }
    }

    private func track(_ kind: TrackKind) -> Track? { tracks.first { $0.kind == kind } }

    private var maxCursor: Int64 { tracks.map(\.cursor).max() ?? nowFrame }

    private var resyncFrames: Int64 { Int64(Recorder.resyncThresholdSeconds * Double(config.sampleRate)) }

    private func place(_ samples: [Float], at position: Int64, in track: Track) {
        if position > track.cursor {
            track.stats.paddedFrames += position - track.cursor
            advance(track, .silence(position - track.cursor))
        }
        let skip = Int(min(Int64(samples.count), max(0, track.cursor - position)))
        track.stats.droppedFrames += Int64(skip)
        if skip < samples.count { advance(track, .samples(samples[skip...])) }
    }

    /// Writes `source` starting at the track cursor, splitting it across segments and skipping gaps.
    private func advance(_ track: Track, _ source: Source) {
        var remaining = source.count
        var consumed = 0
        while remaining > 0 && !failed {
            switch timeline.locate(track.cursor) {
            case .segment(let i):
                let segment = timeline.segments[i]
                let n = min(remaining, segment.end - track.cursor)
                do {
                    let writer = try self.writer(for: track, segment: segment)
                    switch source {
                    case .samples(let s):
                        let from = s.startIndex + consumed
                        try writer.append(s[from..<from + Int(n)])
                    case .silence:
                        try writer.appendSilence(Int(n))
                    }
                    track.cursor += n
                    if track.cursor == segment.end {
                        try writer.close()
                        track.writers[segment.index] = nil
                    }
                } catch {
                    fail("write_failed", "写入录音文件失败：\(error)")
                    return
                }
                consumed += Int(n)
                remaining -= n
            case .gap(let until):
                let n = until.map { min(remaining, $0 - track.cursor) } ?? remaining
                track.cursor += n
                consumed += Int(n)
                remaining -= n
            }
        }
    }

    private func writer(for track: Track, segment: Timeline.Segment) throws -> WavWriter {
        if let writer = track.writers[segment.index] { return writer }
        let url = config.outDir.appendingPathComponent(fileName(track.kind, segment.index))
        let writer = try WavWriter(url: url, sampleRate: config.sampleRate)
        track.writers[segment.index] = writer
        return writer
    }

    /// Finalizes segments every track has written past (or, with no tracks, that the clock has passed).
    private func finalizeReadySegments() {
        let reached = tracks.map(\.cursor).min() ?? nowFrame
        while let i = timeline.firstOpenIndex, timeline.segments[i].end <= reached {
            finalize(i)
        }
    }

    private func finalize(_ i: Int) {
        let segment = timeline.segments[i]
        timeline.markFinalized(i)
        var files: [TrackKind: String] = [:]
        for track in tracks {
            if let writer = track.writers.removeValue(forKey: segment.index) { try? writer.close() }
            files[track.kind] = fileName(track.kind, segment.index)
        }
        let entry = Manifest.SegmentEntry(
            index: segment.index, startMs: ms(segment.start), endMs: ms(segment.end), files: files)
        manifest.segments.append(entry)
        saveManifest()

        var event: [(String, JSON)] = [
            ("type", "segment"), ("index", .num(entry.index)), ("startMs", .int(entry.startMs)),
            ("endMs", .int(entry.endMs)),
        ]
        for kind in TrackKind.allCases {
            event.append((kind.rawValue, .optional(files[kind].map { config.outDir.appendingPathComponent($0).path })))
        }
        sink.emit(.object(event))
    }

    private func saveManifest() {
        do {
            try manifest.write(to: config.outDir)
        } catch {
            fail("write_failed", "写入 manifest.json 失败：\(error.localizedDescription)")
        }
    }

    private func fail(_ code: String, _ message: String) {
        guard !failed else { return }
        failed = true
        sink.error(code, message)
        onFatalError?()
    }

    // MARK: - Units

    func fileName(_ kind: TrackKind, _ index: Int) -> String {
        "\(kind.rawValue)-\(String(format: "%04d", index)).wav"
    }

    private func frame(atNanos t: UInt64) -> Int64 {
        let delta = Int64(bitPattern: t &- t0)
        return Int64((Double(delta) * Double(config.sampleRate) / 1e9).rounded())
    }

    private func ms(_ frames: Int64) -> Int64 { frames * 1000 / Int64(config.sampleRate) }

    private func msSinceStart(_ t: UInt64) -> Int64 { Int64(bitPattern: t &- t0) / 1_000_000 }
}
