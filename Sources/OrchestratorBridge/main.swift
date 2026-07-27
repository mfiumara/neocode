import Foundation
import OrchestratorCore

private struct BridgeContext {
  let projectID: String
  let taskID: String
  let parentAgentID: String
  let token: String

  static func load() throws -> BridgeContext {
    let environment = ProcessInfo.processInfo.environment
    guard let projectID = environment["ORCHESTRATOR_PROJECT_ID"],
      let taskID = environment["ORCHESTRATOR_TASK_ID"],
      let parentAgentID = environment["ORCHESTRATOR_PARENT_AGENT_ID"],
      let token = environment["ORCHESTRATOR_DELEGATION_TOKEN"],
      token.count >= 32
    else {
      throw BridgeError.invalidContext
    }
    return BridgeContext(
      projectID: projectID,
      taskID: taskID,
      parentAgentID: parentAgentID,
      token: token
    )
  }
}

private enum BridgeError: LocalizedError {
  case invalidContext
  case invalidRequest
  case unsupportedMethod(String)

  var errorDescription: String? {
    switch self {
    case .invalidContext:
      "The delegation bridge requires a scoped Orchestrator capability."
    case .invalidRequest:
      "Invalid JSON-RPC request."
    case .unsupportedMethod(let method):
      "Unsupported bridge method \(method)."
    }
  }
}

private struct BridgeRPCRequest: Decodable {
  let id: JSONValue?
  let method: String
  let params: JSONValue?
}

private struct BridgeRPCResponse: Encodable {
  let jsonrpc = "2.0"
  let id: JSONValue?
  let result: JSONValue?
  let error: BridgeRPCError?
}

private struct BridgeRPCError: Encodable {
  let code: Int
  let message: String
}

private final class BridgeServiceClient: @unchecked Sendable {
  private let connection: NSXPCConnection

  init() {
    connection = NSXPCConnection(
      machServiceName: OrchestratorProtocol.serviceName,
      options: []
    )
    connection.remoteObjectInterface = NSXPCInterface(
      with: OrchestratorServiceXPC.self
    )
    connection.resume()
  }

  func perform(
    token: String,
    method: String,
    params: JSONValue
  ) async throws -> JSONValue {
    let request = try CoreRPCCodec.encode(
      CoreRPCRequest.delegation(
        DelegationBridgeRequest(
          token: token,
          method: method,
          params: params
        )
      )
    )
    let data: Data = try await withCheckedThrowingContinuation { continuation in
      let gate = BridgeReplyGate(continuation)
      guard
        let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
          gate.resume(throwing: error)
        }) as? any OrchestratorServiceXPC
      else {
        gate.resume(throwing: BridgeError.invalidContext)
        return
      }
      proxy.perform(request) {
        gate.resume(returning: $0)
      }
    }
    let response = try CoreRPCCodec.decode(CoreRPCResponse.self, from: data)
    switch response {
    case .json(let value):
      return value
    case .failure(let error):
      throw error
    default:
      throw BridgeError.invalidRequest
    }
  }
}

private final class BridgeReplyGate: @unchecked Sendable {
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

private func write(_ response: BridgeRPCResponse) {
  guard let data = try? JSONEncoder.orchestrator.encode(response) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

do {
  let context = try BridgeContext.load()
  let service = BridgeServiceClient()
  while let line = readLine() {
    var responseID: JSONValue?
    do {
      let request = try JSONDecoder.orchestrator.decode(
        BridgeRPCRequest.self,
        from: Data(line.utf8)
      )
      responseID = request.id
      let result: JSONValue
      switch request.method {
      case "initialize":
        result = .object([
          "protocolVersion": .string("2025-06-18"),
          "serverInfo": .object([
            "name": .string("orchestrator"),
            "version": .string("0.1.0"),
          ]),
          "capabilities": .object(["tools": .object([:])]),
        ])
      case "tools/list":
        result = .object([
          "tools": .array(delegationTools)
        ])
      case "tools/call":
        guard let name = request.params?["name"]?.stringValue else {
          throw BridgeError.invalidRequest
        }
        let arguments = request.params?["arguments"] ?? .object([:])
        let value = try await service.perform(
          token: context.token,
          method: name,
          params: arguments
        )
        let encoded = try JSONEncoder.orchestrator.encode(value)
        result = .object([
          "content": .array([
            .object([
              "type": .string("text"),
              "text": .string(String(decoding: encoded, as: UTF8.self)),
            ])
          ]),
          "structuredContent": value,
          "isError": .bool(false),
        ])
      case "notifications/initialized":
        continue
      default:
        throw BridgeError.unsupportedMethod(request.method)
      }
      write(
        BridgeRPCResponse(
          id: request.id,
          result: result,
          error: nil
        )
      )
    } catch {
      write(
        BridgeRPCResponse(
          id: responseID,
          result: nil,
          error: BridgeRPCError(
            code: -32600,
            message: error.localizedDescription
          )
        )
      )
    }
  }
} catch {
  FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
  exit(EXIT_FAILURE)
}

private var delegationTools: [JSONValue] {
  [
    tool(
      name: "providers.list",
      description: "List providers available to this Orchestrator task."
    ),
    tool(
      name: "agents.create",
      description: "Launch a scoped child agent. User approval is required by default.",
      properties: [
        "title": .object(["type": .string("string")]),
        "providerID": .object(["type": .string("string")]),
        "prompt": .object(["type": .string("string")]),
        "model": .object(["type": .string("string")]),
        "mode": .object(["type": .string("string")]),
      ],
      required: ["title", "providerID", "prompt"]
    ),
    tool(
      name: "agents.inspect",
      description: "Inspect this agent or one of its descendants.",
      properties: [
        "agentID": .object(["type": .string("string")])
      ]
    ),
    tool(
      name: "agents.send",
      description: "Send a message to an in-scope agent.",
      properties: [
        "agentID": .object(["type": .string("string")]),
        "text": .object(["type": .string("string")]),
      ],
      required: ["agentID", "text"]
    ),
    tool(
      name: "agents.stop",
      description: "Interrupt an in-scope agent.",
      properties: [
        "agentID": .object(["type": .string("string")])
      ],
      required: ["agentID"]
    ),
    tool(
      name: "approval",
      description: "Ask the Orchestrator user to approve a Claude tool invocation.",
      properties: [
        "tool_name": .object(["type": .string("string")]),
        "input": .object([
          "type": .string("object"),
          "additionalProperties": .bool(true),
        ]),
      ],
      required: ["tool_name", "input"]
    ),
  ]
}

private func tool(
  name: String,
  description: String,
  properties: [String: JSONValue] = [:],
  required: [String] = []
) -> JSONValue {
  .object([
    "name": .string(name),
    "description": .string(description),
    "inputSchema": .object([
      "type": .string("object"),
      "properties": .object(properties),
      "required": .array(required.map(JSONValue.string)),
      "additionalProperties": .bool(false),
    ]),
  ])
}
