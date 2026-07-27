import Foundation
import OrchestratorCore
import Testing

struct WorkspaceLayoutTests {
  @Test
  func legacySinglePanelMigratesWithoutLosingSelection() {
    let legacy = PanelLayout(
      id: "layout",
      projectID: "project",
      taskID: "task",
      selectedPanel: .diff
    )

    let migrated = WorkspaceLayoutV2.migrating(legacy)

    #expect(migrated.version == 2)
    #expect(migrated.panes.count == 1)
    #expect(migrated.selectedTarget == .workingChanges(focusedPath: nil))
    #expect(migrated.split == nil)
  }

  @Test
  func legacySecondaryPanelBecomesASecondPane() {
    let legacy = PanelLayout(
      id: "layout",
      projectID: "project",
      taskID: "task",
      selectedPanel: .agent,
      layout: .object(["secondary": .string(PanelKind.terminal.rawValue)])
    )

    let migrated = WorkspaceLayoutV2.migrating(legacy)

    #expect(migrated.panes.count == 2)
    #expect(migrated.panes[0].selectedTab?.target == .agent(agentID: nil))
    #expect(migrated.panes[1].selectedTab?.target == .terminal(terminalID: nil))
    #expect(migrated.split == WorkspaceSplit(axis: .horizontal, fraction: 0.5))
  }

  @Test
  func versionTwoLayoutRoundTripsThroughPanelJSON() throws {
    let file = WorkspaceTab(
      id: "file",
      target: .sourceFile(path: "Sources/App.swift", line: 42)
    )
    let terminal = WorkspaceTab(
      id: "terminal",
      target: .terminal(terminalID: "terminal-1")
    )
    let left = WorkspacePane(
      id: "left",
      tabs: [file],
      selectedTabID: file.id
    )
    let right = WorkspacePane(
      id: "right",
      tabs: [terminal],
      selectedTabID: terminal.id
    )
    let layout = WorkspaceLayoutV2(
      panes: [left, right],
      focusedPaneID: right.id,
      split: WorkspaceSplit(axis: .vertical, fraction: 0.63)
    )
    let persisted = PanelLayout(
      id: "layout",
      projectID: "project",
      taskID: "task",
      selectedPanel: .terminal,
      layout: try JSONValue.encode(layout)
    )

    #expect(WorkspaceLayoutV2.migrating(persisted) == layout)
  }

  @Test
  func openDeduplicatesTargetsAndFocusesTheirPane() {
    var layout = WorkspaceLayoutV2.single(.fileExplorer)
    let first = layout.open(.workingChanges(focusedPath: nil))
    let second = layout.open(.workingChanges(focusedPath: nil))

    #expect(first.id == second.id)
    #expect(layout.panes[0].tabs.count == 2)
    #expect(layout.panes[0].selectedTabID == first.id)
  }

  @Test
  func movingTheOnlyPrimaryTabLeavesAnEmptyQuickActionPane() {
    let first = WorkspaceTab(id: "first", target: .fileExplorer)
    let second = WorkspaceTab(id: "second", target: .terminal(terminalID: nil))
    let left = WorkspacePane(id: "left", tabs: [first], selectedTabID: first.id)
    let right = WorkspacePane(id: "right", tabs: [second], selectedTabID: second.id)
    var layout = WorkspaceLayoutV2(
      panes: [left, right],
      focusedPaneID: left.id,
      split: WorkspaceSplit(axis: .horizontal, fraction: 0.5)
    )

    layout.move(tabID: first.id, to: right.id, at: 1)

    #expect(layout.panes.count == 2)
    #expect(layout.panes[0].tabs.isEmpty)
    #expect(layout.panes[1].tabs.map(\.id) == ["second", "first"])
    #expect(layout.split != nil)
  }

  @Test
  func splitFractionsAreClamped() {
    var layout = WorkspaceLayoutV2.single(.newAgent)
    layout.split(axis: .vertical)
    layout.updateSplitFraction(0.98)

    #expect(layout.split?.fraction == 0.8)
    layout.updateSplitFraction(0.02)
    #expect(layout.split?.fraction == 0.2)
  }
}
