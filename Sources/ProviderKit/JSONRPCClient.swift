import Foundation
import OrchestratorCore

struct JSONRPCMessage: Sendable, Equatable {
  var id: JSONValue?
  var method: String?
  var params: JSONValue?
  var result: JSONValue?
  var error: JSONValue?
  var raw: JSONValue

  init(_ value: JSONValue) {
    raw = value
    id = value["id"]
    method = value["method"]?.stringValue
    params = value["params"]
    result = value["result"]
    error = value["error"]
  }
}

private struct PendingRequest {
  let continuation: CheckedContinuation<JSONValue, Error>
}

actor JSONRPCClient {
  private let process = JSONLineProcess()
  private let includesVersionHeader: Bool
  private var pending: [JSONValue: PendingRequest] = [:]
  private var consumeTask: Task<Void, Never>?
  private let messageStream: AsyncStream<JSONRPCMessage>
  private let messageContinuation: AsyncStream<JSONRPCMessage>.Continuation

  init(includesVersionHeader: Bool) {
    self.includesVersionHeader = includesVersionHeader
    let pair = AsyncStream.makeStream(of: JSONRPCMessage.self)
    messageStream = pair.stream
    messageContinuation = pair.continuation
  }

  func start(_ spec: CommandSpec) async throws {
    try await process.start(spec)
    let events = await process.events()
    consumeTask = Task { [weak self] in
      for await event in events {
        await self?.consume(event)
      }
    }
  }

  func events() -> AsyncStream<JSONRPCMessage> {
    messageStream
  }

  func request(method: String, params: JSONValue = .object([:])) async throws -> JSONValue {
    let id = JSONValue.string(UUID().uuidString.lowercased())
    let message = makeMessage(id: id, method: method, params: params)
    return try await withCheckedThrowingContinuation { continuation in
      pending[id] = PendingRequest(continuation: continuation)
      Task { [weak self] in
        await self?.write(message, requestID: id)
      }
    }
  }

  func notify(method: String, params: JSONValue = .object([:])) async throws {
    try await process.send(makeMessage(id: nil, method: method, params: params))
  }

  func respond(id: JSONValue, result: JSONValue) async throws {
    var object: [String: JSONValue] = ["id": id, "result": result]
    if includesVersionHeader {
      object["jsonrpc"] = .string("2.0")
    }
    try await process.send(.object(object))
  }

  func respond(id: JSONValue, errorCode: Int, message: String) async throws {
    var object: [String: JSONValue] = [
      "id": id,
      "error": .object([
        "code": .number(Double(errorCode)),
        "message": .string(message),
      ]),
    ]
    if includesVersionHeader {
      object["jsonrpc"] = .string("2.0")
    }
    try await process.send(.object(object))
  }

  func interrupt() async {
    await process.interrupt()
  }

  func stop() async {
    consumeTask?.cancel()
    await process.terminate()
    failPending(ProviderError.processExited(-15, "Provider process stopped."))
    messageContinuation.finish()
  }

  private func makeMessage(id: JSONValue?, method: String, params: JSONValue) -> JSONValue {
    var object: [String: JSONValue] = [
      "method": .string(method),
      "params": params,
    ]
    if let id {
      object["id"] = id
    }
    if includesVersionHeader {
      object["jsonrpc"] = .string("2.0")
    }
    return .object(object)
  }

  private func write(_ value: JSONValue, requestID: JSONValue) async {
    do {
      try await process.send(value)
    } catch {
      if let request = pending.removeValue(forKey: requestID) {
        request.continuation.resume(throwing: error)
      }
    }
  }

  private func consume(_ event: JSONLineProcessEvent) {
    switch event {
    case .value(let value):
      let message = JSONRPCMessage(value)
      if let id = message.id, message.method == nil,
        let request = pending.removeValue(forKey: id)
      {
        if let error = message.error {
          request.continuation.resume(
            throwing: ProviderError.protocolViolation(
              error.descriptionForDisplay
            )
          )
        } else {
          request.continuation.resume(returning: message.result ?? .null)
        }
      } else {
        messageContinuation.yield(message)
      }
    case .standardError(let text):
      messageContinuation.yield(
        JSONRPCMessage(
          .object([
            "_orchestrator": .string("stderr"),
            "text": .string(text),
          ])
        )
      )
    case .terminated(let status):
      let error = ProviderError.processExited(status, "Process terminated.")
      failPending(error)
      messageContinuation.yield(
        JSONRPCMessage(
          .object([
            "_orchestrator": .string("terminated"),
            "status": .number(Double(status)),
          ])
        )
      )
      messageContinuation.finish()
    }
  }

  private func failPending(_ error: Error) {
    let requests = pending.values
    pending.removeAll()
    for request in requests {
      request.continuation.resume(throwing: error)
    }
  }
}

extension JSONValue {
  var descriptionForDisplay: String {
    switch self {
    case .null:
      "null"
    case .bool(let value):
      String(value)
    case .number(let value):
      String(value)
    case .string(let value):
      value
    case .array(let value):
      value.map(\.descriptionForDisplay).joined(separator: ", ")
    case .object(let value):
      if let message = value["message"]?.stringValue {
        message
      } else {
        value.map { "\($0.key): \($0.value.descriptionForDisplay)" }
          .sorted()
          .joined(separator: ", ")
      }
    }
  }
}
