// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "Orchestrator",
  platforms: [
    .macOS("26.0")
  ],
  products: [
    .library(name: "OrchestratorCore", targets: ["OrchestratorCore"]),
    .library(name: "ProviderKit", targets: ["ProviderKit"]),
    .executable(name: "Orchestrator", targets: ["OrchestratorApp"]),
    .executable(name: "OrchestratorService", targets: ["OrchestratorService"]),
    .executable(name: "OrchestratorBridge", targets: ["OrchestratorBridge"]),
  ],
  dependencies: [
    .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.10.0"),
    .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    .package(url: "https://github.com/krzyzanowskim/STTextView.git", from: "2.3.11"),
    .package(
      url: "https://github.com/krzyzanowskim/STTextView-Plugin-Neon.git",
      revision: "5a30db4ce7908a5414e7b499e2379bdc49991cd1"
    ),
    // Command Line Tools 26 ships Testing without its private support
    // module, so use the portable package until a full Xcode toolchain is selected.
    .package(url: "https://github.com/swiftlang/swift-testing.git", from: "0.12.0"),
  ],
  targets: [
    .target(
      name: "OrchestratorCore",
      dependencies: [
        .product(name: "GRDB", package: "GRDB.swift"),
        .product(name: "SwiftTerm", package: "SwiftTerm"),
      ]
    ),
    .target(
      name: "ProviderKit",
      dependencies: ["OrchestratorCore"]
    ),
    .executableTarget(
      name: "OrchestratorApp",
      dependencies: [
        "OrchestratorCore",
        "ProviderKit",
        .product(name: "STTextView", package: "STTextView"),
        .product(
          name: "STTextView-Plugin-Neon",
          package: "STTextView-Plugin-Neon"
        ),
        .product(name: "SwiftTerm", package: "SwiftTerm"),
      ],
      resources: [.process("Resources")]
    ),
    .executableTarget(
      name: "OrchestratorService",
      dependencies: ["OrchestratorCore", "ProviderKit"]
    ),
    .executableTarget(
      name: "OrchestratorBridge",
      dependencies: ["OrchestratorCore"]
    ),
    .testTarget(
      name: "OrchestratorCoreTests",
      dependencies: [
        "OrchestratorCore",
        "ProviderKit",
        .product(name: "Testing", package: "swift-testing"),
      ]
    ),
    .testTarget(
      name: "ProviderKitTests",
      dependencies: [
        "ProviderKit",
        "OrchestratorCore",
        .product(name: "Testing", package: "swift-testing"),
      ]
    ),
    .testTarget(
      name: "OrchestratorAppTests",
      dependencies: [
        "OrchestratorApp",
        .product(name: "Testing", package: "swift-testing"),
      ]
    ),
  ],
  swiftLanguageModes: [.v6]
)
