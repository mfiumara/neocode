import Foundation
import OrchestratorCore

private struct ACPApprovalRoute: Sendable {
  var rpcID: JSONValue
  var optionIDsByKind: [String: String]
}

private struct ACPRunningSession {
  var client: JSONRPCClient
  var workingDirectory: String
  var stream: AsyncStream<ProviderEvent>
  var continuation: AsyncStream<ProviderEvent>.Continuation
  var approvals: [String: ACPApprovalRoute]
  var forwardingTask: Task<Void, Never>?
}

public actor ACPAdapter: ProviderAdapter {
  public nonisolated let descriptor: ProviderDescriptor
  private let protocolVersion: Int
  private let runtime: CatalogRuntime
  private let additionalEnvironment: [String: String]
  private let registryVersion: String?
  private let terminalProcesses = ServiceProcessManager(
    maximumOutputBytes: 2_000_000
  )
  private var sessions: [String: ACPRunningSession] = [:]
  private var terminalOwners: [String: String] = [:]

  public init(
    descriptor: ProviderDescriptor,
    protocolVersion: Int = 1,
    runtime: CatalogRuntime = .executable,
    additionalEnvironment: [String: String] = [:],
    registryVersion: String? = nil
  ) {
    self.descriptor = descriptor
    self.protocolVersion = protocolVersion
    self.runtime = runtime
    self.additionalEnvironment = additionalEnvironment
    self.registryVersion = registryVersion
  }

  public func inspect() async -> ProviderInspection {
    guard let command = try? await resolvedCommand() else {
      return ProviderInspection(
        descriptor: descriptor,
        availability: .unavailable(reason: "\(descriptor.label) is not installed.")
      )
    }
    return ProviderInspection(
      descriptor: descriptor,
      availability: .available(
        path: command.executable,
        version: registryVersion
      )
    )
  }

  public func start(_ request: ProviderLaunchRequest) async throws -> ProviderSession {
    let command = try await resolvedCommand()
    let client = JSONRPCClient(includesVersionHeader: true)
    try await client.start(
      CommandSpec(
        executable: command.executable,
        arguments: command.arguments,
        workingDirectory: request.workingDirectory,
        environment: additionalEnvironment.merging(
          request.environment,
          uniquingKeysWith: { _, requestValue in requestValue }
        )
      )
    )
    let initialization = try await client.request(
      method: "initialize",
      params: .object([
        "protocolVersion": .number(Double(protocolVersion)),
        "clientCapabilities": .object([
          "terminal": .bool(true),
          "fs": .object([
            "readTextFile": .bool(false),
            "writeTextFile": .bool(false),
          ]),
        ]),
        "clientInfo": .object([
          "name": .string("orchestrator-macos"),
          "title": .string("Orchestrator"),
          "version": .string("0.1.0"),
        ]),
      ])
    )
    guard
      case .number(let negotiatedVersion) = initialization["protocolVersion"],
      Int(negotiatedVersion) == protocolVersion
    else {
      await client.stop()
      throw ProviderError.unsupported(
        "The ACP agent negotiated an unsupported protocol version."
      )
    }

    let sessionResult: JSONValue
    if let resume = request.resumeSessionID {
      sessionResult = try await client.request(
        method: "session/resume",
        params: .object([
          "sessionId": .string(resume),
          "cwd": .string(request.workingDirectory),
          "mcpServers": DelegationConfiguration.acpServers(
            path: request.mcpConfigurationPath
          ),
        ])
      )
    } else {
      sessionResult = try await client.request(
        method: "session/new",
        params: .object([
          "cwd": .string(request.workingDirectory),
          "mcpServers": DelegationConfiguration.acpServers(
            path: request.mcpConfigurationPath
          ),
        ])
      )
    }
    guard let sessionID = sessionResult["sessionId"]?.stringValue else {
      await client.stop()
      throw ProviderError.protocolViolation("session/new did not return a session ID.")
    }
    let pair = AsyncStream.makeStream(of: ProviderEvent.self)
    let rpcEvents = await client.events()
    sessions[sessionID] = ACPRunningSession(
      client: client,
      workingDirectory: request.workingDirectory,
      stream: pair.stream,
      continuation: pair.continuation,
      approvals: [:],
      forwardingTask: nil
    )
    let forwarding = Task { [weak self] in
      for await message in rpcEvents {
        await self?.handle(message, sessionID: sessionID)
      }
    }
    sessions[sessionID]?.forwardingTask = forwarding
    if !request.prompt.isEmpty {
      try await send(request.prompt, to: sessionID)
    }
    return ProviderSession(
      id: sessionID,
      providerID: descriptor.id,
      agentID: request.agentID
    )
  }

  public func send(_ text: String, to sessionID: String) async throws {
    guard let state = sessions[sessionID] else {
      throw ProviderError.unknownSession(sessionID)
    }
    _ = try await state.client.request(
      method: "session/prompt",
      params: .object([
        "sessionId": .string(sessionID),
        "prompt": .array([
          .object(["type": .string("text"), "text": .string(text)])
        ]),
      ])
    )
  }

  public func steer(_ text: String, sessionID: String) async throws {
    try await send(text, to: sessionID)
  }

  public func interrupt(sessionID: String) async throws {
    guard let state = sessions[sessionID] else {
      throw ProviderError.unknownSession(sessionID)
    }
    try await state.client.notify(
      method: "session/cancel",
      params: .object(["sessionId": .string(sessionID)])
    )
  }

  public func respond(
    to approvalID: String,
    decision: ApprovalDecision,
    sessionID: String
  ) async throws {
    guard var state = sessions[sessionID] else {
      throw ProviderError.unknownSession(sessionID)
    }
    guard let route = state.approvals.removeValue(forKey: approvalID) else {
      throw ProviderError.protocolViolation("Unknown ACP approval \(approvalID).")
    }
    sessions[sessionID] = state
    let outcome: String? =
      switch decision {
      case .allowOnce:
        route.optionIDsByKind["allow_once"]
          ?? route.optionIDsByKind["allow_always"]
      case .allowForSession:
        route.optionIDsByKind["allow_always"]
          ?? route.optionIDsByKind["allow_once"]
      case .deny:
        route.optionIDsByKind["reject_once"]
          ?? route.optionIDsByKind["reject_always"]
      case .cancel:
        nil
      }
    let permissionOutcome: JSONValue
    if let outcome {
      permissionOutcome = .object([
        "outcome": .string("selected"),
        "optionId": .string(outcome),
      ])
    } else {
      permissionOutcome = .object(["outcome": .string("cancelled")])
    }
    try await state.client.respond(
      id: route.rpcID,
      result: .object(["outcome": permissionOutcome])
    )
  }

  public func close(sessionID: String) async {
    guard let state = sessions.removeValue(forKey: sessionID) else { return }
    for terminalID in terminalOwners.compactMap({
      $0.value == sessionID ? $0.key : nil
    }) {
      await terminalProcesses.stop(id: terminalID)
      terminalOwners.removeValue(forKey: terminalID)
    }
    _ = try? await state.client.request(
      method: "session/close",
      params: .object(["sessionId": .string(sessionID)])
    )
    state.forwardingTask?.cancel()
    state.continuation.finish()
    await state.client.stop()
  }

  public func events(sessionID: String) async -> AsyncStream<ProviderEvent> {
    guard let state = sessions[sessionID] else {
      return AsyncStream { $0.finish() }
    }
    return state.stream
  }

  private func handle(_ message: JSONRPCMessage, sessionID: String) async {
    guard var state = sessions[sessionID] else { return }
    let params = message.params ?? .object([:])
    let event: ProviderEvent
    if let method = message.method,
      method.hasPrefix("terminal/"),
      let rpcID = message.id
    {
      do {
        let result = try await handleTerminalRequest(
          method: method,
          params: params,
          sessionID: sessionID,
          workspacePath: state.workingDirectory
        )
        try await state.client.respond(id: rpcID, result: result)
      } catch {
        try? await state.client.respond(
          id: rpcID,
          errorCode: -32_602,
          message: error.localizedDescription
        )
      }
      return
    } else if message.method == "session/request_permission", let rpcID = message.id {
      let approvalID = OrchestratorID.make("acp_approval")
      let options = params["options"]?.arrayValue ?? []
      var optionIDsByKind: [String: String] = [:]
      for option in options {
        if let kind = option["kind"]?.stringValue,
          let id = option["optionId"]?.stringValue
        {
          optionIDsByKind[kind] = id
        }
      }
      state.approvals[approvalID] = ACPApprovalRoute(
        rpcID: rpcID,
        optionIDsByKind: optionIDsByKind
      )
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .approvalRequested,
        payload: .object([
          "approvalID": .string(approvalID),
          "kind": .string(ApprovalKind.providerSpecific.rawValue),
          "title": .string("Agent permission"),
          "summary": .string(
            params["toolCall"]?["title"]?.stringValue
              ?? "The agent needs permission to continue."
          ),
          "supportsAllowOnce": .bool(optionIDsByKind["allow_once"] != nil),
          "supportsAllowForSession": .bool(optionIDsByKind["allow_always"] != nil),
          "supportsDeny": .bool(
            optionIDsByKind["reject_once"] != nil
              || optionIDsByKind["reject_always"] != nil
          ),
        ]),
        raw: message.raw
      )
    } else if message.method == "session/update" {
      let update = params["update"] ?? params
      let updateKind = update["sessionUpdate"]?.stringValue
      let kind: AgentEventKind
      var payload = update
      switch updateKind {
      case "agent_message_chunk":
        kind = .messageDelta
        payload = normalizedTextPayload(from: update)
      case "agent_thought_chunk":
        kind = .reasoning
        payload = normalizedTextPayload(from: update)
      case "tool_call":
        kind = .toolStarted
      case "tool_call_update":
        kind =
          update["status"]?.stringValue == "completed"
          ? .toolCompleted
          : .toolUpdated
      case "plan":
        kind = .reasoning
      case "current_mode_update", "config_options_update":
        kind = .status
      default:
        kind = .raw
      }
      event = ProviderEvent(
        sessionID: sessionID,
        kind: kind,
        payload: payload,
        raw: message.raw
      )
    } else if message.raw["_orchestrator"]?.stringValue == "terminated" {
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .status,
        payload: .object(["status": .string(AgentStatus.disconnected.rawValue)]),
        raw: message.raw
      )
    } else {
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .raw,
        payload: params,
        raw: message.raw
      )
    }
    sessions[sessionID] = state
    state.continuation.yield(event)
  }

  private func handleTerminalRequest(
    method: String,
    params: JSONValue,
    sessionID: String,
    workspacePath: String
  ) async throws -> JSONValue {
    if let requestedSessionID = params["sessionId"]?.stringValue,
      requestedSessionID != sessionID
    {
      throw ProviderError.protocolViolation(
        "ACP terminal request crossed session boundaries."
      )
    }
    switch method {
    case "terminal/create":
      guard let command = params["command"]?.stringValue else {
        throw ProviderError.protocolViolation(
          "terminal/create requires a command."
        )
      }
      let workingDirectory = try scopedWorkingDirectory(
        params["cwd"]?.stringValue,
        workspacePath: workspacePath
      )
      let executable: String
      if command.hasPrefix("/") {
        executable = command
      } else if let located = BinaryLocator.locate(command) {
        executable = located
      } else {
        throw ProviderError.executableNotFound(command)
      }
      var environment: [String: String] = [:]
      for entry in params["env"]?.arrayValue ?? [] {
        if let name = entry["name"]?.stringValue,
          let value = entry["value"]?.stringValue
        {
          environment[name] = value
        }
      }
      let terminalID = OrchestratorID.make("acp_terminal")
      _ = try await terminalProcesses.start(
        id: terminalID,
        spec: CommandSpec(
          executable: executable,
          arguments: params["args"]?.arrayValue?.compactMap(\.stringValue) ?? [],
          workingDirectory: workingDirectory,
          environment: environment
        )
      )
      terminalOwners[terminalID] = sessionID
      return .object(["terminalId": .string(terminalID)])
    case "terminal/output":
      let snapshot = try await terminalSnapshot(
        params: params,
        sessionID: sessionID
      )
      var result: [String: JSONValue] = [
        "output": .string(snapshot.output),
        "truncated": .bool(snapshot.wasTruncated),
      ]
      if snapshot.status != .running && snapshot.status != .starting {
        result["exitStatus"] = terminalExitStatus(snapshot)
      }
      return .object(result)
    case "terminal/wait_for_exit":
      let terminalID = try terminalID(
        params: params,
        sessionID: sessionID
      )
      guard let snapshot = await terminalProcesses.waitForExit(id: terminalID) else {
        throw ProviderError.protocolViolation("Unknown ACP terminal.")
      }
      return terminalExitStatus(snapshot)
    case "terminal/kill":
      let terminalID = try terminalID(
        params: params,
        sessionID: sessionID
      )
      await terminalProcesses.terminate(id: terminalID)
      return .object([:])
    case "terminal/release":
      let terminalID = try terminalID(
        params: params,
        sessionID: sessionID
      )
      await terminalProcesses.stop(id: terminalID)
      terminalOwners.removeValue(forKey: terminalID)
      return .object([:])
    default:
      throw ProviderError.unsupportedCapability(method)
    }
  }

  private func terminalSnapshot(
    params: JSONValue,
    sessionID: String
  ) async throws -> ManagedProcessSnapshot {
    let terminalID = try terminalID(params: params, sessionID: sessionID)
    guard let snapshot = await terminalProcesses.snapshot(id: terminalID) else {
      throw ProviderError.protocolViolation("Unknown ACP terminal.")
    }
    return snapshot
  }

  private func terminalID(
    params: JSONValue,
    sessionID: String
  ) throws -> String {
    guard
      let terminalID = params["terminalId"]?.stringValue,
      terminalOwners[terminalID] == sessionID
    else {
      throw ProviderError.protocolViolation(
        "ACP terminal is missing or outside this session."
      )
    }
    return terminalID
  }

  private func terminalExitStatus(
    _ snapshot: ManagedProcessSnapshot
  ) -> JSONValue {
    .object([
      "exitCode": snapshot.exitCode.map {
        .number(Double($0))
      } ?? .null,
      "signal": snapshot.signal.map(JSONValue.string) ?? .null,
    ])
  }

  private func scopedWorkingDirectory(
    _ requested: String?,
    workspacePath: String
  ) throws -> String {
    let root = URL(fileURLWithPath: workspacePath)
      .resolvingSymlinksInPath()
      .standardizedFileURL
    let candidate = URL(fileURLWithPath: requested ?? workspacePath)
      .resolvingSymlinksInPath()
      .standardizedFileURL
    let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
    guard candidate.path == root.path || candidate.path.hasPrefix(rootPrefix) else {
      throw ProviderError.protocolViolation(
        "ACP terminal working directory is outside the task worktree."
      )
    }
    return candidate.path
  }

  private func normalizedTextPayload(from update: JSONValue) -> JSONValue {
    let content = update["content"] ?? .object([:])
    let text =
      content["text"]?.stringValue
      ?? update["text"]?.stringValue
      ?? ""
    return .object([
      "text": .string(text),
      "update": update,
    ])
  }

  private func resolvedCommand() async throws -> (
    executable: String,
    arguments: [String]
  ) {
    switch runtime {
    case .executable:
      guard let executable = descriptor.command.first else {
        throw ProviderError.executableNotFound(
          descriptor.id
        )
      }
      let path =
        executable.hasPrefix("/")
          && FileManager.default.isExecutableFile(atPath: executable)
        ? executable
        : BinaryLocator.locate(executable)
      guard let path else {
        throw ProviderError.executableNotFound(executable)
      }
      return (path, Array(descriptor.command.dropFirst()))
    case .npmGlobal(let package):
      guard let npm = BinaryLocator.locate("npm") else {
        throw ProviderError.executableNotFound("npm")
      }
      let result = try await ProcessRunner().run(
        CommandSpec(executable: npm, arguments: ["root", "--global"])
      )
      let root = result.standardOutput
        .trimmingCharacters(in: .whitespacesAndNewlines)
      guard !root.isEmpty else {
        throw ProviderError.executableNotFound(package)
      }
      let packageName = Self.npmPackageName(package)
      let packageURL = URL(fileURLWithPath: root)
        .appending(path: packageName)
        .standardizedFileURL
      let manifestURL = packageURL.appending(path: "package.json")
      let data = try Data(contentsOf: manifestURL)
      let manifest = try JSONDecoder.orchestrator.decode(
        JSONValue.self,
        from: data
      )
      guard
        let binaryName = Self.npmBinaryName(
          manifest["bin"],
          packageName: packageName
        )
      else {
        throw ProviderError.protocolViolation(
          "The installed npm package \(packageName) declares no executable."
        )
      }
      let executable = URL(fileURLWithPath: root)
        .appending(path: ".bin")
        .appending(path: binaryName)
        .path
      guard FileManager.default.isExecutableFile(atPath: executable) else {
        throw ProviderError.executableNotFound(binaryName)
      }
      return (executable, Array(descriptor.command.dropFirst()))
    }
  }

  private static func npmPackageName(_ specification: String) -> String {
    if specification.hasPrefix("@"),
      let slash = specification.firstIndex(of: "/"),
      let version = specification[specification.index(after: slash)...]
        .firstIndex(of: "@")
    {
      return String(specification[..<version])
    }
    return specification.split(separator: "@", maxSplits: 1)
      .first
      .map(String.init) ?? specification
  }

  private static func npmBinaryName(
    _ value: JSONValue?,
    packageName: String
  ) -> String? {
    if case .string = value {
      return packageName.split(separator: "/").last.map(String.init)
    }
    guard case .object(let binaries) = value else { return nil }
    let preferred = packageName.split(separator: "/").last.map(String.init)
    if let preferred, binaries[preferred] != nil {
      return preferred
    }
    return binaries.keys.sorted().first
  }
}
