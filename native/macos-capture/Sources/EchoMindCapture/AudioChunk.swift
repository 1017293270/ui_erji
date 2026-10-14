import CoreAudio
import Foundation

/// One captured IO buffer, mixed down to mono Float32 and stamped with the host time of its first frame.
struct AudioChunk: Sendable {
    let hostNanos: UInt64
    let sampleRate: Double
    let samples: [Float]
}

/// Linear-PCM layout of a HAL stream, able to mix an `AudioBufferList` down to mono Float32.
struct PCMLayout: Sendable, Equatable {
    enum SampleType: Sendable { case float32, int16, int32 }

    let sampleRate: Double
    let sampleType: SampleType
    let channels: Int

    /// Mixdown averages at most this many leading channels (L+R; avoids diluting a mic on wide interfaces).
    static let maxMixChannels = 2

    init?(_ asbd: AudioStreamBasicDescription) {
        guard asbd.mFormatID == kAudioFormatLinearPCM, asbd.mSampleRate > 0 else { return nil }
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        switch (isFloat, asbd.mBitsPerChannel) {
        case (true, 32): sampleType = .float32
        case (false, 16): sampleType = .int16
        case (false, 32): sampleType = .int32
        default: return nil
        }
        sampleRate = asbd.mSampleRate
        channels = Int(asbd.mChannelsPerFrame)
    }

    private var bytesPerSample: Int { sampleType == .int16 ? 2 : 4 }

    /// Averages the first `maxMixChannels` channels across all buffers (interleaved or not).
    func monoSamples(_ list: UnsafePointer<AudioBufferList>) -> [Float] {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        var frames = Int.max
        for buffer in buffers where buffer.mData != nil && buffer.mNumberChannels > 0 {
            frames = min(frames, Int(buffer.mDataByteSize) / (bytesPerSample * Int(buffer.mNumberChannels)))
        }
        guard frames != Int.max, frames > 0 else { return [] }

        var mono = [Float](repeating: 0, count: frames)
        var used = 0
        mono.withUnsafeMutableBufferPointer { out in
            for buffer in buffers {
                guard let data = buffer.mData, buffer.mNumberChannels > 0 else { continue }
                let stride = Int(buffer.mNumberChannels)
                for channel in 0..<stride where used < PCMLayout.maxMixChannels {
                    accumulate(data, channel: channel, stride: stride, frames: frames, into: out)
                    used += 1
                }
            }
        }
        if used > 1 {
            let scale = 1 / Float(used)
            for i in 0..<frames { mono[i] *= scale }
        }
        return mono
    }

    private func accumulate(
        _ data: UnsafeMutableRawPointer, channel: Int, stride: Int, frames: Int, into out: UnsafeMutableBufferPointer<Float>
    ) {
        switch sampleType {
        case .float32:
            let src = data.assumingMemoryBound(to: Float.self)
            for i in 0..<frames { out[i] += src[i * stride + channel] }
        case .int16:
            let src = data.assumingMemoryBound(to: Int16.self)
            for i in 0..<frames { out[i] += Float(src[i * stride + channel]) / 32768 }
        case .int32:
            let src = data.assumingMemoryBound(to: Int32.self)
            for i in 0..<frames { out[i] += Float(src[i * stride + channel]) / 2_147_483_648 }
        }
    }
}
