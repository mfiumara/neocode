import Foundation
import OrchestratorCore

public enum CatalogRuntime: Codable, Sendable, Equatable {
  case executable
  case npmGlobal(package: String)
}

public struct CatalogProvider: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var name: String
  public var command: [String]
  public var installCommand: String?
  public var runtime: CatalogRuntime
  public var environment: [String: String]
  public var registryVersion: String?

  public init(
    id: String,
    name: String,
    command: [String],
    installCommand: String? = nil,
    runtime: CatalogRuntime = .executable,
    environment: [String: String] = [:],
    registryVersion: String? = nil
  ) {
    self.id = id
    self.name = name
    self.command = command
    self.installCommand = installCommand
    self.runtime = runtime
    self.environment = environment
    self.registryVersion = registryVersion
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case name
    case command
    case installCommand
    case runtime
    case environment
    case registryVersion
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    name = try container.decode(String.self, forKey: .name)
    command = try container.decode([String].self, forKey: .command)
    installCommand = try container.decodeIfPresent(
      String.self,
      forKey: .installCommand
    )
    runtime =
      try container.decodeIfPresent(
        CatalogRuntime.self,
        forKey: .runtime
      ) ?? .executable
    environment =
      try container.decodeIfPresent(
        [String: String].self,
        forKey: .environment
      ) ?? [:]
    registryVersion = try container.decodeIfPresent(
      String.self,
      forKey: .registryVersion
    )
  }

  public var descriptor: ProviderDescriptor {
    ProviderDescriptor(
      id: id,
      label: name,
      command: command,
      installationCommand: installCommand,
      capabilities: [
        .models, .modes, .resume, .steer, .interrupt, .approvals,
        .toolCalls, .sessionList, .sessionClose, .terminalRequests, .mcpInjection,
      ]
    )
  }
}

public enum ProviderCatalog {
  /// Offline bootstrap catalog used until the official HTTPS registry is refreshed.
  public static let bootstrap: [CatalogProvider] = [
    CatalogProvider(
      id: "copilot",
      name: "GitHub Copilot",
      command: ["copilot", "--acp"],
      installCommand: "npm install -g @github/copilot"
    ),
    CatalogProvider(
      id: "gemini",
      name: "Gemini CLI",
      command: ["gemini", "--acp"],
      installCommand: "npm install -g @google/gemini-cli"
    ),
    CatalogProvider(
      id: "opencode",
      name: "OpenCode",
      command: ["opencode", "acp"],
      installCommand: "brew install anomalyco/tap/opencode"
    ),
    CatalogProvider(
      id: "goose",
      name: "Goose",
      command: ["goose", "acp"],
      installCommand: "brew install block-goose-cli"
    ),
    CatalogProvider(
      id: "pi",
      name: "Pi",
      command: ["pi-acp"],
      installCommand: "npm install -g pi-acp"
    ),
  ]

  public static func makeDefaultAdapters(includeDemo: Bool = false) -> [any ProviderAdapter] {
    var adapters: [any ProviderAdapter] = [
      CodexAdapter(),
      ClaudeAdapter(),
    ]
    adapters.append(contentsOf: makeACPAdapters(from: bootstrap))
    if includeDemo {
      adapters.append(FakeProvider())
    }
    return adapters
  }

  public static func makeACPAdapters(
    from providers: [CatalogProvider]
  ) -> [any ProviderAdapter] {
    providers.map { provider in
      ACPAdapter(
        descriptor: provider.descriptor,
        runtime: provider.runtime,
        additionalEnvironment: provider.environment,
        registryVersion: provider.registryVersion
      )
    }
  }
}
