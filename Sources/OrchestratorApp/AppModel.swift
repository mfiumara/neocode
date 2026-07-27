import AppKit
import Foundation
import Observation
import OrchestratorCore
import ProviderKit
import ServiceManagement
import UniformTypeIdentifiers
import UserNotifications

@MainActor
@Observable
final class AppModel {
  private(set) var isBootstrapped = false
  private(set) var isBootstrapping = false
  private(set) var projects: [Project] = []
  private(set) var snapshots: [String: CoreSnapshot] = [:]
  private(set) var eventsByTask: [String: [AgentEvent]] = [:]
  private(set) var diffsByTask: [String: GitDiff] = [:]
  private(set) var providerInspections: [ProviderInspection] = []
  private(set) var installationOutput = ""
  private(set) var backgroundServiceStatus = "Not registered"
  var activeProjectID: String?
  var selectedTaskByProject: [String: String] = [:]
  var isInspectorPresented = false
  var alertMessage: String?
  var pendingTrustRequirement: ConfigurationTrustRequirement?
  var pendingInstallProvider: ProviderInspection?
  var pendingDirtyArchiveTaskID: String?

  private var backend: BackendRouter?
  private var pendingCreateTask: CreateTaskRequest?
  private var liveEventTask: Task<Void, Never>?
  private var lastEventSequence: Int64 = 0
  private var knownEventIDs = Set<String>()
  private var usesBackgroundService = false

  func bootstrapIfNeeded() async {
    if isBootstrapped { return }
    if isBootstrapping {
      // Multiple restored windows can appear together at launch. A project
      // window must wait for the launcher-owned bootstrap instead of racing
      // ahead with a nil backend and remaining empty until manual refresh.
      while isBootstrapping && !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(20))
      }
      if !isBootstrapped && !Task.isCancelled {
        await bootstrapIfNeeded()
      }
      return
    }
    isBootstrapping = true
    defer { isBootstrapping = false }
    do {
      let selectedBackend: BackendRouter
      let serviceClient = OrchestratorServiceClient()
      do {
        let info = try await serviceClient.connect()
        selectedBackend = BackendRouter(service: serviceClient)
        usesBackgroundService = true
        backgroundServiceStatus = "Connected · PID \(info.processIdentifier)"
      } catch {
        usesBackgroundService = false
        let support = try applicationSupportDirectory()
        let databaseURL = support.appending(path: "orchestrator.sqlite")
        let worktreesURL = support.appending(path: "Worktrees")
        try FileManager.default.createDirectory(
          at: worktreesURL,
          withIntermediateDirectories: true,
          attributes: [.posixPermissions: 0o700]
        )
        let database = try AppDatabase(path: databaseURL.path)
        let coordinator = OrchestrationCoordinator(
          database: database,
          worktreesRoot: worktreesURL.path
        )
        for provider in ProviderCatalog.makeDefaultAdapters(
          includeDemo: Self.includesDemoProvider
        ) {
          await coordinator.register(provider: provider)
        }
        let registry = ACPRegistryClient(
          cacheURL:
            support
            .appending(path: "ACPRegistry")
            .appending(path: "registry.json")
        )
        if let cached = try? await registry.cachedProviders() {
          for provider in ProviderCatalog.makeACPAdapters(from: cached) {
            await coordinator.register(provider: provider)
          }
        }
        try await coordinator.restorePersistentState()
        selectedBackend = BackendRouter(
          local: coordinator,
          registry: registry
        )
        updateBackgroundServiceStatus()
      }
      backend = selectedBackend
      projects = try await selectedBackend.allProjects()
      providerInspections = await selectedBackend.providerInspections()
      startEventStream(selectedBackend)
      requestNotificationAuthorization()
      isBootstrapped = true
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func chooseAndOpenProject() async -> Project? {
    await bootstrapIfNeeded()
    let panel = NSOpenPanel()
    panel.title = "Open a Git repository"
    panel.prompt = "Open Repository"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    guard panel.runModal() == .OK, let url = panel.url else { return nil }
    return await openProject(path: url.path)
  }

  func openProject(path: String) async -> Project? {
    guard let backend else { return nil }
    do {
      let project = try await backend.openProject(OpenProjectRequest(path: path))
      if let index = projects.firstIndex(where: { $0.id == project.id }) {
        projects[index] = project
      } else {
        projects.insert(project, at: 0)
      }
      activeProjectID = project.id
      await refresh(projectID: project.id)
      return project
    } catch {
      alertMessage = error.localizedDescription
      return nil
    }
  }

  func refresh(projectID: String) async {
    guard let backend else { return }
    do {
      let snapshot = try await backend.snapshot(projectID: projectID)
      snapshots[projectID] = snapshot
      if let project = snapshot.project,
        let index = projects.firstIndex(where: { $0.id == project.id })
      {
        projects[index] = project
      }
      activeProjectID = projectID
      let visibleTasks = snapshot.tasks.filter { $0.status != .archived }
      if let selected = selectedTaskByProject[projectID],
        !visibleTasks.contains(where: { $0.id == selected })
      {
        selectedTaskByProject[projectID] = visibleTasks.first?.id
      } else if selectedTaskByProject[projectID] == nil {
        selectedTaskByProject[projectID] = visibleTasks.first?.id
      }
      for task in snapshot.tasks {
        let events = try await backend.events(
          after: 0,
          taskID: task.id
        )
        eventsByTask[task.id] = events
        knownEventIDs.formUnion(events.map(\.id))
        lastEventSequence = max(
          lastEventSequence,
          events.last?.sequence ?? 0
        )
      }
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func createTask(
    _ request: CreateTaskRequest
  ) async -> OrchestrationTask? {
    guard let backend else { return nil }
    do {
      let task = try await backend.createTask(request)
      pendingCreateTask = nil
      pendingTrustRequirement = nil
      selectedTaskByProject[request.projectID] = task.id
      await refresh(projectID: request.projectID)
      return task
    } catch let error as OrchestrationError {
      if case .configurationTrustRequired(let requirement) = error {
        pendingCreateTask = request
        pendingTrustRequirement = requirement
      } else {
        alertMessage = error.localizedDescription
        await refresh(projectID: request.projectID)
      }
      return nil
    } catch {
      alertMessage = error.localizedDescription
      await refresh(projectID: request.projectID)
      return nil
    }
  }

  func trustConfigurationAndCreateTask() async -> OrchestrationTask? {
    guard var request = pendingCreateTask,
      let requirement = pendingTrustRequirement
    else { return nil }
    request.trustConfigurationHash = requirement.hash
    return await createTask(request)
  }

  func cancelConfigurationTrust() {
    pendingCreateTask = nil
    pendingTrustRequirement = nil
  }

  func launchAgent(
    taskID: String,
    title: String,
    providerID: String,
    prompt: String,
    model: String?,
    mode: String?,
    parentID: String? = nil
  ) async {
    guard let backend else { return }
    do {
      _ = try await backend.launchAgent(
        LaunchAgentRequest(
          taskID: taskID,
          parentAgentID: parentID,
          title: title,
          providerID: providerID,
          prompt: prompt,
          model: model,
          mode: mode
        )
      )
      if let projectID = projectID(containing: taskID) {
        await refresh(projectID: projectID)
      }
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func sendMessage(agentID: String, text: String, steer: Bool) async {
    guard let backend else { return }
    do {
      try await backend.send(
        SendAgentMessageRequest(
          agentID: agentID,
          text: text,
          steerActiveTurn: steer
        )
      )
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func interrupt(agentID: String) async {
    guard let backend else { return }
    do {
      try await backend.interrupt(agentID: agentID)
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func resolveApproval(id: String, decision: ApprovalDecision) async {
    guard let backend else { return }
    do {
      try await backend.resolveApproval(
        ResolveApprovalRequest(approvalID: id, decision: decision)
      )
      if let projectID = projectID(containingApproval: id) {
        await refresh(projectID: projectID)
      }
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func respondToInput(
    id: String,
    answers: [String: [String]],
    cancelled: Bool = false
  ) async {
    guard let backend else { return }
    do {
      try await backend.respondToInput(
        RespondToInputRequest(
          inputRequestID: id,
          answers: answers,
          cancelled: cancelled
        )
      )
      if let projectID = projectID(containingInput: id) {
        await refresh(projectID: projectID)
      }
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func loadDiff(taskID: String) async {
    guard let backend else { return }
    do {
      diffsByTask[taskID] = try await backend.diff(taskID: taskID)
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func createPullRequest(
    taskID: String,
    title: String,
    body: String,
    files: [String],
    commitMessage: String
  ) async {
    guard let backend else { return }
    do {
      _ = try await backend.createPullRequest(
        CreatePullRequestRequest(
          taskID: taskID,
          title: title,
          body: body,
          stageFiles: files,
          commitMessage: commitMessage
        )
      )
      if let projectID = projectID(containing: taskID) {
        await refresh(projectID: projectID)
      }
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func archiveTask(taskID: String, force: Bool = false) async {
    guard let backend else { return }
    do {
      try await backend.archiveTask(
        ArchiveTaskRequest(taskID: taskID, forceDirtyWorktree: force)
      )
      if let projectID = projectID(containing: taskID) {
        selectedTaskByProject[projectID] = nil
        await refresh(projectID: projectID)
      }
    } catch let error as GitServiceError {
      if case .dirtyWorktree = error {
        pendingDirtyArchiveTaskID = taskID
      } else {
        alertMessage = error.localizedDescription
      }
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func confirmDirtyArchive() async {
    guard let taskID = pendingDirtyArchiveTaskID else { return }
    pendingDirtyArchiveTaskID = nil
    await archiveTask(taskID: taskID, force: true)
  }

  func startTerminal(
    projectID: String,
    taskID: String,
    preferExisting: Bool
  ) async -> TerminalSession? {
    guard let backend else { return nil }
    if preferExisting,
      let existing = snapshot(for: projectID).terminals.last(where: {
        $0.taskID == taskID
          && $0.title == "Shell"
          && $0.status == .running
      })
    {
      return existing
    }
    do {
      let terminal = try await backend.startTerminal(
        StartTerminalRequest(taskID: taskID)
      )
      await refresh(projectID: projectID)
      return terminal
    } catch {
      alertMessage = error.localizedDescription
      return nil
    }
  }

  func sendTerminalInput(terminalID: String, data: Data) async {
    guard let backend else { return }
    do {
      try await backend.sendTerminalInput(
        terminalID: terminalID,
        data: data
      )
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func resizeTerminal(terminalID: String, columns: Int, rows: Int) async {
    guard let backend else { return }
    do {
      try await backend.resizeTerminal(
        TerminalResizeRequest(
          terminalID: terminalID,
          columns: columns,
          rows: rows
        )
      )
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func terminalOutput(
    terminalID: String,
    after sequence: Int64
  ) async -> TerminalOutputBatch? {
    guard let backend else { return nil }
    return try? await backend.terminalOutput(
      terminalID: terminalID,
      after: sequence
    )
  }

  func stopTerminal(terminalID: String) async {
    guard let backend else { return }
    do {
      try await backend.stopTerminal(terminalID: terminalID)
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func savePanelLayout(
    projectID: String,
    taskID: String,
    primary: PanelKind,
    secondary: PanelKind?
  ) async {
    guard let backend else { return }
    let existing = snapshot(for: projectID).layouts.first {
      $0.taskID == taskID
    }
    let layout = PanelLayout(
      id: existing?.id ?? OrchestratorID.make("layout"),
      projectID: projectID,
      taskID: taskID,
      selectedPanel: primary,
      layout: .object([
        "secondary": secondary.map { .string($0.rawValue) } ?? .null
      ])
    )
    do {
      try await backend.savePanelLayout(layout)
      var snapshot = snapshot(for: projectID)
      if let index = snapshot.layouts.firstIndex(where: { $0.id == layout.id }) {
        snapshot.layouts[index] = layout
      } else {
        snapshot.layouts.append(layout)
      }
      snapshots[projectID] = snapshot
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func savePanelLayout(
    projectID: String,
    taskID: String,
    workspaceLayout: WorkspaceLayoutV2
  ) async {
    guard let backend else { return }
    let existing = snapshot(for: projectID).layouts.first {
      $0.taskID == taskID
    }
    do {
      let encodedLayout = try JSONValue.encode(workspaceLayout)
      let layout = PanelLayout(
        id: existing?.id ?? OrchestratorID.make("layout"),
        projectID: projectID,
        taskID: taskID,
        selectedPanel: workspaceLayout.selectedTarget?.panelKind ?? .agent,
        layout: encodedLayout
      )
      try await backend.savePanelLayout(layout)
      var snapshot = snapshot(for: projectID)
      if let index = snapshot.layouts.firstIndex(where: { $0.id == layout.id }) {
        snapshot.layouts[index] = layout
      } else {
        snapshot.layouts.append(layout)
      }
      snapshots[projectID] = snapshot
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func recoverTask(
    projectID: String,
    taskID: String,
    action: TaskRecoveryAction
  ) async {
    guard let backend else { return }
    do {
      _ = try await backend.recoverTask(
        RecoverTaskRequest(taskID: taskID, action: action)
      )
      await refresh(projectID: projectID)
    } catch {
      alertMessage = error.localizedDescription
      await refresh(projectID: projectID)
    }
  }

  func runGuidedInstall(_ inspection: ProviderInspection) async {
    guard let command = inspection.descriptor.installationCommand else { return }
    installationOutput = "Running: \(command)\n"
    do {
      let result = try await ProcessRunner().run(
        CommandSpec(
          executable: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
          arguments: ["-lc", command]
        )
      )
      installationOutput += result.standardOutput
      providerInspections = await backend?.providerInspections() ?? []
    } catch {
      installationOutput += "\n\(error.localizedDescription)"
    }
  }

  func refreshProviders() async {
    guard let backend else { return }
    providerInspections = await backend.providerInspections()
  }

  func refreshACPRegistry() async {
    guard let backend else { return }
    installationOutput = "Refreshing the official ACP Registry…\n"
    do {
      providerInspections = try await backend.refreshACPRegistry()
      let registryCount = providerInspections.filter {
        $0.descriptor.id != "codex" && $0.descriptor.id != "claude" && $0.descriptor.id != "fake"
      }.count
      installationOutput += "Loaded \(registryCount) ACP providers. " + "Nothing was installed."
    } catch {
      installationOutput += error.localizedDescription
    }
  }

  func registerBackgroundService() {
    do {
      let service = SMAppService.agent(
        plistName: "com.mattiafiumara.Orchestrator.service.plist"
      )
      try service.register()
      updateBackgroundServiceStatus()
      alertMessage =
        "The background helper is registered. Quit and reopen Orchestrator "
        + "before starting persistent work."
    } catch {
      alertMessage = error.localizedDescription
      updateBackgroundServiceStatus()
    }
  }

  func openProjectInEditor(_ project: Project) {
    NSWorkspace.shared.open(URL(fileURLWithPath: project.rootPath))
  }

  func reveal(_ path: String) {
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }

  func openFile(at path: String, line: Int) {
    let preference =
      UserDefaults.standard.string(forKey: "externalEditor")
      .flatMap(ExternalEditor.init(rawValue:)) ?? .system
    guard let executableName = preference.executableName,
      let executable = BinaryLocator.locate(executableName)
    else {
      NSWorkspace.shared.open(URL(fileURLWithPath: path))
      return
    }
    let location = "\(path):\(max(1, line))"
    let arguments = preference == .zed ? [location] : ["--goto", location]
    Task {
      do {
        _ = try await ProcessRunner().run(
          CommandSpec(executable: executable, arguments: arguments)
        )
      } catch {
        alertMessage = error.localizedDescription
      }
    }
  }

  func exportDiagnostics() {
    let panel = NSSavePanel()
    panel.title = "Export Orchestrator Diagnostics"
    panel.nameFieldStringValue = "orchestrator-diagnostics.json"
    panel.allowedContentTypes = [.json]
    guard panel.runModal() == .OK, let url = panel.url else { return }
    do {
      let bundle = DiagnosticsExporter.make(
        projects: projects,
        snapshots: snapshots,
        events: eventsByTask,
        providers: providerInspections,
        backgroundServiceStatus: backgroundServiceStatus
      )
      let encoder = JSONEncoder.orchestrator
      encoder.outputFormatting = [
        .prettyPrinted, .sortedKeys, .withoutEscapingSlashes,
      ]
      try encoder.encode(bundle).write(to: url, options: .atomic)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o600],
        ofItemAtPath: url.path
      )
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func project(_ id: String) -> Project? {
    projects.first { $0.id == id }
  }

  func snapshot(for projectID: String) -> CoreSnapshot {
    snapshots[projectID] ?? CoreSnapshot()
  }

  func selectedTask(for projectID: String) -> OrchestrationTask? {
    let snapshot = snapshot(for: projectID)
    guard let id = selectedTaskByProject[projectID] else { return nil }
    return snapshot.tasks.first { $0.id == id }
  }

  func agents(for taskID: String) -> [AgentSession] {
    snapshots.values.flatMap(\.agents).filter { $0.taskID == taskID }
  }

  func pendingApprovals(for projectID: String) -> [Approval] {
    snapshot(for: projectID).approvals.filter { $0.status == .pending }
  }

  func pendingInputRequests(for projectID: String) -> [AgentInputRequest] {
    snapshot(for: projectID).inputRequests.filter { $0.status == .pending }
  }

  func attentionCount(for projectID: String) -> Int {
    let snapshot = snapshot(for: projectID)
    let setupFailures = snapshot.tasks.filter { task in
      task.status == .failed
        && !snapshot.agents.contains(where: { $0.taskID == task.id })
    }.count
    let agentFailures = snapshot.agents.filter {
      $0.status == .failed || $0.status == .disconnected
    }.count
    let serviceFailures = snapshot.services.filter {
      $0.status == .failed || $0.status == .orphaned
    }.count
    return pendingApprovals(for: projectID).count
      + pendingInputRequests(for: projectID).count
      + setupFailures
      + agentFailures
      + serviceFailures
  }

  #if DEBUG
    func installDebugGalleryFixture(
      project: Project,
      snapshot: CoreSnapshot,
      events: [String: [AgentEvent]],
      diffs: [String: GitDiff],
      providers: [ProviderInspection]
    ) {
      isBootstrapped = true
      isBootstrapping = false
      projects = [project]
      snapshots = [project.id: snapshot]
      eventsByTask = events
      diffsByTask = diffs
      providerInspections = providers
      backgroundServiceStatus = "Gallery fixture · helper connected"
      activeProjectID = project.id
      selectedTaskByProject[project.id] = snapshot.tasks.first?.id
      knownEventIDs = Set(events.values.flatMap { $0.map(\.id) })
      lastEventSequence = events.values
        .flatMap { $0 }
        .map(\.sequence)
        .max() ?? 0
    }
  #endif

  private func applicationSupportDirectory() throws -> URL {
    guard
      let base = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first
    else {
      throw OrchestrationError.invalidState("Application Support is unavailable.")
    }
    let directory = base.appending(path: "Orchestrator")
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: directory.path
    )
    return directory
  }

  private static var includesDemoProvider: Bool {
    #if DEBUG
      true
    #else
      false
    #endif
  }

  private func startEventStream(_ backend: BackendRouter) {
    liveEventTask?.cancel()
    liveEventTask = Task { [weak self] in
      while !Task.isCancelled {
        let sequence = self?.lastEventSequence ?? 0
        let events: [AgentEvent]
        do {
          events = try await backend.events(after: sequence)
        } catch {
          try? await Task.sleep(for: .seconds(1))
          continue
        }
        for event in events {
          self?.ingestLiveEvent(event)
        }
        if let latest = events.last?.sequence {
          self?.lastEventSequence = max(
            self?.lastEventSequence ?? 0,
            latest
          )
        }
        guard !Task.isCancelled else { break }
        try? await Task.sleep(for: .milliseconds(350))
      }
    }
  }

  private func ingestLiveEvent(_ event: AgentEvent) {
    guard knownEventIDs.insert(event.id).inserted else { return }
    eventsByTask[event.taskID, default: []].append(event)
    if !usesBackgroundService,
      let notification = CoreNotificationPolicy.notification(for: event)
    {
      sendNotification(
        title: notification.title,
        body: notification.body
      )
    }
    if [.approvalRequested, .inputRequested, .error].contains(event.kind) {
      isInspectorPresented = true
    }
    if [
      .approvalRequested, .approvalResolved, .inputRequested, .inputResolved,
      .status, .error,
    ].contains(event.kind),
      let projectID = projectID(containing: event.taskID)
    {
      Task { await refreshSnapshot(projectID: projectID) }
    }
  }

  private func refreshSnapshot(projectID: String) async {
    guard let backend else { return }
    do {
      snapshots[projectID] = try await backend.snapshot(projectID: projectID)
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  private func projectID(containing taskID: String) -> String? {
    for (projectID, snapshot) in snapshots
    where snapshot.tasks.contains(where: { $0.id == taskID }) {
      return projectID
    }
    return nil
  }

  private func projectID(containingApproval approvalID: String) -> String? {
    for (projectID, snapshot) in snapshots
    where snapshot.approvals.contains(where: { $0.id == approvalID }) {
      return projectID
    }
    return nil
  }

  private func projectID(containingInput inputID: String) -> String? {
    for (projectID, snapshot) in snapshots
    where snapshot.inputRequests.contains(where: { $0.id == inputID }) {
      return projectID
    }
    return nil
  }

  private func requestNotificationAuthorization() {
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound, .badge]
    ) { _, _ in }
  }

  private func sendNotification(title: String, body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(
        identifier: UUID().uuidString,
        content: content,
        trigger: nil
      )
    )
  }

  private func updateBackgroundServiceStatus() {
    let status = SMAppService.agent(
      plistName: "com.mattiafiumara.Orchestrator.service.plist"
    ).status
    backgroundServiceStatus =
      switch status {
      case .enabled: "Enabled"
      case .requiresApproval: "Needs approval in System Settings"
      case .notFound: "Unavailable in this development build"
      case .notRegistered: "Not registered"
      @unknown default: "Unknown"
      }
  }
}
