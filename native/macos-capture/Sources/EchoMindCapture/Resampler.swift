import AVFoundation

/// Streaming mono Float32 sample-rate converter built on AVAudioConverter.
/// Keeps filter state between calls, so consecutive chunks resample seamlessly.
final class Resampler {
    let inputRate: Double
    let outputRate: Double
    private let converter: AVAudioConverter?
    private let inputFormat: AVAudioFormat
    private let outputFormat: AVAudioFormat

    init?(inputRate: Double, outputRate: Double) {
        guard
            let inFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: inputRate, channels: 1, interleaved: false),
            let outFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: outputRate, channels: 1, interleaved: false)
        else { return nil }
        self.inputRate = inputRate
        self.outputRate = outputRate
        self.inputFormat = inFormat
        self.outputFormat = outFormat
        if inputRate == outputRate {
            converter = nil
        } else {
            guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else { return nil }
            converter.sampleRateConverterQuality = AVAudioQuality.high.rawValue
            converter.primeMethod = .normal
            self.converter = converter
        }
    }

    func process(_ input: [Float]) -> [Float] {
        guard let converter else { return input }
        guard !input.isEmpty else { return [] }

        let feeder = Feeder(samples: input, format: inputFormat)
        let capacity = AVAudioFrameCount(Double(input.count) * outputRate / inputRate) + 64
        var result: [Float] = []
        result.reserveCapacity(Int(capacity))

        while true {
            guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { break }
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { requested, inputStatus in
                feeder.next(requested, inputStatus)
            }
            if out.frameLength > 0, let channel = out.floatChannelData?[0] {
                result.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
            }
            if status == .haveData && out.frameLength == out.frameCapacity { continue }
            if status == .error { Log.info("重采样失败: \(error?.localizedDescription ?? "unknown")") }
            break
        }
        return result
    }

    /// Serves one input chunk to the converter in pieces of at most the requested size.
    private final class Feeder: @unchecked Sendable {
        private let samples: [Float]
        private let format: AVAudioFormat
        private var offset = 0

        init(samples: [Float], format: AVAudioFormat) {
            self.samples = samples
            self.format = format
        }

        func next(_ requested: AVAudioPacketCount, _ status: UnsafeMutablePointer<AVAudioConverterInputStatus>)
            -> AVAudioBuffer?
        {
            let n = min(Int(requested), samples.count - offset)
            guard n > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)),
                let dst = buffer.floatChannelData?[0]
            else {
                status.pointee = .noDataNow
                return nil
            }
            samples.withUnsafeBufferPointer { src in
                dst.update(from: src.baseAddress! + offset, count: n)
            }
            buffer.frameLength = AVAudioFrameCount(n)
            offset += n
            status.pointee = .haveData
            return buffer
        }
    }
}
