import Darwin
import Foundation

private struct DelegationScope: Sendable {
  var projectID: String
  var taskID: String
  var parentAgentID: String
}

public actor OrchestrationCoordinator {
  public static let childAgentLimit = 3

  private let database: AppDatabase
  private let worktrees: WorktreeManager
  private let git: GitService
  private let runner: ProcessRunner
  private let eventHub: EventHub
  private let portAllocator: PortAllocator
  private let serviceProcesses: ServiceProcessManager
  private let terminalProcesses: PersistentTerminalManager
  private let worktreesRoot: String
  private var providers: [String: any ProviderAdapter] = [:]
  private var projects: [String: Project] = [:]
  private var tasks: [String: OrchestrationTask] = [:]
  private var workspacesByTask: [String: Workspace] = [:]
  private var agents: [String: AgentSession] = [:]
  private var approvals: [String: Approval] = [:]
  private var inputRequests: [String: AgentInputRequest] = [:]
  private var services: [String: ManagedService] = [:]
  private var terminals: [String: TerminalSession] = [:]
  private var layouts: [String: PanelLayout] = [:]
  private var providerSessionByAgent: [String: ProviderSession] = [:]
  private var providerEventTasks: [String: Task<Void, Never>] = [:]
  private var delegationScopes: [String: DelegationScope] = [:]
  private var delegationTokenByAgent: [String: String] = [:]
  private var pendingChildApprovalTokens: [String: String] = [:]
  private var approvedSingleChildTokens = Set<String>()
  private var permissionWaiters: [String: CheckedContinuation<ApprovalDecision, Never>] = [:]

  public init(
    database: AppDatabase,
    worktreesRoot: String,
    worktrees: WorktreeManager = .init(),
    git: GitService = .init(),
    runner: ProcessRunner = .init(),
    eventHub: EventHub = .init(),
    portAllocator: PortAllocator = .init(),
    serviceProcesses: ServiceProcessManager = .init(),
    terminalProcesses: PersistentTerminalManager = .init()
  ) {
    self.database = database
    self.worktreesRoot = worktreesRoot
    self.worktrees = worktrees
    self.git = git
    self.runner = runner
    self.eventHub = eventHub
    self.portAllocator = portAllocator
    self.serviceProcesses = serviceProcesses
    self.terminalProcesses = terminalProcesses
  }

  public func register(provider: any ProviderAdapter) {
    providers[provider.descriptor.id] = provider
  }

  public func providerInspections() async -> [ProviderInspection] {
    await withTaskGroup(of: ProviderInspection.self) { group in
      for provider in providers.values {
        group.addTask { await provider.inspect() }
      }
      var inspections: [ProviderInspection] = []
      for await inspection in group {
        inspections.append(inspection)
      }
      return inspections.sorted { $0.descriptor.label < $1.descriptor.label }
    }
  }

  public func openProject(_ request: OpenProjectRequest) async throws -> Project {
    if let stored: Project = try await database.storedResult(
      for: request.requestID,
      as: Project.self
    ) {
      projects[stored.id] = stored
      return stored
    }

    let selectedRoot = try await git.repositoryRoot(at: request.path)
    let linkedWorktrees = try await git.linkedWorktrees(at: selectedRoot)
    let root =
      linkedWorktrees.first(where: { !$0.isBare && !$0.isPrunable })?.path
      ?? selectedRoot
    let currentBranch = try await git.currentBranch(at: root)
    let linkedPaths = Set(linkedWorktrees.map { normalizedPath($0.path) })
    var project = Project(
      name: URL(fileURLWithPath: root).lastPathComponent,
      rootPath: root,
      defaultBranch: currentBranch.isEmpty ? "HEAD" : currentBranch
    )
    let existing =
      projects.values.first(where: {
        normalizedPath($0.rootPath) == normalizedPath(root)
      })
      ?? projects.values.first(where: {
        linkedPaths.contains(normalizedPath($0.rootPath))
      })
    if let existing {
      project = existing
      project.name = URL(fileURLWithPath: root).lastPathComponent
      project.rootPath = root
      project.defaultBranch =
        currentBranch.isEmpty
        ? project.defaultBranch
        : currentBranch
      project.lastOpenedAt = .now
    }
    projects[project.id] = project
    try await database.upsert(project)
    try await reconcileLinkedWorktrees(
      for: project,
      linkedWorktrees: linkedWorktrees
    )
    try await database.storeResult(project, for: request.requestID)
    return project
  }

  public func createTask(_ request: CreateTaskRequest) async throws -> OrchestrationTask {
    if let stored: OrchestrationTask = try await database.storedResult(
      for: request.requestID,
      as: OrchestrationTask.self
    ) {
      tasks[stored.id] = stored
      return stored
    }
    guard let project = projects[request.projectID] else {
      throw OrchestrationError.projectNotFound(request.projectID)
    }

    let resolvedBaseRef =
      request.baseRef == "HEAD"
      ? project.defaultBranch
      : request.baseRef
    let configurationData = try await git.fileContents(
      at: project.rootPath,
      ref: resolvedBaseRef,
      relativePath: ProjectConfigurationLoader.fileName
    )
    let loadedConfiguration = try configurationData.map {
      try ProjectConfigurationLoader.load(
        data: $0,
        path: "\(project.rootPath)/\(ProjectConfigurationLoader.fileName) @ \(resolvedBaseRef)"
      )
    }
    if let loadedConfiguration {
      let alreadyTrusted = try await database.isConfigurationTrusted(
        projectID: project.id,
        hash: loadedConfiguration.hash
      )
      if !alreadyTrusted {
        guard request.trustConfigurationHash == loadedConfiguration.hash else {
          throw OrchestrationError.configurationTrustRequired(
            ConfigurationTrustRequirement(
              projectID: project.id,
              path: loadedConfiguration.path,
              hash: loadedConfiguration.hash,
              setupCommands: loadedConfiguration.configuration.worktree.setup,
              teardownCommands: loadedConfiguration.configuration.worktree.teardown
            )
          )
        }
        try await database.trustConfiguration(
          projectID: project.id,
          hash: loadedConfiguration.hash
        )
      }
    }

    var task = OrchestrationTask(
      projectID: project.id,
      title: request.title,
      goal: request.goal,
      baseRef: resolvedBaseRef,
      branchName: request.branchName
    )
    tasks[task.id] = task
    try await database.upsert(task)

    do {
      let workspace: Workspace
      if request.useWorktree {
        workspace = try await worktrees.create(
          WorktreeCreationRequest(
            taskID: task.id,
            sourcePath: project.rootPath,
            baseRef: resolvedBaseRef,
            branchName: request.branchName,
            worktreesRoot: worktreesRoot
          )
        )
      } else {
        workspace = Workspace(
          taskID: task.id,
          sourcePath: project.rootPath,
          path: project.rootPath,
          isolation: .currentCheckout,
          baseCommit: try await git.headCommit(at: project.rootPath),
          branchName: try await git.currentBranch(at: project.rootPath)
        )
      }
      var configuredWorkspace = workspace
      configuredWorkspace.configHash = loadedConfiguration?.hash
      configuredWorkspace.configuration = loadedConfiguration?.configuration
      workspacesByTask[task.id] = configuredWorkspace
      try await database.upsert(configuredWorkspace)

      if let setup = loadedConfiguration?.configuration.worktree.setup {
        try await runHooks(
          setup,
          workspace: configuredWorkspace,
          sourcePath: project.rootPath
        )
      }
      if let configuration = loadedConfiguration?.configuration {
        try await startConfiguredServices(
          configuration,
          taskID: task.id,
          workspace: configuredWorkspace
        )
      }

      task.workspaceID = configuredWorkspace.id
      task.status = .running
      task.updatedAt = .now
      tasks[task.id] = task
      try await database.upsert(task)
      let event = try await record(
        taskID: task.id,
        kind: .status,
        payload: .object([
          "status": .string(TaskStatus.running.rawValue),
          "workspacePath": .string(configuredWorkspace.path),
        ])
      )
      await eventHub.publish(event)
    } catch {
      task.status = .failed
      task.updatedAt = .now
      tasks[task.id] = task
      try await database.upsert(task)
      let event = try await record(
        taskID: task.id,
        kind: .error,
        payload: .object(["message": .string(error.localizedDescription)])
      )
      await eventHub.publish(event)
      throw error
    }

    try await database.storeResult(task, for: request.requestID)
    return task
  }

  public func launchAgent(
    _ request: LaunchAgentRequest,
    initiatedByAgent: Bool = false,
    childLaunchAuthorized: Bool = false
  ) async throws -> AgentSession {
    if let stored: AgentSession = try await database.storedResult(
      for: request.requestID,
      as: AgentSession.self
    ) {
      agents[stored.id] = stored
      return stored
    }
    guard let task = tasks[request.taskID] else {
      throw OrchestrationError.taskNotFound(request.taskID)
    }
    guard let workspace = workspacesByTask[request.taskID] else {
      throw OrchestrationError.workspaceNotFound(request.taskID)
    }
    guard let provider = providers[request.providerID] else {
      throw OrchestrationError.providerNotFound(request.providerID)
    }

    if initiatedByAgent {
      switch task.childLaunchPolicy {
      case .deny:
        throw OrchestrationError.childLaunchDenied
      case .ask:
        guard childLaunchAuthorized else {
          throw OrchestrationError.invalidState(
            "Child launch requires a user approval before execution."
          )
        }
      case .allowForTask:
        break
      }
      let liveChildren = agents.values.filter {
        $0.parentID == request.parentAgentID
          && [.launching, .running, .waitingForApproval, .waitingForInput, .idle]
            .contains($0.status)
      }
      guard liveChildren.count < Self.childAgentLimit else {
        throw OrchestrationError.childLaunchLimit(Self.childAgentLimit)
      }
    }

    var agent = AgentSession(
      taskID: request.taskID,
      parentID: request.parentAgentID,
      title: request.title,
      providerID: request.providerID,
      model: request.model,
      mode: request.mode
    )
    agents[agent.id] = agent
    try await database.upsert(agent)
    let delegation = try makeDelegationConfiguration(
      projectID: task.projectID,
      taskID: task.id,
      parentAgentID: agent.id
    )

    do {
      let providerSession = try await provider.start(
        ProviderLaunchRequest(
          agentID: agent.id,
          taskID: request.taskID,
          workingDirectory: workspace.path,
          prompt: request.prompt,
          model: request.model,
          mode: request.mode,
          environment: delegation.environment,
          mcpConfigurationPath: delegation.configurationPath
        )
      )
      providerSessionByAgent[agent.id] = providerSession
      agent.providerSessionID = providerSession.id
      agent.status = .running
      agent.updatedAt = .now
      agents[agent.id] = agent
      try await database.upsert(agent)
      try await database.storeResult(agent, for: request.requestID)

      let stream = await provider.events(sessionID: providerSession.id)
      let agentID = agent.id
      let taskID = request.taskID
      let forwardingTask = Task { @Sendable [weak self] in
        for await providerEvent in stream {
          guard !Task.isCancelled else { break }
          await self?.ingest(
            providerEvent,
            agentID: agentID,
            taskID: taskID
          )
        }
      }
      providerEventTasks[agentID] = forwardingTask
      return agent
    } catch {
      revokeDelegation(for: agent.id)
      agent.status = .failed
      agent.updatedAt = .now
      agents[agent.id] = agent
      try await database.upsert(agent)
      _ = try await record(
        taskID: request.taskID,
        agentID: agent.id,
        kind: .error,
        payload: .object(["message": .string(error.localizedDescription)])
      )
      throw error
    }
  }

  public func send(_ request: SendAgentMessageRequest) async throws {
    if let completed: Bool = try await database.storedResult(
      for: request.requestID,
      as: Bool.self
    ), completed {
      return
    }
    guard let agent = agents[request.agentID] else {
      throw OrchestrationError.agentNotFound(request.agentID)
    }
    guard let session = providerSessionByAgent[agent.id],
      let provider = providers[agent.providerID]
    else {
      throw OrchestrationError.invalidState("Agent is not connected to its provider.")
    }
    if request.steerActiveTurn {
      try await provider.steer(request.text, sessionID: session.id)
    } else {
      try await provider.send(request.text, to: session.id)
    }
    let event = try await record(
      taskID: agent.taskID,
      agentID: agent.id,
      kind: .userMessage,
      payload: .object(["text": .string(request.text)])
    )
    await eventHub.publish(event)
    try await database.storeResult(true, for: request.requestID)
  }

  public func interrupt(_ request: InterruptAgentRequest) async throws {
    if let completed: Bool = try await database.storedResult(
      for: request.requestID,
      as: Bool.self
    ), completed {
      return
    }
    guard var agent = agents[request.agentID] else {
      throw OrchestrationError.agentNotFound(request.agentID)
    }
    guard let session = providerSessionByAgent[agent.id],
      let provider = providers[agent.providerID]
    else {
      throw OrchestrationError.invalidState("Agent is not connected to its provider.")
    }
    try await provider.interrupt(sessionID: session.id)
    agent.status = .interrupted
    agent.updatedAt = .now
    agents[agent.id] = agent
    try await database.upsert(agent)
    try await database.storeResult(true, for: request.requestID)
  }

  public func resolveApproval(_ request: ResolveApprovalRequest) async throws {
    if let completed: Bool = try await database.storedResult(
      for: request.requestID,
      as: Bool.self
    ), completed {
      return
    }
    guard var approval = approvals[request.approvalID] else {
      throw OrchestrationError.approvalNotFound(request.approvalID)
    }
    if approval.kind == .childAgent {
      if let token = pendingChildApprovalTokens.removeValue(forKey: approval.id) {
        switch request.decision {
        case .allowOnce:
          approvedSingleChildTokens.insert(token)
        case .allowForSession:
          if var task = tasks[approval.taskID] {
            task.childLaunchPolicy = .allowForTask
            task.updatedAt = .now
            tasks[task.id] = task
            try await database.upsert(task)
          }
        case .deny, .cancel:
          break
        }
      }
    } else if let agentID = approval.agentID,
      let agent = agents[agentID],
      let session = providerSessionByAgent[agentID],
      let provider = providers[agent.providerID],
      let providerRequestID = approval.providerRequestID
    {
      try await provider.respond(
        to: providerRequestID,
        decision: request.decision,
        sessionID: session.id
      )
    }
    approval.status =
      switch request.decision {
      case .allowOnce: .allowedOnce
      case .allowForSession: .allowedForSession
      case .deny: .denied
      case .cancel: .cancelled
      }
    approval.resolvedAt = .now
    approvals[approval.id] = approval
    try await database.upsert(approval)
    if var task = tasks[approval.taskID], task.status == .needsAttention,
      !hasPendingAttention(taskID: approval.taskID)
    {
      task.status = .running
      task.updatedAt = .now
      tasks[task.id] = task
      try await database.upsert(task)
    }
    let event = try await record(
      taskID: approval.taskID,
      agentID: approval.agentID,
      kind: .approvalResolved,
      payload: .object([
        "approvalID": .string(approval.id),
        "decision": .string(request.decision.rawValue),
      ])
    )
    await eventHub.publish(event)
    if let waiter = permissionWaiters.removeValue(forKey: approval.id) {
      waiter.resume(returning: request.decision)
    }
    if let agentID = approval.agentID, var agent = agents[agentID],
      agent.status == .waitingForApproval
    {
      agent.status = .running
      agent.updatedAt = .now
      agents[agent.id] = agent
      try await database.upsert(agent)
    }
    try await database.storeResult(true, for: request.requestID)
  }

  public func respondToInput(_ request: RespondToInputRequest) async throws {
    if let completed: Bool = try await database.storedResult(
      for: request.requestID,
      as: Bool.self
    ), completed {
      return
    }
    guard var input = inputRequests[request.inputRequestID] else {
      throw OrchestrationError.inputRequestNotFound(request.inputRequestID)
    }
    guard input.status == .pending else {
      throw OrchestrationError.invalidState("This input request is no longer pending.")
    }
    guard let agent = agents[input.agentID],
      let session = providerSessionByAgent[input.agentID],
      let provider = providers[agent.providerID]
    else {
      throw OrchestrationError.invalidState("Agent is not connected to its provider.")
    }

    let answers = request.cancelled ? [:] : request.answers
    try await provider.respondToInput(
      requestID: input.providerRequestID,
      answers: answers,
      sessionID: session.id
    )
    input.status = request.cancelled ? .cancelled : .submitted
    input.resolvedAt = .now
    inputRequests[input.id] = input
    try await database.upsert(input)

    if var storedAgent = agents[input.agentID],
      storedAgent.status == .waitingForInput
    {
      storedAgent.status = .running
      storedAgent.updatedAt = .now
      agents[storedAgent.id] = storedAgent
      try await database.upsert(storedAgent)
    }
    if var task = tasks[input.taskID], task.status == .needsAttention,
      !hasPendingAttention(taskID: input.taskID)
    {
      task.status = .running
      task.updatedAt = .now
      tasks[task.id] = task
      try await database.upsert(task)
    }
    let event = try await record(
      taskID: input.taskID,
      agentID: input.agentID,
      kind: .inputResolved,
      payload: .object([
        "inputRequestID": .string(input.id),
        "resolution": .string(request.cancelled ? "cancelled" : "submitted"),
      ])
    )
    await eventHub.publish(event)
    try await database.storeResult(true, for: request.requestID)
  }

  public func archiveTask(_ request: ArchiveTaskRequest) async throws {
    if let completed: Bool = try await database.storedResult(
      for: request.requestID,
      as: Bool.self
    ), completed {
      return
    }
    guard var task = tasks[request.taskID] else {
      throw OrchestrationError.taskNotFound(request.taskID)
    }
    guard let workspace = workspacesByTask[request.taskID] else {
      throw OrchestrationError.workspaceNotFound(request.taskID)
    }
    if workspace.isolation == .worktree,
      workspace.ownership == .orchestrator,
      !request.forceDirtyWorktree,
      try await git.isDirty(at: workspace.path)
    {
      throw GitServiceError.dirtyWorktree(workspace.path)
    }
    for agent in agents.values where agent.taskID == request.taskID {
      providerEventTasks[agent.id]?.cancel()
      revokeDelegation(for: agent.id)
      if let provider = providers[agent.providerID],
        let session = providerSessionByAgent[agent.id]
      {
        await provider.close(sessionID: session.id)
      }
    }
    for service in services.values where service.taskID == request.taskID {
      await serviceProcesses.stop(id: service.id)
      if let port = service.port, let value = UInt16(exactly: port) {
        await portAllocator.release(value)
      }
      var stopped = service
      stopped.status = .stopped
      services[stopped.id] = stopped
      try await database.upsert(stopped)
    }
    for terminal in terminals.values where terminal.taskID == request.taskID {
      await terminalProcesses.stop(terminalID: terminal.id)
      var stopped = terminal
      stopped.status = .exited
      terminals[stopped.id] = stopped
      try await database.upsert(stopped)
    }

    if let project = projects[task.projectID],
      let configuration = workspace.configuration
    {
      try await runHooks(
        configuration.worktree.teardown,
        workspace: workspace,
        sourcePath: project.rootPath
      )
    }
    try await worktrees.archive(workspace, force: request.forceDirtyWorktree)
    task.status = .archived
    task.updatedAt = .now
    tasks[task.id] = task
    try await database.upsert(task)
    try await database.storeResult(true, for: request.requestID)
  }

  public func diff(taskID: String) async throws -> GitDiff {
    guard let task = tasks[taskID] else {
      throw OrchestrationError.taskNotFound(taskID)
    }
    guard let workspace = workspacesByTask[taskID] else {
      throw OrchestrationError.workspaceNotFound(taskID)
    }
    return try await git.diff(at: workspace.path, baseRef: task.baseRef)
  }

  public func createPullRequest(
    _ request: CreatePullRequestRequest
  ) async throws -> PullRequest {
    if let stored: PullRequest = try await database.storedResult(
      for: request.requestID,
      as: PullRequest.self
    ) {
      return stored
    }
    guard var task = tasks[request.taskID] else {
      throw OrchestrationError.taskNotFound(request.taskID)
    }
    guard let workspace = workspacesByTask[request.taskID] else {
      throw OrchestrationError.workspaceNotFound(request.taskID)
    }
    try await git.stage(files: request.stageFiles, at: workspace.path)
    if try await git.hasStagedChanges(at: workspace.path) {
      _ = try await git.commit(
        message: request.commitMessage,
        at: workspace.path
      )
    } else {
      let hasExistingCommit = try await git.hasCommits(
        since: task.baseRef,
        at: workspace.path
      )
      if !hasExistingCommit {
        throw GitServiceError.noChangesToCommit
      }
    }
    try await git.push(branch: task.branchName, at: workspace.path)
    let created: CreatedPullRequest
    if let existing = try await git.existingPullRequest(
      head: task.branchName,
      at: workspace.path
    ) {
      created = existing
    } else {
      created = try await git.createPullRequest(
        title: request.title,
        body: request.body,
        base: task.baseRef,
        head: task.branchName,
        at: workspace.path
      )
    }
    let pullRequest = PullRequest(
      taskID: task.id,
      number: created.number,
      url: created.url,
      title: request.title
    )
    try await database.upsert(pullRequest)
    task.status = .shipped
    task.updatedAt = .now
    tasks[task.id] = task
    try await database.upsert(task)
    try await database.storeResult(pullRequest, for: request.requestID)
    return pullRequest
  }

  public func snapshot(projectID: String) async throws -> CoreSnapshot {
    var snapshot = try await database.snapshot(projectID: projectID)
    if let project = snapshot.project {
      projects[project.id] = project
      do {
        try await reconcileLinkedWorktrees(for: project)
        snapshot = try await database.snapshot(projectID: projectID)
      } catch {
        // A project remains usable if Git cannot enumerate worktrees briefly.
      }
    }
    for task in snapshot.tasks {
      tasks[task.id] = task
    }
    for workspace in snapshot.workspaces {
      workspacesByTask[workspace.taskID] = workspace
    }
    for agent in snapshot.agents {
      agents[agent.id] = agent
    }
    for approval in snapshot.approvals {
      approvals[approval.id] = approval
    }
    for input in snapshot.inputRequests {
      inputRequests[input.id] = input
    }
    for var terminal in snapshot.terminals {
      if let output = await terminalProcesses.output(
        terminalID: terminal.id,
        after: 0
      ) {
        terminal.status = output.status
        terminal.exitCode = output.exitCode
      } else if terminal.status == .running || terminal.status == .starting {
        terminal.status = .failed
      }
      terminals[terminal.id] = terminal
      try await database.upsert(terminal)
    }
    for var service in snapshot.services {
      if let process = await serviceProcesses.snapshot(id: service.id) {
        service.status = process.status
        services[service.id] = service
        try await database.upsert(service)
      } else if service.status == .running || service.status == .starting {
        service.status = .orphaned
        services[service.id] = service
        try await database.upsert(service)
      } else {
        services[service.id] = service
      }
    }
    for layout in snapshot.layouts {
      layouts[layout.id] = layout
    }
    snapshot.services = services.values
      .filter { task in
        snapshot.tasks.contains { $0.id == task.taskID }
      }
      .sorted { $0.createdAt < $1.createdAt }
    snapshot.terminals = terminals.values
      .filter { terminal in
        snapshot.tasks.contains { $0.id == terminal.taskID }
      }
      .sorted { $0.createdAt < $1.createdAt }
    return snapshot
  }

  public func allProjects() async throws -> [Project] {
    let stored = try await database.allProjects()
    for project in stored {
      projects[project.id] = project
    }
    return stored
  }

  /// Rehydrates the helper's in-memory ownership after launchd restarts it.
  /// Provider sessions are resumed when the adapter advertises that capability;
  /// PTYs that cannot be reattached are failed explicitly, and surviving
  /// detached services are surfaced as orphaned instead of being killed by PID.
  public func restorePersistentState() async throws {
    let storedProjects = try await database.allProjects()
    for project in storedProjects {
      projects[project.id] = project
      let snapshot = try await database.snapshot(projectID: project.id)
      for task in snapshot.tasks {
        tasks[task.id] = task
      }
      for workspace in snapshot.workspaces {
        workspacesByTask[workspace.taskID] = workspace
      }
      for agent in snapshot.agents {
        agents[agent.id] = agent
      }
      for approval in snapshot.approvals {
        approvals[approval.id] = approval
      }
      for input in snapshot.inputRequests {
        inputRequests[input.id] = input
      }
      for terminal in snapshot.terminals {
        terminals[terminal.id] = terminal
      }
      for service in snapshot.services {
        services[service.id] = service
      }
      for layout in snapshot.layouts {
        layouts[layout.id] = layout
      }
    }

    for var approval in approvals.values where approval.status == .pending {
      approval.status = .cancelled
      approval.resolvedAt = .now
      approvals[approval.id] = approval
      try await database.upsert(approval)
      let event = try await record(
        taskID: approval.taskID,
        agentID: approval.agentID,
        kind: .approvalResolved,
        payload: .object([
          "approvalID": .string(approval.id),
          "decision": .string(ApprovalDecision.cancel.rawValue),
          "reason": .string("backgroundHelperRestart"),
        ])
      )
      await eventHub.publish(event)
    }

    for var input in inputRequests.values where input.status == .pending {
      input.status = .cancelled
      input.resolvedAt = .now
      inputRequests[input.id] = input
      try await database.upsert(input)
      let event = try await record(
        taskID: input.taskID,
        agentID: input.agentID,
        kind: .inputResolved,
        payload: .object([
          "inputRequestID": .string(input.id),
          "resolution": .string("cancelled"),
          "reason": .string("backgroundHelperRestart"),
        ])
      )
      await eventHub.publish(event)
    }

    for var terminal in terminals.values
    where terminal.status == .running || terminal.status == .starting {
      terminal.status = .failed
      terminal.exitCode = nil
      terminals[terminal.id] = terminal
      try await database.upsert(terminal)
    }

    for service in services.values
    where service.status == .running || service.status == .starting {
      await restore(service: service)
    }

    let resumableStatuses: Set<AgentStatus> = [
      .launching, .running, .waitingForApproval, .waitingForInput, .idle,
    ]
    let resumableAgents = agents.values
      .filter { resumableStatuses.contains($0.status) }
      .sorted { $0.createdAt < $1.createdAt }
    for agent in resumableAgents {
      await restore(agent: agent)
    }
  }

  public func events(after sequence: Int64, taskID: String? = nil) async throws -> [AgentEvent] {
    try await database.events(after: sequence, taskID: taskID)
  }

  public func liveEvents() async -> AsyncStream<AgentEvent> {
    await eventHub.stream()
  }

  public func performDelegation(
    _ request: DelegationBridgeRequest
  ) async throws -> JSONValue {
    guard let scope = delegationScopes[request.token] else {
      throw CoreServiceFailure(
        code: "invalid_capability",
        message: "This delegation capability is invalid or expired."
      )
    }
    switch request.method {
    case "providers.list":
      let inspections = await providerInspections()
      return try JSONValue.encode(inspections)
    case "agents.inspect":
      let requestedID =
        request.params["agentID"]?.stringValue
        ?? scope.parentAgentID
      guard canAccess(agentID: requestedID, from: scope),
        let agent = agents[requestedID]
      else {
        throw CoreServiceFailure(
          code: "agent_out_of_scope",
          message: "The requested agent is outside this capability."
        )
      }
      let descendants = agents.values.filter {
        $0.id == agent.id || isDescendant($0.id, of: agent.id)
      }
      return try JSONValue.encode(
        descendants.sorted { $0.createdAt < $1.createdAt }
      )
    case "agents.send":
      guard let agentID = request.params["agentID"]?.stringValue,
        let text = request.params["text"]?.stringValue,
        canAccess(agentID: agentID, from: scope)
      else {
        throw CoreServiceFailure(
          code: "invalid_arguments",
          message: "agents.send requires an in-scope agentID and text."
        )
      }
      try await send(
        SendAgentMessageRequest(agentID: agentID, text: text)
      )
      return .object(["status": .string("sent")])
    case "agents.stop":
      guard let agentID = request.params["agentID"]?.stringValue,
        canAccess(agentID: agentID, from: scope)
      else {
        throw CoreServiceFailure(
          code: "invalid_arguments",
          message: "agents.stop requires an in-scope agentID."
        )
      }
      try await interrupt(InterruptAgentRequest(agentID: agentID))
      return .object(["status": .string("stopped")])
    case "agents.create":
      return try await createDelegatedAgent(
        params: request.params,
        token: request.token,
        scope: scope
      )
    case "approval":
      return try await requestDelegatedPermission(
        params: request.params,
        scope: scope
      )
    default:
      throw CoreServiceFailure(
        code: "method_not_found",
        message: "Unsupported delegation method \(request.method)."
      )
    }
  }

  public func startTerminal(
    _ request: StartTerminalRequest
  ) async throws -> TerminalSession {
    if let stored: TerminalSession = try await database.storedResult(
      for: request.requestID,
      as: TerminalSession.self
    ) {
      terminals[stored.id] = stored
      return stored
    }
    guard tasks[request.taskID] != nil else {
      throw OrchestrationError.taskNotFound(request.taskID)
    }
    guard let workspace = workspacesByTask[request.taskID] else {
      throw OrchestrationError.workspaceNotFound(request.taskID)
    }
    var terminal = TerminalSession(
      taskID: request.taskID,
      title: request.title,
      workingDirectory: workspace.path
    )
    terminal.processIdentifier = await terminalProcesses.start(
      terminalID: terminal.id,
      workingDirectory: workspace.path,
      columns: max(20, request.columns),
      rows: max(5, request.rows),
      environment: [
        "COLORTERM": "truecolor",
        "TERM": "xterm-256color",
        "TERM_PROGRAM": "Orchestrator",
        "ORCHESTRATOR_WORKTREE_PATH": workspace.path,
      ]
    )
    terminal.status = .running
    terminals[terminal.id] = terminal
    try await database.upsert(terminal)
    try await database.storeResult(terminal, for: request.requestID)
    return terminal
  }

  public func sendTerminalInput(_ request: TerminalInputRequest) async throws {
    if let completed: Bool = try await database.storedResult(
      for: request.requestID,
      as: Bool.self
    ), completed {
      return
    }
    guard terminals[request.terminalID] != nil else {
      throw OrchestrationError.invalidState(
        "Terminal \(request.terminalID) was not found."
      )
    }
    await terminalProcesses.send(
      terminalID: request.terminalID,
      data: request.data
    )
    try await database.storeResult(true, for: request.requestID)
  }

  public func resizeTerminal(_ request: TerminalResizeRequest) async throws {
    if let completed: Bool = try await database.storedResult(
      for: request.requestID,
      as: Bool.self
    ), completed {
      return
    }
    guard terminals[request.terminalID] != nil else {
      throw OrchestrationError.invalidState(
        "Terminal \(request.terminalID) was not found."
      )
    }
    await terminalProcesses.resize(
      terminalID: request.terminalID,
      columns: max(20, request.columns),
      rows: max(5, request.rows)
    )
    try await database.storeResult(true, for: request.requestID)
  }

  public func terminalOutput(
    terminalID: String,
    after sequence: Int64
  ) async throws -> TerminalOutputBatch {
    guard var terminal = terminals[terminalID] else {
      throw OrchestrationError.invalidState("Terminal \(terminalID) was not found.")
    }
    guard
      let output = await terminalProcesses.output(
        terminalID: terminalID,
        after: sequence
      )
    else {
      terminal.status = .failed
      terminals[terminal.id] = terminal
      try await database.upsert(terminal)
      return TerminalOutputBatch(
        terminalID: terminalID,
        firstSequence: sequence,
        lastSequence: sequence,
        data: Data(),
        status: .failed,
        exitCode: terminal.exitCode,
        wasTruncated: false
      )
    }
    if terminal.status != output.status || terminal.exitCode != output.exitCode {
      terminal.status = output.status
      terminal.exitCode = output.exitCode
      terminals[terminal.id] = terminal
      try await database.upsert(terminal)
    }
    return output
  }

  public func stopTerminal(_ request: StopTerminalRequest) async throws {
    if let completed: Bool = try await database.storedResult(
      for: request.requestID,
      as: Bool.self
    ), completed {
      return
    }
    guard var terminal = terminals[request.terminalID] else {
      throw OrchestrationError.invalidState(
        "Terminal \(request.terminalID) was not found."
      )
    }
    await terminalProcesses.stop(terminalID: request.terminalID)
    terminal.status = .exited
    terminals[terminal.id] = terminal
    try await database.upsert(terminal)
    try await database.storeResult(true, for: request.requestID)
  }

  public func savePanelLayout(_ request: SavePanelLayoutRequest) async throws {
    if let completed: Bool = try await database.storedResult(
      for: request.requestID,
      as: Bool.self
    ), completed {
      return
    }
    var updated = request.layout
    updated.updatedAt = .now
    layouts[updated.id] = updated
    try await database.upsert(updated)
    try await database.storeResult(true, for: request.requestID)
  }

  public func recoverTask(
    _ request: RecoverTaskRequest
  ) async throws -> OrchestrationTask {
    if let stored: OrchestrationTask = try await database.storedResult(
      for: request.requestID,
      as: OrchestrationTask.self
    ) {
      tasks[stored.id] = stored
      return stored
    }
    guard var task = tasks[request.taskID] else {
      throw OrchestrationError.taskNotFound(request.taskID)
    }
    guard task.status == .failed else {
      throw OrchestrationError.invalidState(
        "Only a failed task can retry or skip setup."
      )
    }
    guard let workspace = workspacesByTask[task.id] else {
      throw OrchestrationError.workspaceNotFound(task.id)
    }
    guard let project = projects[task.projectID] else {
      throw OrchestrationError.projectNotFound(task.projectID)
    }

    for service in services.values where service.taskID == task.id {
      await serviceProcesses.stop(id: service.id)
      if let port = service.port, let value = UInt16(exactly: port) {
        await portAllocator.release(value)
      }
      var stopped = service
      stopped.status = .stopped
      services[stopped.id] = stopped
      try await database.upsert(stopped)
    }

    if request.action == .retrySetup,
      let configuration = workspace.configuration
    {
      try await runHooks(
        configuration.worktree.setup,
        workspace: workspace,
        sourcePath: project.rootPath
      )
    }
    if let configuration = workspace.configuration {
      try await startConfiguredServices(
        configuration,
        taskID: task.id,
        workspace: workspace
      )
    }
    task.workspaceID = workspace.id
    task.status = .running
    task.updatedAt = .now
    tasks[task.id] = task
    try await database.upsert(task)
    try await database.storeResult(task, for: request.requestID)
    let event = try await record(
      taskID: task.id,
      kind: .status,
      payload: .object([
        "status": .string(TaskStatus.running.rawValue),
        "recovery": .string(request.action.rawValue),
      ])
    )
    await eventHub.publish(event)
    return task
  }

  private func reconcileLinkedWorktrees(
    for storedProject: Project,
    linkedWorktrees providedWorktrees: [LinkedGitWorktree]? = nil
  ) async throws {
    let linkedWorktrees: [LinkedGitWorktree]
    if let providedWorktrees {
      linkedWorktrees = providedWorktrees
    } else {
      linkedWorktrees = try await git.linkedWorktrees(
        at: storedProject.rootPath
      )
    }
    guard
      let primary = linkedWorktrees.first(where: {
        !$0.isBare && !$0.isPrunable
      })
    else {
      return
    }

    var project = storedProject
    let primaryPath = normalizedPath(primary.path)
    let hasCanonicalProject = projects.values.contains {
      $0.id != project.id
        && normalizedPath($0.rootPath) == primaryPath
    }
    if normalizedPath(project.rootPath) != primaryPath,
      !hasCanonicalProject
    {
      project.rootPath = primary.path
      project.name = URL(fileURLWithPath: primary.path).lastPathComponent
      let primaryBranch = try await git.currentBranch(at: primary.path)
      if !primaryBranch.isEmpty {
        project.defaultBranch = primaryBranch
      }
      projects[project.id] = project
      try await database.upsert(project)
    }

    let snapshot = try await database.snapshot(projectID: project.id)
    for task in snapshot.tasks {
      tasks[task.id] = task
    }
    for workspace in snapshot.workspaces {
      workspacesByTask[workspace.taskID] = workspace
    }
    let tasksByID = Dictionary(
      uniqueKeysWithValues: snapshot.tasks.map { ($0.id, $0) }
    )
    var existingByPath: [String: Workspace] = [:]
    for workspace in snapshot.workspaces {
      existingByPath[normalizedPath(workspace.path)] = workspace
    }

    for linked in linkedWorktrees
    where !linked.isBare && !linked.isPrunable
      && FileManager.default.fileExists(atPath: linked.path)
    {
      let path = normalizedPath(linked.path)
      let branch =
        linked.branch
        ?? "detached@\(String(linked.head.prefix(8)))"
      if var workspace = existingByPath[path] {
        guard workspace.ownership == .external else { continue }
        workspace.sourcePath = primary.path
        workspace.path = linked.path
        workspace.isolation =
          path == primaryPath ? .currentCheckout : .worktree
        workspace.baseCommit = linked.head
        workspace.branchName = branch
        workspacesByTask[workspace.taskID] = workspace
        try await database.upsert(workspace)

        if var task = tasksByID[workspace.taskID],
          task.status != .archived
        {
          task.branchName = branch
          task.updatedAt = .now
          tasks[task.id] = task
          try await database.upsert(task)
        }
        continue
      }

      var task = OrchestrationTask(
        projectID: project.id,
        title: URL(fileURLWithPath: linked.path).lastPathComponent,
        goal: "Existing Git worktree imported from \(linked.path)",
        baseRef: project.defaultBranch,
        branchName: branch,
        status: .running
      )
      let workspace = Workspace(
        taskID: task.id,
        sourcePath: primary.path,
        path: linked.path,
        isolation: path == primaryPath ? .currentCheckout : .worktree,
        ownership: .external,
        baseCommit: linked.head,
        branchName: branch
      )
      task.workspaceID = workspace.id
      tasks[task.id] = task
      workspacesByTask[task.id] = workspace
      existingByPath[path] = workspace
      try await database.upsert(task)
      try await database.upsert(workspace)
      let event = try await record(
        taskID: task.id,
        kind: .status,
        payload: .object([
          "status": .string(TaskStatus.running.rawValue),
          "source": .string("existingGitWorktree"),
          "path": .string(linked.path),
          "branch": .string(branch),
        ])
      )
      await eventHub.publish(event)
    }
  }

  private nonisolated func normalizedPath(_ path: String) -> String {
    URL(fileURLWithPath: path)
      .standardizedFileURL
      .resolvingSymlinksInPath()
      .path
  }

  private func ingest(_ providerEvent: ProviderEvent, agentID: String, taskID: String) async {
    do {
      let event = try await record(
        taskID: taskID,
        agentID: agentID,
        kind: providerEvent.kind,
        payload: providerEvent.payload,
        raw: providerEvent.raw,
        timestamp: providerEvent.timestamp
      )
      if providerEvent.kind == .inputRequested {
        let providerRequestID =
          providerEvent.payload["inputRequestID"]?.stringValue
          ?? OrchestratorID.make("provider_input")
        let questions =
          (try? providerEvent.payload["questions"]?.decode(
            [AgentInputQuestion].self
          )) ?? []
        let input = AgentInputRequest(
          taskID: taskID,
          agentID: agentID,
          providerRequestID: providerRequestID,
          title: providerEvent.payload["title"]?.stringValue
            ?? "Agent needs input",
          questions: questions,
          details: providerEvent.payload
        )
        inputRequests[input.id] = input
        try await database.upsert(input)
        if var agent = agents[agentID] {
          agent.status = .waitingForInput
          agent.updatedAt = .now
          agents[agentID] = agent
          try await database.upsert(agent)
        }
        if var task = tasks[taskID] {
          task.status = .needsAttention
          task.updatedAt = .now
          tasks[task.id] = task
          try await database.upsert(task)
        }
      } else if providerEvent.kind == .inputResolved,
        let providerRequestID =
          providerEvent.payload["inputRequestID"]?.stringValue,
        var input = inputRequests.values.first(where: {
          $0.providerRequestID == providerRequestID && $0.status == .pending
        })
      {
        let resolution =
          providerEvent.payload["resolution"]?.stringValue ?? "submitted"
        input.status = resolution == "submitted" ? .submitted : .cancelled
        input.resolvedAt = .now
        inputRequests[input.id] = input
        try await database.upsert(input)
        if var agent = agents[agentID],
          agent.status == .waitingForInput
        {
          agent.status = .running
          agent.updatedAt = .now
          agents[agentID] = agent
          try await database.upsert(agent)
        }
        if var task = tasks[taskID], task.status == .needsAttention,
          !hasPendingAttention(taskID: taskID)
        {
          task.status = .running
          task.updatedAt = .now
          tasks[task.id] = task
          try await database.upsert(task)
        }
      } else if providerEvent.kind == .approvalRequested {
        let requestID =
          providerEvent.payload["approvalID"]?.stringValue
          ?? OrchestratorID.make("provider_request")
        let kind =
          ApprovalKind(
            rawValue: providerEvent.payload["kind"]?.stringValue ?? ""
          ) ?? .providerSpecific
        let approval = Approval(
          taskID: taskID,
          agentID: agentID,
          providerRequestID: requestID,
          kind: kind,
          title: providerEvent.payload["title"]?.stringValue ?? "Approval requested",
          summary: providerEvent.payload["summary"]?.stringValue ?? "",
          details: providerEvent.payload
        )
        approvals[approval.id] = approval
        try await database.upsert(approval)
        if var agent = agents[agentID] {
          agent.status = .waitingForApproval
          agent.updatedAt = .now
          agents[agentID] = agent
          try await database.upsert(agent)
        }
        if var task = tasks[taskID] {
          task.status = .needsAttention
          task.updatedAt = .now
          tasks[task.id] = task
          try await database.upsert(task)
        }
      } else if providerEvent.kind == .status,
        let status = providerEvent.payload["status"]?.stringValue,
        let mapped = AgentStatus(rawValue: status),
        var agent = agents[agentID]
      {
        agent.status = mapped
        agent.updatedAt = .now
        agents[agentID] = agent
        try await database.upsert(agent)
        if var task = tasks[taskID] {
          if mapped == .failed {
            task.status = .failed
          } else if mapped == .completed {
            let hasLiveAgent = agents.values.contains {
              $0.taskID == taskID && $0.id != agentID
                && [
                  .launching, .running, .waitingForApproval,
                  .waitingForInput, .idle,
                ].contains($0.status)
            }
            if !hasLiveAgent {
              task.status = .reviewReady
            }
          } else if mapped == .running {
            task.status = .running
          }
          task.updatedAt = .now
          tasks[task.id] = task
          try await database.upsert(task)
        }
      }
      await eventHub.publish(event)
    } catch {
      // A persistence failure is surfaced as a local error event on the next snapshot.
    }
  }

  private func hasPendingAttention(taskID: String) -> Bool {
    approvals.values.contains {
      $0.taskID == taskID && $0.status == .pending
    }
      || inputRequests.values.contains {
        $0.taskID == taskID && $0.status == .pending
      }
  }

  private func record(
    taskID: String,
    agentID: String? = nil,
    kind: AgentEventKind,
    payload: JSONValue,
    raw: JSONValue? = nil,
    timestamp: Date = .now
  ) async throws -> AgentEvent {
    try await database.append(
      AgentEvent(
        taskID: taskID,
        agentID: agentID,
        kind: kind,
        payload: payload,
        rawProviderPayload: raw,
        timestamp: timestamp
      )
    )
  }

  private func restore(agent storedAgent: AgentSession) async {
    var agent = storedAgent
    guard let task = tasks[agent.taskID],
      task.status != .archived,
      task.status != .shipped,
      let workspace = workspacesByTask[agent.taskID],
      let provider = providers[agent.providerID],
      provider.descriptor.capabilities.contains(.resume),
      let previousSessionID = agent.providerSessionID
    else {
      await markAgentDisconnected(
        agent,
        message: "The provider session cannot be resumed after helper restart."
      )
      return
    }

    do {
      let delegation = try makeDelegationConfiguration(
        projectID: task.projectID,
        taskID: task.id,
        parentAgentID: agent.id
      )
      let session = try await provider.start(
        ProviderLaunchRequest(
          agentID: agent.id,
          taskID: task.id,
          workingDirectory: workspace.path,
          prompt: "",
          model: agent.model,
          mode: agent.mode,
          resumeSessionID: previousSessionID,
          environment: delegation.environment,
          mcpConfigurationPath: delegation.configurationPath
        )
      )
      providerSessionByAgent[agent.id] = session
      agent.providerSessionID = session.id
      agent.status = .running
      agent.updatedAt = .now
      agents[agent.id] = agent
      try await database.upsert(agent)

      if var restoredTask = tasks[task.id],
        restoredTask.status != .archived,
        restoredTask.status != .shipped
      {
        restoredTask.status = .running
        restoredTask.updatedAt = .now
        tasks[restoredTask.id] = restoredTask
        try await database.upsert(restoredTask)
      }
      let event = try await record(
        taskID: task.id,
        agentID: agent.id,
        kind: .status,
        payload: .object([
          "status": .string(AgentStatus.running.rawValue),
          "restored": .bool(true),
        ])
      )
      await eventHub.publish(event)

      let stream = await provider.events(sessionID: session.id)
      let agentID = agent.id
      let taskID = task.id
      providerEventTasks[agentID] = Task { @Sendable [weak self] in
        for await providerEvent in stream {
          guard !Task.isCancelled else { break }
          await self?.ingest(
            providerEvent,
            agentID: agentID,
            taskID: taskID
          )
        }
      }
    } catch {
      revokeDelegation(for: agent.id)
      await markAgentDisconnected(agent, message: error.localizedDescription)
    }
  }

  private func markAgentDisconnected(
    _ storedAgent: AgentSession,
    message: String
  ) async {
    var agent = storedAgent
    agent.status = .disconnected
    agent.updatedAt = .now
    agents[agent.id] = agent
    try? await database.upsert(agent)
    if var task = tasks[agent.taskID],
      task.status != .archived,
      task.status != .shipped
    {
      task.status = .needsAttention
      task.updatedAt = .now
      tasks[task.id] = task
      try? await database.upsert(task)
    }
    if let event = try? await record(
      taskID: agent.taskID,
      agentID: agent.id,
      kind: .error,
      payload: .object([
        "message": .string(message),
        "recovery": .string("providerResumeFailed"),
      ])
    ) {
      await eventHub.publish(event)
    }
  }

  private func restore(service storedService: ManagedService) async {
    var service = storedService
    guard let workspace = workspacesByTask[service.taskID],
      tasks[service.taskID]?.status != .archived
    else {
      service.status = .stopped
      services[service.id] = service
      try? await database.upsert(service)
      return
    }
    if let processIdentifier = service.processIdentifier,
      Self.isProcessAlive(processIdentifier)
    {
      service.status = .orphaned
      services[service.id] = service
      try? await database.upsert(service)
      return
    }
    guard let portValue = service.port,
      let port = UInt16(exactly: portValue)
    else {
      service.status = .failed
      services[service.id] = service
      try? await database.upsert(service)
      return
    }
    do {
      try await portAllocator.reserve(port)
      service.processIdentifier = try await serviceProcesses.start(
        id: service.id,
        command: service.command,
        workingDirectory: workspace.path,
        environment: [
          "PORT": String(port),
          "ORCHESTRATOR_PORT": String(port),
          "ORCHESTRATOR_WORKTREE_PATH": workspace.path,
        ]
      )
      service.status = .running
      services[service.id] = service
      try await database.upsert(service)
    } catch {
      await portAllocator.release(port)
      service.status = .failed
      services[service.id] = service
      try? await database.upsert(service)
    }
  }

  private static func isProcessAlive(_ processIdentifier: Int32) -> Bool {
    guard processIdentifier > 1 else { return false }
    if kill(processIdentifier, 0) == 0 {
      return true
    }
    return errno == EPERM
  }

  private func runHooks(
    _ commands: [String],
    workspace: Workspace,
    sourcePath: String
  ) async throws {
    guard !commands.isEmpty else { return }
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    for command in commands {
      _ = try await runner.run(
        CommandSpec(
          executable: shell,
          arguments: ["-lc", command],
          workingDirectory: workspace.path,
          environment: [
            "ORCHESTRATOR_SOURCE_PATH": sourcePath,
            "ORCHESTRATOR_WORKTREE_PATH": workspace.path,
          ]
        )
      )
    }
  }

  private func createDelegatedAgent(
    params: JSONValue,
    token: String,
    scope: DelegationScope
  ) async throws -> JSONValue {
    guard let title = params["title"]?.stringValue,
      let prompt = params["prompt"]?.stringValue,
      let providerID = params["providerID"]?.stringValue
    else {
      throw CoreServiceFailure(
        code: "invalid_arguments",
        message: "agents.create requires title, prompt, and providerID."
      )
    }
    guard let task = tasks[scope.taskID],
      task.projectID == scope.projectID
    else {
      throw CoreServiceFailure(
        code: "scope_expired",
        message: "The task for this capability is no longer available."
      )
    }

    var authorized = task.childLaunchPolicy == .allowForTask
    if approvedSingleChildTokens.remove(token) != nil {
      authorized = true
    }
    if task.childLaunchPolicy == .deny {
      throw OrchestrationError.childLaunchDenied
    }
    if !authorized {
      if let pending = pendingChildApprovalTokens.first(where: {
        $0.value == token
      })?.key {
        return .object([
          "status": .string("approval_required"),
          "approvalID": .string(pending),
        ])
      }
      let approval = Approval(
        taskID: task.id,
        agentID: scope.parentAgentID,
        kind: .childAgent,
        title: "Launch child agent?",
        summary: "\(title) · \(providerID)",
        details: .object([
          "title": .string(title),
          "providerID": .string(providerID),
          "promptPreview": .string(String(prompt.prefix(240))),
        ])
      )
      approvals[approval.id] = approval
      pendingChildApprovalTokens[approval.id] = token
      try await database.upsert(approval)
      let event = try await record(
        taskID: task.id,
        agentID: scope.parentAgentID,
        kind: .approvalRequested,
        payload: .object([
          "approvalID": .string(approval.id),
          "kind": .string(ApprovalKind.childAgent.rawValue),
          "title": .string(approval.title),
          "summary": .string(approval.summary),
        ])
      )
      await eventHub.publish(event)
      return .object([
        "status": .string("approval_required"),
        "approvalID": .string(approval.id),
      ])
    }

    let agent = try await launchAgent(
      LaunchAgentRequest(
        taskID: task.id,
        parentAgentID: scope.parentAgentID,
        title: title,
        providerID: providerID,
        prompt: prompt,
        model: params["model"]?.stringValue,
        mode: params["mode"]?.stringValue
      ),
      initiatedByAgent: true,
      childLaunchAuthorized: authorized
    )
    return try JSONValue.encode(agent)
  }

  private func requestDelegatedPermission(
    params: JSONValue,
    scope: DelegationScope
  ) async throws -> JSONValue {
    let toolName =
      params["tool_name"]?.stringValue
      ?? params["toolName"]?.stringValue
      ?? "Claude tool"
    let input = params["input"] ?? .object([:])
    let kind: ApprovalKind
    if toolName.localizedCaseInsensitiveContains("bash") {
      kind = .command
    } else if toolName.localizedCaseInsensitiveContains("edit")
      || toolName.localizedCaseInsensitiveContains("write")
    {
      kind = .fileChange
    } else {
      kind = .permissions
    }
    let summary =
      input["command"]?.stringValue
      ?? input["file_path"]?.stringValue
      ?? input["path"]?.stringValue
      ?? toolName
    let approval = Approval(
      taskID: scope.taskID,
      agentID: scope.parentAgentID,
      kind: kind,
      title: "\(toolName) needs permission",
      summary: summary,
      details: .object([
        "toolName": .string(toolName),
        "input": input,
      ])
    )
    approvals[approval.id] = approval
    try await database.upsert(approval)
    if var agent = agents[scope.parentAgentID] {
      agent.status = .waitingForApproval
      agent.updatedAt = .now
      agents[agent.id] = agent
      try await database.upsert(agent)
    }
    let event = try await record(
      taskID: scope.taskID,
      agentID: scope.parentAgentID,
      kind: .approvalRequested,
      payload: .object([
        "approvalID": .string(approval.id),
        "kind": .string(kind.rawValue),
        "title": .string(approval.title),
        "summary": .string(approval.summary),
      ])
    )
    await eventHub.publish(event)

    let decision = await withCheckedContinuation {
      (continuation: CheckedContinuation<ApprovalDecision, Never>) in
      permissionWaiters[approval.id] = continuation
    }
    switch decision {
    case .allowOnce, .allowForSession:
      return .object([
        "behavior": .string("allow"),
        "updatedInput": input,
      ])
    case .deny, .cancel:
      return .object([
        "behavior": .string("deny"),
        "message": .string("Permission denied in Orchestrator."),
      ])
    }
  }

  private func canAccess(agentID: String, from scope: DelegationScope) -> Bool {
    agentID == scope.parentAgentID || isDescendant(agentID, of: scope.parentAgentID)
  }

  private func isDescendant(_ candidateID: String, of ancestorID: String) -> Bool {
    var current = agents[candidateID]?.parentID
    while let id = current {
      if id == ancestorID { return true }
      current = agents[id]?.parentID
    }
    return false
  }

  private func makeDelegationConfiguration(
    projectID: String,
    taskID: String,
    parentAgentID: String
  ) throws -> (configurationPath: String, environment: [String: String]) {
    let token = (UUID().uuidString + UUID().uuidString)
      .replacingOccurrences(of: "-", with: "")
      .lowercased()
    let scope = DelegationScope(
      projectID: projectID,
      taskID: taskID,
      parentAgentID: parentAgentID
    )
    delegationScopes[token] = scope
    delegationTokenByAgent[parentAgentID] = token

    let executableDirectory = URL(
      fileURLWithPath: CommandLine.arguments[0]
    )
    .resolvingSymlinksInPath()
    .deletingLastPathComponent()
    let bridgeCandidates = [
      executableDirectory.appending(path: "OrchestratorBridge"),
      executableDirectory
        .deletingLastPathComponent()
        .appending(path: "Helpers")
        .appending(path: "OrchestratorBridge"),
    ]
    let bridgePath =
      bridgeCandidates.first {
        FileManager.default.isExecutableFile(atPath: $0.path)
      }?.path ?? bridgeCandidates[0].path
    let environment: [String: String] = [
      "ORCHESTRATOR_PROJECT_ID": projectID,
      "ORCHESTRATOR_TASK_ID": taskID,
      "ORCHESTRATOR_PARENT_AGENT_ID": parentAgentID,
      "ORCHESTRATOR_DELEGATION_TOKEN": token,
    ]
    let environmentJSON = environment.mapValues(JSONValue.string)
    let server: JSONValue = .object([
      "command": .string(bridgePath),
      "args": .array([]),
      "env": .object(environmentJSON),
    ])
    let acpEnvironment: JSONValue = .array(
      environment.sorted { $0.key < $1.key }.map {
        .object([
          "name": .string($0.key),
          "value": .string($0.value),
        ])
      }
    )
    let configuration: JSONValue = .object([
      "mcpServers": .object(["orchestrator": server]),
      "codex": .object([
        "mcp_servers": .object(["orchestrator": server])
      ]),
      "acp": .array([
        .object([
          "name": .string("orchestrator"),
          "command": .string(bridgePath),
          "args": .array([]),
          "env": acpEnvironment,
        ])
      ]),
    ])
    let directory = URL(fileURLWithPath: worktreesRoot)
      .deletingLastPathComponent()
      .appending(path: "BridgeConfigurations")
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let url = directory.appending(path: "\(parentAgentID).json")
    let data = try JSONEncoder.orchestrator.encode(configuration)
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: url.path
    )
    return (url.path, environment)
  }

  private func revokeDelegation(for agentID: String) {
    guard let token = delegationTokenByAgent.removeValue(forKey: agentID) else {
      return
    }
    delegationScopes.removeValue(forKey: token)
    approvedSingleChildTokens.remove(token)
    let configuration = URL(fileURLWithPath: worktreesRoot)
      .deletingLastPathComponent()
      .appending(path: "BridgeConfigurations")
      .appending(path: "\(agentID).json")
    try? FileManager.default.removeItem(at: configuration)
  }

  private func startConfiguredServices(
    _ configuration: ProjectConfiguration,
    taskID: String,
    workspace: Workspace
  ) async throws {
    for (name, script) in configuration.scripts.sorted(by: { $0.key < $1.key })
    where script.kind == .service {
      let port: UInt16
      switch script.port {
      case .automatic:
        port = try await portAllocator.reserve()
      case .fixed(let value):
        guard let fixed = UInt16(exactly: value) else {
          throw ProjectConfigurationError.invalidPort(value)
        }
        try await portAllocator.reserve(fixed)
        port = fixed
      case nil:
        throw ProjectConfigurationError.invalidService(name)
      }

      let previewURL = script.url?
        .replacingOccurrences(of: "${PORT}", with: String(port))
      var service = ManagedService(
        taskID: taskID,
        name: name,
        command: script.command,
        port: Int(port),
        previewURL: previewURL
      )
      do {
        service.processIdentifier = try await serviceProcesses.start(
          id: service.id,
          command: script.command,
          workingDirectory: workspace.path,
          environment: [
            "PORT": String(port),
            "ORCHESTRATOR_PORT": String(port),
            "ORCHESTRATOR_WORKTREE_PATH": workspace.path,
          ]
        )
        service.status = .running
        services[service.id] = service
        try await database.upsert(service)
      } catch {
        await portAllocator.release(port)
        service.status = .failed
        services[service.id] = service
        try await database.upsert(service)
        throw error
      }
    }
  }
}
