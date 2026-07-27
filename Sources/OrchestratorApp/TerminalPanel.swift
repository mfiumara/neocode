import AppKit
import OrchestratorCore
import SwiftTerm
import SwiftUI

struct TerminalPanel: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let task: OrchestrationTask

  @State private var terminal: TerminalSession?
  @State private var output: TerminalOutputBatch?
  @State private var generation = UUID()
  @State private var shouldReuseExisting = true
  @State private var launchFailed = false

  var body: some View {
    ZStack(alignment: .topTrailing) {
      if terminal != nil {
        RemoteTerminalView(
          output: output,
          onInput: send,
          onResize: resize
        )
      } else if launchFailed {
        ContentUnavailableView {
          Label(
            "Shell unavailable",
            systemImage: "exclamationmark.triangle"
          )
        } description: {
          Text("The task shell could not be started.")
        } actions: {
          Button("Try Again") {
            shouldReuseExisting = false
            generation = UUID()
          }
        }
      } else if workspacePath != nil {
        VStack(spacing: 10) {
          ProgressView()
          Text("Connecting to persistent shell…")
            .foregroundStyle(theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ContentUnavailableView(
          "Workspace unavailable",
          systemImage: "terminal.fill"
        )
      }

      if terminal != nil {
        terminalOverlay
          .padding(8)
      }
    }
    .foregroundStyle(theme.foreground)
    .background(theme.surface0)
    .task(id: generation) {
      await runTerminal()
    }
  }

  private var terminalOverlay: some View {
    HStack(spacing: 3) {
      if let output {
        Circle()
          .fill(output.status.tint(in: theme))
          .frame(width: 6, height: 6)
        Text(output.status.label)
          .font(OrchestratorTheme.Typography.captionMedium)
          .foregroundStyle(theme.muted)
      }

      Button {
        restart()
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .buttonStyle(OrchestratorIconButtonStyle(size: 24))
      .help("Restart shell")

      if let terminal {
        Button {
          Task { await model.stopTerminal(terminalID: terminal.id) }
        } label: {
          Image(systemName: "stop.fill")
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 24))
        .disabled(output?.status != .running)
        .help("Stop shell")
      }

      Button {
        if let path = workspacePath {
          model.reveal(path)
        }
      } label: {
        Image(systemName: "folder")
      }
      .buttonStyle(OrchestratorIconButtonStyle(size: 24))
      .help("Reveal worktree")
    }
    .padding(.horizontal, 6)
    .frame(height: 28)
    .background(.ultraThinMaterial, in: .rect(cornerRadius: 7))
    .overlay {
      RoundedRectangle(cornerRadius: 7)
        .stroke(theme.borderStrong, lineWidth: 1)
    }
  }

  private var workspacePath: String? {
    model.snapshot(for: projectID).workspaces
      .first { $0.taskID == task.id }?
      .path
  }

  private func runTerminal() async {
    terminal = nil
    output = nil
    launchFailed = false
    guard
      let connected = await model.startTerminal(
        projectID: projectID,
        taskID: task.id,
        preferExisting: shouldReuseExisting
      )
    else {
      launchFailed = true
      return
    }
    terminal = connected
    shouldReuseExisting = true
    var sequence: Int64 = 0
    while !Task.isCancelled {
      if let next = await model.terminalOutput(
        terminalID: connected.id,
        after: sequence
      ) {
        if next.lastSequence > sequence || next.status != output?.status {
          output = next
        }
        sequence = max(sequence, next.lastSequence)
        if next.status == .exited || next.status == .failed {
          break
        }
      }
      try? await Task.sleep(for: .milliseconds(60))
    }
  }

  private func restart() {
    let previousTerminal = terminal
    terminal = nil
    output = nil
    shouldReuseExisting = false
    Task {
      if let previousTerminal {
        await model.stopTerminal(terminalID: previousTerminal.id)
      }
      generation = UUID()
    }
  }

  private func send(_ data: Data) {
    guard let terminal else { return }
    Task {
      await model.sendTerminalInput(terminalID: terminal.id, data: data)
    }
  }

  private func resize(columns: Int, rows: Int) {
    guard let terminal else { return }
    Task {
      await model.resizeTerminal(
        terminalID: terminal.id,
        columns: columns,
        rows: rows
      )
    }
  }
}

private struct RemoteTerminalView: NSViewRepresentable {
  @Environment(\.orchestratorTheme) private var theme
  let output: TerminalOutputBatch?
  let onInput: (Data) -> Void
  let onResize: (Int, Int) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(onInput: onInput, onResize: onResize)
  }

  func makeNSView(context: Context) -> TerminalView {
    let terminal = TerminalView(frame: .zero)
    terminal.terminalDelegate = context.coordinator
    terminal.allowMouseReporting = true
    terminal.optionAsMetaKey = true
    terminal.nativeForegroundColor = theme.foreground.nsColor
    terminal.nativeBackgroundColor = theme.surface0.nsColor
    DispatchQueue.main.async { [weak terminal] in
      guard let terminal, let window = terminal.window else { return }
      window.makeFirstResponder(terminal)
    }
    return terminal
  }

  func updateNSView(_ terminal: TerminalView, context: Context) {
    terminal.nativeForegroundColor = theme.foreground.nsColor
    terminal.nativeBackgroundColor = theme.surface0.nsColor
    context.coordinator.onInput = onInput
    context.coordinator.onResize = onResize
    guard let output,
      output.lastSequence > context.coordinator.lastSequence
    else {
      return
    }
    if output.wasTruncated {
      terminal.feed(text: "\u{001B}c")
    }
    terminal.feed(byteArray: Array(output.data)[...])
    context.coordinator.lastSequence = output.lastSequence
  }

  final class Coordinator: NSObject, TerminalViewDelegate {
    var onInput: (Data) -> Void
    var onResize: (Int, Int) -> Void
    var lastSequence: Int64 = 0

    init(
      onInput: @escaping (Data) -> Void,
      onResize: @escaping (Int, Int) -> Void
    ) {
      self.onInput = onInput
      self.onResize = onResize
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
      onResize(newCols, newRows)
    }

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
      onInput(Data(data))
    }

    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func requestOpenLink(
      source: TerminalView,
      link: String,
      params: [String: String]
    ) {
      guard let url = URL(string: link) else { return }
      NSWorkspace.shared.open(url)
    }
    func bell(source: TerminalView) {
      NSSound.beep()
    }
    func clipboardCopy(source: TerminalView, content: Data) {
      guard let text = String(data: content, encoding: .utf8) else { return }
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    }
    func clipboardRead(source: TerminalView) -> Data? {
      NSPasteboard.general.string(forType: .string)?.data(using: .utf8)
    }
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
  }
}

extension TerminalStatus {
  fileprivate var label: String {
    switch self {
    case .starting: "Starting"
    case .running: "Connected"
    case .exited: "Exited"
    case .failed: "Failed"
    }
  }

  fileprivate func tint(in theme: OrchestratorTheme) -> SwiftUI.Color {
    switch self {
    case .starting: theme.accent
    case .running: theme.success
    case .exited: theme.tertiary
    case .failed: theme.danger
    }
  }
}
