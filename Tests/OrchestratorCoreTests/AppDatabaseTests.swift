import Foundation
import OrchestratorCore
import Testing

struct AppDatabaseTests {
  @Test
  func eventReplayIsOrderedAndIdempotentResultsRoundTrip() async throws {
    let database = try AppDatabase(inMemory: true)
    let project = Project(name: "Example", rootPath: "/tmp/example")
    let task = OrchestrationTask(
      projectID: project.id,
      title: "Ship it",
      goal: "Exercise persistence",
      baseRef: "main",
      branchName: "orch/ship-it"
    )
    try await database.upsert(project)
    try await database.upsert(task)

    let first = try await database.append(
      AgentEvent(
        taskID: task.id,
        kind: .status,
        payload: .object(["status": .string("running")])
      )
    )
    let second = try await database.append(
      AgentEvent(
        taskID: task.id,
        kind: .agentMessage,
        payload: .object(["text": .string("done")])
      )
    )

    #expect(first.sequence == 1)
    #expect(second.sequence == 2)
    let replay = try await database.events(after: first.sequence, taskID: task.id)
    #expect(replay.map(\.id) == [second.id])

    try await database.storeResult(task, for: "request-1")
    let restored = try await database.storedResult(
      for: "request-1",
      as: OrchestrationTask.self
    )
    #expect(restored == task)
  }

  @Test
  func snapshotContainsEveryPersistedTaskRecord() async throws {
    let database = try AppDatabase(inMemory: true)
    let project = Project(name: "Example", rootPath: "/tmp/example")
    let task = OrchestrationTask(
      projectID: project.id,
      title: "Task",
      goal: "Goal",
      baseRef: "main",
      branchName: "orch/task"
    )
    let workspace = Workspace(
      taskID: task.id,
      sourcePath: project.rootPath,
      path: "/tmp/worktree",
      isolation: .worktree,
      baseCommit: "abc",
      branchName: task.branchName
    )
    let agent = AgentSession(
      taskID: task.id,
      title: "Agent",
      providerID: "fake"
    )
    let approval = Approval(
      taskID: task.id,
      agentID: agent.id,
      kind: .command,
      title: "Run test",
      summary: "swift test"
    )
    let input = AgentInputRequest(
      taskID: task.id,
      agentID: agent.id,
      providerRequestID: "provider-input",
      questions: [
        AgentInputQuestion(
          id: "choice",
          header: "Choice",
          question: "Which option?",
          options: [AgentInputOption(label: "Option A")]
        )
      ]
    )
    try await database.upsert(project)
    try await database.upsert(task)
    try await database.upsert(workspace)
    try await database.upsert(agent)
    try await database.upsert(approval)
    try await database.upsert(input)

    let snapshot = try await database.snapshot(projectID: project.id)
    #expect(snapshot.project == project)
    #expect(snapshot.tasks == [task])
    #expect(snapshot.workspaces == [workspace])
    #expect(snapshot.agents == [agent])
    #expect(snapshot.approvals == [approval])
    #expect(snapshot.inputRequests == [input])
  }

  @Test
  func configurationTrustIsScopedToProjectAndHash() async throws {
    let database = try AppDatabase(inMemory: true)
    #expect(try await !database.isConfigurationTrusted(projectID: "one", hash: "hash"))
    try await database.trustConfiguration(projectID: "one", hash: "hash")
    #expect(try await database.isConfigurationTrusted(projectID: "one", hash: "hash"))
    #expect(try await !database.isConfigurationTrusted(projectID: "two", hash: "hash"))
    #expect(try await !database.isConfigurationTrusted(projectID: "one", hash: "changed"))
  }
}
