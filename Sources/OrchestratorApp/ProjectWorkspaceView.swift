import AppKit
import OrchestratorCore
import SwiftUI

struct ProjectWorkspaceView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  @State private var showsNewTask = false
  @State private var showsProviderPanel = false

  var body: some View {
    @Bindable var model = model
    NavigationSplitView {
      TaskSidebar(
        projectID: projectID,
        selection: Binding(
          get: { model.selectedTaskByProject[projectID] },
          set: { model.selectedTaskByProject[projectID] = $0 }
        ),
        newTask: { showsNewTask = true }
      )
      .navigationSplitViewColumnWidth(min: 210, ideal: 244, max: 320)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(theme.sidebar.ignoresSafeArea())
    } detail: {
      if let task = model.selectedTask(for: projectID) {
        TaskWorkspaceView(
          projectID: projectID,
          task: task,
          newTask: { showsNewTask = true }
        )
          .id(task.id)
      } else {
        ProjectEmptyState(
          project: model.project(projectID),
          newTask: { showsNewTask = true },
          refresh: {
            Task { await model.refresh(projectID: projectID) }
          }
        )
      }
    }
    .background(theme.surface0)
    .navigationSplitViewStyle(.balanced)
    .inspector(isPresented: $model.isInspectorPresented) {
      AttentionInspector(projectID: projectID)
        .inspectorColumnWidth(min: 280, ideal: 320, max: 420)
    }
    .navigationTitle(model.project(projectID)?.name ?? "Project")
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        Button {
          model.isInspectorPresented.toggle()
        } label: {
          Label(
            model.isInspectorPresented ? "Hide Attention" : "Show Attention",
            systemImage: "checklist.unchecked"
          )
        }
        .badge(model.attentionCount(for: projectID))
        .help("Show approvals, questions, and failures")

        Button {
          showsNewTask = true
        } label: {
          Label("New Task", systemImage: "plus")
        }
        .help("Create a worktree task (⌘N)")

        Menu {
          Button {
            Task { await model.refresh(projectID: projectID) }
          } label: {
            Label("Refresh Worktrees", systemImage: "arrow.clockwise")
          }
          Button {
            showsProviderPanel = true
          } label: {
            Label("Agent Providers…", systemImage: "cpu")
          }
        } label: {
          Label("Project Actions", systemImage: "ellipsis.circle")
        }
        .help("Project actions")
      }
    }
    .sheet(isPresented: $showsNewTask) {
      if let project = model.project(projectID) {
        NewTaskSheet(project: project) {
          showsNewTask = false
        }
      }
    }
    .sheet(isPresented: $showsProviderPanel) {
      ProviderSettingsView {
        showsProviderPanel = false
      }
        .frame(minWidth: 640, minHeight: 520)
    }
    .alert(
      "Orchestrator",
      isPresented: Binding(
        get: { model.alertMessage != nil },
        set: { if !$0 { model.alertMessage = nil } }
      )
    ) {
      Button("OK") { model.alertMessage = nil }
    } message: {
      Text(model.alertMessage ?? "")
    }
    .alert(
      "Archive dirty worktree?",
      isPresented: Binding(
        get: {
          guard let taskID = model.pendingDirtyArchiveTaskID else {
            return false
          }
          return model.snapshot(for: projectID).tasks.contains {
            $0.id == taskID
          }
        },
        set: {
          if !$0 { model.pendingDirtyArchiveTaskID = nil }
        }
      )
    ) {
      Button("Cancel", role: .cancel) {
        model.pendingDirtyArchiveTaskID = nil
      }
      Button("Archive & Remove Changes", role: .destructive) {
        Task { await model.confirmDirtyArchive() }
      }
    } message: {
      Text(
        "This worktree has uncommitted changes. Archiving now permanently "
          + "removes the worktree and those changes."
      )
    }
    .onAppear {
      model.activeProjectID = projectID
      DispatchQueue.main.async {
        for window in NSApp.windows
        where window.identifier?.rawValue == LauncherWindowMarker.identifier {
          window.close()
        }
      }
    }
  }
}

private struct ProjectEmptyState: View {
  @Environment(\.orchestratorTheme) private var theme
  let project: Project?
  let newTask: () -> Void
  let refresh: () -> Void

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "square.stack.3d.up")
        .font(.system(size: 34, weight: .medium))
        .foregroundStyle(theme.accent)
        .frame(width: 68, height: 68)
        .background(theme.accent.opacity(0.1), in: .rect(cornerRadius: 12))

      VStack(spacing: 7) {
        Text("Choose a worktree")
          .font(.title2.weight(.semibold))
          .foregroundStyle(theme.foreground)
        Text(
          "Select an existing checkout in the sidebar, or create an isolated "
            + "task for new work."
        )
        .foregroundStyle(theme.muted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 430)
      }

      if let project {
        Text(project.rootPath)
          .font(.caption.monospaced())
          .foregroundStyle(theme.tertiary)
          .lineLimit(1)
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(theme.surface2, in: .rect(cornerRadius: 6))
      }

      HStack(spacing: 10) {
        Button(action: refresh) {
          Label("Refresh Worktrees", systemImage: "arrow.clockwise")
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .secondary))
        Button(action: newTask) {
          Label("New Task", systemImage: "plus")
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .primary))
      }
      .controlSize(.large)
    }
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(theme.surface0)
  }
}
