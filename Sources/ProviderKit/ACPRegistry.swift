import Foundation
import OrchestratorCore

public struct ACPRegistryIndex: Codable, Sendable, Equatable {
  public var version: String
  public var agents: [ACPRegistryAgent]

  public init(version: String, agents: [ACPRegistryAgent]) {
    self.version = version
    self.agents = agents
  }
}

public struct ACPRegistryAgent: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var name: String
  public var version: String
  public var description: String
  public var repository: URL?
  public var website: URL?
  public var distribution: ACPRegistryDistribution

  public init(
    id: String,
    name: String,
    version: String,
    description: String,
    repository: URL? = nil,
    website: URL? = nil,
    distribution: ACPRegistryDistribution
  ) {
    self.id = id
    self.name = name
    self.version = version
    self.description = description
    self.repository = repository
    self.website = website
    self.distribution = distribution
  }
}

public struct ACPRegistryDistribution: Codable, Sendable, Equatable {
  public var binary: [String: ACPRegistryBinaryTarget]?
  public var npx: ACPRegistryPackageDistribution?
  public var uvx: ACPRegistryPackageDistribution?

  public init(
    binary: [String: ACPRegistryBinaryTarget]? = nil,
    npx: ACPRegistryPackageDistribution? = nil,
    uvx: ACPRegistryPackageDistribution? = nil
  ) {
    self.binary = binary
    self.npx = npx
    self.uvx = uvx
  }
}

public struct ACPRegistryBinaryTarget: Codable, Sendable, Equatable {
  public var archive: URL
  public var sha256: String?
  public var cmd: String
  public var args: [String]?
  public var env: [String: String]?

  public init(
    archive: URL,
    sha256: String? = nil,
    cmd: String,
    args: [String]? = nil,
    env: [String: String]? = nil
  ) {
    self.archive = archive
    self.sha256 = sha256
    self.cmd = cmd
    self.args = args
    self.env = env
  }
}

public struct ACPRegistryPackageDistribution: Codable, Sendable, Equatable {
  public var package: String
  public var args: [String]?
  public var env: [String: String]?

  public init(
    package: String,
    args: [String]? = nil,
    env: [String: String]? = nil
  ) {
    self.package = package
    self.args = args
    self.env = env
  }
}

public enum ACPRegistryError: LocalizedError, Sendable {
  case invalidResponse
  case responseTooLarge
  case unsupportedSchema(String)

  public var errorDescription: String? {
    switch self {
    case .invalidResponse:
      "The ACP Registry returned an invalid response."
    case .responseTooLarge:
      "The ACP Registry response exceeded the 10 MB safety limit."
    case .unsupportedSchema(let version):
      "ACP Registry schema \(version) is not supported."
    }
  }
}

public actor ACPRegistryClient {
  public static let endpoint = URL(
    string: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
  )!

  private let cacheURL: URL
  private let session: URLSession
  private let maximumResponseBytes = 10 * 1_024 * 1_024

  public init(cacheURL: URL, session: URLSession = .shared) {
    self.cacheURL = cacheURL
    self.session = session
  }

  public func cachedProviders() throws -> [CatalogProvider] {
    guard let data = FileManager.default.contents(atPath: cacheURL.path) else {
      return []
    }
    return try Self.decodeProviders(data)
  }

  public func refresh() async throws -> [CatalogProvider] {
    var request = URLRequest(
      url: Self.endpoint,
      cachePolicy: .reloadIgnoringLocalCacheData,
      timeoutInterval: 20
    )
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse,
      (200..<300).contains(response.statusCode)
    else {
      throw ACPRegistryError.invalidResponse
    }
    guard data.count <= maximumResponseBytes else {
      throw ACPRegistryError.responseTooLarge
    }
    let providers = try Self.decodeProviders(data)
    try FileManager.default.createDirectory(
      at: cacheURL.deletingLastPathComponent(),
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try data.write(to: cacheURL, options: .atomic)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: cacheURL.path
    )
    return providers
  }

  public static func decodeProviders(_ data: Data) throws -> [CatalogProvider] {
    let registry = try JSONDecoder().decode(ACPRegistryIndex.self, from: data)
    guard registry.version.hasPrefix("1.") else {
      throw ACPRegistryError.unsupportedSchema(registry.version)
    }
    return registry.agents.compactMap { agent in
      guard let distribution = agent.distribution.npx else {
        return nil
      }
      return CatalogProvider(
        id: agent.id,
        name: agent.name,
        command: [distribution.package] + (distribution.args ?? []),
        installCommand: "npm install --global -- \(shellQuote(distribution.package))",
        runtime: .npmGlobal(package: distribution.package),
        environment: distribution.env ?? [:],
        registryVersion: agent.version
      )
    }
    .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }

  private static func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }
}
