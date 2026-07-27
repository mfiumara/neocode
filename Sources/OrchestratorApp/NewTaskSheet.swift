import OrchestratorCore
import SwiftUI

struct NewTaskSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let project: Project
  let dismiss: () -> Void
  @State private var title = ""
  @State private var goal = ""
  @State private var baseRef = "HEAD"
  @State private var branchName = ""
  @State private var useWorktree = true
  @State private var launchImmediately = true
  @State private var providerID = "codex"
  @State private var modelID = ""
  @State private var modeID = ""
  @State private var isWorking = false
  @State private var lastSuggestedBranch = ""
  @FocusState private var titleIsFocused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack {
        VStack(alignment: .leading) {
          Text("New Task")
            .font(.title2.bold())
            .foregroundStyle(theme.foreground)
          Text(project.name)
            .foregroundStyle(theme.muted)
        }
        Spacer()
        Image(systemName: "arrow.triangle.branch")
          .font(.largeTitle)
          .foregroundStyle(theme.accent)
          .accessibilityHidden(true)
      }

      Form {
        TextField("Title", text: $title)
          .focused($titleIsFocused)
        TextField("What should the agent accomplish?", text: $goal, axis: .vertical)
          .lineLimit(3...7)
        LabeledContent("Base revision") {
          TextField("HEAD", text: $baseRef)
            .textFieldStyle(.roundedBorder)
            .frame(width: 250)
        }
        LabeledContent("Branch") {
          TextField("orch/task-name", text: $branchName)
            .textFieldStyle(.roundedBorder)
            .frame(width: 250)
        }
        Toggle("Create an isolated Git worktree", isOn: $useWorktree)
        Toggle("Launch an agent after setup", isOn: $launchImmediately)

        if launchImmediately {
          Picker("Provider", selection: $providerID) {
            ForEach(model.providerInspections, id: \.descriptor.id) { inspection in
              HStack {
                Text(inspection.descriptor.label)
                if !inspection.isAvailable {
                  Text("Unavailable")
                    .foregroundStyle(.secondary)
                }
              }
              .tag(inspection.descriptor.id)
            }
          }
          if let selectedProviderIssue {
            Text(selectedProviderIssue)
              .font(.caption)
              .foregroundStyle(theme.warning)
          }
          if !availableModels.isEmpty {
            Picker("Model", selection: $modelID) {
              Text("Provider default").tag("")
              ForEach(availableModels) { providerModel in
                Text(providerModel.label).tag(providerModel.id)
              }
            }
          }
          if !availableModes.isEmpty {
            Picker("Permissions", selection: $modeID) {
              Text("Provider default").tag("")
              ForEach(availableModes) { mode in
                Text(mode.label).tag(mode.id)
              }
            }
          }
        }
      }
      .formStyle(.grouped)
      .scrollContentBackground(.hidden)

      HStack {
        Button("Cancel", role: .cancel) { dismiss() }
          .keyboardShortcut(.cancelAction)
          .buttonStyle(OrchestratorButtonStyle(variant: .ghost))
        Spacer()
        if isWorking {
          ProgressView()
            .controlSize(.small)
        }
        Button("Create Task") {
          Task { await create() }
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .primary))
        .keyboardShortcut(.defaultAction)
        .disabled(
          title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || baseRef.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || branchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || (launchImmediately && !selectedProviderAvailable) || isWorking
        )
      }
    }
    .padding(24)
    .frame(width: 620)
    .foregroundStyle(theme.foreground)
    .background(theme.surface0)
    .onChange(of: title) {
      let suggestion = WorktreeManager.suggestedBranchName(for: title)
      if branchName.isEmpty || branchName == lastSuggestedBranch {
        branchName = suggestion
      }
      lastSuggestedBranch = suggestion
    }
    .onAppear {
      if baseRef == "HEAD" {
        baseRef = project.defaultBranch
      }
      if let first = model.providerInspections.first(where: { $0.isAvailable }) {
        providerID = first.descriptor.id
      }
      DispatchQueue.main.async {
        titleIsFocused = true
      }
    }
    .onChange(of: providerID) {
      modelID = ""
      modeID = ""
    }
    .alert(
      "Trust project configuration?",
      isPresented: Binding(
        get: {
          model.pendingTrustRequirement?.projectID == project.id
        },
        set: {
          if !$0 {
            model.cancelConfigurationTrust()
            isWorking = false
          }
        }
      )
    ) {
      Button("Cancel", role: .cancel) {
        model.cancelConfigurationTrust()
        isWorking = false
      }
      Button("Trust & Continue") {
        Task { await trustAndContinue() }
      }
    } message: {
      if let requirement = model.pendingTrustRequirement {
        Text(requirement.reviewText)
      }
    }
  }

  private var selectedInspection: ProviderInspection? {
    model.providerInspections.first { $0.descriptor.id == providerID }
  }

  private var availableModels: [ProviderModel] {
    selectedInspection?.models ?? []
  }

  private var availableModes: [ProviderMode] {
    selectedInspection?.modes ?? []
  }

  private var selectedProviderAvailable: Bool {
    guard let selectedInspection else { return false }
    if case .available = selectedInspection.availability {
      return true
    }
    return false
  }

  private var selectedProviderIssue: String? {
    guard let selectedInspection else {
      return "Choose an installed provider."
    }
    switch selectedInspection.availability {
    case .available:
      return nil
    case .unavailable(let reason):
      return reason
    case .unsupported(_, _, let reason):
      return reason
    }
  }

  private func create() async {
    isWorking = true
    let request = CreateTaskRequest(
      projectID: project.id,
      title: title.trimmingCharacters(in: .whitespacesAndNewlines),
      goal: goal.trimmingCharacters(in: .whitespacesAndNewlines),
      baseRef: baseRef.trimmingCharacters(in: .whitespacesAndNewlines),
      branchName: branchName.trimmingCharacters(in: .whitespacesAndNewlines),
      useWorktree: useWorktree
    )
    let task = await model.createTask(request)
    if model.pendingTrustRequirement != nil {
      isWorking = false
      return
    }
    guard let task else {
      isWorking = false
      return
    }
    await finish(task: task)
  }

  private func trustAndContinue() async {
    isWorking = true
    guard let task = await model.trustConfigurationAndCreateTask() else {
      isWorking = false
      return
    }
    await finish(task: task)
  }

  private func finish(task: OrchestrationTask) async {
    if launchImmediately {
      await model.launchAgent(
        taskID: task.id,
        title: title,
        providerID: providerID,
        prompt: goal,
        model: modelID.isEmpty ? nil : modelID,
        mode: modeID.isEmpty ? nil : modeID
      )
    }
    isWorking = false
    dismiss()
  }
}

extension ConfigurationTrustRequirement {
  fileprivate var reviewText: String {
    var sections = [
      "Configuration hash: \(hash)",
      "Setup commands:\n"
        + (setupCommands.isEmpty ? "(none)" : setupCommands.joined(separator: "\n")),
    ]
    if !teardownCommands.isEmpty {
      sections.append(
        "Teardown commands:\n" + teardownCommands.joined(separator: "\n")
      )
    }
    return sections.joined(separator: "\n\n")
  }
}

extension ProviderInspection {
  fileprivate var isAvailable: Bool {
    if case .available = availability { return true }
    return false
  }
}
