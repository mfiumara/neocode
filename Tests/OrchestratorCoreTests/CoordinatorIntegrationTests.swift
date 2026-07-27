import Foundation
import OrchestratorCore
import ProviderKit
import Testing

struct CoordinatorIntegrationTests {
  @Test
  func helperRestartResumesPersistedProviderSession() async throws {
    let root = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let database = try AppDatabase(inMemory: true)
    let project = Project(
      name: "Recovery",
      rootPath: root.path,
      defaultBranch: "main"
    )
    let task = OrchestrationTask(
      projectID: project.id,
      title: "Resume",
      goal: "Survive helper restart",
      baseRef: "main",
      branchName: "orch/resume",
      status: .running
    )
    let workspace = Workspace(
      taskID: task.id,
      sourcePath: root.path,
      path: root.path,
      isolation: .currentCheckout,
      baseCommit: "deadbeef",
      branchName: "orch/resume"
    )
    let agent = AgentSession(
      taskID: task.id,
      title: "Persistent",
      providerID: "fake",
      providerSessionID: "fake-persisted-session",
      status: .running
    )
    try await database.upsert(project)
    try await database.upsert(task)
    try await database.upsert(workspace)
    try await database.upsert(agent)

    let coordinator = OrchestrationCoordinator(
      database: database,
      worktreesRoot: root.appending(path: "worktrees").path
    )
    await coordinator.register(provider: FakeProvider())
    try await coordinator.restorePersistentState()

    let snapshot = try await coordinator.snapshot(projectID: project.id)
    let restored = try #require(
      snapshot.agents.first { $0.id == agent.id }
    )
    #expect(restored.status == .running)
    #expect(restored.providerSessionID == "fake-persisted-session")
    let history = try await coordinator.events(after: 0, taskID: task.id)
    #expect(
      history.contains {
        $0.agentID == agent.id && $0.payload["restored"] == .bool(true)
      }
    )
  }

  @Test
  func trustedConfigurationCreatesWorktreeAndReplaysAgentHistory() async throws {
    let root = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let repository = root.appending(path: "repository")
    let worktrees = root.appending(path: "worktrees")
    try FileManager.default.createDirectory(
      at: repository,
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: worktrees,
      withIntermediateDirectories: true
    )
    try await initializeRepository(repository)

    let configurationData = Data(
      """
      {
        "version": 1,
        "worktree": {
          "setup": ["printf setup-complete > .setup-complete"],
          "teardown": []
        },
        "scripts": {}
      }
      """.utf8
    )
    try configurationData.write(
      to: repository.appending(path: ProjectConfigurationLoader.fileName)
    )
    try Data("hello\n".utf8).write(to: repository.appending(path: "README.md"))
    try await commitAll(repository, message: "Initial")

    let database = try AppDatabase(inMemory: true)
    let coordinator = OrchestrationCoordinator(
      database: database,
      worktreesRoot: worktrees.path
    )
    await coordinator.register(provider: FakeProvider())
    let project = try await coordinator.openProject(
      OpenProjectRequest(path: repository.path)
    )
    let loadedConfiguration = try ProjectConfigurationLoader.load(
      from: repository
    )
    let loaded = try #require(loadedConfiguration)
    var request = CreateTaskRequest(
      projectID: project.id,
      title: "Integration",
      goal: "Verify the vertical slice",
      baseRef: project.defaultBranch,
      branchName: "orch/integration"
    )

    do {
      _ = try await coordinator.createTask(request)
      Issue.record("Executable configuration should require trust.")
    } catch let error as OrchestrationError {
      guard case .configurationTrustRequired(let requirement) = error else {
        Issue.record("Unexpected trust error: \(error)")
        return
      }
      #expect(requirement.hash == loaded.hash)
    }

    request.trustConfigurationHash = loaded.hash
    let task = try await coordinator.createTask(request)
    let snapshot = try await coordinator.snapshot(projectID: project.id)
    let workspace = try #require(
      snapshot.workspaces.first { $0.taskID == task.id }
    )
    #expect(
      FileManager.default.fileExists(
        atPath: URL(fileURLWithPath: workspace.path)
          .appending(path: ".setup-complete")
          .path
      )
    )

    let agent = try await coordinator.launchAgent(
      LaunchAgentRequest(
        taskID: task.id,
        title: "Demo",
        providerID: "fake",
        prompt: "hello"
      )
    )
    try await Task.sleep(for: .milliseconds(250))
    let history = try await coordinator.events(after: 0, taskID: task.id)
    #expect(history.contains { $0.agentID == agent.id && $0.kind == .messageDelta })
    #expect(
      history.map(\.sequence) == history.map(\.sequence).sorted()
    )
    let terminal = try await coordinator.startTerminal(
      StartTerminalRequest(taskID: task.id)
    )

    do {
      try await coordinator.archiveTask(ArchiveTaskRequest(taskID: task.id))
      Issue.record("Dirty setup output should protect the worktree.")
    } catch GitServiceError.dirtyWorktree {
      // Expected.
    }
    let terminalAfterRefusal = try await coordinator.terminalOutput(
      terminalID: terminal.id,
      after: 0
    )
    #expect(terminalAfterRefusal.status == .running)
    let archiveRequest = ArchiveTaskRequest(
      taskID: task.id,
      forceDirtyWorktree: true
    )
    try await coordinator.archiveTask(archiveRequest)
    try await coordinator.archiveTask(archiveRequest)
    #expect(!FileManager.default.fileExists(atPath: workspace.path))
  }

  @Test
  func openingLinkedCheckoutImportsExistingWorktreesWithoutTakingOwnership() async throws {
    let root = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let repository = root.appending(path: "repository")
    let linkedCheckout = root.appending(path: "existing-worktree")
    try FileManager.default.createDirectory(
      at: repository,
      withIntermediateDirectories: true
    )
    try await initializeRepository(repository)
    try Data("fixture\n".utf8).write(
      to: repository.appending(path: "README.md")
    )
    try await commitAll(repository, message: "Initial")
    try await GitService().createWorktree(
      sourcePath: repository.path,
      destinationPath: linkedCheckout.path,
      branchName: "existing/feature",
      baseRef: "main"
    )

    let database = try AppDatabase(inMemory: true)
    let coordinator = OrchestrationCoordinator(
      database: database,
      worktreesRoot: root.appending(path: "managed").path
    )
    let project = try await coordinator.openProject(
      OpenProjectRequest(path: linkedCheckout.path)
    )
    let repositoryPath = try await GitService().repositoryRoot(
      at: repository.path
    )
    let linkedPath = try await GitService().repositoryRoot(
      at: linkedCheckout.path
    )
    #expect(project.rootPath == repositoryPath)
    #expect(project.defaultBranch == "main")

    var snapshot = try await coordinator.snapshot(projectID: project.id)
    let imported = snapshot.workspaces.filter {
      $0.ownership == .external
    }
    #expect(Set(imported.map(\.path)) == Set([repositoryPath, linkedPath]))
    let linkedWorkspace = try #require(
      imported.first { $0.path == linkedPath }
    )
    let linkedTask = try #require(
      snapshot.tasks.first { $0.id == linkedWorkspace.taskID }
    )
    #expect(linkedTask.branchName == "existing/feature")

    try Data("dirty\n".utf8).write(
      to: linkedCheckout.appending(path: "uncommitted.txt")
    )
    try await coordinator.archiveTask(
      ArchiveTaskRequest(taskID: linkedTask.id)
    )
    #expect(FileManager.default.fileExists(atPath: linkedCheckout.path))
    snapshot = try await coordinator.snapshot(projectID: project.id)
    #expect(
      snapshot.tasks.first { $0.id == linkedTask.id }?.status == .archived
    )
  }

  @Test
  func structuredInputPersistsAndReturnsAnswersToProvider() async throws {
    let root = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let repository = root.appending(path: "repository")
    try FileManager.default.createDirectory(
      at: repository,
      withIntermediateDirectories: true
    )
    try await initializeRepository(repository)
    try Data("fixture\n".utf8).write(
      to: repository.appending(path: "README.md")
    )
    try await commitAll(repository, message: "Initial")

    let provider = StructuredInputProvider()
    let database = try AppDatabase(inMemory: true)
    let coordinator = OrchestrationCoordinator(
      database: database,
      worktreesRoot: root.appending(path: "worktrees").path
    )
    await coordinator.register(provider: provider)
    let project = try await coordinator.openProject(
      OpenProjectRequest(path: repository.path)
    )
    let task = try await coordinator.createTask(
      CreateTaskRequest(
        projectID: project.id,
        title: "Input",
        goal: "Answer a provider question",
        baseRef: project.defaultBranch,
        branchName: "orch/input",
        useWorktree: false
      )
    )
    let agent = try await coordinator.launchAgent(
      LaunchAgentRequest(
        taskID: task.id,
        title: "Questioner",
        providerID: provider.descriptor.id,
        prompt: ""
      )
    )
    let sessionID = try #require(agent.providerSessionID)
    await provider.requestInput(sessionID: sessionID)
    try await Task.sleep(for: .milliseconds(40))

    var snapshot = try await coordinator.snapshot(projectID: project.id)
    let input = try #require(snapshot.inputRequests.first)
    #expect(input.status == .pending)
    #expect(snapshot.agents.first { $0.id == agent.id }?.status == .waitingForInput)

    let response = RespondToInputRequest(
      requestID: "structured-input-response",
      inputRequestID: input.id,
      answers: ["target": ["Production"]]
    )
    try await coordinator.respondToInput(response)
    try await coordinator.respondToInput(response)

    snapshot = try await coordinator.snapshot(projectID: project.id)
    #expect(snapshot.inputRequests.first?.status == .submitted)
    #expect(snapshot.agents.first { $0.id == agent.id }?.status == .running)
    let received = await provider.receivedAnswers()
    #expect(received == ["target": ["Production"]])
  }

  private func makeTemporaryDirectory() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appending(path: "orchestrator-coordinator-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: root,
      withIntermediateDirectories: true
    )
    return root
  }

  private func initializeRepository(_ repository: URL) async throws {
    let runner = ProcessRunner()
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["init", "-b", "main"],
        workingDirectory: repository.path
      )
    )
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["config", "user.email", "tests@example.invalid"],
        workingDirectory: repository.path
      )
    )
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["config", "user.name", "Orchestrator Tests"],
        workingDirectory: repository.path
      )
    )
  }

  private func commitAll(_ repository: URL, message: String) async throws {
    let runner = ProcessRunner()
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["add", "--all"],
        workingDirectory: repository.path
      )
    )
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["commit", "-m", message],
        workingDirectory: repository.path
      )
    )
  }
}

private actor StructuredInputProvider: ProviderAdapter {
  nonisolated let descriptor = ProviderDescriptor(
    id: "structured-input-fixture",
    label: "Structured Input Fixture",
    command: [],
    capabilities: [.structuredInput]
  )

  private var sessions:
    [String: (
      stream: AsyncStream<ProviderEvent>,
      continuation: AsyncStream<ProviderEvent>.Continuation
    )] = [:]
  private var response: [String: [String]]?

  func inspect() async -> ProviderInspection {
    ProviderInspection(
      descriptor: descriptor,
      availability: .available(path: "fixture", version: "1")
    )
  }

  func start(_ request: ProviderLaunchRequest) async throws -> ProviderSession {
    let sessionID = UUID().uuidString
    let pair = AsyncStream.makeStream(of: ProviderEvent.self)
    sessions[sessionID] = pair
    return ProviderSession(
      id: sessionID,
      providerID: descriptor.id,
      agentID: request.agentID
    )
  }

  func send(_ text: String, to sessionID: String) async throws {}
  func steer(_ text: String, sessionID: String) async throws {}
  func interrupt(sessionID: String) async throws {}

  func respond(
    to approvalID: String,
    decision: ApprovalDecision,
    sessionID: String
  ) async throws {}

  func respondToInput(
    requestID: String,
    answers: [String: [String]],
    sessionID: String
  ) async throws {
    guard sessions[sessionID] != nil, requestID == "fixture-input" else {
      throw ProviderError.protocolViolation("Unexpected fixture input route.")
    }
    response = answers
  }

  func close(sessionID: String) async {
    sessions.removeValue(forKey: sessionID)?.continuation.finish()
  }

  func events(sessionID: String) async -> AsyncStream<ProviderEvent> {
    sessions[sessionID]?.stream ?? AsyncStream { $0.finish() }
  }

  func requestInput(sessionID: String) {
    sessions[sessionID]?.continuation.yield(
      ProviderEvent(
        sessionID: sessionID,
        kind: .inputRequested,
        payload: .object([
          "inputRequestID": .string("fixture-input"),
          "title": .string("Choose a target"),
          "questions": .array([
            .object([
              "id": .string("target"),
              "header": .string("Target"),
              "question": .string("Where should this deploy?"),
              "options": .array([
                .object([
                  "label": .string("Production"),
                  "description": .string("Deploy to production."),
                ])
              ]),
              "allowsFreeform": .bool(true),
              "isSecret": .bool(false),
            ])
          ]),
        ]),
        raw: .object(["fixture": .bool(true)])
      )
    )
  }

  func receivedAnswers() -> [String: [String]]? {
    response
  }
}
