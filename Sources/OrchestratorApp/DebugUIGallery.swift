#if DEBUG
  import AppKit
  import OrchestratorCore
  import ProviderKit
  import SwiftUI

  @MainActor
  struct DebugUIGalleryView: View {
    @State private var model = DebugGalleryFixtures.makeModel()
    @State private var showsPalettePreview = false
    @State private var isCapturing = false

    var body: some View {
      ProjectWorkspaceView(projectID: DebugGalleryFixtures.projectID)
        .environment(model)
        .safeAreaInset(edge: .bottom, spacing: 0) {
          if !isCapturing {
            galleryControls
          }
        }
        .overlay {
          if showsPalettePreview {
            ZStack(alignment: .top) {
              Color.black.opacity(0.46)
                .ignoresSafeArea()
                .onTapGesture { showsPalettePreview = false }
              CommandPalette(
                commands: DebugGalleryFixtures.paletteCommands,
                dismiss: { showsPalettePreview = false }
              )
              .frame(maxWidth: 680)
              .padding(.horizontal, 24)
              .padding(.top, 72)
            }
          }
        }
        .background(DebugGalleryWindowMarker())
        .onReceive(
          NotificationCenter.default.publisher(
            for: .orchestratorDebugGalleryScenario
          )
        ) { notification in
          guard let scenario = notification.object as? String else { return }
          select(scenario)
        }
        .onReceive(
          NotificationCenter.default.publisher(
            for: .orchestratorDebugGalleryCaptureState
          )
        ) { notification in
          isCapturing = notification.object as? Bool ?? false
        }
    }

    private var galleryControls: some View {
      HStack(spacing: 5) {
        Text("UI GALLERY")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(.secondary)
          .padding(.trailing, 5)

        ForEach(DebugGalleryFixtures.scenarios) { scenario in
          Button(scenario.title) {
            model.selectedTaskByProject[DebugGalleryFixtures.projectID] =
              scenario.taskID
          }
          .buttonStyle(.borderless)
          .font(.caption)
        }

        Divider()
          .frame(height: 14)

        Button(model.isInspectorPresented ? "Hide Attention" : "Attention") {
          model.isInspectorPresented.toggle()
        }
        .buttonStyle(.borderless)
        .font(.caption)

        Button("Palette") {
          showsPalettePreview = true
        }
        .buttonStyle(.borderless)
        .font(.caption)

        Spacer()
        Text("⌘K palette · ⌘D split · Space Quick Look")
          .font(.caption2.monospaced())
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 9)
      .frame(height: 28)
      .background(.ultraThinMaterial)
    }

    private func select(_ scenario: String) {
      showsPalettePreview = scenario == "palette"
      if scenario == "attention" {
        model.isInspectorPresented = true
        return
      }
      model.isInspectorPresented = false
      guard
        let match = DebugGalleryFixtures.scenarios.first(where: {
          $0.id == scenario
        })
      else {
        return
      }
      model.selectedTaskByProject[DebugGalleryFixtures.projectID] = match.taskID
    }
  }

  @MainActor
  private enum DebugGalleryFixtures {
    struct Scenario: Identifiable {
      let id: String
      let title: String
      let taskID: String
    }

    static let projectID = "gallery-project"
    static let agentTaskID = "gallery-agent-task"
    static let filesTaskID = "gallery-files-task"
    static let diffTaskID = "gallery-diff-task"
    static let splitTaskID = "gallery-split-task"
    static let failedTaskID = "gallery-failed-task"

    static let scenarios = [
      Scenario(id: "agent", title: "Agent", taskID: agentTaskID),
      Scenario(id: "files", title: "Files", taskID: filesTaskID),
      Scenario(id: "diff", title: "Diff", taskID: diffTaskID),
      Scenario(id: "split", title: "Two Pane", taskID: splitTaskID),
      Scenario(id: "failed", title: "Setup Error", taskID: failedTaskID),
    ]

    static var paletteCommands: [PaletteCommand] {
      [
        PaletteCommand(
          id: "gallery.open-agent",
          title: "Open Agent",
          detail: "Focus the most recent agent tab",
          symbol: "sparkles",
          shortcut: "⌘1",
          keywords: ["conversation"]
        ) {},
        PaletteCommand(
          id: "gallery.open-terminal",
          title: "Open Terminal",
          detail: "Create or focus a persistent shell",
          symbol: "terminal",
          shortcut: "⌘2",
          keywords: ["shell"]
        ) {},
        PaletteCommand(
          id: "gallery.open-preview",
          title: "Open Preview",
          detail: "Open the running web service",
          symbol: "safari",
          shortcut: "⌘3",
          keywords: ["browser"]
        ) {},
        PaletteCommand(
          id: "gallery.open-diff",
          title: "Open Changes",
          detail: "Review working-tree changes against main",
          symbol: "arrow.left.arrow.right",
          shortcut: "⌘4",
          keywords: ["git", "diff"]
        ) {},
        PaletteCommand(
          id: "gallery.split",
          title: "Split Right",
          detail: "Open a second workspace pane",
          symbol: "rectangle.split.2x1",
          shortcut: "⌘D",
          keywords: ["pane"]
        ) {},
        PaletteCommand(
          id: "gallery.attention",
          title: "Show Attention",
          detail: "Review approvals, questions, and failures",
          symbol: "checklist.unchecked",
          shortcut: "⌥⌘I",
          keywords: ["inspector"]
        ) {},
      ]
    }

    static func makeModel() -> AppModel {
      let model = AppModel()
      let project = Project(
        id: projectID,
        name: "orchestrator-ui-gallery",
        rootPath: repositoryRoot,
        defaultBranch: "main",
        createdAt: fixedDate,
        lastOpenedAt: fixedDate
      )
      let tasks = fixtureTasks
      let agents = fixtureAgents
      let snapshot = CoreSnapshot(
        project: project,
        tasks: tasks,
        workspaces: tasks.map(workspace(for:)),
        agents: agents,
        approvals: [fixtureApproval],
        inputRequests: [fixtureInputRequest],
        terminals: [],
        services: [
          ManagedService(
            id: "gallery-service",
            taskID: splitTaskID,
            name: "web",
            command: "npm run dev",
            port: 4_321,
            previewURL: "http://127.0.0.1:4321",
            status: .running,
            processIdentifier: 42,
            createdAt: fixedDate
          )
        ],
        layouts: fixtureLayouts,
        latestSequence: 12
      )
      model.installDebugGalleryFixture(
        project: project,
        snapshot: snapshot,
        events: [agentTaskID: fixtureEvents],
        diffs: [
          diffTaskID: fixtureDiff,
          splitTaskID: fixtureDiff,
        ],
        providers: fixtureProviders
      )
      return model
    }

    private static var fixtureTasks: [OrchestrationTask] {
      [
        OrchestrationTask(
          id: agentTaskID,
          projectID: projectID,
          title: "Refine the workspace interaction model for a long project name",
          goal: "Polish the complete daily-driver experience.",
          baseRef: "main",
          branchName: "orch/workspace-interactions",
          workspaceID: "workspace-agent",
          status: .running,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
        OrchestrationTask(
          id: filesTaskID,
          projectID: projectID,
          title: "Browse a large repository",
          goal: "Existing Git worktree imported from \(repositoryRoot)",
          baseRef: "main",
          branchName: "main",
          workspaceID: "workspace-files",
          status: .reviewReady,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
        OrchestrationTask(
          id: diffTaskID,
          projectID: projectID,
          title: "Review a deliberately large change set",
          goal: "Audit unified and side-by-side changes.",
          baseRef: "main",
          branchName: "orch/large-diff-review",
          workspaceID: "workspace-diff",
          status: .reviewReady,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
        OrchestrationTask(
          id: splitTaskID,
          projectID: projectID,
          title: "Source and preview side by side",
          goal: "Exercise two-pane restoration and resizing.",
          baseRef: "main",
          branchName: "orch/two-pane-layout",
          workspaceID: "workspace-split",
          status: .running,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
        OrchestrationTask(
          id: failedTaskID,
          projectID: projectID,
          title: "Setup failed after dependency installation",
          goal: "Exercise failure recovery actions.",
          baseRef: "main",
          branchName: "orch/setup-failure",
          workspaceID: "workspace-failed",
          status: .failed,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
      ]
    }

    private static var fixtureAgents: [AgentSession] {
      [
        AgentSession(
          id: "gallery-agent-1",
          taskID: agentTaskID,
          title: "Primary implementation",
          providerID: "codex",
          providerSessionID: "thread-fixture",
          model: "gpt-5.4",
          mode: "workspace-write",
          status: .running,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
        AgentSession(
          id: "gallery-agent-2",
          taskID: agentTaskID,
          parentID: "gallery-agent-1",
          title: "Accessibility audit with a deliberately long agent title",
          providerID: "claude",
          status: .completed,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
        AgentSession(
          id: "gallery-agent-3",
          taskID: agentTaskID,
          parentID: "gallery-agent-1",
          title: "Diff parser",
          providerID: "codex",
          status: .waitingForApproval,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
        AgentSession(
          id: "gallery-agent-4",
          taskID: agentTaskID,
          title: "Terminal recovery",
          providerID: "claude",
          status: .idle,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
        AgentSession(
          id: "gallery-agent-5",
          taskID: agentTaskID,
          title: "Preview smoke test",
          providerID: "acp-demo",
          status: .failed,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
        AgentSession(
          id: "gallery-agent-6",
          taskID: agentTaskID,
          title: "Release notes",
          providerID: "codex",
          status: .completed,
          createdAt: fixedDate,
          updatedAt: fixedDate
        ),
      ]
    }

    private static var fixtureEvents: [AgentEvent] {
      [
        event(
          1,
          .userMessage,
          text:
            "Please audit the entire workspace. Keep the interface quiet, keyboard-first, "
            + "and make Files and Diff feel like one coherent tool."
        ),
        event(
          2,
          .reasoning,
          text:
            "I’ll inspect the information hierarchy, selection behavior, and repeated "
            + "chrome before touching individual colors."
        ),
        AgentEvent(
          id: "gallery-event-3",
          sequence: 3,
          taskID: agentTaskID,
          agentID: "gallery-agent-1",
          kind: .toolStarted,
          payload: .object([
            "item": .object([
              "id": .string("tool-1"),
              "type": .string("commandExecution"),
              "command": .string("swift test --filter WorkspaceLayoutTests"),
            ])
          ]),
          timestamp: fixedDate.addingTimeInterval(20)
        ),
        AgentEvent(
          id: "gallery-event-4",
          sequence: 4,
          taskID: agentTaskID,
          agentID: "gallery-agent-1",
          kind: .toolCompleted,
          payload: .object([
            "item": .object([
              "id": .string("tool-1"),
              "type": .string("commandExecution"),
              "command": .string("swift test --filter WorkspaceLayoutTests"),
            ])
          ]),
          timestamp: fixedDate.addingTimeInterval(26)
        ),
        event(5, .messageDelta, text: "The structural pass is complete. "),
        event(
          6,
          .messageDelta,
          text:
            "Tabs now preserve identity across worktrees, and streamed output is projected "
            + "into one calm response instead of token-sized cards.\n\n"
            + "- Files previews on one click and opens a source tab on Return.\n"
            + "- Diff supports unified and side-by-side review.\n"
            + "- Every primary workflow has a menu command and keyboard route."
        ),
        event(
          7,
          .agentMessage,
          text:
            """
            The structural pass is complete. Tabs now preserve identity across worktrees, \
            and streamed output is projected into one calm response instead of token-sized \
            cards.

            - Files previews on one click and opens a source tab on Return.
            - Diff supports unified and side-by-side review.
            - Every primary workflow has a menu command and keyboard route.
            """
        ),
      ]
    }

    private static func event(
      _ sequence: Int64,
      _ kind: AgentEventKind,
      text: String
    ) -> AgentEvent {
      AgentEvent(
        id: "gallery-event-\(sequence)",
        sequence: sequence,
        taskID: agentTaskID,
        agentID: "gallery-agent-1",
        kind: kind,
        payload: .object(["text": .string(text)]),
        timestamp: fixedDate.addingTimeInterval(TimeInterval(sequence * 6))
      )
    }

    private static var fixtureApproval: Approval {
      Approval(
        id: "gallery-approval",
        taskID: agentTaskID,
        agentID: "gallery-agent-3",
        providerRequestID: "approval-fixture",
        kind: .command,
        title: "Run release verification",
        summary: "The agent wants to build, test, package, and verify the signed app.",
        details: .object([
          "command": .string("Scripts/build-app.sh release && codesign --verify Orchestrator.app"),
          "supportsAllowOnce": .bool(true),
          "supportsAllowForSession": .bool(true),
          "supportsDeny": .bool(true),
        ]),
        createdAt: fixedDate
      )
    }

    private static var fixtureInputRequest: AgentInputRequest {
      AgentInputRequest(
        id: "gallery-input",
        taskID: agentTaskID,
        agentID: "gallery-agent-1",
        providerRequestID: "input-fixture",
        title: "Choose the default review mode",
        questions: [
          AgentInputQuestion(
            id: "mode",
            header: "Diff mode",
            question: "Which view should open for files with both additions and deletions?",
            options: [
              AgentInputOption(
                label: "Unified",
                description: "Compact and best for narrow panes."
              ),
              AgentInputOption(
                label: "Side by side",
                description: "Clear before/after comparison on wide screens."
              ),
            ],
            allowsFreeform: true
          )
        ],
        createdAt: fixedDate
      )
    }

    private static var fixtureLayouts: [PanelLayout] {
      [
        panelLayout(
          taskID: agentTaskID,
          layout: .single(.agent(agentID: "gallery-agent-1"))
        ),
        panelLayout(taskID: filesTaskID, layout: .single(.fileExplorer)),
        panelLayout(
          taskID: diffTaskID,
          layout: .single(
            .workingChanges(
              focusedPath: "Sources/OrchestratorApp/TaskWorkspaceView.swift"
            )
          )
        ),
        panelLayout(taskID: splitTaskID, layout: splitLayout),
        panelLayout(taskID: failedTaskID, layout: .single(.fileExplorer)),
      ]
    }

    private static var splitLayout: WorkspaceLayoutV2 {
      let source = WorkspaceTab(
        id: "gallery-source-tab",
        target: .sourceFile(
          path: "Sources/OrchestratorApp/TaskWorkspaceView.swift",
          line: 520
        )
      )
      let preview = WorkspaceTab(
        id: "gallery-preview-tab",
        target: .browser(
          url: "http://127.0.0.1:4321",
          serviceID: "gallery-service"
        )
      )
      let first = WorkspacePane(
        id: "gallery-pane-1",
        tabs: [source],
        selectedTabID: source.id
      )
      let second = WorkspacePane(
        id: "gallery-pane-2",
        tabs: [preview],
        selectedTabID: preview.id
      )
      return WorkspaceLayoutV2(
        panes: [first, second],
        focusedPaneID: first.id,
        split: WorkspaceSplit(axis: .horizontal, fraction: 0.56)
      )
    }

    private static func panelLayout(
      taskID: String,
      layout: WorkspaceLayoutV2
    ) -> PanelLayout {
      PanelLayout(
        id: "gallery-layout-\(taskID)",
        projectID: projectID,
        taskID: taskID,
        selectedPanel: layout.selectedTarget?.panelKind ?? .agent,
        layout: (try? JSONValue.encode(layout)) ?? .object([:]),
        updatedAt: fixedDate
      )
    }

    private static func workspace(for task: OrchestrationTask) -> Workspace {
      Workspace(
        id: task.workspaceID ?? "workspace-\(task.id)",
        taskID: task.id,
        sourcePath: repositoryRoot,
        path: repositoryRoot,
        isolation: task.id == filesTaskID ? .currentCheckout : .worktree,
        ownership: task.id == filesTaskID ? .external : .orchestrator,
        baseCommit: String(repeating: "a", count: 40),
        branchName: task.branchName,
        createdAt: fixedDate
      )
    }

    private static var fixtureDiff: GitDiff {
      let files = [
        "Sources/OrchestratorApp/TaskWorkspaceView.swift",
        "Sources/OrchestratorApp/FilePanel.swift",
        "Sources/OrchestratorApp/DiffPanel.swift",
        "Sources/OrchestratorApp/AgentPanel.swift",
        "Sources/OrchestratorApp/TerminalPanel.swift",
        "Sources/OrchestratorApp/BrowserPanel.swift",
        "Sources/OrchestratorApp/AttentionInspector.swift",
        "Sources/OrchestratorApp/CommandPalette.swift",
        "Sources/OrchestratorApp/OrchestratorDesignSystem.swift",
        "Sources/OrchestratorCore/Domain.swift",
        "Tests/OrchestratorCoreTests/WorkspaceLayoutTests.swift",
        "readme.md",
      ] + (1...20).map { "Fixtures/LongDirectory/GeneratedComponent\($0).swift" }

      let text = files.enumerated().map { index, path in
        """
        diff --git a/\(path) b/\(path)
        index 1111111..2222222 100644
        --- a/\(path)
        +++ b/\(path)
        @@ -\(index + 1),5 +\(index + 1),7 @@
         struct WorkspaceComponent {
        -  let legacyColor = Color.blue
        -  let cornerRadius: CGFloat = 14
        +  let surface = theme.surface1
        +  let cornerRadius = OrchestratorTheme.Radius.large
        +  let border = theme.border

        -  func render() { print("legacy") }
        +  func render() {
        +    print("orchestrated")
        +  }
         }
        """
      }.joined(separator: "\n")
      return GitDiff(text: text, changedFiles: files)
    }

    private static var fixtureProviders: [ProviderInspection] {
      [
        ProviderInspection(
          descriptor: ProviderDescriptor(
            id: "codex",
            label: "Codex",
            command: ["codex", "app-server", "--stdio"],
            capabilities: [.models, .modes, .resume, .steer, .approvals]
          ),
          availability: .available(path: "/opt/homebrew/bin/codex", version: "0.99"),
          models: [ProviderModel(id: "gpt-5.4", label: "GPT-5.4", isDefault: true)],
          modes: [ProviderMode(id: "workspace-write", label: "Workspace Write")]
        ),
        ProviderInspection(
          descriptor: ProviderDescriptor(
            id: "claude",
            label: "Claude",
            command: ["claude", "--output-format", "stream-json"],
            capabilities: [.models, .resume, .approvals]
          ),
          availability: .available(path: "/opt/homebrew/bin/claude", version: "2.1")
        ),
      ]
    }

    private static let fixedDate = Date(timeIntervalSince1970: 1_782_000_000)

    private static var repositoryRoot: String {
      URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .path
    }
  }

  extension Notification.Name {
    fileprivate static let orchestratorDebugGalleryScenario = Notification.Name(
      "OrchestratorDebugGalleryScenario"
    )
    fileprivate static let orchestratorDebugGalleryCaptureState =
      Notification.Name("OrchestratorDebugGalleryCaptureState")
  }

  @MainActor
  enum DebugGalleryController {
    static let windowIdentifier = "orchestrator.ui-gallery"

    static func showScenario(_ scenario: String) {
      galleryWindow?.makeKeyAndOrderFront(nil)
      NotificationCenter.default.post(
        name: .orchestratorDebugGalleryScenario,
        object: scenario
      )
    }

    static func resize(width: CGFloat, height: CGFloat) {
      guard let window = galleryWindow else { return }
      window.setContentSize(NSSize(width: width, height: height))
      window.center()
      window.makeKeyAndOrderFront(nil)
    }

    @discardableResult
    static func capture(
      to path: String = "/private/tmp/orchestrator-ui-gallery.png"
    ) async throws -> URL {
      NotificationCenter.default.post(
        name: .orchestratorDebugGalleryCaptureState,
        object: true
      )
      try await Task.sleep(for: .milliseconds(120))
      defer {
        NotificationCenter.default.post(
          name: .orchestratorDebugGalleryCaptureState,
          object: false
        )
      }
      guard let window = galleryWindow, let view = window.contentView else {
        throw GalleryCaptureError.windowUnavailable
      }
      window.makeKeyAndOrderFront(nil)
      view.layoutSubtreeIfNeeded()
      view.displayIfNeeded()
      guard
        let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds)
      else {
        throw GalleryCaptureError.renderFailed
      }
      view.cacheDisplay(in: view.bounds, to: representation)
      representation.size = view.bounds.size
      guard let data = representation.representation(using: .png, properties: [:])
      else {
        throw GalleryCaptureError.renderFailed
      }
      let url = URL(fileURLWithPath: path)
      try data.write(to: url, options: .atomic)
      return url
    }

    private static var galleryWindow: NSWindow? {
      NSApp.windows.first {
        $0.identifier?.rawValue == windowIdentifier
      }
    }

    enum GalleryCaptureError: LocalizedError {
      case windowUnavailable
      case renderFailed

      var errorDescription: String? {
        switch self {
        case .windowUnavailable:
          "The UI gallery window is not open."
        case .renderFailed:
          "The UI gallery could not be rendered."
        }
      }
    }
  }

  @MainActor
  private struct DebugGalleryWindowMarker: NSViewRepresentable {
    func makeNSView(context: Context) -> MarkerView {
      MarkerView()
    }

    func updateNSView(_ nsView: MarkerView, context: Context) {
      nsView.mark()
    }

    final class MarkerView: NSView {
      override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        mark()
      }

      func mark() {
        window?.identifier = NSUserInterfaceItemIdentifier(
          DebugGalleryController.windowIdentifier
        )
      }
    }
  }
#endif
