// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ZenchronMenuBar",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "zenchron-menubar", targets: ["ZenchronMenuBar"])],
    targets: [
        .target(name: "ZenchronStatusCore"),
        .executableTarget(name: "ZenchronMenuBar", dependencies: ["ZenchronStatusCore"]),
        .testTarget(name: "ZenchronStatusCoreTests", dependencies: ["ZenchronStatusCore"]),
    ]
)
