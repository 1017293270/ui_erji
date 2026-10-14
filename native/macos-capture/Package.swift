// swift-tools-version:6.0
import Foundation
import PackageDescription

// The Info.plist is linked into the binary's __TEXT,__info_plist section so TCC can read the
// bundle id and usage descriptions of this bare executable.
let infoPlistPath = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("Info.plist")
    .path

let package = Package(
    name: "EchoMindCapture",
    platforms: [.macOS("14.2")],
    products: [
        .executable(name: "echomind-capture", targets: ["EchoMindCapture"])
    ],
    targets: [
        .executableTarget(
            name: "EchoMindCapture",
            path: "Sources/EchoMindCapture",
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", infoPlistPath,
                ])
            ]
        )
    ],
    swiftLanguageModes: [.v6]
)
