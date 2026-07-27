import OrchestratorCore
import SwiftUI

struct ProviderSettingsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let dismiss: (() -> Void)?

  init(dismiss: (() -> Void)? = nil) {
    self.dismiss = dismiss
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text("Agent Providers")
            .font(.title2.bold())
            .foregroundStyle(theme.foreground)
          Text("Orchestrator reuses each CLI’s existing login and configuration.")
            .foregroundStyle(theme.muted)
        }
        Spacer()
        Button {
          Task { await model.refreshACPRegistry() }
        } label: {
          Label("ACP Registry", systemImage: "shippingbox")
        }
        Button {
          Task { await model.refreshProviders() }
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
        if let dismiss {
          Button("Done", action: dismiss)
            .buttonStyle(OrchestratorButtonStyle(variant: .primary, compact: true))
        }
      }
      .padding(20)

      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      ScrollView {
        LazyVStack(spacing: 6) {
          ForEach(model.providerInspections, id: \.descriptor.id) { inspection in
            ProviderRow(inspection: inspection)
          }
        }
        .padding(10)
      }

      if !model.installationOutput.isEmpty {
        Rectangle()
          .fill(theme.border)
          .frame(height: 1)
        ScrollView {
          Text(model.installationOutput)
            .font(.caption.monospaced())
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
        .frame(maxHeight: 130)
        .background(theme.surface1)
      }
    }
    .background(theme.surface0)
  }
}

private struct ProviderRow: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let inspection: ProviderInspection

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: inspection.availability.symbol)
        .font(.title2)
        .foregroundStyle(inspection.availability.tint(in: theme))
        .frame(width: 34)
        .accessibilityLabel(inspection.availability.accessibilityLabel)
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(inspection.descriptor.label)
            .font(.headline)
          Text(inspection.descriptor.id)
            .font(.caption.monospaced())
            .foregroundStyle(theme.tertiary)
        }
        Text(inspection.availability.detail)
          .font(.caption)
          .foregroundStyle(theme.muted)
          .textSelection(.enabled)
        if !capabilityLabels.isEmpty {
          Text(capabilityLabels.joined(separator: " · "))
            .font(.caption2)
            .foregroundStyle(theme.tertiary)
        }
      }
      Spacer()
      if case .unavailable = inspection.availability,
        inspection.descriptor.installationCommand != nil
      {
        Button("Review Install…") {
          model.pendingInstallProvider = inspection
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .secondary, compact: true))
      }
    }
    .padding(10)
    .background(
      theme.surface1,
      in: .rect(cornerRadius: OrchestratorTheme.Radius.large)
    )
    .overlay {
      RoundedRectangle(cornerRadius: OrchestratorTheme.Radius.large)
        .stroke(theme.border, lineWidth: 1)
    }
    .confirmationDialog(
      "Run provider installation command?",
      isPresented: Binding(
        get: {
          model.pendingInstallProvider?.descriptor.id == inspection.descriptor.id
        },
        set: {
          if !$0 { model.pendingInstallProvider = nil }
        }
      ),
      titleVisibility: .visible
    ) {
      Button("Run Command") {
        model.pendingInstallProvider = nil
        Task { await model.runGuidedInstall(inspection) }
      }
      Button("Cancel", role: .cancel) {
        model.pendingInstallProvider = nil
      }
    } message: {
      Text(inspection.descriptor.installationCommand ?? "")
    }
  }

  private var capabilityLabels: [String] {
    let capabilities = inspection.descriptor.capabilities
    return [
      capabilities.contains(.resume) ? "Resume" : nil,
      capabilities.contains(.approvals) ? "Approvals" : nil,
      capabilities.contains(.steer) ? "Steering" : nil,
      capabilities.contains(.terminalRequests) ? "Terminal requests" : nil,
      capabilities.contains(.mcpInjection) ? "MCP" : nil,
    ].compactMap { $0 }
  }
}

extension ProviderAvailability {
  fileprivate var detail: String {
    switch self {
    case .available(let path, let version):
      [version, path].compactMap { $0 }.joined(separator: " · ")
    case .unavailable(let reason):
      reason
    case .unsupported(let path, let version, let reason):
      [version, path, reason].compactMap { $0 }.joined(separator: " · ")
    }
  }

  fileprivate var symbol: String {
    switch self {
    case .available: "checkmark.circle.fill"
    case .unavailable: "arrow.down.circle"
    case .unsupported: "exclamationmark.triangle.fill"
    }
  }

  fileprivate var accessibilityLabel: String {
    switch self {
    case .available: "Available"
    case .unavailable: "Not installed"
    case .unsupported: "Unsupported version"
    }
  }

  fileprivate var tint: Color {
    switch self {
    case .available: .green
    case .unavailable: .secondary
    case .unsupported: .orange
    }
  }

  fileprivate func tint(in theme: OrchestratorTheme) -> Color {
    switch self {
    case .available: theme.success
    case .unavailable: theme.tertiary
    case .unsupported: theme.warning
    }
  }
}
