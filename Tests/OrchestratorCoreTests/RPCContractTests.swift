import Foundation
import OrchestratorCore
import Testing

struct RPCContractTests {
  @Test
  func everyMutationEnvelopeRoundTrips() throws {
    let requests: [CoreRPCRequest] = [
      .handshake(CoreHandshake(clientName: "Tests", clientVersion: "1")),
      .refreshACPRegistry,
      .openProject(OpenProjectRequest(requestID: "open", path: "/tmp/repo")),
      .createTask(
        CreateTaskRequest(
          requestID: "task",
          projectID: "project",
          title: "Title",
          goal: "Goal",
          baseRef: "main",
          branchName: "orch/title"
        )
      ),
      .launchAgent(
        LaunchAgentRequest(
          requestID: "agent",
          taskID: "task",
          title: "Agent",
          providerID: "fake",
          prompt: "Go"
        )
      ),
      .sendMessage(
        SendAgentMessageRequest(
          requestID: "send",
          agentID: "agent",
          text: "Continue"
        )
      ),
      .interrupt(
        InterruptAgentRequest(
          requestID: "interrupt",
          agentID: "agent"
        )
      ),
      .resolveApproval(
        ResolveApprovalRequest(
          requestID: "approval",
          approvalID: "approval",
          decision: .allowOnce
        )
      ),
      .respondToInput(
        RespondToInputRequest(
          requestID: "input",
          inputRequestID: "input",
          answers: ["choice": ["Option A"]]
        )
      ),
      .archiveTask(ArchiveTaskRequest(requestID: "archive", taskID: "task")),
      .startTerminal(
        StartTerminalRequest(
          requestID: "terminal",
          taskID: "task"
        )
      ),
      .terminalInput(
        TerminalInputRequest(
          requestID: "terminal-input",
          terminalID: "terminal",
          data: Data("pwd\n".utf8)
        )
      ),
      .terminalResize(
        TerminalResizeRequest(
          requestID: "terminal-resize",
          terminalID: "terminal",
          columns: 120,
          rows: 40
        )
      ),
      .stopTerminal(
        StopTerminalRequest(
          requestID: "terminal-stop",
          terminalID: "terminal"
        )
      ),
      .savePanelLayout(
        SavePanelLayoutRequest(
          requestID: "layout",
          layout: PanelLayout(
            id: "layout",
            projectID: "project",
            taskID: "task",
            selectedPanel: .diff
          )
        )
      ),
      .events(after: 42, taskID: "task"),
    ]

    for request in requests {
      let data = try CoreRPCCodec.encode(request)
      #expect(try CoreRPCCodec.decode(CoreRPCRequest.self, from: data) == request)
    }
  }
}
