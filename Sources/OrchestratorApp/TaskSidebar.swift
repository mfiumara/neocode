import OrchestratorCore
import SwiftUI

struct TaskSidebar: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  @Binding var selection: String?
  let newTask: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      sidebarHeader

      if visibleTasks.isEmpty {
        ContentUnavailableView {
          Label("No worktrees", systemImage: "square.stack.3d.up.slash")
        } description: {
          Text("Create a task or refresh this repository.")
        } actions: {
          Button("New Task", systemImage: "plus", action: newTask)
            .buttonStyle(
              OrchestratorButtonStyle(variant: .primary, compact: true)
            )
        }
        .foregroundStyle(theme.muted)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollView {
          LazyVStack(spacing: 2) {
            ForEach(visibleTasks) { task in
              TaskSidebarRow(
                task: task,
                workspace: workspace(for: task.id),
                agents: agents(task.id),
                pendingCount: pendingCount(task.id),
                isSelected: selection == task.id,
                select: { selection = task.id },
                reveal: {
                  guard let workspace = workspace(for: task.id) else { return }
                  model.reveal(workspace.path)
                },
                archive: {
                  Task { await model.archiveTask(taskID: task.id) }
                }
              )
            }
          }
          .padding(.horizontal, 7)
          .padding(.vertical, 6)
        }
        .scrollIndicators(.hidden)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(theme.sidebar.ignoresSafeArea())
  }

  private var sidebarHeader: some View {
    HStack(spacing: 7) {
      Text("WORKTREES")
        .font(.system(size: 10, weight: .semibold))
        .tracking(0.45)
        .foregroundStyle(theme.tertiary)
      Text(visibleTasks.count.formatted())
        .font(OrchestratorTheme.Typography.caption.monospacedDigit())
        .foregroundStyle(theme.tertiary)
      Spacer()
      Button(action: newTask) {
        Image(systemName: "plus")
      }
      .buttonStyle(OrchestratorIconButtonStyle(size: 24))
      .help("New Task")
    }
    .padding(.leading, 11)
    .padding(.trailing, 7)
    .frame(height: 36)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)
    }
  }

  private var visibleTasks: [OrchestrationTask] {
    model.snapshot(for: projectID).tasks.filter {
      $0.status != .archived
    }
  }

  private func workspace(for taskID: String) -> Workspace? {
    model.snapshot(for: projectID).workspaces.first {
      $0.taskID == taskID
    }
  }

  private func agents(_ taskID: String) -> [AgentSession] {
    model.agents(for: taskID).sorted { $0.createdAt < $1.createdAt }
  }

  private func pendingCount(_ taskID: String) -> Int {
    let snapshot = model.snapshot(for: projectID)
    return snapshot.approvals.filter {
      $0.taskID == taskID && $0.status == .pending
    }.count
      + snapshot.inputRequests.filter {
        $0.taskID == taskID && $0.status == .pending
      }.count
  }
}

private struct TaskSidebarRow: View {
  @Environment(\.orchestratorTheme) private var theme
  let task: OrchestrationTask
  let workspace: Workspace?
  let agents: [AgentSession]
  let pendingCount: Int
  let isSelected: Bool
  let select: () -> Void
  let reveal: () -> Void
  let archive: () -> Void
  @State private var isHovered = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button(action: select) {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            StatusDot(status: task.status)

            Text(task.title)
              .font(OrchestratorTheme.Typography.bodyMedium)
              .foregroundStyle(theme.foreground)
              .lineLimit(1)

            Spacer(minLength: 4)

            if workspace?.ownership == .external {
              Image(systemName: "link")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(theme.tertiary)
                .help("Existing Git worktree")
            }

            if pendingCount > 0 {
              Text(pendingCount.formatted())
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(theme.warning)
                .padding(.horizontal, 6)
                .frame(height: 17)
                .background(theme.warning.opacity(0.12), in: .capsule)
            }
          }

          HStack(spacing: 7) {
            Text(task.branchName)
              .font(OrchestratorTheme.Typography.caption.monospaced())
              .foregroundStyle(theme.tertiary)
              .lineLimit(1)

            Spacer(minLength: 4)

            AgentSummary(agents: agents)
          }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 54)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityAddTraits(isSelected ? .isSelected : [])

      if isSelected, agents.count > 1 {
        VStack(spacing: 5) {
          ForEach(rootAgents) { agent in
            AgentTreeRow(
              agent: agent,
              allAgents: agents,
              depth: 0
            )
          }
        }
        .padding(.leading, 25)
        .padding(.trailing, 10)
        .padding(.bottom, 9)
      }
    }
    .background(
      isSelected
        ? theme.surface2
        : (isHovered ? theme.surface1 : .clear),
      in: .rect(cornerRadius: OrchestratorTheme.Radius.large)
    )
    .overlay(alignment: .leading) {
      RoundedRectangle(cornerRadius: 1.5)
        .fill(isSelected ? theme.accent : .clear)
        .frame(width: 3)
        .padding(.vertical, 8)
    }
    .onHover { isHovered = $0 }
    .contextMenu {
      Button("Reveal Worktree", systemImage: "folder", action: reveal)
      Divider()
      Button(
        workspace?.ownership == .external
          ? "Forget Worktree"
          : "Archive Task",
        role: .destructive,
        action: archive
      )
    }
  }

  private var rootAgents: [AgentSession] {
    agents.filter { $0.parentID == nil }
  }
}

private struct AgentSummary: View {
  @Environment(\.orchestratorTheme) private var theme
  let agents: [AgentSession]

  var body: some View {
    if let onlyAgent = agents.first, agents.count == 1 {
      HStack(spacing: 4) {
        Image(systemName: onlyAgent.status.symbolName)
          .foregroundStyle(onlyAgent.status.orchestratorTint(in: theme))
        Text(onlyAgent.providerID)
          .lineLimit(1)
      }
      .font(OrchestratorTheme.Typography.caption)
      .foregroundStyle(theme.muted)
      .accessibilityElement(children: .combine)
      .accessibilityLabel(
        "\(onlyAgent.providerID), \(onlyAgent.status.accessibilityTitle)"
      )
    } else if agents.count > 1 {
      Label(agents.count.formatted(), systemImage: "person.2")
        .font(OrchestratorTheme.Typography.caption)
        .foregroundStyle(theme.muted)
        .help("\(agents.count) agents")
    }
  }
}

private struct AgentTreeRow: View {
  @Environment(\.orchestratorTheme) private var theme
  let agent: AgentSession
  let allAgents: [AgentSession]
  let depth: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        Image(systemName: agent.status.symbolName)
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(agent.status.orchestratorTint(in: theme))
          .frame(width: 13)
        Text(agent.title)
          .font(OrchestratorTheme.Typography.caption)
          .foregroundStyle(theme.muted)
          .lineLimit(1)
        Spacer()
        Text(agent.providerID)
          .font(.system(size: 10))
          .foregroundStyle(theme.tertiary)
      }
      .padding(.leading, CGFloat(depth * 13))
      .accessibilityElement(children: .combine)
      .accessibilityLabel(
        "\(agent.title), \(agent.providerID), \(agent.status.accessibilityTitle)"
      )

      ForEach(allAgents.filter { $0.parentID == agent.id }) { child in
        AgentTreeRow(agent: child, allAgents: allAgents, depth: depth + 1)
      }
    }
  }
}

private struct StatusDot: View {
  @Environment(\.orchestratorTheme) private var theme
  let status: TaskStatus

  var body: some View {
    Circle()
      .fill(status.orchestratorTint(in: theme))
      .frame(width: 7, height: 7)
      .shadow(
        color: status == .running
          ? status.orchestratorTint(in: theme).opacity(0.55)
          : .clear,
        radius: 3
      )
      .accessibilityLabel(status.displayName)
  }
}

extension TaskStatus {
  var displayName: String {
    switch self {
    case .preparing: "Preparing"
    case .running: "Running"
    case .needsAttention: "Needs Attention"
    case .reviewReady: "Review Ready"
    case .shipped: "Shipped"
    case .failed: "Failed"
    case .archived: "Archived"
    }
  }

  var tint: Color {
    switch self {
    case .preparing: .blue
    case .running: .green
    case .needsAttention: .orange
    case .reviewReady: .purple
    case .shipped: .mint
    case .failed: .red
    case .archived: .gray
    }
  }
}

extension AgentStatus {
  var tint: Color {
    switch self {
    case .launching: .blue
    case .running: .green
    case .waitingForApproval, .waitingForInput: .orange
    case .idle: .secondary
    case .completed: .mint
    case .failed: .red
    case .interrupted, .disconnected: .gray
    }
  }

  var symbolName: String {
    switch self {
    case .launching: "circle.dotted"
    case .running: "waveform"
    case .waitingForApproval: "hand.raised.fill"
    case .waitingForInput: "text.bubble.fill"
    case .idle: "pause.circle"
    case .completed: "checkmark.circle.fill"
    case .failed: "exclamationmark.triangle.fill"
    case .interrupted: "stop.circle"
    case .disconnected: "bolt.slash"
    }
  }

  var accessibilityTitle: String {
    switch self {
    case .launching: "launching"
    case .running: "running"
    case .waitingForApproval: "waiting for approval"
    case .waitingForInput: "waiting for input"
    case .idle: "idle"
    case .completed: "completed"
    case .failed: "failed"
    case .interrupted: "interrupted"
    case .disconnected: "disconnected"
    }
  }
}
