import Foundation
import OrchestratorCore

private struct ClaudeRunningSession {
  var process: JSONLineProcess
  var stream: AsyncStream<ProviderEvent>
  var continuation: AsyncStream<ProviderEvent>.Continuation
  var forwardingTask: Task<Void, Never>?
}

public actor ClaudeAdapter: ProviderAdapter {
  public nonisolated let descriptor = ProviderDescriptor(
    id: "claude",
    label: "Claude",
    command: [
      "claude", "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
    ],
    installationCommand: "npm install -g @anthropic-ai/claude-code",
    capabilities: [
      .models, .modes, .resume, .steer, .interrupt, .approvals,
      .fileChanges, .toolCalls, .sessionClose, .mcpInjection,
    ]
  )

  private let runner = ProcessRunner()
  private var sessions: [String: ClaudeRunningSession] = [:]

  public init() {}

  public func inspect() async -> ProviderInspection {
    guard let binary = BinaryLocator.locate("claude") else {
      return ProviderInspection(
        descriptor: descriptor,
        availability: .unavailable(reason: "Claude Code is not installed."),
        modes: modes
      )
    }
    let version = try? await runner.run(
      CommandSpec(executable: binary, arguments: ["--version"])
    ).standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    return ProviderInspection(
      descriptor: descriptor,
      availability: .available(path: binary, version: version),
      models: [
        ProviderModel(id: "sonnet", label: "Sonnet", isDefault: true),
        ProviderModel(id: "opus", label: "Opus"),
      ],
      modes: modes
    )
  }

  public func start(_ request: ProviderLaunchRequest) async throws -> ProviderSession {
    guard let binary = BinaryLocator.locate("claude") else {
      throw ProviderError.executableNotFound("claude")
    }
    let sessionID = request.resumeSessionID ?? UUID().uuidString.lowercased()
    var arguments = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
    ]
    if request.resumeSessionID != nil {
      arguments += ["--resume", sessionID]
    } else {
      arguments += ["--session-id", sessionID]
    }
    if let model = request.model {
      arguments += ["--model", model]
    }
    if let mode = request.mode {
      arguments += ["--permission-mode", mode]
    }
    if let mcpConfigurationPath = try DelegationConfiguration.claudePath(
      path: request.mcpConfigurationPath
    ) {
      arguments += [
        "--mcp-config", mcpConfigurationPath,
        "--permission-prompt-tool", "mcp__orchestrator__approval",
      ]
    }

    let process = JSONLineProcess()
    try await process.start(
      CommandSpec(
        executable: binary,
        arguments: arguments,
        workingDirectory: request.workingDirectory,
        environment: request.environment
      )
    )
    let pair = AsyncStream.makeStream(of: ProviderEvent.self)
    let processEvents = await process.events()
    sessions[sessionID] = ClaudeRunningSession(
      process: process,
      stream: pair.stream,
      continuation: pair.continuation,
      forwardingTask: nil
    )
    let forwarding = Task { [weak self] in
      for await event in processEvents {
        await self?.handle(event, sessionID: sessionID)
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
    try await state.process.send(
      .object([
        "type": .string("user"),
        "message": .object([
          "role": .string("user"),
          "content": .array([
            .object(["type": .string("text"), "text": .string(text)])
          ]),
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
    await state.process.interrupt()
  }

  public func respond(
    to approvalID: String,
    decision: ApprovalDecision,
    sessionID: String
  ) async throws {
    throw ProviderError.unsupportedCapability(
      "direct approval responses; Claude approvals are routed through the private MCP bridge"
    )
  }

  public func close(sessionID: String) async {
    guard let state = sessions.removeValue(forKey: sessionID) else { return }
    state.forwardingTask?.cancel()
    state.continuation.finish()
    await state.process.terminate()
  }

  public func events(sessionID: String) async -> AsyncStream<ProviderEvent> {
    guard let state = sessions[sessionID] else {
      return AsyncStream { $0.finish() }
    }
    return state.stream
  }

  private var modes: [ProviderMode] {
    [
      ProviderMode(id: "default", label: "Ask when needed"),
      ProviderMode(id: "acceptEdits", label: "Accept file edits"),
      ProviderMode(id: "plan", label: "Plan only"),
    ]
  }

  private func handle(_ processEvent: JSONLineProcessEvent, sessionID: String) {
    guard let state = sessions[sessionID] else { return }
    let event: ProviderEvent
    switch processEvent {
    case .standardError(let text):
      let raw = JSONValue.object([
        "_orchestrator": .string("stderr"),
        "text": .string(text),
      ])
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .raw,
        payload: raw,
        raw: raw
      )
    case .terminated(let status):
      event = ProviderEvent(
        sessionID: sessionID,
        kind: .status,
        payload: .object([
          "status": .string(
            status == 0 ? AgentStatus.completed.rawValue : AgentStatus.failed.rawValue
          )
        ]),
        raw: .object(["exitCode": .number(Double(status))])
      )
      state.continuation.yield(event)
      state.continuation.finish()
      return
    case .value(let value):
      let type = value["type"]?.stringValue ?? ""
      if type == "stream_event" {
        let delta = value["event"]?["delta"]
        if let text = delta?["text"]?.stringValue, !text.isEmpty {
          event = ProviderEvent(
            sessionID: sessionID,
            kind: .messageDelta,
            payload: .object(["text": .string(text)]),
            raw: value
          )
        } else {
          event = ProviderEvent(
            sessionID: sessionID,
            kind: .toolUpdated,
            payload: .object([
              "partialJSON": delta?["partial_json"] ?? .null
            ]),
            raw: value
          )
        }
      } else if type == "assistant" {
        let text = textContent(in: value["message"]?["content"])
        event = ProviderEvent(
          sessionID: sessionID,
          kind: .agentMessage,
          payload: .object(["text": .string(text)]),
          raw: value
        )
      } else if type == "result" {
        let failed = value["is_error"] == .bool(true)
        event = ProviderEvent(
          sessionID: sessionID,
          kind: .status,
          payload: .object([
            "status": .string(
              failed ? AgentStatus.failed.rawValue : AgentStatus.completed.rawValue
            )
          ]),
          raw: value
        )
      } else if type == "system" {
        event = ProviderEvent(
          sessionID: sessionID,
          kind: .status,
          payload: .object(["status": .string(AgentStatus.running.rawValue)]),
          raw: value
        )
      } else {
        event = ProviderEvent(
          sessionID: sessionID,
          kind: .raw,
          payload: value,
          raw: value
        )
      }
    }
    state.continuation.yield(event)
  }

  private func textContent(in value: JSONValue?) -> String {
    guard let blocks = value?.arrayValue else { return "" }
    return blocks.compactMap { block in
      guard block["type"]?.stringValue == "text" else { return nil }
      return block["text"]?.stringValue
    }.joined()
  }
}
