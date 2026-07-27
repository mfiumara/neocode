import Foundation
import OrchestratorCore
import Testing

struct ConfigurationTests {
  @Test
  func exampleConfigurationLoadsAndHashesDeterministically() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let data = Data(
      """
      {
        "version": 1,
        "worktree": {
          "setup": ["npm ci"],
          "teardown": []
        },
        "scripts": {
          "web": {
            "kind": "service",
            "command": "npm run dev",
            "port": "auto",
            "url": "http://127.0.0.1:${PORT}"
          }
        }
      }
      """.utf8
    )
    try data.write(
      to: directory.appending(path: ProjectConfigurationLoader.fileName)
    )

    let loadedFirst = try ProjectConfigurationLoader.load(from: directory)
    let loadedSecond = try ProjectConfigurationLoader.load(from: directory)
    let first = try #require(loadedFirst)
    let second = try #require(loadedSecond)
    #expect(first.hash == second.hash)
    #expect(first.configuration.worktree.setup == ["npm ci"])
    #expect(first.configuration.scripts["web"]?.kind == .service)
    #expect(first.configuration.scripts["web"]?.port == .automatic)
  }

  @Test
  func invalidServiceConfigurationIsRejected() {
    let configuration = ProjectConfiguration(
      scripts: [
        "web": ProjectScript(kind: .service, command: "npm run dev")
      ]
    )
    #expect(throws: (any Error).self) {
      try ProjectConfigurationLoader.validate(configuration)
    }
  }

  @Test
  func unknownProviderFieldsSurviveAsRawJSON() throws {
    let raw: JSONValue = .object([
      "type": .string("future-event"),
      "nested": .object([
        "newField": .array([.number(1), .bool(true), .null])
      ]),
    ])
    let encoded = try JSONEncoder.orchestrator.encode(raw)
    let decoded = try JSONDecoder.orchestrator.decode(JSONValue.self, from: encoded)
    #expect(decoded == raw)
  }

  @Test
  func legacyProjectWithoutDefaultBranchStillDecodes() throws {
    let data = try JSONSerialization.data(
      withJSONObject: [
        "id": "project_legacy",
        "name": "Legacy",
        "rootPath": "/tmp/legacy",
        "createdAt": 0,
        "lastOpenedAt": 0,
      ]
    )
    let project = try JSONDecoder.orchestrator.decode(
      Project.self,
      from: data
    )
    #expect(project.defaultBranch == "HEAD")
  }

  @Test
  func legacyWorkspaceDefaultsToOrchestratorOwnership() throws {
    let workspace = Workspace(
      taskID: "task",
      sourcePath: "/tmp/repository",
      path: "/tmp/worktree",
      isolation: .worktree,
      baseCommit: "abc",
      branchName: "orch/legacy"
    )
    let encoded = try JSONEncoder.orchestrator.encode(workspace)
    var object = try #require(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    )
    object.removeValue(forKey: "ownership")
    let legacy = try JSONSerialization.data(withJSONObject: object)
    let decoded = try JSONDecoder.orchestrator.decode(
      Workspace.self,
      from: legacy
    )
    #expect(decoded.ownership == .orchestrator)
  }

  @Test
  func removedEditorPanelLayoutFallsBackToTerminal() throws {
    let decoded = try JSONDecoder.orchestrator.decode(
      PanelKind.self,
      from: Data(#""editor""#.utf8)
    )
    #expect(decoded == .terminal)
    #expect(!PanelKind.allCases.map(\.rawValue).contains("editor"))
  }

  @Test
  func notificationPolicySurfacesAttentionAndCompletion() {
    let approval = AgentEvent(
      taskID: "task",
      agentID: "agent",
      kind: .approvalRequested,
      payload: .object(["summary": .string("Run npm test")])
    )
    #expect(
      CoreNotificationPolicy.notification(for: approval)
        == CoreNotification(
          title: "Approval needed",
          body: "Run npm test"
        )
    )

    let input = AgentEvent(
      taskID: "task",
      agentID: "agent",
      kind: .inputRequested,
      payload: .object(["title": .string("Choose a deployment target")])
    )
    #expect(
      CoreNotificationPolicy.notification(for: input)
        == CoreNotification(
          title: "Agent needs input",
          body: "Choose a deployment target"
        )
    )

    let completed = AgentEvent(
      taskID: "task",
      agentID: "agent",
      kind: .status,
      payload: .object(["status": .string(AgentStatus.completed.rawValue)])
    )
    #expect(CoreNotificationPolicy.notification(for: completed)?.title == "Agent finished")

    let ordinaryDelta = AgentEvent(
      taskID: "task",
      agentID: "agent",
      kind: .messageDelta,
      payload: .object(["text": .string("working")])
    )
    #expect(CoreNotificationPolicy.notification(for: ordinaryDelta) == nil)
  }

  private func temporaryDirectory() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appending(path: "orchestrator-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: root,
      withIntermediateDirectories: true
    )
    return root
  }
}
