import Foundation
import OrchestratorCore

actor OrchestratorServiceClient {
  private var connection: NSXPCConnection?

  func connect() async throws -> CoreServiceInfo {
    let response = try await perform(
      .handshake(
        CoreHandshake(
          clientName: "Orchestrator",
          clientVersion: "0.1.0"
        )
      )
    )
    guard case .serviceInfo(let info) = response else {
      throw CoreServiceFailure(
        code: "unexpected_response",
        message: "The helper returned an invalid handshake."
      )
    }
    return info
  }

  func perform(_ request: CoreRPCRequest) async throws -> CoreRPCResponse {
    let data = try CoreRPCCodec.encode(request)
    let connection = makeConnectionIfNeeded()
    let responseData: Data = try await withCheckedThrowingContinuation {
      continuation in
      let gate = XPCReplyGate(continuation)
      guard
        let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
          gate.resume(throwing: error)
        }) as? any OrchestratorServiceXPC
      else {
        gate.resume(
          throwing: CoreServiceFailure(
            code: "helper_unavailable",
            message: "The Orchestrator helper is unavailable."
          )
        )
        return
      }
      proxy.perform(data) { response in
        gate.resume(returning: response)
      }
    }
    let response = try CoreRPCCodec.decode(CoreRPCResponse.self, from: responseData)
    if case .failure(let failure) = response {
      throw failure
    }
    if case .configurationTrustRequired(let requirement) = response {
      throw OrchestrationError.configurationTrustRequired(requirement)
    }
    if case .dirtyWorktree(let path) = response {
      throw GitServiceError.dirtyWorktree(path)
    }
    return response
  }

  private func makeConnectionIfNeeded() -> NSXPCConnection {
    if connection == nil {
      let connection = NSXPCConnection(
        machServiceName: OrchestratorProtocol.serviceName,
        options: []
      )
      connection.remoteObjectInterface = NSXPCInterface(
        with: OrchestratorServiceXPC.self
      )
      connection.interruptionHandler = {}
      connection.invalidationHandler = {}
      connection.resume()
      self.connection = connection
    }
    return connection!
  }
}

private final class XPCReplyGate: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Data, any Error>?

  init(_ continuation: CheckedContinuation<Data, any Error>) {
    self.continuation = continuation
  }

  func resume(returning value: sending Data) {
    take()?.resume(returning: value)
  }

  func resume(throwing error: sending any Error) {
    take()?.resume(throwing: error)
  }

  private func take() -> CheckedContinuation<Data, any Error>? {
    lock.lock()
    defer { lock.unlock() }
    let result = continuation
    continuation = nil
    return result
  }
}
