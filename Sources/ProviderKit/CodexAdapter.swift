import Foundation
import OrchestratorCore

private struct CodexApprovalRoute: Sendable {
  var rpcID: JSONValue
  var method: String
  var params: JSONValue
}

private struct CodexInputRoute: Sendable {
  var rpcID: JSONValue
}

private struct CodexRunningSession {
  var client: JSONRPCClient
  var threadID: String
  var activeTurnID: String?
  var stream: AsyncStream<ProviderEvent>
  var continuation: AsyncStream<ProviderEvent>.Continuation
  var approvals: [String: CodexApprovalRoute]
  var inputs: [String: CodexInputRoute]
  var forwardingTask: Task<Void, Never>?
}

public actor CodexAdapter: ProviderAdapter {
  public nonisolated let descriptor = ProviderDescriptor(
    id: "codex",
    label: "Codex",
    command: ["codex", "app-server", "--stdio"],
    installationCommand: "npm install -g @openai/codex",
    capabilities: [
      .models, .modes, .resume, .steer, .interrupt, .approvals,
      .fileChanges, .toolCalls, .sessionList, .sessionClose, .mcpInjection,
      .structuredInput,
    ]
  )

  private let runner = ProcessRunner()
  private var sessions: [String: CodexRunningSession] = [:]

  public init() {}

  public func inspect() async -> ProviderInspection {
    guard let binary = BinaryLocator.locate("codex") else {
      return ProviderInspection(
        descriptor: descriptor,
        availability: .unavailable(reason: "Codex CLI is not installed."),
        modes: modes
      )
    }
    let version = try? await runner.run(
      CommandSpec(executable: binary, arguments: ["--version"])
    ).standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    return ProviderInspection(
      descriptor: descriptor,
      availability: .available(path: binary, version: version),
      modes: modes
    )
  }

  public func start(_ request: ProviderLaunchRequest) async throws -> ProviderSession {
    guard let binary = BinaryLocator.locate("codex") else {
      throw ProviderError.executableNotFound("codex")
    }
    let client = JSONRPCClient(includesVersionHeader: false)
    try await client.start(
      CommandSpec(
        executable: binary,
        arguments: ["app-server", "--stdio"],
        workingDirectory: request.workingDirectory,
        environment: request.environment
      )
    )
    _ = try await client.request(
      method: "initialize",
      params: .object([
        "clientInfo": .object([
          "name": .string("orchestrator_macos"),
          "title": .string("Orchestrator"),
          "version": .string("0.1.0"),
        ])
      ])
    )
    try await client.notify(method: "initialized")

    let threadResult: JSONValue
    if let resume = request.resumeSessionID {
      var params: [String: JSONValue] = [
        "threadId": .string(resume),
        "cwd": .string(request.workingDirectory),
      ]
      if let model = request.model {
        params["model"] = .string(model)
      }
      if let mode = request.mode {
        params["approvalPolicy"] = .string(mode)
      }
      if let overrides = DelegationConfiguration.codexOverrides(
        path: request.mcpConfigurationPath
      ) {
        params["config"] = overrides
      }
      threadResult = try await client.request(
        method: "thread/resume",
        params: .object(params)
      )
    } else {
      var params: [String: JSONValue] = [
        "cwd": .string(request.workingDirectory)
      ]
      if let model = request.model {
        params["model"] = .string(model)
      }
      if let mode = request.mode {
        params["approvalPolicy"] = .string(mode)
      }
      if let overrides = DelegationConfiguration.codexOverrides(
        path: request.mcpConfigurationPath
      ) {
        params["config"] = overrides
      }
      threadResult = try await client.request(
        method: "thread/start",
        params: .object(params)
      )
    }
    guard
      let threadID = threadResult["thread"]?["id"]?.stringValue
        ?? threadResult["threadId"]?.stringValue
    else {
      await client.stop()
      throw ProviderError.protocolViolation("thread/start did not return a thread ID.")
    }

    let pair = AsyncStream.makeStream(of: ProviderEvent.self)
    let rpcEvents = await client.events()
    let providerSession = ProviderSession(
      id: threadID,
      providerID: descriptor.id,
      agentID: request.agentID
    )
    sessions[threadID] = CodexRunningSession(
      client: client,
      threadID: threadID,
      activeTurnID: nil,
      stream: pair.stream,
      continuation: pair.continuation,
      approvals: [:],
      inputs: [:],
      forwardingTask: nil
    )
    let forwarding = Task { [weak self] in
      for await message in rpcEvents {
        await self?.handle(message, sessionID: threadID)
      }
    }
    sessions[threadID]?.forwardingTask = forwarding
    if !request.prompt.isEmpty {
      try await startTurn(text: request.prompt, sessionID: threadID)
    }
    return providerSession
  }

  public func send(_ text: String, to sessionID: String) async throws {
    try await startTurn(text: text, sessionID: sessionID)
  }

  public func steer(_ text: String, sessionID: String) async throws {
    guard let state = sessions[sessionID] else {
      throw ProviderError.unknownSession(sessionID)
    }
    guard let activeTurnID = state.activeTurnID else {
      throw ProviderError.protocolViolation("There is no active Codex turn to steer.")
    }
    _ = try await state.client.request(
      method: "turn/steer",
      params: .object([
        "threadId": .string(state.threadID),
        "expectedTurnId": .string(activeTurnID),
        "input": .array([
          .object(["type": .string("text"), "text": .string(text)])
        ]),
      ])
    )
  }

  public func interrupt(sessionID: String) async throws {
    guard let state = sessions[sessionID] else {
      throw ProviderError.unknownSession(sessionID)
    }
    guard let activeTurnID = state.activeTurnID else {
      throw ProviderError.protocolViolation("There is no active Codex turn to interrupt.")
    }
    _ = try await state.client.request(
      method: "turn/interrupt",
      params: .object([
        "threadId": .string(state.threadID),
        "turnId": .string(activeTurnID),
      ])
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
      throw ProviderError.protocolViolation("Unknown Codex approval \(approvalID).")
    }
    sessions[sessionID] = state

    if route.method == "item/permissions/requestApproval" {
      let granted: JSONValue
      switch decision {
      case .allowOnce, .allowForSession:
        granted = route.params["permissions"] ?? .object([:])
      case .deny, .cancel:
        granted = .object([:])
      }
      try await state.client.respond(
        id: route.rpcID,
        result: .object([
          "permissions": granted,
          "scope": .string(decision == .allowForSession ? "session" : "turn"),
        ])
      )
    } else {
      let value: String =
        switch decision {
        case .allowOnce: "accept"
        case .allowForSession: "acceptForSession"
        case .deny: "decline"
        case .cancel: "cancel"
        }
      try await state.client.respond(
        id: route.rpcID,
        result: .object(["decision": .string(value)])
      )
    }
  }

  public func respondToInput(
    requestID: String,
    answers: [String: [String]],
    sessionID: String
  ) async throws {
    try await completeInput(
      requestID: requestID,
      answers: answers,
      resolution: "submitted",
      emitsEvent: false,
      sessionID: sessionID
    )
  }

  public func close(sessionID: String) async {
    guard let state = sessions.removeValue(forKey: sessionID) else { return }
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

  private var modes: [ProviderMode] {
    [
      ProviderMode(id: "untrusted", label: "Default permissions"),
      ProviderMode(id: "on-request", label: "Ask when needed"),
      ProviderMode(id: "never", label: "Never ask"),
    ]
  }

  private func startTurn(text: String, sessionID: String) async throws {
    guard let state = sessions[sessionID] else {
      throw ProviderError.unknownSession(sessionID)
    }
    let result = try await state.client.request(
      method: "turn/start",
      params: .object([
        "threadId": .string(state.threadID),
        "input": .array([
          .object(["type": .string("text"), "text": .string(text)])
        ]),
      ])
    )
    if let turnID =
      result["turn"]?["id"]?.stringValue
      ?? result["turnId"]?.stringValue,
      var current = sessions[sessionID]
    {
      current.activeTurnID = turnID
      sessions[sessionID] = current
    }
  }

  private func handle(_ message: JSONRPCMessage, sessionID: String) {
    guard var state = sessions[sessionID] else { return }
    if message.raw["_orchestrator"]?.stringValue == "stderr" {
      state.continuation.yield(
        ProviderEvent(
          sessionID: sessionID,
          kind: .raw,
          payload: message.raw,
          raw: message.raw
        )
      )
      return
    }
    guard let method = message.method else {
      if message.raw["_orchestrator"]?.stringValue == "terminated" {
        state.continuation.yield(
          ProviderEvent(
            sessionID: sessionID,
            kind: .status,
            payload: .object(["status": .string(AgentStatus.disconnected.rawValue)]),
            raw: message.raw
          )
        )
        state.continuation.finish()
      }
      return
    }

    let params = message.params ?? .object([:])
    let event: ProviderEvent
    if method == "item/tool/requestUserInput", let rpcID = message.id {
      let inputID = OrchestratorID.make("codex_input")
      state.inputs[inputID] = CodexInputRoute(rpcID: rpcID)
      var payload: [String: JSONValue] = [
        "inputRequestID": .string(inputID),
        "title": .string("Codex needs input"),
        "questions": normalizedQuestions(params["questions"]),
      ]
      if let autoResolutionMs = params["autoResolutionMs"] {
        payload["autoResolutionMs"] = autoResolutionMs
      }
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .inputRequested,
        payload: .object(payload),
        raw: message.raw
      )
      if case .number(let milliseconds) = params["autoResolutionMs"],
        milliseconds > 0,
        milliseconds <= Double(Int64.max)
      {
        let delay = Int64(milliseconds)
        Task { [weak self] in
          try? await Task.sleep(for: .milliseconds(delay))
          await self?.autoResolveInput(
            requestID: inputID,
            sessionID: sessionID
          )
        }
      }
    } else if method.hasSuffix("/requestApproval"), let rpcID = message.id {
      let approvalID = OrchestratorID.make("codex_approval")
      state.approvals[approvalID] = CodexApprovalRoute(
        rpcID: rpcID,
        method: method,
        params: params
      )
      let kind: ApprovalKind =
        if method.contains("commandExecution") {
          .command
        } else if method.contains("fileChange") {
          .fileChange
        } else if method.contains("permissions") {
          .permissions
        } else {
          .providerSpecific
        }
      let summary =
        firstString(
          in: params,
          paths: [["reason"], ["command"], ["item", "command"], ["cwd"]]
        ) ?? "Codex needs permission to continue."
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .approvalRequested,
        payload: .object([
          "approvalID": .string(approvalID),
          "kind": .string(kind.rawValue),
          "title": .string(approvalTitle(for: kind)),
          "summary": .string(summary),
          "providerMethod": .string(method),
        ]),
        raw: message.raw
      )
    } else if method == "turn/started" {
      state.activeTurnID =
        params["turn"]?["id"]?.stringValue
        ?? params["turnId"]?.stringValue
        ?? state.activeTurnID
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .status,
        payload: .object(["status": .string(AgentStatus.running.rawValue)]),
        raw: message.raw
      )
    } else if method == "item/agentMessage/delta" {
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .messageDelta,
        payload: .object([
          "text": .string(firstString(in: params, paths: [["delta"]]) ?? "")
        ]),
        raw: message.raw
      )
    } else if method == "item/started" {
      let type = params["item"]?["type"]?.stringValue ?? "tool"
      let kind: AgentEventKind =
        switch type {
        case "userMessage": .userMessage
        case "agentMessage": .messageDelta
        case "reasoning": .reasoning
        case "commandExecution": .command
        case "fileChange": .fileChange
        default: .toolStarted
        }
      event = ProviderEvent(
        sessionID: sessionID,
        kind: kind,
        payload: params,
        raw: message.raw
      )
    } else if method == "item/completed" {
      let type = params["item"]?["type"]?.stringValue ?? "tool"
      let kind: AgentEventKind =
        switch type {
        case "userMessage": .userMessage
        case "agentMessage": .agentMessage
        case "reasoning": .reasoning
        case "fileChange": .fileChange
        default: .toolCompleted
        }
      event = ProviderEvent(
        sessionID: sessionID,
        kind: kind,
        payload: params,
        raw: message.raw
      )
    } else if method == "turn/completed" {
      state.activeTurnID = nil
      let providerStatus = params["turn"]?["status"]?.stringValue ?? "completed"
      let status: AgentStatus =
        switch providerStatus {
        case "failed": .failed
        case "interrupted", "cancelled": .interrupted
        default: .completed
        }
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .status,
        payload: .object(["status": .string(status.rawValue)]),
        raw: message.raw
      )
    } else if method == "error" {
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .error,
        payload: params,
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

  private func completeInput(
    requestID: String,
    answers: [String: [String]],
    resolution: String,
    emitsEvent: Bool,
    sessionID: String
  ) async throws {
    guard let state = sessions[sessionID] else {
      throw ProviderError.unknownSession(sessionID)
    }
    guard let route = state.inputs[requestID] else {
      throw ProviderError.protocolViolation("Unknown Codex input request \(requestID).")
    }
    let response = JSONValue.object([
      "answers": .object(
        answers.mapValues { values in
          .object(["answers": .array(values.map(JSONValue.string))])
        }
      )
    ])
    try await state.client.respond(id: route.rpcID, result: response)
    guard var current = sessions[sessionID] else { return }
    current.inputs.removeValue(forKey: requestID)
    if emitsEvent {
      current.continuation.yield(
        ProviderEvent(
          sessionID: sessionID,
          kind: .inputResolved,
          payload: .object([
            "inputRequestID": .string(requestID),
            "resolution": .string(resolution),
          ]),
          raw: .object([
            "_orchestrator": .string("inputResponse"),
            "resolution": .string(resolution),
          ])
        )
      )
    }
    sessions[sessionID] = current
  }

  private func autoResolveInput(requestID: String, sessionID: String) async {
    try? await completeInput(
      requestID: requestID,
      answers: [:],
      resolution: "autoResolved",
      emitsEvent: true,
      sessionID: sessionID
    )
  }

  private func normalizedQuestions(_ value: JSONValue?) -> JSONValue {
    guard let questions = value?.arrayValue else { return .array([]) }
    return .array(
      questions.enumerated().map { index, question in
        let options =
          question["options"]?.arrayValue?.map { option in
            JSONValue.object([
              "label": .string(option["label"]?.stringValue ?? ""),
              "description": .string(
                option["description"]?.stringValue ?? ""
              ),
            ])
          } ?? []
        return .object([
          "id": .string(
            question["id"]?.stringValue ?? "question-\(index + 1)"
          ),
          "header": .string(
            question["header"]?.stringValue ?? "Question \(index + 1)"
          ),
          "question": .string(
            question["question"]?.stringValue ?? "Please provide an answer."
          ),
          "options": .array(options),
          "allowsFreeform": .bool(true),
          "isSecret": question["isSecret"] ?? .bool(false),
        ])
      }
    )
  }

  private func approvalTitle(for kind: ApprovalKind) -> String {
    switch kind {
    case .command: "Run command?"
    case .fileChange: "Apply file changes?"
    case .permissions: "Grant additional permissions?"
    case .childAgent: "Launch child agent?"
    case .configuration: "Trust project configuration?"
    case .providerSpecific: "Provider approval"
    }
  }

  private func firstString(in value: JSONValue, paths: [[String]]) -> String? {
    for path in paths {
      var current: JSONValue? = value
      for component in path {
        current = current?[component]
      }
      if let result = current?.stringValue, !result.isEmpty {
        return result
      }
      if let array = current?.arrayValue {
        let strings = array.compactMap(\.stringValue)
        if !strings.isEmpty {
          return strings.joined(separator: " ")
        }
      }
    }
    return nil
  }
}
