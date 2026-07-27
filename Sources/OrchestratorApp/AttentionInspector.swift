import OrchestratorCore
import SwiftUI

struct AttentionInspector: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Label("Attention", systemImage: "checklist.unchecked")
          .font(OrchestratorTheme.Typography.title)
        Spacer()
        Text("\(inputs.count + approvals.count + failures.count)")
          .font(.caption.bold())
          .foregroundStyle(
            inputs.isEmpty && approvals.isEmpty && failures.isEmpty
              ? theme.tertiary
              : theme.warning
          )
        Button {
          model.isInspectorPresented = false
        } label: {
          Image(systemName: "xmark")
            .frame(width: 24, height: 24)
            .contentShape(.rect)
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 26))
        .help("Close Attention")
        .accessibilityLabel("Close Attention")
      }
      .padding(.horizontal, 10)
      .frame(height: 40)
      .background(theme.surface1)

      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      if inputs.isEmpty && approvals.isEmpty && failures.isEmpty {
        ContentUnavailableView {
          Label("All clear", systemImage: "checkmark.circle")
        } description: {
          Text("Questions, approvals, and provider failures appear here.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollView {
          LazyVStack(spacing: 6) {
            ForEach(inputs) { input in
              InputRequestCard(projectID: projectID, input: input)
            }
            ForEach(approvals) { approval in
              ApprovalCard(projectID: projectID, approval: approval)
            }
            ForEach(failures) { failure in
              FailureCard(projectID: projectID, failure: failure)
            }
          }
          .padding(8)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .foregroundStyle(theme.foreground)
    .background(theme.sidebar)
  }

  private var approvals: [Approval] {
    model.pendingApprovals(for: projectID)
  }

  private var inputs: [AgentInputRequest] {
    model.pendingInputRequests(for: projectID)
  }

  private var failures: [AttentionFailure] {
    let snapshot = model.snapshot(for: projectID)
    var failures = snapshot.tasks.compactMap { task -> AttentionFailure? in
      guard task.status == .failed,
        !snapshot.agents.contains(where: { $0.taskID == task.id })
      else {
        return nil
      }
      return AttentionFailure(
        id: "task:\(task.id)",
        taskID: task.id,
        title: "Task setup failed",
        summary: task.title,
        kind: .task
      )
    }
    failures += snapshot.agents.compactMap { agent -> AttentionFailure? in
      guard agent.status == .failed || agent.status == .disconnected else {
        return nil
      }
      return AttentionFailure(
        id: "agent:\(agent.id)",
        taskID: agent.taskID,
        title: agent.status == .disconnected
          ? "Provider disconnected"
          : "Agent failed",
        summary: agent.title,
        kind: .agent
      )
    }
    failures += snapshot.services.compactMap { service -> AttentionFailure? in
      guard service.status == .failed || service.status == .orphaned else {
        return nil
      }
      return AttentionFailure(
        id: "service:\(service.id)",
        taskID: service.taskID,
        title: service.status == .orphaned
          ? "Service needs reattachment"
          : "Service failed",
        summary: service.name,
        kind: .service
      )
    }
    return failures
  }
}

private struct InputRequestCard: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let input: AgentInputRequest
  @State private var answers: [String: String] = [:]
  @State private var isResponding = false

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      Label(input.title, systemImage: "questionmark.bubble.fill")
        .font(OrchestratorTheme.Typography.bodyMedium)
        .foregroundStyle(theme.accent)

      taskContext(taskID: input.taskID)

      ForEach(input.questions) { question in
        VStack(alignment: .leading, spacing: 6) {
          Text(question.header)
            .font(OrchestratorTheme.Typography.captionMedium)
            .foregroundStyle(theme.muted)
          Text(question.question)
            .font(OrchestratorTheme.Typography.body)
            .textSelection(.enabled)

          if question.isSecret {
            SecureField("Response", text: answer(for: question.id))
              .textFieldStyle(.plain)
              .attentionTextField()
          } else {
            if !question.options.isEmpty {
              Picker("Response", selection: answer(for: question.id)) {
                Text("Choose an option…").tag("")
                ForEach(question.options, id: \.self) { option in
                  Text(option.label).tag(option.label)
                }
              }
              .labelsHidden()
              .pickerStyle(.menu)

              if let selected = question.options.first(where: {
                $0.label == answers[question.id]
              }), !selected.description.isEmpty {
                Text(selected.description)
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
            if question.allowsFreeform || question.options.isEmpty {
              TextField(
                question.options.isEmpty ? "Response" : "Or type a response",
                text: answer(for: question.id),
                axis: .vertical
              )
              .textFieldStyle(.plain)
              .attentionTextField()
              .lineLimit(1...4)
            }
          }
        }
      }

      if input.questions.isEmpty {
        Text("The provider sent an unsupported question format.")
          .font(.callout)
          .foregroundStyle(theme.muted)
      }

      if isResponding {
        ProgressView()
          .controlSize(.small)
      } else {
        HStack {
          Button("Cancel", role: .cancel) {
            respond(cancelled: true)
          }
          Spacer()
          Button("Submit") {
            respond(cancelled: false)
          }
          .buttonStyle(OrchestratorButtonStyle(variant: .primary, compact: true))
          .disabled(!hasCompleteAnswers)
        }
        .controlSize(.small)
      }
    }
    .attentionRow(tint: theme.accent)
  }

  private var hasCompleteAnswers: Bool {
    !input.questions.isEmpty
      && input.questions.allSatisfy {
        !(answers[$0.id] ?? "")
          .trimmingCharacters(in: .whitespacesAndNewlines)
          .isEmpty
      }
  }

  private func taskContext(taskID: String) -> some View {
    Button {
      model.selectedTaskByProject[projectID] = taskID
    } label: {
      Label(taskTitle(taskID), systemImage: "shippingbox")
        .font(.caption)
        .foregroundStyle(theme.muted)
    }
    .buttonStyle(.plain)
    .help("Select worktree")
  }

  private func taskTitle(_ taskID: String) -> String {
    model.snapshot(for: projectID).tasks
      .first { $0.id == taskID }?
      .title ?? "Unknown worktree"
  }

  private func answer(for questionID: String) -> Binding<String> {
    Binding(
      get: { answers[questionID, default: ""] },
      set: { answers[questionID] = $0 }
    )
  }

  private func respond(cancelled: Bool) {
    isResponding = true
    let payload = Dictionary(
      uniqueKeysWithValues: input.questions.compactMap { question in
        let value = (answers[question.id] ?? "")
          .trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : (question.id, [value])
      }
    )
    Task {
      await model.respondToInput(
        id: input.id,
        answers: payload,
        cancelled: cancelled
      )
      isResponding = false
    }
  }
}

private struct ApprovalCard: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let approval: Approval
  @State private var isResolving = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(approval.title, systemImage: approval.kind.symbol)
        .font(OrchestratorTheme.Typography.bodyMedium)
        .foregroundStyle(theme.warning)
      Button {
        model.selectedTaskByProject[projectID] = approval.taskID
      } label: {
        Label(taskTitle, systemImage: "shippingbox")
          .font(.caption)
          .foregroundStyle(theme.muted)
      }
      .buttonStyle(.plain)
      .help("Select worktree")
      Text(approval.summary)
        .font(OrchestratorTheme.Typography.body)
        .textSelection(.enabled)

      if let command = approval.details["command"]?.stringValue {
        Text(command)
          .font(.caption.monospaced())
          .foregroundStyle(theme.muted)
          .textSelection(.enabled)
          .padding(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(theme.surface0, in: .rect(cornerRadius: 6))
          .overlay {
            RoundedRectangle(cornerRadius: 6)
              .stroke(theme.border, lineWidth: 1)
          }
      }

      if isResolving {
        ProgressView()
          .controlSize(.small)
      } else {
        HStack(spacing: 7) {
          if supports("supportsDeny") {
            Button("Deny", role: .destructive) {
              resolve(.deny)
            }
            .buttonStyle(
              OrchestratorButtonStyle(variant: .ghost, compact: true)
            )
          }
          Spacer()
          if supports("supportsAllowOnce") {
            Button("Allow Once") {
              resolve(.allowOnce)
            }
            .buttonStyle(
              OrchestratorButtonStyle(variant: .secondary, compact: true)
            )
          }
          if supports("supportsAllowForSession") {
            Button("Allow Session") {
              resolve(.allowForSession)
            }
            .buttonStyle(
              OrchestratorButtonStyle(variant: .primary, compact: true)
            )
          }
        }
        .controlSize(.small)
      }
    }
    .attentionRow(tint: theme.warning)
  }

  private func resolve(_ decision: ApprovalDecision) {
    isResolving = true
    Task {
      await model.resolveApproval(id: approval.id, decision: decision)
      isResolving = false
    }
  }

  private func supports(_ key: String) -> Bool {
    approval.details[key] != .bool(false)
  }

  private var taskTitle: String {
    model.snapshot(for: projectID).tasks
      .first { $0.id == approval.taskID }?
      .title ?? "Unknown worktree"
  }
}

private struct FailureCard: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let failure: AttentionFailure

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(failure.title, systemImage: failure.kind.symbol)
        .font(OrchestratorTheme.Typography.bodyMedium)
        .foregroundStyle(theme.danger)
      Text(failure.summary)
        .font(OrchestratorTheme.Typography.body)
        .textSelection(.enabled)
      HStack {
        Button("Select Task") {
          model.selectedTaskByProject[projectID] = failure.taskID
        }
        if let workspacePath {
          Button("Reveal") {
            model.reveal(workspacePath)
          }
        }
        Spacer()
        if failure.kind == .task {
          Button("Skip Setup") {
            recover(.skipSetup)
          }
          Button("Retry") {
            recover(.retrySetup)
          }
          .buttonStyle(
            OrchestratorButtonStyle(variant: .primary, compact: true)
          )
        }
      }
      .controlSize(.small)
    }
    .attentionRow(tint: theme.danger)
  }

  private var workspacePath: String? {
    model.snapshot(for: projectID).workspaces
      .first { $0.taskID == failure.taskID }?
      .path
  }

  private func recover(_ action: TaskRecoveryAction) {
    Task {
      await model.recoverTask(
        projectID: projectID,
        taskID: failure.taskID,
        action: action
      )
    }
  }
}

private struct AttentionFailure: Identifiable {
  enum Kind: Equatable {
    case task
    case agent
    case service

    var symbol: String {
      switch self {
      case .task: "hammer.fill"
      case .agent: "person.crop.circle.badge.exclamationmark"
      case .service: "bolt.trianglebadge.exclamationmark.fill"
      }
    }
  }

  var id: String
  var taskID: String
  var title: String
  var summary: String
  var kind: Kind
}

extension ApprovalKind {
  fileprivate var symbol: String {
    switch self {
    case .command: "terminal"
    case .fileChange: "doc.badge.ellipsis"
    case .permissions: "lock.shield"
    case .childAgent: "person.2.badge.plus"
    case .configuration: "gearshape.2"
    case .providerSpecific: "hand.raised.fill"
    }
  }
}

private struct AttentionRowModifier: ViewModifier {
  @Environment(\.orchestratorTheme) private var theme
  let tint: Color

  func body(content: Content) -> some View {
    content
      .padding(10)
      .background(
        theme.surface1,
        in: .rect(cornerRadius: OrchestratorTheme.Radius.large)
      )
      .overlay {
        RoundedRectangle(cornerRadius: OrchestratorTheme.Radius.large)
          .stroke(theme.border, lineWidth: 1)
      }
      .overlay(alignment: .leading) {
        RoundedRectangle(cornerRadius: 1)
          .fill(tint)
          .frame(width: 2)
          .padding(.vertical, 8)
      }
  }
}

private struct AttentionTextFieldModifier: ViewModifier {
  @Environment(\.orchestratorTheme) private var theme

  func body(content: Content) -> some View {
    content
      .font(OrchestratorTheme.Typography.body)
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .background(
        theme.surface0,
        in: .rect(cornerRadius: OrchestratorTheme.Radius.medium)
      )
      .overlay {
        RoundedRectangle(cornerRadius: OrchestratorTheme.Radius.medium)
          .stroke(theme.borderStrong, lineWidth: 1)
      }
  }
}

private extension View {
  func attentionRow(tint: Color) -> some View {
    modifier(AttentionRowModifier(tint: tint))
  }

  func attentionTextField() -> some View {
    modifier(AttentionTextFieldModifier())
  }
}
