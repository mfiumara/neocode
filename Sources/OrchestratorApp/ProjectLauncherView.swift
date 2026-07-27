import AppKit
import OrchestratorCore
import SwiftUI

struct ProjectLauncherView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openWindow) private var openWindow
  @Environment(\.dismissWindow) private var dismissWindow
  @Environment(\.orchestratorTheme) private var theme

  var body: some View {
    @Bindable var model = model
    VStack(spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 5) {
          Text("Orchestrator")
            .font(.system(size: 28, weight: .semibold))
            .foregroundStyle(theme.foreground)
          Text("Native workspaces for coding agents")
            .font(OrchestratorTheme.Typography.body)
            .foregroundStyle(theme.muted)
        }
        Spacer()
        Button {
          Task {
            if let project = await model.chooseAndOpenProject() {
              open(project)
            }
          }
        } label: {
          Label("Open Repository", systemImage: "folder.badge.plus")
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .primary))
      }
      .padding(28)

      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      if model.isBootstrapping {
        Spacer()
        ProgressView("Preparing local core…")
        Spacer()
      } else if model.projects.isEmpty {
        ContentUnavailableView {
          Label("Open your first project", systemImage: "point.3.connected.trianglepath.dotted")
        } description: {
          Text("Orchestrator creates an isolated worktree for each mutating task.")
        } actions: {
          Button("Choose Repository…") {
            Task {
              if let project = await model.chooseAndOpenProject() {
                open(project)
              }
            }
          }
          .buttonStyle(OrchestratorButtonStyle(variant: .primary))
        }
      } else {
        ScrollView {
          LazyVStack(spacing: 6) {
            ForEach(model.projects) { project in
              Button {
                open(project)
              } label: {
                HStack(spacing: 12) {
                  Image(systemName: "shippingbox")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(theme.accent)
                    .frame(width: 34, height: 34)
                    .background(
                      theme.accent.opacity(0.11),
                      in: .rect(cornerRadius: 8)
                    )
                  VStack(alignment: .leading, spacing: 3) {
                    Text(project.name)
                      .font(OrchestratorTheme.Typography.bodyMedium)
                      .foregroundStyle(theme.foreground)
                    Text(project.rootPath)
                      .font(OrchestratorTheme.Typography.caption)
                      .foregroundStyle(theme.tertiary)
                      .lineLimit(1)
                  }
                  Spacer()
                  Text(project.lastOpenedAt, style: .relative)
                    .font(OrchestratorTheme.Typography.caption)
                    .foregroundStyle(theme.tertiary)
                  Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.tertiary)
                }
                .padding(.horizontal, 12)
                .frame(height: 56)
                .background(
                  theme.surface1,
                  in: .rect(cornerRadius: OrchestratorTheme.Radius.large)
                )
                .overlay {
                  RoundedRectangle(cornerRadius: OrchestratorTheme.Radius.large)
                    .stroke(theme.border, lineWidth: 1)
                }
                .contentShape(.rect)
              }
              .buttonStyle(.plain)
            }
          }
          .padding(16)
        }
      }

      HStack {
        Label(
          "Local only · \(model.providerInspections.filter(\.isAvailable).count) providers ready",
          systemImage: "lock.shield"
        )
        .font(.caption)
        .foregroundStyle(theme.muted)
        Spacer()
        Text(model.backgroundServiceStatus)
          .font(.caption)
          .foregroundStyle(theme.muted)
      }
      .padding(16)
      .background(theme.surface1)
      .overlay(alignment: .top) {
        Rectangle()
          .fill(theme.border)
          .frame(height: 1)
      }
    }
    .background(theme.surface0)
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
    .background(LauncherWindowMarker())
  }

  private func open(_ project: Project) {
    let launcherWindow = NSApp.keyWindow
    model.activeProjectID = project.id
    openWindow(value: project.id)
    dismissWindow(id: "launcher")
    // SwiftUI can retain a restored WindowGroup instance even after
    // dismissWindow when another value-based group is opened in the same run
    // loop. Close the exact launcher that initiated the action as a fallback.
    DispatchQueue.main.async {
      launcherWindow?.close()
    }
  }
}

@MainActor
struct LauncherWindowMarker: NSViewRepresentable {
  static let identifier = "orchestrator.launcher"

  func makeNSView(context: Context) -> MarkerView {
    MarkerView()
  }

  func updateNSView(_ nsView: MarkerView, context: Context) {
    nsView.markWindow()
  }

  final class MarkerView: NSView {
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      markWindow()
    }

    func markWindow() {
      window?.identifier = NSUserInterfaceItemIdentifier(
        LauncherWindowMarker.identifier
      )
    }
  }
}

extension ProviderInspection {
  fileprivate var isAvailable: Bool {
    if case .available = availability { return true }
    return false
  }
}
