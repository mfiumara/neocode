import AppKit
import OrchestratorCore
import SwiftUI

struct AgentPanel: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let task: OrchestrationTask
  var initialAgentID: String? = nil

  @State private var selectedAgentID: String?
  @State private var message = ""
  @State private var shouldSteer = false
  @State private var showsChildAgent = false

  var body: some View {
    VStack(spacing: 0) {
      agentBar
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)
      timeline
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)
      composer
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(theme.surface0)
    .onAppear {
      if let initialAgentID, agents.contains(where: { $0.id == initialAgentID }) {
        selectedAgentID = initialAgentID
      }
      selectAgentIfNeeded()
    }
    .onChange(of: agents.map(\.id)) { selectAgentIfNeeded() }
    .onChange(of: selectedAgentID) {
      shouldSteer = false
    }
    .sheet(isPresented: $showsChildAgent) {
      LaunchAgentSheet(
        task: task,
        parentAgentID: selectedAgentID
      ) {
        showsChildAgent = false
      }
    }
  }

  private var agents: [AgentSession] {
    model.agents(for: task.id)
      .sorted { $0.createdAt < $1.createdAt }
  }

  private var selectedAgent: AgentSession? {
    agents.first { $0.id == selectedAgentID }
  }

  private var visibleEvents: [AgentEvent] {
    let all = model.eventsByTask[task.id] ?? []
    guard let selectedAgentID else { return all }
    return all.filter { $0.agentID == selectedAgentID || $0.agentID == nil }
  }

  private var timelineItems: [AgentTimelineItem] {
    AgentTimelineProjection.items(from: visibleEvents)
  }

  private var agentBar: some View {
    HStack(spacing: 10) {
      if agents.count > 1 {
        Picker("Agent", selection: $selectedAgentID) {
          Text("Select Agent")
            .tag(Optional<String>.none)
          ForEach(agents) { agent in
            Label(agent.title, systemImage: agent.status.symbolName)
              .tag(Optional(agent.id))
          }
        }
        .labelsHidden()
        .frame(minWidth: 170, maxWidth: 260)
      } else if let selectedAgent {
        Label(selectedAgent.title, systemImage: selectedAgent.status.symbolName)
          .font(.callout.weight(.semibold))
          .foregroundStyle(.primary)
          .lineLimit(1)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(selectedAgent.title)
      } else {
        Label("No agent", systemImage: "sparkles")
          .font(.callout.weight(.semibold))
          .foregroundStyle(.secondary)
      }

      if let selectedAgent {
        AgentStatusBadge(status: selectedAgent.status)
        Text(providerLabel(selectedAgent.providerID))
          .font(OrchestratorTheme.Typography.caption)
          .foregroundStyle(theme.tertiary)
      }

      Spacer(minLength: 12)

      if let selectedAgent, selectedAgent.status.canInterrupt {
        Button {
          Task { await model.interrupt(agentID: selectedAgent.id) }
        } label: {
          Label("Stop", systemImage: "stop.fill")
        }
        .buttonStyle(
          OrchestratorButtonStyle(variant: .secondary, compact: true)
        )
        .help("Interrupt the active turn")
      }

      Button {
        showsChildAgent = true
      } label: {
        Label(
          selectedAgent == nil ? "Launch Agent" : "Delegate",
          systemImage: selectedAgent == nil ? "plus" : "person.2.badge.plus"
        )
      }
      .buttonStyle(
        OrchestratorButtonStyle(variant: .primary, compact: true)
      )
    }
    .padding(.horizontal, 10)
    .frame(height: 36)
    .background(theme.surface1)
  }

  @ViewBuilder
  private var timeline: some View {
    if agents.isEmpty {
      ContentUnavailableView {
        Label("No agent yet", systemImage: "sparkles")
      } description: {
        Text("Launch Codex, Claude, or an ACP agent in this worktree.")
      } actions: {
        Button {
          showsChildAgent = true
        } label: {
          Label("Launch Agent", systemImage: "plus")
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .primary))
      }
    } else if timelineItems.isEmpty {
      ContentUnavailableView {
        Label(
          selectedAgent?.status.isWorking == true
            ? "Agent is starting"
            : "No conversation yet",
          systemImage: selectedAgent?.status.isWorking == true
            ? "ellipsis.message"
            : "bubble.left.and.bubble.right"
        )
      } description: {
        Text(
          selectedAgent?.status.isWorking == true
            ? "Waiting for the first response."
            : "Send a message below to start a new turn."
        )
      }
    } else {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(timelineItems) { item in
              AgentTimelineRow(item: item)
                .id(item.id)
            }
          }
          .frame(maxWidth: 860)
          .frame(maxWidth: .infinity)
          .padding(.horizontal, 24)
          .padding(.vertical, 18)
        }
        .background(theme.surface0)
        .onAppear {
          scrollToLatest(using: proxy)
        }
        .onChange(of: timelineItems.last?.lastSequence) {
          scrollToLatest(using: proxy)
        }
      }
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(alignment: .bottom, spacing: 9) {
        TextField(
          selectedAgent.map { "Message \($0.title)…" } ?? "Select an agent",
          text: $message,
          axis: .vertical
        )
        .lineLimit(1...5)
        .textFieldStyle(.plain)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
          theme.surface2,
          in: .rect(cornerRadius: OrchestratorTheme.Radius.large)
        )
        .overlay {
          RoundedRectangle(cornerRadius: OrchestratorTheme.Radius.large)
            .stroke(theme.borderStrong, lineWidth: 1)
        }
        .disabled(selectedAgent == nil)
        .accessibilityLabel("Message the selected agent")

        Button {
          send()
        } label: {
          Label("Send", systemImage: "paperplane.fill")
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .primary))
        .keyboardShortcut(.return, modifiers: [.command])
        .disabled(!canSend)
      }

      if supportsSteering, selectedAgent?.status.canInterrupt == true {
        Toggle("Steer the active turn", isOn: $shouldSteer)
          .toggleStyle(.checkbox)
          .font(.caption)
          .foregroundStyle(theme.muted)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .background(theme.surface1)
  }

  private var canSend: Bool {
    selectedAgentID != nil
      && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var supportsSteering: Bool {
    guard let selectedAgent else { return false }
    return providerCapabilities(selectedAgent.providerID).contains(.steer)
  }

  private func selectAgentIfNeeded() {
    if selectedAgentID == nil
      || !agents.contains(where: { $0.id == selectedAgentID })
    {
      selectedAgentID = agents.last?.id
    }
  }

  private func providerCapabilities(_ providerID: String) -> ProviderCapabilities {
    model.providerInspections.first {
      $0.descriptor.id == providerID
    }?.descriptor.capabilities ?? []
  }

  private func providerLabel(_ providerID: String) -> String {
    model.providerInspections.first {
      $0.descriptor.id == providerID
    }?.descriptor.label ?? providerID.capitalized
  }

  private func scrollToLatest(using proxy: ScrollViewProxy) {
    guard let id = timelineItems.last?.id else { return }
    DispatchQueue.main.async {
      proxy.scrollTo(id, anchor: .bottom)
    }
  }

  private func send() {
    guard let selectedAgentID else { return }
    let outgoing = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !outgoing.isEmpty else { return }
    message = ""
    Task {
      await model.sendMessage(
        agentID: selectedAgentID,
        text: outgoing,
        steer: shouldSteer
      )
    }
  }
}

private struct AgentTimelineRow: View {
  @Environment(\.orchestratorTheme) private var theme
  let item: AgentTimelineItem
  @State private var isActivityExpanded = false

  var body: some View {
    switch item.kind {
    case .userMessage:
      userMessage
    case .agentMessage:
      agentMessage
    case .reasoning:
      reasoning
    case .activity:
      activity
    case .notice:
      notice
    case .error:
      error
    }
  }

  private var userMessage: some View {
    HStack(alignment: .top) {
      Spacer(minLength: 90)
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text("You")
            .font(.caption.weight(.semibold))
          Spacer()
          timestamp
        }
        messageText
      }
      .padding(.horizontal, 13)
      .padding(.vertical, 10)
      .frame(maxWidth: 650, alignment: .leading)
      .background(
        theme.accent.opacity(theme.isDark ? 0.13 : 0.1),
        in: .rect(cornerRadius: OrchestratorTheme.Radius.large)
      )
    }
  }

  private var agentMessage: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "sparkles")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(theme.accent)
        .frame(width: 20, height: 24)

      VStack(alignment: .leading, spacing: 7) {
        HStack {
          Text("Agent")
            .font(.caption.weight(.semibold))
          if item.isInProgress {
            ProgressView()
              .controlSize(.mini)
          }
          Spacer()
          timestamp
        }
        messageText
      }
      .padding(.vertical, 4)
      .frame(maxWidth: 790, alignment: .leading)

      Spacer(minLength: 60)
    }
  }

  private var reasoning: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "brain.head.profile")
        .foregroundStyle(theme.tertiary)
        .frame(width: 20)
      DisclosureGroup {
        Text(item.text)
          .font(.callout)
          .foregroundStyle(theme.muted)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.top, 5)
      } label: {
        HStack {
          Text("Reasoning")
            .font(.caption.weight(.semibold))
          Spacer()
          timestamp
        }
      }
      .frame(maxWidth: 790)
      Spacer(minLength: 60)
    }
    .padding(.vertical, 2)
  }

  private var activity: some View {
    DisclosureGroup(isExpanded: $isActivityExpanded) {
      if !item.text.isEmpty {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "terminal")
            .font(.system(size: 11))
            .foregroundStyle(theme.tertiary)
          Text(item.text)
            .font(OrchestratorTheme.Typography.caption.monospaced())
            .foregroundStyle(theme.muted)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 7)
      }
    } label: {
      HStack(spacing: 8) {
        if item.isInProgress {
          ProgressView()
            .controlSize(.mini)
            .frame(width: 16)
        } else {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(theme.success)
            .frame(width: 16)
        }
        Text(item.title)
          .font(OrchestratorTheme.Typography.captionMedium)
        if !item.text.isEmpty && !isActivityExpanded {
          Text(item.text)
            .font(OrchestratorTheme.Typography.caption.monospaced())
            .foregroundStyle(theme.tertiary)
            .lineLimit(1)
        }
        Spacer()
        timestamp
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .frame(maxWidth: 830)
    .background(
      theme.surface1,
      in: .rect(cornerRadius: OrchestratorTheme.Radius.medium)
    )
    .overlay {
      RoundedRectangle(cornerRadius: OrchestratorTheme.Radius.medium)
        .stroke(theme.border, lineWidth: 1)
    }
  }

  private var notice: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "hand.raised.fill")
        .foregroundStyle(theme.warning)
        .frame(width: 20)
      VStack(alignment: .leading, spacing: 3) {
        Text(item.title)
          .font(.caption.weight(.semibold))
        Text(item.text)
          .font(.callout)
          .textSelection(.enabled)
      }
      Spacer()
      timestamp
    }
    .padding(11)
    .frame(maxWidth: 830)
    .background(
      theme.warning.opacity(0.08),
      in: .rect(cornerRadius: OrchestratorTheme.Radius.large)
    )
  }

  private var error: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(theme.danger)
        .frame(width: 20)
      VStack(alignment: .leading, spacing: 3) {
        Text("Error")
          .font(.caption.weight(.semibold))
        Text(item.text)
          .font(.callout)
          .textSelection(.enabled)
      }
      Spacer()
      timestamp
    }
    .padding(11)
    .frame(maxWidth: 830)
    .background(
      theme.danger.opacity(0.08),
      in: .rect(cornerRadius: OrchestratorTheme.Radius.large)
    )
  }

  private var messageText: some View {
    Text(markdownText)
      .font(OrchestratorTheme.Typography.body)
      .foregroundStyle(theme.foreground)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var markdownText: AttributedString {
    (
      try? AttributedString(
        markdown: item.text,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
      )
    ) ?? AttributedString(item.text)
  }

  private var timestamp: some View {
    Text(item.timestamp, style: .time)
      .font(.caption2)
      .foregroundStyle(theme.tertiary)
  }
}

private struct AgentStatusBadge: View {
  @Environment(\.orchestratorTheme) private var theme
  let status: AgentStatus

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(status.orchestratorTint(in: theme))
        .frame(width: 6, height: 6)
      Text(status.displayName)
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(theme.muted)
    .accessibilityElement(children: .combine)
  }
}

extension AgentStatus {
  fileprivate var canInterrupt: Bool {
    switch self {
    case .launching, .running, .waitingForApproval, .waitingForInput:
      true
    case .idle, .completed, .failed, .interrupted, .disconnected:
      false
    }
  }

  fileprivate var isWorking: Bool {
    self == .launching || self == .running
  }

  fileprivate var displayName: String {
    switch self {
    case .launching: "Starting"
    case .running: "Running"
    case .waitingForApproval: "Needs approval"
    case .waitingForInput: "Needs input"
    case .idle: "Idle"
    case .completed: "Ready"
    case .failed: "Failed"
    case .interrupted: "Stopped"
    case .disconnected: "Disconnected"
    }
  }
}
