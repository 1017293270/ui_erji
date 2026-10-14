import AVFoundation
import Foundation

/// `selftest --out <dir>`: feeds synthetic 48 kHz Float32 tones through the real pipeline
/// (PCMLayout mixdown → Recorder → Resampler → Timeline → WavWriter → Manifest) on a simulated
/// host clock, then re-reads the files and checks headers, segment cuts and alignment.
///
/// Scenario "aligned" (files directly in `<dir>`): mic starts at t0, the system stream starts 250 ms
/// late; both carry tone bursts at the same instants. Scenario "pause-dropout" (`<dir>/pause-dropout`):
/// a 500 ms mic dropout, a mark, and a pause/resume.
enum SelfTest {
    static let segmentSeconds = 2
    static let sampleRate = 16000
    static let toleranceFrames = 160  // 10 ms at 16 kHz

    static func run(outDir: URL) -> Int32 {
        let aligned = runAligned(dir: outDir)
        let pause = runPauseDropout(dir: outDir.appendingPathComponent("pause-dropout"))
        let ok = aligned.ok && pause.ok
        StdoutSink.shared.emit([
            "type": "selftest",
            "ok": .bool(ok),
            "out": .string(outDir.path),
            "sampleRate": .num(sampleRate),
            "segmentSeconds": .num(segmentSeconds),
            "scenarios": [aligned.json, pause.json],
        ])
        return ok ? 0 : 1
    }

    // MARK: - Scenarios

    private static func runAligned(dir: URL) -> Report {
        var report = Report(name: "aligned")
        let micBursts = [0.0, 1.0, 1.95, 3.0]
        let systemBursts = [0.25, 1.0, 1.95, 3.0]
        let streams = [
            SyntheticStream(
                track: .mic, tone: Tone(frequency: 440, amplitude: 0.5, starts: micBursts, length: 0.1),
                channels: 1, start: 0.0, bufferFrames: 480),
            SyntheticStream(
                track: .system, tone: Tone(frequency: 660, amplitude: 0.5, starts: systemBursts, length: 0.1),
                channels: 2, start: 0.25, bufferFrames: 512),
        ]
        let sim = simulate(dir: dir, streams: streams, commands: [(1.5, "mark")], stopAt: 5.0, report: &report)
        guard let sim else { return report }

        let expected: [(Int, Int64, Int64)] = [(1, 0, 2000), (2, 2000, 4000), (3, 4000, 5000)]
        let tracks = verifySegments(dir: dir, expected: expected, report: &report)
        verifyManifest(dir: dir, expected: expected, marks: [1500], paused: [], report: &report)
        verifyEvents(sim.sink, segments: expected.count, report: &report)

        guard let mic = tracks[.mic], let system = tracks[.system] else { return report }
        let micFound = bursts(mic)
        let systemFound = bursts(system)
        let micOnsets = micFound.map(\.start)
        let systemOnsets = systemFound.map(\.start)
        let expectedMic = micBursts.map { Int($0 * Double(sampleRate)) }
        let expectedSystem = systemBursts.map { Int($0 * Double(sampleRate)) }
        report.check("mic burst onsets ±10 ms", close(micOnsets, expectedMic), "\(micOnsets) vs \(expectedMic)")
        report.check(
            "system burst onsets ±10 ms (250 ms lead-in padded)", close(systemOnsets, expectedSystem),
            "\(systemOnsets) vs \(expectedSystem)")
        for found in [micFound, systemFound] {
            let lengths = found.map { $0.end - $0.start }
            report.check(
                "burst lengths 100 ms ±10 ms (continuous across segment cut)",
                lengths.allSatisfy { abs($0 - 1600) <= toleranceFrames }, "\(lengths)")
        }

        var skew = Int.max
        if micOnsets.count == 4, systemOnsets.count == 4 {
            skew = (1..<4).map { abs(micOnsets[$0] - systemOnsets[$0]) }.max()!
        }
        report.check("mic/system skew on shared bursts ≤ 10 ms", skew <= toleranceFrames, "\(skew) frames")

        let micHz = micFound.first.map { frequency(mic[$0.start..<$0.end]) } ?? 0
        let systemHz = systemFound.first.map { frequency(system[$0.start..<$0.end]) } ?? 0
        report.check("mic tone ≈ 440 Hz", abs(micHz - 440) < 22, "\(micHz)")
        report.check("system tone ≈ 660 Hz", abs(systemHz - 660) < 33, "\(systemHz)")

        report.extra = [
            ("systemLeadInMs", .rounded(Double(systemOnsets.first ?? -1) * 1000 / Double(sampleRate))),
            ("expectedLeadInMs", 250),
            ("maxSharedBurstSkewMs", .rounded(Double(skew) * 1000 / Double(sampleRate))),
            ("micOnsetsMs", .array(micOnsets.map { .rounded(Double($0) * 1000 / Double(sampleRate)) })),
            ("systemOnsetsMs", .array(systemOnsets.map { .rounded(Double($0) * 1000 / Double(sampleRate)) })),
            ("micHz", .rounded(micHz)),
            ("systemHz", .rounded(systemHz)),
            ("stats", sim.stats),
        ]
        return report
    }

    private static func runPauseDropout(dir: URL) -> Report {
        var report = Report(name: "pause-dropout")
        let streams = [
            SyntheticStream(
                track: .mic, tone: Tone(frequency: 440, amplitude: 0.3, starts: [0], length: 10),
                channels: 1, start: 0.0, bufferFrames: 480, dropout: 1.2..<1.7),
            SyntheticStream(
                track: .system, tone: Tone(frequency: 660, amplitude: 0.3, starts: [0], length: 10),
                channels: 2, start: 0.0, bufferFrames: 512),
        ]
        let commands: [(Double, String)] = [(0.5, "mark"), (2.5, "pause"), (3.5, "resume")]
        let sim = simulate(dir: dir, streams: streams, commands: commands, stopAt: 5.0, report: &report)
        guard let sim else { return report }

        let expected: [(Int, Int64, Int64)] = [(1, 0, 2000), (2, 2000, 2500), (3, 3500, 5000)]
        _ = verifySegments(dir: dir, expected: expected, report: &report)
        verifyManifest(dir: dir, expected: expected, marks: [500], paused: [(2500, 3500)], report: &report)
        verifyEvents(sim.sink, segments: expected.count, report: &report)
        let types = sim.sink.events.compactMap { $0["type"]?.stringValue }
        report.check("paused/resumed events", types.contains("paused") && types.contains("resumed"), "\(Set(types))")

        let rate = Double(sampleRate)
        func window(_ samples: [Int16], _ from: Double, _ to: Double) -> ArraySlice<Int16> {
            samples[Int(from * rate)..<Int(to * rate)]
        }
        if let mic1 = try? WavFormat.read(dir.appendingPathComponent("mic-0001.wav")).samples,
            let sys1 = try? WavFormat.read(dir.appendingPathComponent("system-0001.wav")).samples,
            let mic3 = try? WavFormat.read(dir.appendingPathComponent("mic-0003.wav")).samples
        {
            let gap = rms(window(mic1, 1.22, 1.68))
            let before = rms(window(mic1, 0.5, 1.15))
            let after = rms(window(mic1, 1.75, 1.95))
            let systemDuring = rms(window(sys1, 1.22, 1.68))
            let resumed = rms(window(mic3, 0.0, 0.1))
            report.check("mic dropout filled with silence", gap < 1e-4, "rms \(gap)")
            report.check("mic audio on both sides of dropout", before > 0.1 && after > 0.1, "rms \(before) / \(after)")
            report.check("system unaffected by mic dropout", systemDuring > 0.1, "rms \(systemDuring)")
            report.check("audio resumes immediately after resume", resumed > 0.1, "rms \(resumed)")
            report.extra = [
                ("micDropoutRms", .double(gap)),
                ("micRmsAroundDropout", [.double((before * 1000).rounded() / 1000), .double((after * 1000).rounded() / 1000)]),
                ("stats", sim.stats),
            ]
        } else {
            report.fail("re-read pause-dropout files")
        }
        return report
    }

    // MARK: - Simulation

    private struct Tone {
        let frequency: Double
        let amplitude: Float
        let starts: [Double]
        let length: Double

        func value(at t: Double) -> Float {
            guard let start = starts.last(where: { $0 <= t }), t < start + length else { return 0 }
            return amplitude * Float(sin(2 * .pi * frequency * (t - start)))
        }
    }

    /// A fake capture: 48 kHz Float32 buffers (interleaved stereo for "system", like a tap),
    /// mixed down by the same `PCMLayout` the IOProcs use.
    private struct SyntheticStream {
        static let rate = 48000.0
        let track: TrackKind
        let tone: Tone
        let channels: Int
        let start: Double
        let bufferFrames: Int
        var dropout: Range<Double>?

        func chunks(until end: Double, t0: UInt64) -> [(at: Double, chunk: AudioChunk)] {
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: Self.rate, channels: AVAudioChannelCount(channels),
                interleaved: channels > 1)!
            let layout = PCMLayout(format.streamDescription.pointee)!
            var result: [(Double, AudioChunk)] = []
            var frame = 0
            while true {
                let bufferStart = start + Double(frame) / Self.rate
                let deliveredAt = start + Double(frame + bufferFrames) / Self.rate
                frame += bufferFrames
                if deliveredAt > end + 1e-9 { break }
                if let dropout, dropout.contains(bufferStart) { continue }

                let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(bufferFrames))!
                buffer.frameLength = AVAudioFrameCount(bufferFrames)
                let data = buffer.floatChannelData![0]
                for i in 0..<bufferFrames {
                    let v = tone.value(at: bufferStart + Double(i) / Self.rate)
                    for c in 0..<channels { data[i * channels + c] = v }
                }
                let samples = layout.monoSamples(buffer.audioBufferList)
                let host = t0 + UInt64((bufferStart * 1e9).rounded())
                result.append((deliveredAt, AudioChunk(hostNanos: host, sampleRate: Self.rate, samples: samples)))
            }
            return result
        }
    }

    private struct Simulation {
        let sink: MemorySink
        let stats: JSON
    }

    private enum Step {
        case chunk(TrackKind, AudioChunk)
        case command(String)
        case tick
    }

    /// Replays chunk deliveries, commands and 100 ms ticks in host-time order, then stops.
    private static func simulate(
        dir: URL, streams: [SyntheticStream], commands: [(Double, String)], stopAt: Double, report: inout Report
    ) -> Simulation? {
        do {
            try prepare(dir)
        } catch {
            report.fail("prepare \(dir.path): \(error)")
            return nil
        }
        let t0: UInt64 = 1_000_000_000_000
        let sink = MemorySink()
        let recorder = Recorder(
            config: .init(outDir: dir, sampleRate: sampleRate, segmentSeconds: segmentSeconds, tracks: [.mic, .system]),
            sink: sink)
        recorder.start(t0Nanos: t0, startedAt: Date())

        var steps: [(at: Double, order: Int, step: Step)] = []
        for stream in streams {
            steps += stream.chunks(until: stopAt, t0: t0).map { ($0.at, 0, .chunk(stream.track, $0.chunk)) }
        }
        steps += commands.map { ($0.0, 1, .command($0.1)) }
        steps += stride(from: 0.1, through: stopAt, by: 0.1).map { ($0, 2, .tick) }
        steps.sort { ($0.at, $0.order) < ($1.at, $1.order) }

        for (at, _, step) in steps {
            let now = t0 + UInt64((at * 1e9).rounded())
            switch step {
            case .chunk(let track, let chunk): recorder.ingest(chunk, into: track)
            case .tick: recorder.tick(nowNanos: now)
            case .command("mark"): recorder.mark(nowNanos: now)
            case .command("pause"): recorder.pause(nowNanos: now)
            case .command("resume"): recorder.resume(nowNanos: now)
            case .command: break
            }
        }
        recorder.stop(nowNanos: t0 + UInt64((stopAt * 1e9).rounded()))
        return Simulation(sink: sink, stats: recorder.statsJSON())
    }

    private static func prepare(_ dir: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        for name in try fm.contentsOfDirectory(atPath: dir.path)
        where name == "manifest.json" || (name.hasSuffix(".wav") && (name.hasPrefix("mic-") || name.hasPrefix("system-"))) {
            try fm.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    // MARK: - Verification

    private struct Report {
        let name: String
        var passed = 0
        var failures: [String] = []
        var segments: [JSON] = []
        var extra: [(String, JSON)] = []

        var ok: Bool { failures.isEmpty && passed > 0 }

        mutating func check(_ what: String, _ condition: Bool, _ detail: @autoclosure () -> String = "") {
            if condition { passed += 1 } else { fail("\(what): \(detail())") }
        }

        mutating func fail(_ what: String) { failures.append(what) }

        var json: JSON {
            .object(
                [
                    ("name", .string(name)), ("ok", .bool(ok)), ("checksPassed", .num(passed)),
                    ("failures", .array(failures.map(JSON.string))), ("segments", .array(segments)),
                ] + extra)
        }
    }

    /// Checks headers and per-segment frame counts; returns each track's concatenated samples.
    private static func verifySegments(
        dir: URL, expected: [(Int, Int64, Int64)], report: inout Report
    ) -> [TrackKind: [Int16]] {
        var joined: [TrackKind: [Int16]] = [:]
        for (index, startMs, endMs) in expected {
            let expectedFrames = Int((endMs - startMs) * Int64(sampleRate) / 1000)
            var frames: [(String, JSON)] = []
            for track in TrackKind.allCases {
                let name = "\(track.rawValue)-\(String(format: "%04d", index)).wav"
                guard let wav = try? WavFormat.read(dir.appendingPathComponent(name)) else {
                    report.fail("read \(name)")
                    continue
                }
                let headerOK =
                    wav.formatTag == 1 && wav.channels == 1 && wav.sampleRate == UInt32(sampleRate)
                    && wav.bitsPerSample == 16 && wav.blockAlign == 2 && wav.byteRate == UInt32(sampleRate * 2)
                    && wav.riffSizeMatches
                report.check("\(name) header (PCM mono 16-bit \(sampleRate) Hz)", headerOK, "\(wav)")
                report.check("\(name) frames", wav.samples.count == expectedFrames, "\(wav.samples.count) ≠ \(expectedFrames)")
                joined[track, default: []] += wav.samples
                frames.append((track.rawValue, .num(wav.samples.count)))
            }
            report.segments.append([
                "index": .num(index), "startMs": .int(startMs), "endMs": .int(endMs), "frames": .object(frames),
            ])
        }
        let extra = (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?
            .filter { $0.hasSuffix(".wav") }.count ?? 0
        report.check("no extra segment files", extra == expected.count * 2, "\(extra) wav files")
        return joined
    }

    private static func verifyManifest(
        dir: URL, expected: [(Int, Int64, Int64)], marks: [Int64], paused: [(Int64, Int64)], report: inout Report
    ) {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("manifest.json")),
            let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            report.fail("parse manifest.json")
            return
        }
        let segments = (m["segments"] as? [[String: Any]]) ?? []
        let got = segments.map { s in
            "\(s["index"] ?? "")/\(s["startMs"] ?? "")-\(s["endMs"] ?? "")/\(s["mic"] ?? "")/\(s["system"] ?? "")"
        }
        let want = expected.map { i, a, b in
            "\(i)/\(a)-\(b)/mic-\(String(format: "%04d", i)).wav/system-\(String(format: "%04d", i)).wav"
        }
        report.check("manifest segments", got == want, "\(got)")
        report.check(
            "manifest header",
            m["version"] as? Int == 1 && m["sampleRate"] as? Int == sampleRate
                && m["segmentSeconds"] as? Int == segmentSeconds && m["status"] as? String == "stopped"
                && (m["tracks"] as? [String]) == ["mic", "system"] && m["startedAt"] is String,
            "\(m)")
        let gotMarks = ((m["marks"] as? [[String: Any]]) ?? []).compactMap { ($0["atMs"] as? NSNumber)?.int64Value }
        report.check("manifest marks", gotMarks == marks, "\(gotMarks)")
        let gotPaused = ((m["paused"] as? [[String: Any]]) ?? []).map {
            "\($0["fromMs"] ?? "")-\($0["toMs"] ?? "")"
        }
        report.check("manifest paused", gotPaused == paused.map { "\($0.0)-\($0.1)" }, "\(gotPaused)")
    }

    private static func verifyEvents(_ sink: MemorySink, segments: Int, report: inout Report) {
        let events = sink.events
        let segmentEvents = events.filter { $0["type"]?.stringValue == "segment" }
        report.check("segment events", segmentEvents.count == segments, "\(segmentEvents.count)")
        let stopped = events.last
        report.check(
            "stopped event last",
            stopped?["type"]?.stringValue == "stopped" && stopped?["segments"]?.intValue == Int64(segments),
            "\(stopped?.serialized() ?? "none")")
        let levels = events.filter { $0["type"]?.stringValue == "level" }.count
        report.check("level events every 100 ms", levels >= 45, "\(levels)")
    }

    // MARK: - Signal analysis

    /// Runs where |x| exceeds 10 % full scale, bridging gaps shorter than 5 ms (zero crossings).
    private static func bursts(_ samples: [Int16]) -> [(start: Int, end: Int)] {
        let threshold: Int16 = 3277
        let maxGap = sampleRate / 200
        var runs: [(start: Int, end: Int)] = []
        for (i, s) in samples.enumerated() where abs(Int(s)) > Int(threshold) {
            if let last = runs.last, i - last.end <= maxGap {
                runs[runs.count - 1].end = i + 1
            } else {
                runs.append((i, i + 1))
            }
        }
        return runs
    }

    private static func close(_ found: [Int], _ expected: [Int]) -> Bool {
        found.count == expected.count && zip(found, expected).allSatisfy { abs($0 - $1) <= toleranceFrames }
    }

    /// Zero-crossing estimate between the first and last crossing (half a period per crossing).
    private static func frequency(_ samples: ArraySlice<Int16>) -> Double {
        var crossings: [Int] = []
        var previous = samples.first ?? 0
        for i in samples.indices.dropFirst() {
            if (previous < 0) != (samples[i] < 0) { crossings.append(i) }
            previous = samples[i]
        }
        guard let first = crossings.first, let last = crossings.last, last > first else { return 0 }
        return Double(crossings.count - 1) / 2 / (Double(last - first) / Double(sampleRate))
    }

    private static func rms(_ samples: ArraySlice<Int16>) -> Double {
        guard !samples.isEmpty else { return 0 }
        let sum = samples.reduce(0.0) { $0 + Double($1) * Double($1) }
        return (sum / Double(samples.count)).squareRoot() / 32768
    }
}
