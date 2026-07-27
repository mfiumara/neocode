import Foundation
import OrchestratorCore
import Testing

struct AgentTimelineTests {
  @Test
  func tokenDeltasBecomeOneConversationMessage() {
    let events = [
      event(sequence: 1, kind: .status, text: "running"),
      event(sequence: 2, kind: .messageDelta, text: "Work"),
      event(sequence: 3, kind: .status, text: "streaming"),
      event(sequence: 4, kind: .messageDelta, text: "tree"),
      event(sequence: 5, kind: .raw, text: "transport chatter"),
      event(sequence: 6, kind: .messageDelta, text: " loaded."),
      event(sequence: 7, kind: .status, text: "completed"),
    ]

    let items = AgentTimelineProjection.items(from: events)
    #expect(items.count == 1)
    #expect(items[0].kind == .agentMessage)
    #expect(items[0].text == "Worktree loaded.")
    #expect(items[0].firstSequence == 2)
    #expect(items[0].lastSequence == 6)
  }

  @Test
  func firstDeltaKeepsBoundaryWhitespaceAndMergesWithFinalMarkdown() {
    let final =
      "Done. Next step.\n\n- Inspect files\n- Review changes"
    let events = [
      event(sequence: 1, kind: .messageDelta, text: "Done. "),
      event(
        sequence: 2,
        kind: .messageDelta,
        text: "Next step.\n\n- Inspect files\n- Review changes"
      ),
      event(sequence: 3, kind: .agentMessage, text: final),
    ]

    let items = AgentTimelineProjection.items(from: events)
    #expect(items.count == 1)
    #expect(items[0].text == final)
    #expect(items[0].isInProgress == false)
  }

  @Test
  func completedCodexMessageReplacesItsStreamWithoutDuplication() {
    var events = [
      event(sequence: 1, kind: .messageDelta, text: "What"),
      event(sequence: 2, kind: .messageDelta, text: " now?"),
    ]
    events.append(
      AgentEvent(
        sequence: 3,
        taskID: "task",
        agentID: "agent",
        kind: .toolCompleted,
        payload: .object([
          "item": .object([
            "id": .string("message-1"),
            "type": .string("agentMessage"),
            "text": .string("What now?"),
          ])
        ])
      )
    )

    let items = AgentTimelineProjection.items(from: events)
    #expect(items.count == 1)
    #expect(items[0].kind == .agentMessage)
    #expect(items[0].text == "What now?")
    #expect(items[0].isInProgress == false)
  }

  @Test
  func codexUserItemsAndToolLifecycleAreSemanticRows() {
    let userPayload: JSONValue = .object([
      "item": .object([
        "id": .string("user-1"),
        "type": .string("userMessage"),
        "content": .array([
          .object(["text": .string("Please fix the UI.")])
        ]),
      ])
    ])
    let commandStarted: JSONValue = .object([
      "item": .object([
        "id": .string("command-1"),
        "type": .string("commandExecution"),
        "command": .string("swift test"),
      ])
    ])
    let commandCompleted: JSONValue = .object([
      "item": .object([
        "id": .string("command-1"),
        "type": .string("commandExecution"),
        "command": .string("swift test"),
      ])
    ])
    let events = [
      AgentEvent(
        sequence: 1,
        taskID: "task",
        agentID: "agent",
        kind: .toolStarted,
        payload: userPayload
      ),
      AgentEvent(
        sequence: 2,
        taskID: "task",
        agentID: "agent",
        kind: .toolCompleted,
        payload: userPayload
      ),
      AgentEvent(
        sequence: 3,
        taskID: "task",
        agentID: "agent",
        kind: .toolStarted,
        payload: commandStarted
      ),
      AgentEvent(
        sequence: 4,
        taskID: "task",
        agentID: "agent",
        kind: .toolCompleted,
        payload: commandCompleted
      ),
    ]

    let items = AgentTimelineProjection.items(from: events)
    #expect(items.count == 2)
    #expect(items[0].kind == .userMessage)
    #expect(items[0].text == "Please fix the UI.")
    #expect(items[1].kind == .activity)
    #expect(items[1].title == "Command completed")
    #expect(items[1].text == "swift test")
    #expect(items[1].isInProgress == false)
  }

  private func event(
    sequence: Int64,
    kind: AgentEventKind,
    text: String
  ) -> AgentEvent {
    AgentEvent(
      sequence: sequence,
      taskID: "task",
      agentID: "agent",
      kind: kind,
      payload: .object(["text": .string(text)])
    )
  }
}
