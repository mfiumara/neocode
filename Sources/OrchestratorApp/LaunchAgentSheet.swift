import OrchestratorCore
import SwiftUI

struct LaunchAgentSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let task: OrchestrationTask
  let parentAgentID: String?
  let dismiss: () -> Void

  @State private var title = ""
  @State private var prompt = ""
  @State private var providerID = "codex"
  @State private var modelID = ""
  @State private var modeID = ""
  @State private var isLaunching = false
  @FocusState private var promptIsFocused: Bool

  init(
    task: OrchestrationTask,
    parentAgentID: String? = nil,
    dismiss: @escaping () -> Void
  ) {
    self.task = task
    self.parentAgentID = parentAgentID
    self.dismiss = dismiss
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 4) {
        Text(parentAgentID == nil ? "Launch Agent" : "Launch Child Agent")
          .font(.title2.bold())
          .foregroundStyle(theme.foreground)
        Text(task.title)
          .foregroundStyle(theme.muted)
      }

      Form {
        TextField("Name", text: $title)
        TextField("Prompt", text: $prompt, axis: .vertical)
          .lineLimit(5...12)
          .focused($promptIsFocused)
        Picker("Provider", selection: $providerID) {
          ForEach(model.providerInspections, id: \.descriptor.id) { inspection in
            HStack {
              Text(inspection.descriptor.label)
              if !inspection.available {
                Text("Unavailable")
                  .foregroundStyle(.secondary)
              }
            }
            .tag(inspection.descriptor.id)
          }
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
            ForEach(availableModes) { providerMode in
              Text(providerMode.label).tag(providerMode.id)
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
        if isLaunching {
          ProgressView()
            .controlSize(.small)
        }
        Button("Launch") {
          Task { await launch() }
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .primary))
        .keyboardShortcut(.defaultAction)
        .disabled(
          title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !selectedProviderAvailable || isLaunching
        )
      }
    }
    .padding(24)
    .frame(width: 620)
    .foregroundStyle(theme.foreground)
    .background(theme.surface0)
    .onAppear {
      title = parentAgentID == nil ? task.title : "Delegate"
      prompt = parentAgentID == nil ? task.goal : ""
      if let preferred = model.providerInspections.first(where: \.available) {
        providerID = preferred.descriptor.id
      }
      DispatchQueue.main.async {
        promptIsFocused = true
      }
    }
    .onChange(of: providerID) {
      modelID = ""
      modeID = ""
    }
  }

  private var selectedInspection: ProviderInspection? {
    model.providerInspections.first { $0.descriptor.id == providerID }
  }

  private var selectedProviderAvailable: Bool {
    selectedInspection?.available == true
  }

  private var availableModels: [ProviderModel] {
    selectedInspection?.models ?? []
  }

  private var availableModes: [ProviderMode] {
    selectedInspection?.modes ?? []
  }

  private func launch() async {
    isLaunching = true
    await model.launchAgent(
      taskID: task.id,
      title: title.trimmingCharacters(in: .whitespacesAndNewlines),
      providerID: providerID,
      prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
      model: modelID.isEmpty ? nil : modelID,
      mode: modeID.isEmpty ? nil : modeID,
      parentID: parentAgentID
    )
    isLaunching = false
    if model.alertMessage == nil {
      dismiss()
    }
  }
}

extension ProviderInspection {
  fileprivate var available: Bool {
    if case .available = availability { return true }
    return false
  }
}
