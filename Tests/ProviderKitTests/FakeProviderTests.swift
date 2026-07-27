import OrchestratorCore
import ProviderKit
import Testing

struct FakeProviderTests {
  @Test
  func fakeProviderStreamsOrderedLifecycle() async throws {
    let provider = FakeProvider()
    let session = try await provider.start(
      ProviderLaunchRequest(
        agentID: "agent",
        taskID: "task",
        workingDirectory: "/tmp",
        prompt: "hello"
      )
    )
    let stream = await provider.events(sessionID: session.id)
    var events: [ProviderEvent] = []
    for await event in stream {
      events.append(event)
      if event.payload["status"]?.stringValue == AgentStatus.completed.rawValue {
        break
      }
    }

    #expect(events.first?.kind == .status)
    #expect(events.contains { $0.kind == .messageDelta })
    #expect(
      events.last?.payload["status"]?.stringValue == AgentStatus.completed.rawValue
    )
    await provider.close(sessionID: session.id)
  }

  @Test
  func catalogIncludesFirstClassAndACPProviders() {
    let adapters = ProviderCatalog.makeDefaultAdapters()
    let ids = Set(adapters.map(\.descriptor.id))
    #expect(ids.contains("codex"))
    #expect(ids.contains("claude"))
    #expect(ids.contains("copilot"))
    #expect(ids.contains("gemini"))
  }
}
