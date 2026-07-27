import AppKit
import SwiftUI

@main
struct OrchestratorApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    Window("Orchestrator", id: "launcher") {
      ProjectLauncherView()
        .environment(model)
        .task { await model.bootstrapIfNeeded() }
        .frame(minWidth: 720, minHeight: 500)
        .orchestratorAppearance()
    }
    .windowResizability(.contentMinSize)
    .defaultSize(width: 820, height: 560)
    .commands {
      OrchestratorCommands(model: model)
    }

    WindowGroup("Project", for: String.self) { projectID in
      if let projectID = projectID.wrappedValue {
        ProjectWorkspaceView(projectID: projectID)
          .environment(model)
          .task {
            await model.bootstrapIfNeeded()
            await model.refresh(projectID: projectID)
          }
          .orchestratorAppearance()
      } else {
        ContentUnavailableView(
          "No project selected",
          systemImage: "folder.badge.questionmark"
        )
      }
    }
    .defaultSize(width: 1_360, height: 860)
    .windowToolbarStyle(.unifiedCompact)

    Settings {
      SettingsView()
        .environment(model)
        .frame(width: 620, height: 520)
        .task { await model.bootstrapIfNeeded() }
        .orchestratorAppearance()
    }

    #if DEBUG
      Window("Orchestrator UI Gallery", id: "ui-gallery") {
        DebugUIGalleryView()
          .frame(minWidth: 900, minHeight: 600)
          .orchestratorAppearance()
      }
      .defaultSize(width: 1_360, height: 860)
      .windowToolbarStyle(.unifiedCompact)
    #endif
  }
}

private struct OrchestratorCommands: Commands {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow
  @FocusedValue(\.workspaceCommandActions) private var workspaceCommandActions

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button("New Task…") {
        workspaceCommandActions?.newTask()
      }
      .keyboardShortcut("n")
      .disabled(workspaceCommandActions == nil)

      Button("Open Repository…") {
        let launcherWindow =
          NSApp.keyWindow?.identifier?.rawValue == LauncherWindowMarker.identifier
          ? NSApp.keyWindow
          : nil
        Task {
          if let project = await model.chooseAndOpenProject() {
            openWindow(value: project.id)
            DispatchQueue.main.async {
              launcherWindow?.close()
            }
          }
        }
      }
      .keyboardShortcut("o")
    }
    CommandMenu("Workspace") {
      Button("Close Tab") {
        workspaceCommandActions?.closeTab()
      }
      .keyboardShortcut("w")
      .disabled(workspaceCommandActions == nil)

      Divider()

      Button("Split Right") {
        workspaceCommandActions?.split(.horizontal)
      }
      .keyboardShortcut("d")
      .disabled(workspaceCommandActions == nil)

      Button("Split Down") {
        workspaceCommandActions?.split(.vertical)
      }
      .keyboardShortcut("d", modifiers: [.command, .shift])
      .disabled(workspaceCommandActions == nil)

      Divider()

      Button("Refresh") {
        guard let projectID = model.activeProjectID else { return }
        Task { await model.refresh(projectID: projectID) }
      }
      .keyboardShortcut("r")

      Button("Toggle Attention Inspector") {
        model.isInspectorPresented.toggle()
      }
      .keyboardShortcut("i", modifiers: [.command, .option])
    }

    CommandMenu("Navigate") {
      Button("Command Palette…") {
        workspaceCommandActions?.showPalette()
      }
      .keyboardShortcut("k")
      .disabled(workspaceCommandActions == nil)

      Button("Launch Agent…") {
        workspaceCommandActions?.launchAgent()
      }
      .keyboardShortcut("a", modifiers: [.command, .shift])
      .disabled(workspaceCommandActions == nil)

      Divider()

      Button("Agent") {
        workspaceCommandActions?.selectPanel(.agent)
      }
      .keyboardShortcut("1")
      .disabled(workspaceCommandActions == nil)

      Button("Terminal") {
        workspaceCommandActions?.selectPanel(.terminal)
      }
      .keyboardShortcut("2")
      .disabled(workspaceCommandActions == nil)

      Button("Preview") {
        workspaceCommandActions?.selectPanel(.browser)
      }
      .keyboardShortcut("3")
      .disabled(workspaceCommandActions == nil)

      Button("Diff") {
        workspaceCommandActions?.selectPanel(.diff)
      }
      .keyboardShortcut("4")
      .disabled(workspaceCommandActions == nil)

      Button("Files") {
        workspaceCommandActions?.selectPanel(.files)
      }
      .keyboardShortcut("5")
      .disabled(workspaceCommandActions == nil)
    }

    #if DEBUG
      CommandMenu("Debug") {
        Button("Open UI Gallery") {
          openDebugGallery()
        }
        .keyboardShortcut("g", modifiers: [.command, .option])

        Menu("Gallery Scenario") {
          Button("Agent") { openDebugGallery(scenario: "agent") }
          Button("Files") { openDebugGallery(scenario: "files") }
          Button("Diff") { openDebugGallery(scenario: "diff") }
          Button("Two Pane") { openDebugGallery(scenario: "split") }
          Button("Attention") { openDebugGallery(scenario: "attention") }
          Button("Command Palette") { openDebugGallery(scenario: "palette") }
          Button("Setup Error") { openDebugGallery(scenario: "failed") }
        }

        Menu("Gallery Size") {
          Button("900 × 600") {
            DebugGalleryController.resize(width: 900, height: 600)
          }
          Button("1360 × 860") {
            DebugGalleryController.resize(width: 1_360, height: 860)
          }
          Button("1728 × 1117") {
            DebugGalleryController.resize(width: 1_728, height: 1_117)
          }
        }

        Button("Capture Gallery PNG") {
          Task { @MainActor in
            do {
              _ = try await DebugGalleryController.capture()
            } catch {
              let alert = NSAlert(error: error)
              alert.runModal()
            }
          }
        }
      }
    #endif
  }

  #if DEBUG
    private func openDebugGallery(scenario: String? = nil) {
      openWindow(id: "ui-gallery")
      guard let scenario else { return }
      Task { @MainActor in
        try? await Task.sleep(for: .milliseconds(180))
        DebugGalleryController.showScenario(scenario)
      }
    }
  #endif
}
