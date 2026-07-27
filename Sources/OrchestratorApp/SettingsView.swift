import SwiftUI

struct SettingsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  @AppStorage("externalEditor") private var externalEditor = ExternalEditor.system.rawValue
  @AppStorage("appearance") private var appearance = OrchestratorAppearance.system.rawValue

  var body: some View {
    TabView {
      Form {
        Picker("External editor", selection: $externalEditor) {
          ForEach(ExternalEditor.allCases, id: \.rawValue) { editor in
            Text(editor.label).tag(editor.rawValue)
          }
        }
        Picker("Appearance", selection: $appearance) {
          ForEach(OrchestratorAppearance.allCases) { appearance in
            Text(appearance.title).tag(appearance.rawValue)
          }
        }
        LabeledContent("Terminal scrollback") {
          Text("Bounded to 2 MB per terminal")
            .foregroundStyle(.secondary)
        }
        Text(
          "Notifications are sent for completion, input, approvals, setup failures, "
            + "and provider crashes."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      .formStyle(.grouped)
      .scrollContentBackground(.hidden)
      .background(theme.surface0)
      .padding()
      .tabItem {
        Label("General", systemImage: "gear")
      }

      VStack(alignment: .leading, spacing: 16) {
        LabeledContent("Background helper") {
          Text(model.backgroundServiceStatus)
            .foregroundStyle(.secondary)
        }
        Text(
          "The helper owns provider processes, services, Git operations, "
            + "and persistent event storage when the app is closed."
        )
        .foregroundStyle(.secondary)
        Button("Register Background Helper") {
          model.registerBackgroundService()
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .primary))
        Spacer()
      }
      .padding(24)
      .foregroundStyle(theme.foreground)
      .background(theme.surface0)
      .tabItem {
        Label("Helper", systemImage: "bolt.horizontal.circle")
      }

      ProviderSettingsView()
        .tabItem {
          Label("Providers", systemImage: "cpu")
        }

      VStack(alignment: .leading, spacing: 12) {
        Label("Private by default", systemImage: "lock.shield.fill")
          .font(.title2.bold())
          .foregroundStyle(theme.success)
        Text(
          "State stays in your user Application Support directory. "
            + "Orchestrator stores no provider credentials and sends no telemetry."
        )
        .foregroundStyle(.secondary)
        Button("Export Redacted Diagnostics…") {
          model.exportDiagnostics()
        }
        Spacer()
      }
      .padding(24)
      .foregroundStyle(theme.foreground)
      .background(theme.surface0)
      .tabItem {
        Label("Privacy", systemImage: "hand.raised")
      }
    }
    .background(theme.surface0)
  }
}

enum ExternalEditor: String, CaseIterable {
  case system
  case visualStudioCode
  case cursor
  case zed

  var label: String {
    switch self {
    case .system: "System default"
    case .visualStudioCode: "Visual Studio Code"
    case .cursor: "Cursor"
    case .zed: "Zed"
    }
  }

  var executableName: String? {
    switch self {
    case .system: nil
    case .visualStudioCode: "code"
    case .cursor: "cursor"
    case .zed: "zed"
    }
  }
}
