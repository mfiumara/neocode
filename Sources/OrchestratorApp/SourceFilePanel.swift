import AppKit
import OrchestratorCore
import SwiftUI

struct SourceFilePanel: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let task: OrchestrationTask
  let relativePath: String
  var initialLine: Int? = nil

  @State private var previewState = FilePreviewState.none
  @State private var wrapsLines = false

  var body: some View {
    VStack(spacing: 0) {
      fileBar

      switch previewState {
      case .none, .loading:
        VStack(spacing: 10) {
          ProgressView()
            .controlSize(.small)
          Text("Loading \(fileName)…")
            .font(OrchestratorTheme.Typography.caption)
            .foregroundStyle(theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.surface0)

      case .text(let text, let metadata):
        SourceCodeView(
          text: text,
          language: metadata.language,
          wrapsLines: wrapsLines,
          initialLine: initialLine
        )
        .id("\(absolutePath ?? relativePath):\(theme.isDark)")
        fileStatus(metadata: metadata, mode: metadata.language?.displayName ?? "Plain Text")

      case .quickLook(let path, let byteCount):
        QuickLookFileView(path: path)
          .id(path)
        fileStatus(
          metadata: PreviewMetadata(
            byteCount: byteCount,
            lineCount: nil,
            language: nil
          ),
          mode: "Quick Look"
        )

      case .failure(let message):
        ContentUnavailableView(
          "Couldn’t preview this file",
          systemImage: "doc.questionmark",
          description: Text(message)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.surface0)
      }
    }
    .task(id: absolutePath) {
      await load()
    }
    .onKeyPress(.space) {
      guard let absolutePath else { return .ignored }
      QuickLookPreviewer.shared.present(path: absolutePath)
      return .handled
    }
  }

  private var fileBar: some View {
    HStack(spacing: 6) {
      Image(systemName: WorkspaceFile.symbol(for: relativePath))
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(theme.muted)

      if !parentPath.isEmpty {
        Text(parentPath)
          .foregroundStyle(theme.tertiary)
          .lineLimit(1)
          .truncationMode(.head)
        Image(systemName: "chevron.right")
          .font(.system(size: 8, weight: .bold))
          .foregroundStyle(theme.tertiary)
      }

      Text(fileName)
        .font(OrchestratorTheme.Typography.bodyMedium)
        .foregroundStyle(theme.foreground)
        .lineLimit(1)

      Spacer(minLength: 12)

      Button {
        wrapsLines.toggle()
      } label: {
        Image(systemName: "arrow.turn.down.left")
      }
      .buttonStyle(OrchestratorIconButtonStyle())
      .foregroundStyle(wrapsLines ? theme.accent : theme.muted)
      .help(wrapsLines ? "Disable Line Wrapping" : "Wrap Lines")

      Button {
        guard let absolutePath else { return }
        model.reveal(absolutePath)
      } label: {
        Image(systemName: "folder")
      }
      .buttonStyle(OrchestratorIconButtonStyle())
      .help("Reveal in Finder")

      Button {
        guard let absolutePath else { return }
        model.openFile(at: absolutePath, line: initialLine ?? 1)
      } label: {
        Image(systemName: "arrow.up.forward.app")
      }
      .buttonStyle(OrchestratorIconButtonStyle())
      .help("Open in configured editor")
    }
    .padding(.horizontal, 10)
    .frame(height: 34)
    .background(theme.surface1)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)
    }
  }

  private func fileStatus(
    metadata: PreviewMetadata,
    mode: String
  ) -> some View {
    HStack(spacing: 8) {
      Text(mode)
      if let lineCount = metadata.lineCount {
        Text("·")
        Text("\(lineCount.formatted()) lines")
          .monospacedDigit()
      }
      Text("·")
      Text(
        ByteCountFormatter.string(
          fromByteCount: Int64(metadata.byteCount),
          countStyle: .file
        )
      )
      .monospacedDigit()
      Spacer()
      if wrapsLines {
        Text("Wrapped")
      }
      Image(systemName: "lock")
      Text("Read Only")
    }
    .font(OrchestratorTheme.Typography.caption)
    .foregroundStyle(theme.tertiary)
    .padding(.horizontal, 10)
    .frame(height: 24)
    .background(theme.surface1)
    .overlay(alignment: .top) {
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)
    }
  }

  private var workspacePath: String? {
    model.snapshot(for: projectID).workspaces
      .first { $0.taskID == task.id }?
      .path
  }

  private var absolutePath: String? {
    guard let workspacePath else { return nil }
    return URL(fileURLWithPath: workspacePath)
      .appendingPathComponent(relativePath)
      .standardizedFileURL
      .path
  }

  private var fileName: String {
    URL(fileURLWithPath: relativePath).lastPathComponent
  }

  private var parentPath: String {
    let parent = (relativePath as NSString).deletingLastPathComponent
    return parent == "." ? "" : parent
  }

  private func load() async {
    guard let absolutePath else {
      previewState = .failure("The worktree is no longer available.")
      return
    }
    previewState = .loading
    let file = WorkspaceFile(
      relativePath: relativePath,
      absolutePath: absolutePath
    )
    let result = await Task.detached(priority: .utility) {
      FilePreviewLoader.load(file: file)
    }.value
    guard !Task.isCancelled, self.absolutePath == absolutePath else { return }
    previewState = result
  }
}
