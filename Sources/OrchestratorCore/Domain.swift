import Foundation

public enum OrchestratorID {
  public static func make(_ prefix: String) -> String {
    "\(prefix)_\(UUID().uuidString.lowercased())"
  }
}

public struct Project: Codable, Sendable, Identifiable, Equatable, Hashable {
  public var id: String
  public var name: String
  public var rootPath: String
  public var defaultBranch: String
  public var createdAt: Date
  public var lastOpenedAt: Date

  public init(
    id: String = OrchestratorID.make("project"),
    name: String,
    rootPath: String,
    defaultBranch: String = "HEAD",
    createdAt: Date = .now,
    lastOpenedAt: Date = .now
  ) {
    self.id = id
    self.name = name
    self.rootPath = rootPath
    self.defaultBranch = defaultBranch
    self.createdAt = createdAt
    self.lastOpenedAt = lastOpenedAt
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case name
    case rootPath
    case defaultBranch
    case createdAt
    case lastOpenedAt
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    name = try container.decode(String.self, forKey: .name)
    rootPath = try container.decode(String.self, forKey: .rootPath)
    defaultBranch =
      try container.decodeIfPresent(
        String.self,
        forKey: .defaultBranch
      ) ?? "HEAD"
    createdAt = try container.decode(Date.self, forKey: .createdAt)
    lastOpenedAt = try container.decode(Date.self, forKey: .lastOpenedAt)
  }
}

public enum TaskStatus: String, Codable, Sendable, CaseIterable {
  case preparing
  case running
  case needsAttention
  case reviewReady
  case shipped
  case failed
  case archived
}

public struct OrchestrationTask: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var projectID: String
  public var title: String
  public var goal: String
  public var baseRef: String
  public var branchName: String
  public var workspaceID: String?
  public var status: TaskStatus
  public var childLaunchPolicy: ChildLaunchPolicy
  public var createdAt: Date
  public var updatedAt: Date

  public init(
    id: String = OrchestratorID.make("task"),
    projectID: String,
    title: String,
    goal: String,
    baseRef: String,
    branchName: String,
    workspaceID: String? = nil,
    status: TaskStatus = .preparing,
    childLaunchPolicy: ChildLaunchPolicy = .ask,
    createdAt: Date = .now,
    updatedAt: Date = .now
  ) {
    self.id = id
    self.projectID = projectID
    self.title = title
    self.goal = goal
    self.baseRef = baseRef
    self.branchName = branchName
    self.workspaceID = workspaceID
    self.status = status
    self.childLaunchPolicy = childLaunchPolicy
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public enum ChildLaunchPolicy: String, Codable, Sendable, CaseIterable {
  case ask
  case allowForTask
  case deny
}

public enum WorkspaceIsolation: String, Codable, Sendable {
  case worktree
  case currentCheckout
}

public enum WorkspaceOwnership: String, Codable, Sendable {
  case orchestrator
  case external
}

public struct Workspace: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var taskID: String
  public var sourcePath: String
  public var path: String
  public var isolation: WorkspaceIsolation
  public var ownership: WorkspaceOwnership
  public var baseCommit: String
  public var branchName: String
  public var configHash: String?
  public var configuration: ProjectConfiguration?
  public var createdAt: Date

  public init(
    id: String = OrchestratorID.make("workspace"),
    taskID: String,
    sourcePath: String,
    path: String,
    isolation: WorkspaceIsolation,
    ownership: WorkspaceOwnership = .orchestrator,
    baseCommit: String,
    branchName: String,
    configHash: String? = nil,
    configuration: ProjectConfiguration? = nil,
    createdAt: Date = .now
  ) {
    self.id = id
    self.taskID = taskID
    self.sourcePath = sourcePath
    self.path = path
    self.isolation = isolation
    self.ownership = ownership
    self.baseCommit = baseCommit
    self.branchName = branchName
    self.configHash = configHash
    self.configuration = configuration
    self.createdAt = createdAt
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case taskID
    case sourcePath
    case path
    case isolation
    case ownership
    case baseCommit
    case branchName
    case configHash
    case configuration
    case createdAt
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    taskID = try container.decode(String.self, forKey: .taskID)
    sourcePath = try container.decode(String.self, forKey: .sourcePath)
    path = try container.decode(String.self, forKey: .path)
    isolation = try container.decode(WorkspaceIsolation.self, forKey: .isolation)
    ownership =
      try container.decodeIfPresent(
        WorkspaceOwnership.self,
        forKey: .ownership
      ) ?? .orchestrator
    baseCommit = try container.decode(String.self, forKey: .baseCommit)
    branchName = try container.decode(String.self, forKey: .branchName)
    configHash = try container.decodeIfPresent(String.self, forKey: .configHash)
    configuration = try container.decodeIfPresent(
      ProjectConfiguration.self,
      forKey: .configuration
    )
    createdAt = try container.decode(Date.self, forKey: .createdAt)
  }
}

public enum AgentStatus: String, Codable, Sendable, CaseIterable {
  case launching
  case running
  case waitingForApproval
  case waitingForInput
  case idle
  case completed
  case failed
  case interrupted
  case disconnected
}

public struct AgentSession: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var taskID: String
  public var parentID: String?
  public var title: String
  public var providerID: String
  public var providerSessionID: String?
  public var model: String?
  public var mode: String?
  public var status: AgentStatus
  public var createdAt: Date
  public var updatedAt: Date

  public init(
    id: String = OrchestratorID.make("agent"),
    taskID: String,
    parentID: String? = nil,
    title: String,
    providerID: String,
    providerSessionID: String? = nil,
    model: String? = nil,
    mode: String? = nil,
    status: AgentStatus = .launching,
    createdAt: Date = .now,
    updatedAt: Date = .now
  ) {
    self.id = id
    self.taskID = taskID
    self.parentID = parentID
    self.title = title
    self.providerID = providerID
    self.providerSessionID = providerSessionID
    self.model = model
    self.mode = mode
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public enum AgentEventKind: String, Codable, Sendable {
  case userMessage
  case agentMessage
  case messageDelta
  case reasoning
  case toolStarted
  case toolUpdated
  case toolCompleted
  case command
  case fileChange
  case approvalRequested
  case approvalResolved
  case inputRequested
  case inputResolved
  case usage
  case status
  case error
  case raw
}

public struct AgentEvent: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var sequence: Int64
  public var taskID: String
  public var agentID: String?
  public var kind: AgentEventKind
  public var payload: JSONValue
  public var rawProviderPayload: JSONValue?
  public var timestamp: Date

  public init(
    id: String = OrchestratorID.make("event"),
    sequence: Int64 = 0,
    taskID: String,
    agentID: String? = nil,
    kind: AgentEventKind,
    payload: JSONValue,
    rawProviderPayload: JSONValue? = nil,
    timestamp: Date = .now
  ) {
    self.id = id
    self.sequence = sequence
    self.taskID = taskID
    self.agentID = agentID
    self.kind = kind
    self.payload = payload
    self.rawProviderPayload = rawProviderPayload
    self.timestamp = timestamp
  }
}

public enum ApprovalKind: String, Codable, Sendable {
  case command
  case fileChange
  case permissions
  case childAgent
  case configuration
  case providerSpecific
}

public enum ApprovalStatus: String, Codable, Sendable {
  case pending
  case allowedOnce
  case allowedForSession
  case denied
  case cancelled
}

public struct Approval: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var taskID: String
  public var agentID: String?
  public var providerRequestID: String?
  public var kind: ApprovalKind
  public var title: String
  public var summary: String
  public var details: JSONValue
  public var status: ApprovalStatus
  public var createdAt: Date
  public var resolvedAt: Date?

  public init(
    id: String = OrchestratorID.make("approval"),
    taskID: String,
    agentID: String? = nil,
    providerRequestID: String? = nil,
    kind: ApprovalKind,
    title: String,
    summary: String,
    details: JSONValue = .object([:]),
    status: ApprovalStatus = .pending,
    createdAt: Date = .now,
    resolvedAt: Date? = nil
  ) {
    self.id = id
    self.taskID = taskID
    self.agentID = agentID
    self.providerRequestID = providerRequestID
    self.kind = kind
    self.title = title
    self.summary = summary
    self.details = details
    self.status = status
    self.createdAt = createdAt
    self.resolvedAt = resolvedAt
  }
}

public struct AgentInputOption: Codable, Sendable, Equatable, Hashable {
  public var label: String
  public var description: String

  public init(label: String, description: String = "") {
    self.label = label
    self.description = description
  }
}

public struct AgentInputQuestion: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var header: String
  public var question: String
  public var options: [AgentInputOption]
  public var allowsFreeform: Bool
  public var isSecret: Bool

  public init(
    id: String,
    header: String,
    question: String,
    options: [AgentInputOption] = [],
    allowsFreeform: Bool = false,
    isSecret: Bool = false
  ) {
    self.id = id
    self.header = header
    self.question = question
    self.options = options
    self.allowsFreeform = allowsFreeform
    self.isSecret = isSecret
  }
}

public enum AgentInputStatus: String, Codable, Sendable {
  case pending
  case submitted
  case cancelled
}

public struct AgentInputRequest: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var taskID: String
  public var agentID: String
  public var providerRequestID: String
  public var title: String
  public var questions: [AgentInputQuestion]
  public var details: JSONValue
  public var status: AgentInputStatus
  public var createdAt: Date
  public var resolvedAt: Date?

  public init(
    id: String = OrchestratorID.make("input"),
    taskID: String,
    agentID: String,
    providerRequestID: String,
    title: String = "Agent needs input",
    questions: [AgentInputQuestion],
    details: JSONValue = .object([:]),
    status: AgentInputStatus = .pending,
    createdAt: Date = .now,
    resolvedAt: Date? = nil
  ) {
    self.id = id
    self.taskID = taskID
    self.agentID = agentID
    self.providerRequestID = providerRequestID
    self.title = title
    self.questions = questions
    self.details = details
    self.status = status
    self.createdAt = createdAt
    self.resolvedAt = resolvedAt
  }
}

public enum TerminalStatus: String, Codable, Sendable {
  case starting
  case running
  case exited
  case failed
}

public struct TerminalSession: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var taskID: String
  public var title: String
  public var workingDirectory: String
  public var status: TerminalStatus
  public var exitCode: Int32?
  public var processIdentifier: Int32?
  public var createdAt: Date

  public init(
    id: String = OrchestratorID.make("terminal"),
    taskID: String,
    title: String,
    workingDirectory: String,
    status: TerminalStatus = .starting,
    exitCode: Int32? = nil,
    processIdentifier: Int32? = nil,
    createdAt: Date = .now
  ) {
    self.id = id
    self.taskID = taskID
    self.title = title
    self.workingDirectory = workingDirectory
    self.status = status
    self.exitCode = exitCode
    self.processIdentifier = processIdentifier
    self.createdAt = createdAt
  }
}

public enum ServiceStatus: String, Codable, Sendable {
  case starting
  case running
  case stopped
  case failed
  case orphaned
}

public struct ManagedService: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var taskID: String
  public var name: String
  public var command: String
  public var port: Int?
  public var previewURL: String?
  public var status: ServiceStatus
  public var processIdentifier: Int32?
  public var createdAt: Date

  public init(
    id: String = OrchestratorID.make("service"),
    taskID: String,
    name: String,
    command: String,
    port: Int? = nil,
    previewURL: String? = nil,
    status: ServiceStatus = .starting,
    processIdentifier: Int32? = nil,
    createdAt: Date = .now
  ) {
    self.id = id
    self.taskID = taskID
    self.name = name
    self.command = command
    self.port = port
    self.previewURL = previewURL
    self.status = status
    self.processIdentifier = processIdentifier
    self.createdAt = createdAt
  }
}

public enum PanelKind: String, Codable, Sendable, CaseIterable {
  case agent
  case terminal
  case browser
  case diff
  case files

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    let value = try container.decode(String.self)
    if value == "editor" {
      self = .terminal
      return
    }
    guard let panel = Self(rawValue: value) else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Unknown workspace panel \(value)."
      )
    }
    self = panel
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

public struct PanelLayout: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var projectID: String
  public var taskID: String?
  public var selectedPanel: PanelKind
  public var layout: JSONValue
  public var updatedAt: Date

  public init(
    id: String = OrchestratorID.make("layout"),
    projectID: String,
    taskID: String? = nil,
    selectedPanel: PanelKind = .agent,
    layout: JSONValue = .object([:]),
    updatedAt: Date = .now
  ) {
    self.id = id
    self.projectID = projectID
    self.taskID = taskID
    self.selectedPanel = selectedPanel
    self.layout = layout
    self.updatedAt = updatedAt
  }
}

public enum WorkspaceSplitAxis: String, Codable, Sendable, CaseIterable {
  case horizontal
  case vertical
}

public struct WorkspaceSplit: Codable, Sendable, Equatable {
  public var axis: WorkspaceSplitAxis
  public var fraction: Double

  public init(
    axis: WorkspaceSplitAxis = .horizontal,
    fraction: Double = 0.5
  ) {
    self.axis = axis
    self.fraction = min(max(fraction, 0.2), 0.8)
  }
}

public enum WorkspaceTabTarget: Codable, Sendable, Equatable, Hashable {
  case newAgent
  case agent(agentID: String?)
  case terminal(terminalID: String?)
  case browser(url: String?, serviceID: String?)
  case workingChanges(focusedPath: String?)
  case fileExplorer
  case sourceFile(path: String, line: Int?)

  public var panelKind: PanelKind {
    switch self {
    case .newAgent, .agent:
      .agent
    case .terminal:
      .terminal
    case .browser:
      .browser
    case .workingChanges:
      .diff
    case .fileExplorer, .sourceFile:
      .files
    }
  }

  public static func legacy(_ panel: PanelKind) -> Self {
    switch panel {
    case .agent:
      .agent(agentID: nil)
    case .terminal:
      .terminal(terminalID: nil)
    case .browser:
      .browser(url: nil, serviceID: nil)
    case .diff:
      .workingChanges(focusedPath: nil)
    case .files:
      .fileExplorer
    }
  }
}

public struct WorkspaceTab: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var target: WorkspaceTabTarget
  public var titleOverride: String?

  public init(
    id: String = OrchestratorID.make("tab"),
    target: WorkspaceTabTarget,
    titleOverride: String? = nil
  ) {
    self.id = id
    self.target = target
    self.titleOverride = titleOverride
  }
}

public struct WorkspacePane: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var tabs: [WorkspaceTab]
  public var selectedTabID: String?

  public init(
    id: String = OrchestratorID.make("pane"),
    tabs: [WorkspaceTab] = [],
    selectedTabID: String? = nil
  ) {
    self.id = id
    self.tabs = tabs
    self.selectedTabID =
      selectedTabID.flatMap { selected in
        tabs.contains(where: { $0.id == selected }) ? selected : nil
      } ?? tabs.first?.id
  }

  public var selectedTab: WorkspaceTab? {
    guard let selectedTabID else { return nil }
    return tabs.first { $0.id == selectedTabID }
  }
}

public struct WorkspaceLayoutV2: Codable, Sendable, Equatable {
  public var version: Int
  public var panes: [WorkspacePane]
  public var focusedPaneID: String
  public var split: WorkspaceSplit?

  public init(
    panes: [WorkspacePane],
    focusedPaneID: String? = nil,
    split: WorkspaceSplit? = nil
  ) {
    version = 2
    let retainedPanes = Array(panes.prefix(2))
    if retainedPanes.isEmpty {
      let pane = WorkspacePane()
      self.panes = [pane]
      self.focusedPaneID = pane.id
      self.split = nil
    } else {
      self.panes = retainedPanes
      self.focusedPaneID =
        focusedPaneID.flatMap { candidate in
          retainedPanes.contains(where: { $0.id == candidate })
            ? candidate
            : nil
        } ?? retainedPanes[0].id
      self.split =
        retainedPanes.count == 2
        ? WorkspaceSplit(
          axis: split?.axis ?? .horizontal,
          fraction: split?.fraction ?? 0.5
        )
        : nil
    }
    normalize()
  }

  public static func single(_ target: WorkspaceTabTarget) -> Self {
    let tab = WorkspaceTab(target: target)
    let pane = WorkspacePane(tabs: [tab], selectedTabID: tab.id)
    return WorkspaceLayoutV2(panes: [pane], focusedPaneID: pane.id)
  }

  public static func migrating(_ legacy: PanelLayout) -> Self {
    if
      let decoded = try? legacy.layout.decode(WorkspaceLayoutV2.self),
      decoded.version == 2
    {
      var normalized = decoded
      normalized.normalize()
      return normalized
    }

    let primaryTab = WorkspaceTab(
      id: "\(legacy.id)-primary",
      target: .legacy(legacy.selectedPanel)
    )
    let primaryPane = WorkspacePane(
      id: "\(legacy.id)-primary-pane",
      tabs: [primaryTab],
      selectedTabID: primaryTab.id
    )
    guard
      let secondaryValue = legacy.layout["secondary"]?.stringValue,
      let secondaryKind = PanelKind(rawValue: secondaryValue),
      secondaryKind != legacy.selectedPanel
    else {
      return WorkspaceLayoutV2(
        panes: [primaryPane],
        focusedPaneID: primaryPane.id
      )
    }

    let secondaryTab = WorkspaceTab(
      id: "\(legacy.id)-secondary",
      target: .legacy(secondaryKind)
    )
    let secondaryPane = WorkspacePane(
      id: "\(legacy.id)-secondary-pane",
      tabs: [secondaryTab],
      selectedTabID: secondaryTab.id
    )
    return WorkspaceLayoutV2(
      panes: [primaryPane, secondaryPane],
      focusedPaneID: primaryPane.id,
      split: WorkspaceSplit()
    )
  }

  public var focusedPane: WorkspacePane? {
    panes.first { $0.id == focusedPaneID }
  }

  public var selectedTarget: WorkspaceTabTarget? {
    focusedPane?.selectedTab?.target
  }

  public mutating func select(tabID: String, in paneID: String) {
    guard
      let paneIndex = panes.firstIndex(where: { $0.id == paneID }),
      panes[paneIndex].tabs.contains(where: { $0.id == tabID })
    else {
      return
    }
    panes[paneIndex].selectedTabID = tabID
    focusedPaneID = paneID
  }

  @discardableResult
  public mutating func open(
    _ target: WorkspaceTabTarget,
    in paneID: String? = nil,
    titleOverride: String? = nil
  ) -> WorkspaceTab {
    for paneIndex in panes.indices {
      if let tab = panes[paneIndex].tabs.first(where: { $0.target == target }) {
        panes[paneIndex].selectedTabID = tab.id
        focusedPaneID = panes[paneIndex].id
        return tab
      }
    }

    let targetPaneID =
      paneID.flatMap { candidate in
        panes.contains(where: { $0.id == candidate }) ? candidate : nil
      } ?? focusedPaneID
    let paneIndex = panes.firstIndex { $0.id == targetPaneID } ?? 0
    let tab = WorkspaceTab(target: target, titleOverride: titleOverride)
    panes[paneIndex].tabs.append(tab)
    panes[paneIndex].selectedTabID = tab.id
    focusedPaneID = panes[paneIndex].id
    return tab
  }

  public mutating func close(tabID: String, in paneID: String) {
    guard let paneIndex = panes.firstIndex(where: { $0.id == paneID }) else {
      return
    }
    guard let tabIndex = panes[paneIndex].tabs.firstIndex(where: { $0.id == tabID })
    else {
      return
    }

    let wasSelected = panes[paneIndex].selectedTabID == tabID
    panes[paneIndex].tabs.remove(at: tabIndex)
    if wasSelected {
      let replacementIndex = min(tabIndex, panes[paneIndex].tabs.count - 1)
      panes[paneIndex].selectedTabID =
        replacementIndex >= 0
        ? panes[paneIndex].tabs[replacementIndex].id
        : nil
    }

    if panes[paneIndex].tabs.isEmpty, panes.count == 2, paneIndex == 1 {
      panes.remove(at: paneIndex)
      focusedPaneID = panes[0].id
      split = nil
    }
    normalize()
  }

  public mutating func split(
    axis: WorkspaceSplitAxis,
    moving tabID: String? = nil
  ) {
    guard panes.count == 1 else {
      split = WorkspaceSplit(axis: axis, fraction: split?.fraction ?? 0.5)
      return
    }

    let secondPane = WorkspacePane()
    panes.append(secondPane)
    split = WorkspaceSplit(axis: axis, fraction: 0.5)
    focusedPaneID = secondPane.id
    if let tabID {
      move(tabID: tabID, to: secondPane.id, at: 0)
    }
  }

  public mutating func move(
    tabID: String,
    to destinationPaneID: String,
    at requestedIndex: Int
  ) {
    guard
      let sourcePaneIndex = panes.firstIndex(where: {
        $0.tabs.contains(where: { $0.id == tabID })
      }),
      let sourceTabIndex = panes[sourcePaneIndex].tabs.firstIndex(where: {
        $0.id == tabID
      }),
      let destinationPaneIndex = panes.firstIndex(where: {
        $0.id == destinationPaneID
      })
    else {
      return
    }

    let tab = panes[sourcePaneIndex].tabs.remove(at: sourceTabIndex)
    if panes[sourcePaneIndex].selectedTabID == tabID {
      panes[sourcePaneIndex].selectedTabID =
        panes[sourcePaneIndex].tabs.indices.contains(sourceTabIndex)
        ? panes[sourcePaneIndex].tabs[sourceTabIndex].id
        : panes[sourcePaneIndex].tabs.last?.id
    }

    var destinationIndex = min(
      max(requestedIndex, 0),
      panes[destinationPaneIndex].tabs.count
    )
    if sourcePaneIndex == destinationPaneIndex, sourceTabIndex < destinationIndex {
      destinationIndex -= 1
    }
    panes[destinationPaneIndex].tabs.insert(tab, at: destinationIndex)
    panes[destinationPaneIndex].selectedTabID = tab.id
    focusedPaneID = panes[destinationPaneIndex].id

    if panes.count == 2, panes[1].tabs.isEmpty {
      let emptyIndex = 1
      panes.remove(at: emptyIndex)
      focusedPaneID = panes[0].id
      split = nil
    }
    normalize()
  }

  public mutating func updateSplitFraction(_ fraction: Double) {
    guard let split else { return }
    self.split = WorkspaceSplit(axis: split.axis, fraction: fraction)
  }

  public mutating func normalize() {
    version = 2
    panes = Array(panes.prefix(2))
    if panes.isEmpty {
      let pane = WorkspacePane()
      panes = [pane]
      focusedPaneID = pane.id
    }
    var seenTabIDs = Set<String>()
    for index in panes.indices {
      panes[index].tabs.removeAll { !seenTabIDs.insert($0.id).inserted }
      if
        let selected = panes[index].selectedTabID,
        !panes[index].tabs.contains(where: { $0.id == selected })
      {
        panes[index].selectedTabID = panes[index].tabs.first?.id
      } else if panes[index].selectedTabID == nil {
        panes[index].selectedTabID = panes[index].tabs.first?.id
      }
    }
    if !panes.contains(where: { $0.id == focusedPaneID }) {
      focusedPaneID = panes[0].id
    }
    split =
      panes.count == 2
      ? WorkspaceSplit(
        axis: split?.axis ?? .horizontal,
        fraction: split?.fraction ?? 0.5
      )
      : nil
  }
}

public struct PullRequest: Codable, Sendable, Identifiable, Equatable {
  public var id: String
  public var taskID: String
  public var number: Int?
  public var url: String
  public var title: String
  public var state: String
  public var createdAt: Date

  public init(
    id: String = OrchestratorID.make("pr"),
    taskID: String,
    number: Int? = nil,
    url: String,
    title: String,
    state: String = "open",
    createdAt: Date = .now
  ) {
    self.id = id
    self.taskID = taskID
    self.number = number
    self.url = url
    self.title = title
    self.state = state
    self.createdAt = createdAt
  }
}

public struct CoreSnapshot: Codable, Sendable, Equatable {
  public var project: Project?
  public var tasks: [OrchestrationTask]
  public var workspaces: [Workspace]
  public var agents: [AgentSession]
  public var approvals: [Approval]
  public var inputRequests: [AgentInputRequest]
  public var terminals: [TerminalSession]
  public var services: [ManagedService]
  public var layouts: [PanelLayout]
  public var pullRequests: [PullRequest]
  public var latestSequence: Int64

  public init(
    project: Project? = nil,
    tasks: [OrchestrationTask] = [],
    workspaces: [Workspace] = [],
    agents: [AgentSession] = [],
    approvals: [Approval] = [],
    inputRequests: [AgentInputRequest] = [],
    terminals: [TerminalSession] = [],
    services: [ManagedService] = [],
    layouts: [PanelLayout] = [],
    pullRequests: [PullRequest] = [],
    latestSequence: Int64 = 0
  ) {
    self.project = project
    self.tasks = tasks
    self.workspaces = workspaces
    self.agents = agents
    self.approvals = approvals
    self.inputRequests = inputRequests
    self.terminals = terminals
    self.services = services
    self.layouts = layouts
    self.pullRequests = pullRequests
    self.latestSequence = latestSequence
  }
}
