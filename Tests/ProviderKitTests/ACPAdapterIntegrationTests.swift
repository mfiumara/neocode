import Foundation
import OrchestratorCore
import ProviderKit
import Testing

struct ACPAdapterIntegrationTests {
  @Test
  func permissionTerminalAndRichUpdateFlowUsesStableACPShapes() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "orchestrator-acp-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: directory) }
    let script = directory.appending(path: "fake_acp.py")
    try Data(fakeAgent.utf8).write(to: script)

    let descriptor = ProviderDescriptor(
      id: "fixture-acp",
      label: "Fixture ACP",
      command: ["/usr/bin/python3", script.path, directory.path],
      capabilities: [
        .resume, .interrupt, .approvals, .toolCalls, .terminalRequests,
      ]
    )
    let adapter = ACPAdapter(descriptor: descriptor)
    let session = try await adapter.start(
      ProviderLaunchRequest(
        agentID: "agent",
        taskID: "task",
        workingDirectory: directory.path,
        prompt: ""
      )
    )
    let stream = await adapter.events(sessionID: session.id)
    let collected = Task {
      var sawApproval = false
      for await event in stream {
        if event.kind == .approvalRequested,
          let approvalID = event.payload["approvalID"]?.stringValue
        {
          sawApproval = true
          #expect(event.payload["supportsAllowForSession"] == .bool(true))
          try await adapter.respond(
            to: approvalID,
            decision: .allowForSession,
            sessionID: session.id
          )
        }
        if event.kind == .messageDelta {
          return (
            sawApproval,
            event.payload["text"]?.stringValue
          )
        }
      }
      return (false, nil)
    }
    let send = Task {
      try await adapter.send("exercise ACP", to: session.id)
    }

    let result = try await withTimeout {
      try await collected.value
    }
    try await send.value
    #expect(result.0)
    #expect(result.1 == "fixture complete")
    await adapter.close(sessionID: session.id)
  }

  private func withTimeout<T: Sendable>(
    _ operation: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask { try await operation() }
      group.addTask {
        try await Task.sleep(for: .seconds(5))
        throw TimeoutError()
      }
      let value = try await group.next()!
      group.cancelAll()
      return value
    }
  }

  private struct TimeoutError: Error {}

  private var fakeAgent: String {
    #"""
    import json
    import sys

    workspace = sys.argv[1]

    def read():
        line = sys.stdin.readline()
        if not line:
            raise SystemExit(2)
        return json.loads(line)

    def write(value):
        print(json.dumps(value, separators=(",", ":")), flush=True)

    while True:
        message = read()
        method = message.get("method")
        request_id = message.get("id")
        if method == "initialize":
            write({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": 1,
                    "agentCapabilities": {
                        "loadSession": True,
                        "promptCapabilities": {
                            "image": False,
                            "audio": False,
                            "embeddedContext": False
                        },
                        "mcpCapabilities": {"http": False, "sse": False}
                    }
                }
            })
        elif method == "session/new":
            write({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"sessionId": "fixture-session"}
            })
        elif method == "session/prompt":
            write({
                "jsonrpc": "2.0",
                "id": "terminal-create",
                "method": "terminal/create",
                "params": {
                    "sessionId": "fixture-session",
                    "command": "/usr/bin/printf",
                    "args": ["terminal fixture\n"],
                    "cwd": workspace,
                    "env": []
                }
            })
            terminal_created = read()
            terminal_id = terminal_created["result"]["terminalId"]
            write({
                "jsonrpc": "2.0",
                "id": "terminal-wait",
                "method": "terminal/wait_for_exit",
                "params": {
                    "sessionId": "fixture-session",
                    "terminalId": terminal_id
                }
            })
            terminal_waited = read()
            assert terminal_waited["result"]["exitCode"] == 0
            write({
                "jsonrpc": "2.0",
                "id": "permission",
                "method": "session/request_permission",
                "params": {
                    "sessionId": "fixture-session",
                    "toolCall": {
                        "toolCallId": "tool-1",
                        "title": "Run fixture command"
                    },
                    "options": [
                        {
                            "optionId": "once",
                            "name": "Allow once",
                            "kind": "allow_once"
                        },
                        {
                            "optionId": "always",
                            "name": "Always allow",
                            "kind": "allow_always"
                        },
                        {
                            "optionId": "reject",
                            "name": "Reject",
                            "kind": "reject_once"
                        }
                    ]
                }
            })
            permission = read()
            assert permission["result"]["outcome"]["outcome"] == "selected"
            assert permission["result"]["outcome"]["optionId"] == "always"
            write({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fixture-session",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {
                            "type": "text",
                            "text": "fixture complete"
                        }
                    }
                }
            })
            write({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"stopReason": "end_turn"}
            })
        elif method == "session/close":
            write({"jsonrpc": "2.0", "id": request_id, "result": {}})
            raise SystemExit(0)
        elif method == "session/cancel":
            pass
    """#
  }
}
