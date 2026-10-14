import CoreAudio
import Foundation

/// A failed Core Audio call, with the OSStatus rendered as a four-char code when printable.
struct CoreAudioError: Error, CustomStringConvertible {
    let operation: String
    let status: OSStatus

    var description: String { "\(operation) 失败 (OSStatus \(CoreAudioError.render(status)))" }

    static func render(_ status: OSStatus) -> String {
        let n = UInt32(bitPattern: status)
        let bytes = [24, 16, 8, 0].map { UInt8((n >> UInt32($0)) & 0xFF) }
        if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) {
            return "'\(String(decoding: bytes, as: UTF8.self))'"
        }
        return String(status)
    }
}

func check(_ status: OSStatus, _ operation: String) throws {
    guard status == noErr else { throw CoreAudioError(operation: operation, status: status) }
}

/// Thin typed wrappers over `AudioObjectGetPropertyData`.
enum CA {
    static let system = AudioObjectID(kAudioObjectSystemObject)

    static func address(
        _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func has(
        _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> Bool {
        var addr = address(selector, scope)
        return AudioObjectHasProperty(object, &addr)
    }

    static func value<T: BitwiseCopyable>(
        _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, initial: T
    ) throws -> T {
        var addr = address(selector, scope)
        var value = initial
        var size = UInt32(MemoryLayout<T>.size)
        try check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value), "读取属性 \(selector)")
        return value
    }

    static func uint32(
        _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> UInt32? {
        try? value(object, selector, scope, initial: UInt32(0))
    }

    static func array<T: BitwiseCopyable>(
        _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, zero: T
    ) -> [T] {
        var addr = address(selector, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var items = [T](repeating: zero, count: Int(size) / MemoryLayout<T>.stride)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &items) == noErr else { return [] }
        return Array(items.prefix(Int(size) / MemoryLayout<T>.stride))
    }

    static func string(
        _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> String? {
        var addr = address(selector, scope)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr else { return nil }
        return value?.takeRetainedValue() as String?
    }
}

/// Host-clock helpers. All timeline math uses host time converted to nanoseconds.
enum HostClock {
    static func nowNanos() -> UInt64 { AudioConvertHostTimeToNanos(AudioGetCurrentHostTime()) }
    static func nanos(hostTime: UInt64) -> UInt64 { AudioConvertHostTimeToNanos(hostTime) }
}

/// Snapshot of one HAL audio device.
struct AudioDeviceInfo: Sendable {
    let id: AudioObjectID
    let uid: String
    let name: String
    let inputChannels: Int
    let outputChannels: Int
    let transport: String
}

/// Device enumeration and per-device queries.
enum AudioDevices {
    static func all() -> [AudioDeviceInfo] {
        CA.array(CA.system, kAudioHardwarePropertyDevices, zero: AudioObjectID(0)).compactMap(info)
    }

    static func info(_ id: AudioObjectID) -> AudioDeviceInfo? {
        guard let uid = CA.string(id, kAudioDevicePropertyDeviceUID) else { return nil }
        if CA.uint32(id, kAudioDevicePropertyIsHidden) == 1 { return nil }
        return AudioDeviceInfo(
            id: id, uid: uid, name: name(id),
            inputChannels: channelCount(id, kAudioObjectPropertyScopeInput),
            outputChannels: channelCount(id, kAudioObjectPropertyScopeOutput),
            transport: transport(id))
    }

    static func name(_ id: AudioObjectID) -> String {
        CA.string(id, kAudioObjectPropertyName) ?? "设备 \(id)"
    }

    static func defaultDevice(input: Bool) -> AudioObjectID? {
        let selector = input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice
        guard let id = CA.uint32(CA.system, selector), id != kAudioObjectUnknown else { return nil }
        return id
    }

    static func device(uid: String) -> AudioObjectID? {
        all().first(where: { $0.uid == uid })?.id
    }

    static func isAlive(_ id: AudioObjectID) -> Bool {
        CA.uint32(id, kAudioDevicePropertyDeviceIsAlive) == 1
    }

    static func nominalSampleRate(_ id: AudioObjectID) -> Double? {
        try? CA.value(id, kAudioDevicePropertyNominalSampleRate, initial: Float64(0))
    }

    static func channelCount(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int {
        var addr = CA.address(kAudioDevicePropertyStreamConfiguration, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    /// Virtual (IOProc-side) format of the first stream in `scope`.
    static func firstStreamFormat(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> AudioStreamBasicDescription? {
        guard let stream = CA.array(id, kAudioDevicePropertyStreams, scope, zero: AudioStreamID(0)).first else {
            return nil
        }
        return try? CA.value(stream, kAudioStreamPropertyVirtualFormat, initial: AudioStreamBasicDescription())
    }

    /// Hardware latency between the converter/ADC and the IO buffer, in frames (device + first stream).
    static func inputLatencyFrames(_ id: AudioObjectID) -> UInt32 {
        let device = CA.uint32(id, kAudioDevicePropertyLatency, kAudioObjectPropertyScopeInput) ?? 0
        let stream = CA.array(id, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput, zero: AudioStreamID(0))
            .first.flatMap { CA.uint32($0, kAudioStreamPropertyLatency) } ?? 0
        return device + stream
    }

    static func transport(_ id: AudioObjectID) -> String {
        switch CA.uint32(id, kAudioDevicePropertyTransportType) ?? 0 {
        case kAudioDeviceTransportTypeBuiltIn: return "builtin"
        case kAudioDeviceTransportTypeUSB: return "usb"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
        case kAudioDeviceTransportTypeAggregate, kAudioDeviceTransportTypeAutoAggregate: return "aggregate"
        case kAudioDeviceTransportTypeVirtual: return "virtual"
        case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: return "display"
        case kAudioDeviceTransportTypeAirPlay: return "airplay"
        case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt"
        case kAudioDeviceTransportTypeContinuityCaptureWired, kAudioDeviceTransportTypeContinuityCaptureWireless:
            return "continuity"
        default: return "unknown"
        }
    }
}

/// Core Audio "process objects" (macOS 14+): one per process that has done audio IO.
enum AudioProcesses {
    struct Info: Sendable {
        let objectID: AudioObjectID
        let pid: pid_t
        let bundleID: String?
        let runningInput: Bool
        let runningOutput: Bool
    }

    static func all() -> [Info] {
        CA.array(CA.system, kAudioHardwarePropertyProcessObjectList, zero: AudioObjectID(0)).compactMap { id in
            guard let pid = try? CA.value(id, kAudioProcessPropertyPID, initial: pid_t(0)) else { return nil }
            return Info(
                objectID: id, pid: pid,
                bundleID: CA.string(id, kAudioProcessPropertyBundleID).flatMap { $0.isEmpty ? nil : $0 },
                runningInput: CA.uint32(id, kAudioProcessPropertyIsRunningInput) == 1,
                runningOutput: CA.uint32(id, kAudioProcessPropertyIsRunningOutput) == 1)
        }
    }

    static func processObject(for pid: pid_t) -> AudioObjectID? {
        var addr = CA.address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var qualifier = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            CA.system, &addr, UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
        guard status == noErr, object != kAudioObjectUnknown else { return nil }
        return object
    }
}

/// One Core Audio property listener whose handler runs on `queue`. Remove it with `cancel()`.
final class PropertyListener: @unchecked Sendable {
    private let object: AudioObjectID
    private var address: AudioObjectPropertyAddress
    private let queue: DispatchQueue
    private let handler: @Sendable () -> Void
    private let lock = NSLock()
    private var active = true

    init?(
        _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
        queue: DispatchQueue, handler: @escaping @Sendable () -> Void
    ) {
        self.object = object
        self.address = CA.address(selector, scope)
        self.queue = queue
        self.handler = handler
        // Retained on purpose: the HAL may still deliver an in-flight callback after removal.
        let context = Unmanaged.passRetained(self).toOpaque()
        if AudioObjectAddPropertyListener(object, &address, propertyListenerProc, context) != noErr {
            Unmanaged<PropertyListener>.fromOpaque(context).release()
            return nil
        }
    }

    func cancel() {
        lock.lock()
        let wasActive = active
        active = false
        lock.unlock()
        guard wasActive else { return }
        AudioObjectRemovePropertyListener(object, &address, propertyListenerProc, Unmanaged.passUnretained(self).toOpaque())
    }

    fileprivate func fire() {
        lock.lock()
        let isActive = active
        lock.unlock()
        guard isActive else { return }
        let handler = self.handler
        queue.async(execute: handler)
    }
}

private func propertyListenerProc(
    _ object: AudioObjectID, _ count: UInt32,
    _ addresses: UnsafePointer<AudioObjectPropertyAddress>, _ context: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let context else { return noErr }
    Unmanaged<PropertyListener>.fromOpaque(context).takeUnretainedValue().fire()
    return noErr
}
