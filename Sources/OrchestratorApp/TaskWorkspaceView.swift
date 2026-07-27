import AppKit
import OrchestratorCore
import SwiftUI
import UniformTypeIdentifiers

struct TaskWorkspaceView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let task: OrchestrationTask
  let newTask: () -> Void

  @State private var workspaceLayout: WorkspaceLayoutV2
  @State private var showsLaunchAgent = false
  @State private var showsCommandPalette = false
  @State private var didRestoreLayout = false
  @State private var persistenceTask: Task<Void, Never>?

  init(
    projectID: String,
    task: OrchestrationTask,
    newTask: @escaping () -> Void
  ) {
    self.projectID = projectID
    self.task = task
    self.newTask = newTask
    _workspaceLayout = State(
      initialValue: .single(
        task.goal.hasPrefix("Existing Git worktree imported from ")
          ? .fileExplorer
          : .agent(agentID: nil)
      )
    )
  }

  var body: some View {
    VStack(spacing: 0) {
      workspaceContextBar
      panes
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(theme.surface0)
    .accessibilityHidden(showsCommandPalette)
    .sheet(isPresented: $showsLaunchAgent) {
      LaunchAgentSheet(task: task) { showsLaunchAgent = false }
    }
    .overlay {
      if showsCommandPalette {
        commandPaletteOverlay
      }
    }
    .animation(.easeOut(duration: 0.12), value: showsCommandPalette)
    .focusedSceneValue(
      \.workspaceCommandActions,
      WorkspaceCommandActions(
        showPalette: { showsCommandPalette = true },
        selectPanel: { open(panel: $0) },
        launchAgent: { showsLaunchAgent = true },
        newTask: newTask,
        closeTab: closeFocusedTab,
        split: split
      )
    )
    .task(id: persistedLayout?.updatedAt) {
      restorePersistedLayoutIfAvailable()
    }
    .task {
      try? await Task.sleep(for: .milliseconds(350))
      if !didRestoreLayout {
        didRestoreLayout = true
      }
    }
    .onChange(of: workspaceLayout) {
      schedulePersistence()
    }
    .onDisappear {
      persistenceTask?.cancel()
    }
  }

  private var panes: some View {
    Group {
      if workspaceLayout.panes.count == 2, let split = workspaceLayout.split {
        WorkspaceSplitView(
          axis: split.axis,
          fraction: Binding(
            get: { workspaceLayout.split?.fraction ?? 0.5 },
            set: { workspaceLayout.updateSplitFraction($0) }
          )
        ) {
          paneView(workspaceLayout.panes[0])
        } second: {
          paneView(workspaceLayout.panes[1])
        }
      } else if let pane = workspaceLayout.panes.first {
        paneView(pane)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func paneView(_ pane: WorkspacePane) -> some View {
    WorkspacePaneView(
      projectID: projectID,
      task: task,
      pane: pane,
      paneCount: workspaceLayout.panes.count,
      isFocused: workspaceLayout.focusedPaneID == pane.id,
      onFocus: {
        workspaceLayout.focusedPaneID = pane.id
      },
      onSelect: { tabID in
        workspaceLayout.select(tabID: tabID, in: pane.id)
      },
      onClose: { tabID in
        workspaceLayout.close(tabID: tabID, in: pane.id)
      },
      onOpen: { target in
        _ = workspaceLayout.open(target, in: pane.id)
      },
      onMove: { tabID, index in
        workspaceLayout.move(tabID: tabID, to: pane.id, at: index)
      },
      onSplit: split,
      onOpenFile: { path, line in
        openFile(path, line: line, in: pane.id)
      }
    )
  }

  private var workspaceContextBar: some View {
    HStack(spacing: OrchestratorTheme.Spacing.small) {
      Image(systemName: isExternalWorkspace ? "link" : "shippingbox")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(task.status.orchestratorTint(in: theme))
        .frame(width: 24, height: 24)
        .background(
          task.status.orchestratorTint(in: theme).opacity(0.12),
          in: .rect(cornerRadius: OrchestratorTheme.Radius.medium)
        )

      Text(task.title)
        .font(OrchestratorTheme.Typography.title)
        .foregroundStyle(theme.foreground)
        .lineLimit(1)

      Image(systemName: "chevron.right")
        .font(.system(size: 8, weight: .bold))
        .foregroundStyle(theme.tertiary)

      Text(task.branchName)
        .font(OrchestratorTheme.Typography.caption.monospaced())
        .foregroundStyle(theme.muted)
        .lineLimit(1)

      if isExternalWorkspace {
        Text("EXISTING")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(theme.tertiary)
          .padding(.horizontal, 5)
          .frame(height: 18)
          .background(theme.surface3, in: .capsule)
      }

      Spacer(minLength: 12)

      StatusCapsule(
        title: task.status.displayName,
        color: task.status.orchestratorTint(in: theme)
      )

      if isSetupFailure {
        recoveryMenu
      }

      Button {
        showsLaunchAgent = true
      } label: {
        Label("New Agent", systemImage: "plus")
      }
      .buttonStyle(
        OrchestratorButtonStyle(variant: .primary, compact: true)
      )

      taskActionsMenu
    }
    .padding(.horizontal, OrchestratorTheme.Spacing.medium)
    .frame(height: 40)
    .background(theme.surface1)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)
    }
  }

  private var recoveryMenu: some View {
    Menu {
      Button("Retry Setup") {
        Task {
          await model.recoverTask(
            projectID: projectID,
            taskID: task.id,
            action: .retrySetup
          )
        }
      }
      Button("Skip Setup") {
        Task {
          await model.recoverTask(
            projectID: projectID,
            taskID: task.id,
            action: .skipSetup
          )
        }
      }
    } label: {
      Image(systemName: "wrench.and.screwdriver")
    }
    .menuStyle(.borderlessButton)
    .help("Recover setup")
  }

  private var taskActionsMenu: some View {
    Menu {
      if let workspacePath {
        Button {
          model.reveal(workspacePath)
        } label: {
          Label("Reveal in Finder", systemImage: "folder")
        }
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(workspacePath, forType: .string)
        } label: {
          Label("Copy Worktree Path", systemImage: "doc.on.doc")
        }
      }
      Divider()
      Button(
        isExternalWorkspace ? "Forget Worktree" : "Archive Task",
        role: .destructive
      ) {
        Task { await model.archiveTask(taskID: task.id) }
      }
    } label: {
      Image(systemName: "ellipsis")
        .frame(width: 28, height: 28)
    }
    .menuStyle(.borderlessButton)
    .help("Worktree actions")
    .accessibilityLabel("Worktree actions")
  }

  private var commandPaletteOverlay: some View {
    ZStack(alignment: .top) {
      Color.black.opacity(0.46)
        .ignoresSafeArea()
        .onTapGesture { showsCommandPalette = false }

      CommandPalette(
        commands: commandPaletteCommands,
        dismiss: { showsCommandPalette = false }
      )
      .frame(maxWidth: 680)
      .padding(.horizontal, 24)
      .padding(.top, 72)
    }
    .transition(.opacity)
  }

  private var commandPaletteCommands: [PaletteCommand] {
    var commands = PanelKind.allCases.enumerated().map { index, panel in
      PaletteCommand(
        id: "panel.\(panel.rawValue)",
        title: "Open \(panel.title)",
        detail: "Open or focus \(panel.title) in the active pane",
        symbol: panel.symbol,
        shortcut: "⌘\(index + 1)",
        keywords: ["panel", "view", "tab", panel.rawValue]
      ) {
        open(panel: panel)
      }
    }

    commands.append(
      PaletteCommand(
        id: "tab.close",
        title: "Close Tab",
        detail: "Close the active workspace tab",
        symbol: "xmark",
        shortcut: "⌘W",
        keywords: ["pane", "document"]
      ) {
        closeFocusedTab()
      }
    )
    commands.append(
      PaletteCommand(
        id: "pane.split-right",
        title: "Split Right",
        detail: "Open a second pane to the right",
        symbol: "rectangle.split.2x1",
        shortcut: "⌘D",
        keywords: ["pane", "horizontal"]
      ) {
        split(.horizontal)
      }
    )
    commands.append(
      PaletteCommand(
        id: "pane.split-down",
        title: "Split Down",
        detail: "Open a second pane below",
        symbol: "rectangle.split.1x2",
        shortcut: "⇧⌘D",
        keywords: ["pane", "vertical"]
      ) {
        split(.vertical)
      }
    )
    commands.append(
      PaletteCommand(
        id: "task.new",
        title: "New Task",
        detail: "Create an isolated worktree for a new goal",
        symbol: "plus",
        shortcut: "⌘N",
        keywords: ["create", "worktree", "workspace"]
      ) {
        newTask()
      }
    )
    commands.append(
      PaletteCommand(
        id: "agent.launch",
        title: "Launch Agent",
        detail: "Start another agent in this worktree",
        symbol: "sparkles",
        shortcut: "⇧⌘A",
        keywords: ["new", "provider", "codex", "claude"]
      ) {
        showsLaunchAgent = true
      }
    )
    commands.append(
      PaletteCommand(
        id: "workspace.refresh",
        title: "Refresh Worktree",
        detail: "Reload agents, terminals, and Git state",
        symbol: "arrow.clockwise",
        shortcut: "⌘R",
        keywords: ["reload", "sync", "git"]
      ) {
        Task { await model.refresh(projectID: projectID) }
      }
    )
    commands.append(
      PaletteCommand(
        id: "workspace.attention",
        title: model.isInspectorPresented ? "Hide Attention" : "Show Attention",
        detail: "Toggle approvals, questions, and failures",
        symbol: "checklist.unchecked",
        shortcut: "⌥⌘I",
        keywords: ["inspector", "approval", "failure"]
      ) {
        model.isInspectorPresented.toggle()
      }
    )
    if let workspacePath {
      commands.append(
        PaletteCommand(
          id: "workspace.reveal",
          title: "Reveal Worktree in Finder",
          detail: workspacePath,
          symbol: "folder",
          keywords: ["open", "directory", "checkout"]
        ) {
          model.reveal(workspacePath)
        }
      )
    }
    return commands
  }

  private var persistedLayout: PanelLayout? {
    model.snapshot(for: projectID).layouts.first { $0.taskID == task.id }
  }

  private var workspacePath: String? {
    model.snapshot(for: projectID).workspaces
      .first { $0.taskID == task.id }?
      .path
  }

  private var isExternalWorkspace: Bool {
    model.snapshot(for: projectID).workspaces.first {
      $0.taskID == task.id
    }?.ownership == .external
  }

  private var isSetupFailure: Bool {
    task.status == .failed && model.agents(for: task.id).isEmpty
  }

  private func restorePersistedLayoutIfAvailable() {
    guard !didRestoreLayout, let persistedLayout else { return }
    workspaceLayout = WorkspaceLayoutV2.migrating(persistedLayout)
    didRestoreLayout = true
  }

  private func schedulePersistence() {
    guard didRestoreLayout else { return }
    persistenceTask?.cancel()
    let nextLayout = workspaceLayout
    persistenceTask = Task {
      try? await Task.sleep(for: .milliseconds(180))
      guard !Task.isCancelled else { return }
      await model.savePanelLayout(
        projectID: projectID,
        taskID: task.id,
        workspaceLayout: nextLayout
      )
    }
  }

  private func open(panel: PanelKind) {
    let target = WorkspaceTabTarget.legacy(panel)
    _ = workspaceLayout.open(target)
  }

  private func openFile(_ path: String, line: Int?, in paneID: String? = nil) {
    _ = workspaceLayout.open(
      .sourceFile(path: path, line: line),
      in: paneID
    )
  }

  private func closeFocusedTab() {
    guard
      let pane = workspaceLayout.focusedPane,
      let tabID = pane.selectedTabID
    else {
      return
    }
    workspaceLayout.close(tabID: tabID, in: pane.id)
  }

  private func split(_ axis: WorkspaceSplitAxis) {
    workspaceLayout.split(axis: axis)
  }
}

private struct WorkspacePaneView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let task: OrchestrationTask
  let pane: WorkspacePane
  let paneCount: Int
  let isFocused: Bool
  let onFocus: () -> Void
  let onSelect: (String) -> Void
  let onClose: (String) -> Void
  let onOpen: (WorkspaceTabTarget) -> Void
  let onMove: (String, Int) -> Void
  let onSplit: (WorkspaceSplitAxis) -> Void
  let onOpenFile: (String, Int?) -> Void

  var body: some View {
    VStack(spacing: 0) {
      WorkspaceTabBar(
        projectID: projectID,
        task: task,
        pane: pane,
        paneCount: paneCount,
        isFocused: isFocused,
        onSelect: onSelect,
        onClose: onClose,
        onOpen: onOpen,
        onMove: onMove,
        onSplit: onSplit
      )

      if let tab = pane.selectedTab {
        WorkspacePanel(
          projectID: projectID,
          task: task,
          tab: tab,
          onOpenFile: onOpenFile
        )
        .id(tab.id)
      } else {
        PaneEmptyState(onOpen: onOpen)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(theme.surface0)
    .overlay {
      Rectangle()
        .stroke(
          isFocused ? theme.accent.opacity(0.25) : .clear,
          lineWidth: 1
        )
        .allowsHitTesting(false)
    }
    .contentShape(.rect)
    .simultaneousGesture(
      TapGesture().onEnded { onFocus() }
    )
  }
}

private struct WorkspaceTabBar: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let task: OrchestrationTask
  let pane: WorkspacePane
  let paneCount: Int
  let isFocused: Bool
  let onSelect: (String) -> Void
  let onClose: (String) -> Void
  let onOpen: (WorkspaceTabTarget) -> Void
  let onMove: (String, Int) -> Void
  let onSplit: (WorkspaceSplitAxis) -> Void

  var body: some View {
    HStack(spacing: 0) {
      ScrollView(.horizontal) {
        HStack(spacing: 0) {
          ForEach(Array(pane.tabs.enumerated()), id: \.element.id) { index, tab in
            WorkspaceTabChip(
              title: title(for: tab),
              symbol: symbol(for: tab.target),
              isSelected: pane.selectedTabID == tab.id,
              isPaneFocused: isFocused,
              onSelect: { onSelect(tab.id) },
              onClose: { onClose(tab.id) }
            )
            .draggable(WorkspaceTabTransfer(tabID: tab.id))
            .dropDestination(for: WorkspaceTabTransfer.self) { transfers, _ in
              guard let transfer = transfers.first else { return false }
              onMove(transfer.tabID, index)
              NSHapticFeedbackManager.defaultPerformer.perform(
                .alignment,
                performanceTime: .now
              )
              return true
            }
          }
        }
      }
      .scrollIndicators(.hidden)
      .dropDestination(for: WorkspaceTabTransfer.self) { transfers, _ in
        guard let transfer = transfers.first else { return false }
        onMove(transfer.tabID, pane.tabs.count)
        return true
      }

      Menu {
        Button("New Agent", systemImage: "sparkles") {
          onOpen(.newAgent)
        }
        Button("Terminal", systemImage: "terminal") {
          onOpen(.terminal(terminalID: nil))
        }
        Button("Preview", systemImage: "safari") {
          onOpen(.browser(url: nil, serviceID: nil))
        }
        Button("Changes", systemImage: "arrow.left.arrow.right") {
          onOpen(.workingChanges(focusedPath: nil))
        }
        Button("Files", systemImage: "folder") {
          onOpen(.fileExplorer)
        }
      } label: {
        Image(systemName: "plus")
          .frame(width: 28, height: 28)
          .contentShape(.rect)
      }
      .menuStyle(.borderlessButton)
      .help("Open Tab")

      Menu {
        Button("Split Right", systemImage: "rectangle.split.2x1") {
          onSplit(.horizontal)
        }
        Button("Split Down", systemImage: "rectangle.split.1x2") {
          onSplit(.vertical)
        }
      } label: {
        Image(
          systemName:
            paneCount == 1
            ? "rectangle.split.2x1"
            : "rectangle.split.2x1.fill"
        )
        .frame(width: 28, height: 28)
        .contentShape(.rect)
      }
      .menuStyle(.borderlessButton)
      .help("Pane Layout")
      .padding(.trailing, 4)
    }
    .frame(height: 34)
    .background(theme.surface0)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)
    }
  }

  private func title(for tab: WorkspaceTab) -> String {
    if let titleOverride = tab.titleOverride, !titleOverride.isEmpty {
      return titleOverride
    }
    switch tab.target {
    case .newAgent:
      return "New Agent"
    case .agent(let agentID):
      guard let agentID else {
        return model.agents(for: task.id).last?.title ?? "Agent"
      }
      return model.agents(for: task.id).first { $0.id == agentID }?.title ?? "Agent"
    case .terminal(let terminalID):
      guard let terminalID else { return "Terminal" }
      return model.snapshot(for: projectID).terminals
        .first { $0.id == terminalID }?
        .title ?? "Terminal"
    case .browser(let url, _):
      guard
        let url,
        let host = URL(string: url)?.host()
      else {
        return "Preview"
      }
      return host
    case .workingChanges:
      return "Changes"
    case .fileExplorer:
      return "Files"
    case .sourceFile(let path, _):
      return URL(fileURLWithPath: path).lastPathComponent
    }
  }

  private func symbol(for target: WorkspaceTabTarget) -> String {
    switch target {
    case .newAgent, .agent:
      "sparkles"
    case .terminal:
      "terminal"
    case .browser:
      "safari"
    case .workingChanges:
      "arrow.left.arrow.right"
    case .fileExplorer:
      "folder"
    case .sourceFile:
      "doc.text"
    }
  }
}

private struct WorkspaceTabChip: View {
  @Environment(\.orchestratorTheme) private var theme
  let title: String
  let symbol: String
  let isSelected: Bool
  let isPaneFocused: Bool
  let onSelect: () -> Void
  let onClose: () -> Void
  @State private var isHovered = false

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .medium))
      Text(title)
        .font(OrchestratorTheme.Typography.body)
        .lineLimit(1)
      if isSelected || isHovered {
        Button(action: onClose) {
          Image(systemName: "xmark")
            .font(.system(size: 9, weight: .semibold))
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 18))
        .help("Close Tab")
      }
    }
    .foregroundStyle(isSelected ? theme.foreground : theme.muted)
    .padding(.horizontal, 10)
    .frame(minWidth: 88, maxWidth: 200, minHeight: 33)
    .background(
      isSelected
        ? theme.surface1
        : (isHovered ? theme.surface2.opacity(0.72) : .clear)
    )
    .overlay(alignment: .top) {
      Rectangle()
        .fill(
          isSelected
            ? (isPaneFocused ? theme.accent : theme.borderStrong)
            : .clear
        )
        .frame(height: 2)
    }
    .overlay(alignment: .trailing) {
      Rectangle()
        .fill(theme.border)
        .frame(width: 1)
    }
    .contentShape(.rect)
    .onTapGesture(perform: onSelect)
    .onHover { isHovered = $0 }
    .background(MiddleClickMonitor(action: onClose))
    .contextMenu {
      Button("Close Tab", systemImage: "xmark", action: onClose)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(title)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}

private struct MiddleClickMonitor: NSViewRepresentable {
  let action: () -> Void

  func makeNSView(context: Context) -> MonitorView {
    MonitorView(action: action)
  }

  func updateNSView(_ nsView: MonitorView, context: Context) {
    nsView.action = action
  }

  @MainActor
  final class MonitorView: NSView {
    var action: () -> Void
    nonisolated(unsafe) private var monitor: Any?

    init(action: @escaping () -> Void) {
      self.action = action
      super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) has not been implemented")
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
      nil
    }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      installMonitor()
    }

    private func installMonitor() {
      if let monitor {
        NSEvent.removeMonitor(monitor)
      }
      guard window != nil else {
        monitor = nil
        return
      }
      monitor = NSEvent.addLocalMonitorForEvents(matching: .otherMouseDown) {
        [weak self] event in
        guard
          let self,
          event.buttonNumber == 2,
          event.window === self.window,
          self.bounds.contains(self.convert(event.locationInWindow, from: nil))
        else {
          return event
        }
        self.action()
        return nil
      }
    }

    deinit {
      if let monitor {
        NSEvent.removeMonitor(monitor)
      }
    }
  }
}

private struct PaneEmptyState: View {
  @Environment(\.orchestratorTheme) private var theme
  let onOpen: (WorkspaceTabTarget) -> Void

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "rectangle.stack.badge.plus")
        .font(.system(size: 24, weight: .medium))
        .foregroundStyle(theme.tertiary)
      Text("Open a workspace tab")
        .font(OrchestratorTheme.Typography.title)
        .foregroundStyle(theme.foreground)
      HStack(spacing: 8) {
        quickAction("Agent", "sparkles", .newAgent)
        quickAction("Terminal", "terminal", .terminal(terminalID: nil))
        quickAction("Files", "folder", .fileExplorer)
        quickAction("Changes", "arrow.left.arrow.right", .workingChanges(focusedPath: nil))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(theme.surface0)
  }

  private func quickAction(
    _ title: String,
    _ symbol: String,
    _ target: WorkspaceTabTarget
  ) -> some View {
    Button {
      onOpen(target)
    } label: {
      Label(title, systemImage: symbol)
    }
    .buttonStyle(OrchestratorButtonStyle(variant: .secondary, compact: true))
  }
}

private struct WorkspacePanel: View {
  let projectID: String
  let task: OrchestrationTask
  let tab: WorkspaceTab
  let onOpenFile: (String, Int?) -> Void

  var body: some View {
    Group {
      switch tab.target {
      case .newAgent:
        AgentPanel(task: task)
      case .agent(let agentID):
        AgentPanel(task: task, initialAgentID: agentID)
      case .terminal:
        TerminalPanel(projectID: projectID, task: task)
      case .browser(let url, _):
        BrowserPanel(
          projectID: projectID,
          task: task,
          initialURL: url
        )
      case .workingChanges(let focusedPath):
        DiffPanel(
          projectID: projectID,
          task: task,
          initialFocusedPath: focusedPath,
          onOpenFile: onOpenFile
        )
      case .fileExplorer:
        FilePanel(
          projectID: projectID,
          task: task,
          onOpenFile: onOpenFile
        )
      case .sourceFile(let path, let line):
        SourceFilePanel(
          projectID: projectID,
          task: task,
          relativePath: path,
          initialLine: line
        )
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct StatusCapsule: View {
  let title: String
  let color: Color

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(color)
        .frame(width: 6, height: 6)
      Text(title)
    }
    .font(OrchestratorTheme.Typography.captionMedium)
    .foregroundStyle(color)
    .padding(.horizontal, 8)
    .frame(height: 22)
    .background(color.opacity(0.11), in: .capsule)
  }
}

private struct WorkspaceTabTransfer: Codable, Transferable {
  let tabID: String

  static var transferRepresentation: some TransferRepresentation {
    CodableRepresentation(contentType: .orchestratorWorkspaceTab)
  }
}

extension UTType {
  fileprivate static let orchestratorWorkspaceTab = UTType(
    exportedAs: "com.mattiafiumara.orchestrator.workspace-tab"
  )
}

extension PanelKind {
  var title: String {
    switch self {
    case .agent: "Agent"
    case .terminal: "Terminal"
    case .browser: "Preview"
    case .diff: "Changes"
    case .files: "Files"
    }
  }

  var symbol: String {
    switch self {
    case .agent: "sparkles"
    case .terminal: "terminal"
    case .browser: "safari"
    case .diff: "arrow.left.arrow.right"
    case .files: "folder"
    }
  }
}
