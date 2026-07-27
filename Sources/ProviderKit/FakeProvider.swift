import Foundation
import OrchestratorCore

private struct FakeRunningSession {
  var stream: AsyncStream<ProviderEvent>
  var continuation: AsyncStream<ProviderEvent>.Continuation
}

public actor FakeProvider: ProviderAdapter {
  public nonisolated let descriptor = ProviderDescriptor(
    id: "fake",
    label: "Demo Agent",
    command: [],
    capabilities: [.resume, .steer, .interrupt, .toolCalls]
  )

  private var sessions: [String: FakeRunningSession] = [:]

  public init() {}

  public func inspect() async -> ProviderInspection {
    ProviderInspection(
      descriptor: descriptor,
      availability: .available(path: "built-in", version: "1")
    )
  }

  public func start(_ request: ProviderLaunchRequest) async throws -> ProviderSession {
    let id = request.resumeSessionID ?? OrchestratorID.make("fake_session")
    let pair = AsyncStream.makeStream(of: ProviderEvent.self)
    sessions[id] = FakeRunningSession(stream: pair.stream, continuation: pair.continuation)
    if !request.prompt.isEmpty {
      await emitResponse(to: request.prompt, sessionID: id)
    }
    return ProviderSession(id: id, providerID: descriptor.id, agentID: request.agentID)
  }

  public func send(_ text: String, to sessionID: String) async throws {
    guard sessions[sessionID] != nil else {
      throw ProviderError.unknownSession(sessionID)
    }
    await emitResponse(to: text, sessionID: sessionID)
  }

  public func steer(_ text: String, sessionID: String) async throws {
    try await send("Steering received: \(text)", to: sessionID)
  }

  public func interrupt(sessionID: String) async throws {
    sessions[sessionID]?.continuation.yield(
      ProviderEvent(
        sessionID: sessionID,
        kind: .status,
        payload: .object(["status": .string(AgentStatus.interrupted.rawValue)]),
        raw: .object([:])
      )
    )
  }

  public func respond(
    to approvalID: String,
    decision: ApprovalDecision,
    sessionID: String
  ) async throws {}

  public func close(sessionID: String) async {
    sessions.removeValue(forKey: sessionID)?.continuation.finish()
  }

  public func events(sessionID: String) async -> AsyncStream<ProviderEvent> {
    guard let state = sessions[sessionID] else {
      return AsyncStream { $0.finish() }
    }
    return state.stream
  }

  private func emitResponse(to prompt: String, sessionID: String) async {
    guard let state = sessions[sessionID] else { return }
    state.continuation.yield(
      ProviderEvent(
        sessionID: sessionID,
        kind: .status,
        payload: .object(["status": .string(AgentStatus.running.rawValue)]),
        raw: .object([:])
      )
    )
    let response = "Demo agent received: \(prompt)"
    for word in response.split(separator: " ") {
      try? await Task.sleep(for: .milliseconds(35))
      state.continuation.yield(
        ProviderEvent(
          sessionID: sessionID,
          kind: .messageDelta,
          payload: .object(["text": .string("\(word) ")]),
          raw: .object(["demo": .bool(true)])
        )
      )
    }
    state.continuation.yield(
      ProviderEvent(
        sessionID: sessionID,
        kind: .status,
        payload: .object(["status": .string(AgentStatus.completed.rawValue)]),
        raw: .object([:])
      )
    )
  }
}
