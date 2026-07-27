import Foundation

public enum OrchestratorProtocol {
  public static let version = 2
  public static let serviceName = "com.mattiafiumara.Orchestrator.service"
}

public struct CoreHandshake: Codable, Sendable, Equatable {
  public var protocolVersion: Int
  public var clientName: String
  public var clientVersion: String

  public init(
    protocolVersion: Int = OrchestratorProtocol.version,
    clientName: String,
    clientVersion: String
  ) {
    self.protocolVersion = protocolVersion
    self.clientName = clientName
    self.clientVersion = clientVersion
  }
}

public struct CoreServiceInfo: Codable, Sendable, Equatable {
  public var protocolVersion: Int
  public var serviceVersion: String
  public var processIdentifier: Int32

  public init(
    protocolVersion: Int = OrchestratorProtocol.version,
    serviceVersion: String,
    processIdentifier: Int32
  ) {
    self.protocolVersion = protocolVersion
    self.serviceVersion = serviceVersion
    self.processIdentifier = processIdentifier
  }
}

public struct CoreServiceFailure: Codable, LocalizedError, Sendable, Equatable {
  public var code: String
  public var message: String

  public init(code: String, message: String) {
    self.code = code
    self.message = message
  }

  public var errorDescription: String? { message }
}

public struct DelegationBridgeRequest: Codable, Sendable, Equatable {
  public var token: String
  public var method: String
  public var params: JSONValue

  public init(token: String, method: String, params: JSONValue = .object([:])) {
    self.token = token
    self.method = method
    self.params = params
  }
}

public enum CoreRPCRequest: Codable, Sendable, Equatable {
  case handshake(CoreHandshake)
  case allProjects
  case providerInspections
  case refreshACPRegistry
  case openProject(OpenProjectRequest)
  case snapshot(projectID: String)
  case createTask(CreateTaskRequest)
  case launchAgent(LaunchAgentRequest)
  case sendMessage(SendAgentMessageRequest)
  case interrupt(InterruptAgentRequest)
  case resolveApproval(ResolveApprovalRequest)
  case respondToInput(RespondToInputRequest)
  case archiveTask(ArchiveTaskRequest)
  case diff(taskID: String)
  case createPullRequest(CreatePullRequestRequest)
  case events(after: Int64, taskID: String?)
  case delegation(DelegationBridgeRequest)
  case startTerminal(StartTerminalRequest)
  case terminalInput(TerminalInputRequest)
  case terminalResize(TerminalResizeRequest)
  case terminalOutput(terminalID: String, after: Int64)
  case stopTerminal(StopTerminalRequest)
  case savePanelLayout(SavePanelLayoutRequest)
  case recoverTask(RecoverTaskRequest)
}

public enum CoreRPCResponse: Codable, Sendable, Equatable {
  case serviceInfo(CoreServiceInfo)
  case projects([Project])
  case providerInspections([ProviderInspection])
  case project(Project)
  case snapshot(CoreSnapshot)
  case task(OrchestrationTask)
  case agent(AgentSession)
  case diff(GitDiff)
  case pullRequest(PullRequest)
  case events([AgentEvent])
  case json(JSONValue)
  case terminal(TerminalSession)
  case terminalOutput(TerminalOutputBatch)
  case success
  case configurationTrustRequired(ConfigurationTrustRequirement)
  case dirtyWorktree(path: String)
  case failure(CoreServiceFailure)
}

@objc public protocol OrchestratorServiceXPC {
  /// Requests and responses are encoded with the stable Codable envelope above.
  /// A single Data boundary keeps XPC independent from Swift ABI changes.
  func perform(
    _ request: Data,
    withReply reply: @escaping @Sendable (Data) -> Void
  )
}

public enum CoreRPCCodec {
  public static func encode<T: Encodable>(_ value: T) throws -> Data {
    try JSONEncoder.orchestrator.encode(value)
  }

  public static func decode<T: Decodable>(
    _ type: T.Type,
    from data: Data
  ) throws -> T {
    try JSONDecoder.orchestrator.decode(type, from: data)
  }
}
