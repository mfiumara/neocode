import Foundation

public struct ProviderCapabilities: OptionSet, Codable, Sendable, Hashable {
  public let rawValue: UInt64

  public init(rawValue: UInt64) {
    self.rawValue = rawValue
  }

  public static let models = ProviderCapabilities(rawValue: 1 << 0)
  public static let modes = ProviderCapabilities(rawValue: 1 << 1)
  public static let resume = ProviderCapabilities(rawValue: 1 << 2)
  public static let steer = ProviderCapabilities(rawValue: 1 << 3)
  public static let interrupt = ProviderCapabilities(rawValue: 1 << 4)
  public static let approvals = ProviderCapabilities(rawValue: 1 << 5)
  public static let fileChanges = ProviderCapabilities(rawValue: 1 << 6)
  public static let toolCalls = ProviderCapabilities(rawValue: 1 << 7)
  public static let sessionList = ProviderCapabilities(rawValue: 1 << 8)
  public static let sessionClose = ProviderCapabilities(rawValue: 1 << 9)
  public static let terminalRequests = ProviderCapabilities(rawValue: 1 << 10)
  public static let mcpInjection = ProviderCapabilities(rawValue: 1 << 11)
  public static let structuredInput = ProviderCapabilities(rawValue: 1 << 12)
}

public struct ProviderModel: Codable, Sendable, Identifiable, Equatable, Hashable {
  public var id: String
  public var label: String
  public var isDefault: Bool

  public init(id: String, label: String, isDefault: Bool = false) {
    self.id = id
    self.label = label
    self.isDefault = isDefault
  }
}

public struct ProviderMode: Codable, Sendable, Identifiable, Equatable, Hashable {
  public var id: String
  public var label: String

  public init(id: String, label: String) {
    self.id = id
    self.label = label
  }
}

public struct ProviderDescriptor: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var label: String
  public var command: [String]
  public var installationCommand: String?
  public var capabilities: ProviderCapabilities

  public init(
    id: String,
    label: String,
    command: [String],
    installationCommand: String? = nil,
    capabilities: ProviderCapabilities
  ) {
    self.id = id
    self.label = label
    self.command = command
    self.installationCommand = installationCommand
    self.capabilities = capabilities
  }
}

public enum ProviderAvailability: Codable, Sendable, Equatable {
  case available(path: String, version: String?)
  case unavailable(reason: String)
  case unsupported(path: String, version: String?, reason: String)
}

public struct ProviderInspection: Codable, Sendable, Equatable {
  public var descriptor: ProviderDescriptor
  public var availability: ProviderAvailability
  public var models: [ProviderModel]
  public var modes: [ProviderMode]

  public init(
    descriptor: ProviderDescriptor,
    availability: ProviderAvailability,
    models: [ProviderModel] = [],
    modes: [ProviderMode] = []
  ) {
    self.descriptor = descriptor
    self.availability = availability
    self.models = models
    self.modes = modes
  }
}

public struct ProviderLaunchRequest: Codable, Sendable, Equatable {
  public var agentID: String
  public var taskID: String
  public var workingDirectory: String
  public var prompt: String
  public var model: String?
  public var mode: String?
  public var resumeSessionID: String?
  public var environment: [String: String]
  public var mcpConfigurationPath: String?

  public init(
    agentID: String,
    taskID: String,
    workingDirectory: String,
    prompt: String,
    model: String? = nil,
    mode: String? = nil,
    resumeSessionID: String? = nil,
    environment: [String: String] = [:],
    mcpConfigurationPath: String? = nil
  ) {
    self.agentID = agentID
    self.taskID = taskID
    self.workingDirectory = workingDirectory
    self.prompt = prompt
    self.model = model
    self.mode = mode
    self.resumeSessionID = resumeSessionID
    self.environment = environment
    self.mcpConfigurationPath = mcpConfigurationPath
  }
}

public struct ProviderSession: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var providerID: String
  public var agentID: String

  public init(id: String, providerID: String, agentID: String) {
    self.id = id
    self.providerID = providerID
    self.agentID = agentID
  }
}

public enum ApprovalDecision: String, Codable, Sendable {
  case allowOnce
  case allowForSession
  case deny
  case cancel
}

public struct ProviderEvent: Codable, Sendable, Equatable {
  public var sessionID: String
  public var kind: AgentEventKind
  public var payload: JSONValue
  public var raw: JSONValue
  public var timestamp: Date

  public init(
    sessionID: String,
    kind: AgentEventKind,
    payload: JSONValue,
    raw: JSONValue,
    timestamp: Date = .now
  ) {
    self.sessionID = sessionID
    self.kind = kind
    self.payload = payload
    self.raw = raw
    self.timestamp = timestamp
  }
}

public protocol ProviderAdapter: Sendable {
  var descriptor: ProviderDescriptor { get }
  func inspect() async -> ProviderInspection
  func start(_ request: ProviderLaunchRequest) async throws -> ProviderSession
  func send(_ text: String, to sessionID: String) async throws
  func steer(_ text: String, sessionID: String) async throws
  func interrupt(sessionID: String) async throws
  func respond(to approvalID: String, decision: ApprovalDecision, sessionID: String) async throws
  func respondToInput(
    requestID: String,
    answers: [String: [String]],
    sessionID: String
  ) async throws
  func close(sessionID: String) async
  func events(sessionID: String) async -> AsyncStream<ProviderEvent>
}

extension ProviderAdapter {
  public func respondToInput(
    requestID: String,
    answers: [String: [String]],
    sessionID: String
  ) async throws {
    throw ProviderError.unsupportedCapability("structured input requests")
  }
}

public enum ProviderError: LocalizedError, Sendable {
  case executableNotFound(String)
  case unsupported(String)
  case processExited(Int32, String)
  case protocolViolation(String)
  case unknownSession(String)
  case unsupportedCapability(String)

  public var errorDescription: String? {
    switch self {
    case .executableNotFound(let name):
      "The \(name) executable could not be found."
    case .unsupported(let message):
      message
    case .processExited(let code, let message):
      "Provider exited with status \(code): \(message)"
    case .protocolViolation(let message):
      "Provider protocol error: \(message)"
    case .unknownSession(let id):
      "Unknown provider session \(id)."
    case .unsupportedCapability(let name):
      "This provider does not support \(name)."
    }
  }
}
