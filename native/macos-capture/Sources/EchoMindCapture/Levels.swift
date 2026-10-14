import Foundation

/// Accumulates mean-square energy between level events and reports RMS in dBFS (floor −90).
struct LevelMeter {
    static let floorDB = -90.0

    private var sumSquares = 0.0
    private var count = 0

    mutating func add(_ samples: [Float]) {
        var acc: Float = 0
        for s in samples { acc += s * s }
        sumSquares += Double(acc)
        count += samples.count
    }

    /// Returns the level since the previous call and resets the window.
    mutating func take() -> Double {
        defer {
            sumSquares = 0
            count = 0
        }
        return LevelMeter.dbfs(meanSquare: count > 0 ? sumSquares / Double(count) : 0)
    }

    static func dbfs(meanSquare: Double) -> Double {
        guard meanSquare > 0 else { return floorDB }
        return min(0, max(floorDB, 10 * log10(meanSquare)))
    }
}
