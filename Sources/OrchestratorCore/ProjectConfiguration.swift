import CryptoKit
import Foundation

public struct ProjectConfiguration: Codable, Sendable, Equatable {
  public var version: Int
  public var worktree: WorktreeConfiguration
  public var scripts: [String: ProjectScript]

  public init(
    version: Int = 1,
    worktree: WorktreeConfiguration = .init(),
    scripts: [String: ProjectScript] = [:]
  ) {
    self.version = version
    self.worktree = worktree
    self.scripts = scripts
  }
}

public struct WorktreeConfiguration: Codable, Sendable, Equatable {
  public var setup: [String]
  public var teardown: [String]

  public init(setup: [String] = [], teardown: [String] = []) {
    self.setup = setup
    self.teardown = teardown
  }
}

public enum ProjectScriptKind: String, Codable, Sendable {
  case task
  case service
}

public enum ProjectPort: Codable, Sendable, Equatable {
  case automatic
  case fixed(Int)

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(Int.self) {
      self = .fixed(value)
    } else {
      let value = try container.decode(String.self)
      guard value == "auto" else {
        throw DecodingError.dataCorruptedError(
          in: container,
          debugDescription: "Port must be an integer or \"auto\"."
        )
      }
      self = .automatic
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .automatic:
      try container.encode("auto")
    case .fixed(let port):
      try container.encode(port)
    }
  }
}

public struct ProjectScript: Codable, Sendable, Equatable {
  public var kind: ProjectScriptKind
  public var command: String
  public var port: ProjectPort?
  public var url: String?

  public init(
    kind: ProjectScriptKind,
    command: String,
    port: ProjectPort? = nil,
    url: String? = nil
  ) {
    self.kind = kind
    self.command = command
    self.port = port
    self.url = url
  }
}

public struct LoadedProjectConfiguration: Sendable, Equatable {
  public var configuration: ProjectConfiguration
  public var sourceData: Data
  public var hash: String
  public var path: String

  public init(
    configuration: ProjectConfiguration,
    sourceData: Data,
    hash: String,
    path: String
  ) {
    self.configuration = configuration
    self.sourceData = sourceData
    self.hash = hash
    self.path = path
  }
}

public enum ProjectConfigurationError: LocalizedError, Sendable {
  case unsupportedVersion(Int)
  case invalidPort(Int)
  case invalidService(String)

  public var errorDescription: String? {
    switch self {
    case .unsupportedVersion(let version):
      "Unsupported .orchestrator.json version \(version)."
    case .invalidPort(let port):
      "Port \(port) is outside the valid range."
    case .invalidService(let name):
      "Service \(name) must declare a port and preview URL."
    }
  }
}

public enum ProjectConfigurationLoader {
  public static let fileName = ".orchestrator.json"

  public static func load(from projectRoot: URL) throws -> LoadedProjectConfiguration? {
    let url = projectRoot.appending(path: fileName)
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }

    let data = try Data(contentsOf: url)
    return try load(data: data, path: url.path)
  }

  public static func load(
    data: Data,
    path: String
  ) throws -> LoadedProjectConfiguration {
    let configuration = try JSONDecoder.orchestrator.decode(
      ProjectConfiguration.self,
      from: data
    )
    try validate(configuration)
    return LoadedProjectConfiguration(
      configuration: configuration,
      sourceData: data,
      hash: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
      path: path
    )
  }

  public static func validate(_ configuration: ProjectConfiguration) throws {
    guard configuration.version == 1 else {
      throw ProjectConfigurationError.unsupportedVersion(configuration.version)
    }

    for (name, script) in configuration.scripts {
      if case .fixed(let port)? = script.port, !(1...65_535).contains(port) {
        throw ProjectConfigurationError.invalidPort(port)
      }
      if script.kind == .service, script.port == nil || script.url == nil {
        throw ProjectConfigurationError.invalidService(name)
      }
    }
  }
}
