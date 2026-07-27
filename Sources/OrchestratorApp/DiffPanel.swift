import OrchestratorCore
import SwiftUI

struct DiffPanel: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let task: OrchestrationTask
  var initialFocusedPath: String? = nil
  var onOpenFile: ((String, Int?) -> Void)? = nil

  @State private var selectedFiles = Set<String>()
  @State private var focusedFile: String?
  @State private var summaries: [String: DiffFileSummary] = [:]
  @State private var search = ""
  @State private var didInitializeSelection = false
  @State private var isRefreshing = false
  @State private var showsPullRequest = false
  @State private var displayMode = DiffDisplayMode.unified

  var body: some View {
    VStack(spacing: 0) {
      reviewBar
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      if let diff {
        if diff.changedFiles.isEmpty {
          ContentUnavailableView(
            "No Changes",
            systemImage: "checkmark.circle",
            description: Text("This worktree matches \(task.baseRef).")
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          HSplitView {
            fileNavigator(diff)
              .frame(minWidth: 230, idealWidth: 285, maxWidth: 340)

            diffDetail
              .frame(minWidth: 440, maxWidth: .infinity, maxHeight: .infinity)
          }
        }
      } else {
        VStack(spacing: 12) {
          ProgressView()
            .controlSize(.small)
          Text("Loading changes against \(task.baseRef)…")
            .font(OrchestratorTheme.Typography.body)
            .foregroundStyle(theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .foregroundStyle(theme.foreground)
    .background(theme.surface0)
    .task(id: task.id) { await load() }
    .onKeyPress(.upArrow) {
      guard canMoveFocus(by: -1) else { return .ignored }
      moveFocus(by: -1)
      return .handled
    }
    .onKeyPress(.downArrow) {
      guard canMoveFocus(by: 1) else { return .ignored }
      moveFocus(by: 1)
      return .handled
    }
    .sheet(isPresented: $showsPullRequest) {
      PullRequestSheet(task: task, files: selectedFiles.sorted()) {
        showsPullRequest = false
      }
    }
  }

  private var reviewBar: some View {
    HStack(spacing: 8) {
      Image(systemName: "arrow.left.arrow.right")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(theme.muted)
      Text((diff?.changedFiles.count ?? 0).formatted())
        .font(OrchestratorTheme.Typography.captionMedium.monospacedDigit())
        .foregroundStyle(theme.foreground)

      Text("against \(task.baseRef)")
        .font(OrchestratorTheme.Typography.caption.monospaced())
        .foregroundStyle(theme.tertiary)
        .lineLimit(1)

      Spacer(minLength: 12)

      if let diff, !diff.changedFiles.isEmpty {
        Text("\(selectedFiles.count) selected")
          .font(OrchestratorTheme.Typography.caption)
          .foregroundStyle(theme.muted)
      }

      Button {
        Task { await load() }
      } label: {
        if isRefreshing {
          ProgressView()
            .controlSize(.small)
        } else {
          Image(systemName: "arrow.clockwise")
        }
      }
      .buttonStyle(OrchestratorIconButtonStyle(size: 26))
      .disabled(isRefreshing)
      .help("Refresh Changes")
      .accessibilityLabel("Refresh Changes")

      Button {
        showsPullRequest = true
      } label: {
        Label("Commit & PR", systemImage: "arrow.triangle.branch")
      }
      .buttonStyle(OrchestratorButtonStyle(variant: .primary, compact: true))
      .disabled(selectedFiles.isEmpty)
    }
    .padding(.horizontal, 10)
    .frame(height: 36)
    .background(theme.surface1)
  }

  private func fileNavigator(_ diff: GitDiff) -> some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text("Changed Files")
          .font(OrchestratorTheme.Typography.bodyMedium)
          .foregroundStyle(theme.foreground)
        Spacer()
        Menu {
          Button("Select All") {
            selectedFiles = Set(diff.changedFiles)
          }
          Button("Deselect All") {
            selectedFiles.removeAll()
          }
          if !search.isEmpty {
            Divider()
            Button("Select Filtered") {
              selectedFiles.formUnion(filteredFiles)
            }
          }
        } label: {
          Image(systemName: "checklist")
        }
        .menuIndicator(.hidden)
        .help("Selection Options")
      }
      .padding(.horizontal, 11)
      .frame(height: 34)

      OrchestratorSearchField(
        placeholder: "Filter changed files",
        text: $search
      )
        .padding(.horizontal, 8)
        .padding(.bottom, 7)

      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      List {
        ForEach(filteredFiles, id: \.self) { file in
          DiffFileRow(
            path: file,
            summary: summaries[file],
            isSelected: focusedFile == file,
            isIncluded: Binding(
              get: { selectedFiles.contains(file) },
              set: { included in
                if included {
                  selectedFiles.insert(file)
                } else {
                  selectedFiles.remove(file)
                }
              }
            )
          )
          .contentShape(.rect)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 1, leading: 5, bottom: 1, trailing: 5))
          .listRowBackground(Color.clear)
          .onTapGesture {
            focusedFile = file
          }
          .onTapGesture(count: 2) {
            focusedFile = file
            openSourceTab(file, line: firstChangedLine(in: file))
          }
          .contextMenu {
            Button("Open in Tab", systemImage: "rectangle.stack.badge.plus") {
              openSourceTab(file, line: firstChangedLine(in: file))
            }
            Button("Open in Editor", systemImage: "arrow.up.forward.app") {
              openInEditor(file)
            }
            Button("Reveal in Finder", systemImage: "folder") {
              reveal(file)
            }
            Divider()
            Button(
              selectedFiles.contains(file) ? "Exclude from Commit" : "Include in Commit",
              systemImage: selectedFiles.contains(file) ? "minus.circle" : "plus.circle"
            ) {
              if selectedFiles.contains(file) {
                selectedFiles.remove(file)
              } else {
                selectedFiles.insert(file)
              }
            }
          }
        }
      }
      .environment(\.defaultMinListRowHeight, 38)
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(theme.surface1)
      .overlay {
        if filteredFiles.isEmpty {
          ContentUnavailableView.search(text: search)
        }
      }

      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      HStack {
        Text("\(selectedFiles.count) of \(diff.changedFiles.count) included")
        Spacer()
        let totals = selectedTotals
        if totals.additions > 0 {
          Text("+\(totals.additions)")
            .foregroundStyle(theme.success)
        }
        if totals.deletions > 0 {
          Text("−\(totals.deletions)")
            .foregroundStyle(theme.danger)
        }
      }
      .font(OrchestratorTheme.Typography.caption.monospacedDigit())
      .foregroundStyle(theme.tertiary)
      .padding(.horizontal, 10)
      .frame(height: 27)
    }
    .background(theme.surface1)
  }

  private var diffDetail: some View {
    VStack(spacing: 0) {
      diffHeader
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      if focusedFile == nil {
        ContentUnavailableView(
          "Select a File",
          systemImage: "doc.text.magnifyingglass",
          description: Text("Choose a changed file to review its patch.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if visibleDiffText.isEmpty {
        ContentUnavailableView(
          "No Textual Diff",
          systemImage: "doc.badge.ellipsis",
          description: Text("This file may be binary or newly untracked.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        switch displayMode {
        case .unified:
          UnifiedDiffView(
            text: visibleDiffText,
            language: focusedFile.flatMap { SourceLanguage.detect(path: $0) },
            onOpenLine: openFocusedSourceLine
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .split:
          SplitDiffView(
            text: visibleDiffText,
            language: focusedFile.flatMap { SourceLanguage.detect(path: $0) },
            onOpenLine: openFocusedSourceLine
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
    .background(theme.surface0)
  }

  private var diffHeader: some View {
    HStack(spacing: 8) {
      if let focusedFile {
        if let summary = summaries[focusedFile] {
          Image(systemName: summary.status.symbol)
            .foregroundStyle(summary.status.tint(in: theme))
            .frame(width: 16)
        } else {
          Image(systemName: "doc.text")
            .foregroundStyle(.secondary)
            .frame(width: 16)
        }

        let directory = directoryName(for: focusedFile)
        if !directory.isEmpty {
          Text(directory)
            .foregroundStyle(theme.muted)
            .lineLimit(1)
            .truncationMode(.head)
          Image(systemName: "chevron.right")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(theme.tertiary)
        }
        Text(URL(fileURLWithPath: focusedFile).lastPathComponent)
          .fontWeight(.semibold)
          .lineLimit(1)

        if let summary = summaries[focusedFile] {
          Text(summary.status.title)
            .font(.caption2.weight(.medium))
            .foregroundStyle(summary.status.tint(in: theme))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
              summary.status.tint(in: theme).opacity(0.11),
              in: Capsule()
            )
        }
      } else {
        Text("File Diff")
          .fontWeight(.semibold)
          .foregroundStyle(.secondary)
      }

      Spacer(minLength: 8)

      diffModePicker

      if let summary = focusedFile.flatMap({ summaries[$0] }) {
        if summary.additions > 0 {
          Text("+\(summary.additions)")
            .foregroundStyle(theme.success)
        }
        if summary.deletions > 0 {
          Text("−\(summary.deletions)")
            .foregroundStyle(theme.danger)
        }
      }

      Divider()
        .frame(height: 16)

      Button {
        moveFocus(by: -1)
      } label: {
        Image(systemName: "chevron.up")
      }
      .buttonStyle(OrchestratorIconButtonStyle(size: 26))
      .disabled(!canMoveFocus(by: -1))
      .help("Previous Changed File")

      Button {
        moveFocus(by: 1)
      } label: {
        Image(systemName: "chevron.down")
      }
      .buttonStyle(OrchestratorIconButtonStyle(size: 26))
      .disabled(!canMoveFocus(by: 1))
      .help("Next Changed File")

      if let focusedFile {
        Button {
          openSourceTab(focusedFile, line: firstChangedLine(in: focusedFile))
        } label: {
          Image(systemName: "rectangle.stack.badge.plus")
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 26))
        .help("Open source tab")

        Button {
          openInEditor(focusedFile)
        } label: {
          ViewThatFits(in: .horizontal) {
            Label("Open in Editor", systemImage: "arrow.up.forward.app")
            Image(systemName: "arrow.up.forward.app")
          }
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .ghost, compact: true))
        .help("Open in configured editor")
      }
    }
    .font(OrchestratorTheme.Typography.body)
    .padding(.horizontal, 10)
    .frame(height: 34)
    .background(theme.surface1)
  }

  private var diffModePicker: some View {
    HStack(spacing: 2) {
      ForEach(DiffDisplayMode.allCases) { mode in
        Button {
          displayMode = mode
        } label: {
          Image(systemName: mode.symbol)
            .frame(width: 24, height: 22)
        }
        .buttonStyle(.plain)
        .foregroundStyle(displayMode == mode ? theme.foreground : theme.tertiary)
        .background(
          displayMode == mode ? theme.surface3 : Color.clear,
          in: .rect(cornerRadius: OrchestratorTheme.Radius.small)
        )
        .help(mode.title)
        .accessibilityLabel(mode.title)
        .accessibilityAddTraits(displayMode == mode ? .isSelected : [])
      }
    }
    .padding(2)
    .background(theme.surface2, in: .rect(cornerRadius: OrchestratorTheme.Radius.medium))
  }

  private var diff: GitDiff? {
    model.diffsByTask[task.id]
  }

  private var workspacePath: String? {
    model.snapshot(for: projectID).workspaces
      .first { $0.taskID == task.id }?
      .path
  }

  private var filteredFiles: [String] {
    guard let diff else { return [] }
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return diff.changedFiles }
    return diff.changedFiles.filter {
      $0.localizedCaseInsensitiveContains(query)
    }
  }

  private var visibleDiffText: String {
    guard let diff, let focusedFile else { return "" }
    return Self.patch(for: focusedFile, in: diff.text)
  }

  private var selectedTotals: (additions: Int, deletions: Int) {
    selectedFiles.reduce(into: (0, 0)) { totals, path in
      guard let summary = summaries[path] else { return }
      totals.0 += summary.additions
      totals.1 += summary.deletions
    }
  }

  private func load() async {
    isRefreshing = true
    await model.loadDiff(taskID: task.id)
    defer { isRefreshing = false }

    guard let diff else { return }
    if !didInitializeSelection {
      selectedFiles = Set(diff.changedFiles)
      didInitializeSelection = true
    } else {
      selectedFiles.formIntersection(diff.changedFiles)
    }

    summaries = Dictionary(
      uniqueKeysWithValues: diff.changedFiles.map { path in
        let patch = Self.patch(for: path, in: diff.text)
        return (path, DiffFileSummary.make(path: path, patch: patch))
      }
    )

    if let focusedFile, diff.changedFiles.contains(focusedFile) {
      return
    }
    if let initialFocusedPath, diff.changedFiles.contains(initialFocusedPath) {
      focusedFile = initialFocusedPath
    } else {
      focusedFile = diff.changedFiles.first
    }
  }

  private func directoryName(for path: String) -> String {
    let directory = (path as NSString).deletingLastPathComponent
    return directory == "." ? "" : directory
  }

  private func openInEditor(_ file: String) {
    guard let workspacePath else { return }
    model.openFile(
      at: URL(fileURLWithPath: workspacePath)
        .appending(path: file)
        .path,
      line: 1
    )
  }

  private func openSourceTab(_ file: String, line: Int?) {
    if let onOpenFile {
      onOpenFile(file, line)
    } else {
      openInEditor(file)
    }
  }

  private func openFocusedSourceLine(_ line: Int) {
    guard let focusedFile else { return }
    openSourceTab(focusedFile, line: line)
  }

  private func firstChangedLine(in file: String) -> Int? {
    let document = UnifiedDiffDocument(text: Self.patch(for: file, in: diff?.text ?? ""))
    return document.lines.lazy.compactMap { line in
      switch line.kind {
      case .addition, .context:
        line.newLine
      case .deletion:
        line.oldLine
      case .file, .metadata, .hunk, .notice:
        nil
      }
    }.first
  }

  private func reveal(_ file: String) {
    guard let workspacePath else { return }
    model.reveal(
      URL(fileURLWithPath: workspacePath)
        .appending(path: file)
        .path
    )
  }

  private func canMoveFocus(by offset: Int) -> Bool {
    guard
      let diff,
      let focusedFile,
      let index = diff.changedFiles.firstIndex(of: focusedFile)
    else {
      return false
    }
    return diff.changedFiles.indices.contains(index + offset)
  }

  private func moveFocus(by offset: Int) {
    guard
      let diff,
      let focusedFile,
      let index = diff.changedFiles.firstIndex(of: focusedFile),
      diff.changedFiles.indices.contains(index + offset)
    else {
      return
    }
    self.focusedFile = diff.changedFiles[index + offset]
  }

  static func patch(for path: String, in diff: String) -> String {
    let lines = diff.split(
      separator: "\n",
      omittingEmptySubsequences: false
    ).map(String.init)
    var sections: [[String]] = []
    var current: [String] = []

    for line in lines {
      if line.hasPrefix("diff --git "), !current.isEmpty {
        sections.append(current)
        current = []
      }
      current.append(line)
    }
    if !current.isEmpty {
      sections.append(current)
    }

    let oldMarker = "--- a/\(path)"
    let newMarker = "+++ b/\(path)"
    let headerSuffix = " b/\(path)"
    return sections.first {
      $0.first?.hasSuffix(headerSuffix) == true
        || $0.contains(oldMarker)
        || $0.contains(newMarker)
    }?.joined(separator: "\n") ?? ""
  }
}

private struct DiffFileRow: View {
  @Environment(\.orchestratorTheme) private var theme
  let path: String
  let summary: DiffFileSummary?
  let isSelected: Bool
  @Binding var isIncluded: Bool

  var body: some View {
    HStack(spacing: 7) {
      Toggle("Include \(path) in commit", isOn: $isIncluded)
        .labelsHidden()
        .toggleStyle(.checkbox)
        .controlSize(.mini)

      Image(systemName: summary?.status.symbol ?? "doc.text")
        .font(.system(size: 11))
        .foregroundStyle(summary?.status.tint(in: theme) ?? theme.tertiary)
        .frame(width: 14)

      VStack(alignment: .leading, spacing: 1) {
        Text(URL(fileURLWithPath: path).lastPathComponent)
          .font(.system(size: 12.5, weight: .medium))
          .lineLimit(1)
        let directory = (path as NSString).deletingLastPathComponent
        if directory != "." {
          Text(directory)
            .font(.caption2)
            .foregroundStyle(theme.tertiary)
            .lineLimit(1)
        }
      }

      Spacer(minLength: 4)

      if let summary {
        HStack(spacing: 4) {
          if summary.additions > 0 {
            Text("+\(summary.additions)")
              .foregroundStyle(theme.success)
          }
          if summary.deletions > 0 {
            Text("−\(summary.deletions)")
              .foregroundStyle(theme.danger)
          }
        }
        .font(.caption2.monospacedDigit())
      }
    }
    .padding(.horizontal, 6)
    .frame(minHeight: 38)
    .foregroundStyle(isSelected ? theme.foreground : theme.muted)
    .background(
      isSelected ? theme.accent.opacity(0.16) : Color.clear,
      in: .rect(cornerRadius: OrchestratorTheme.Radius.medium)
    )
    .overlay(alignment: .leading) {
      if isSelected {
        RoundedRectangle(cornerRadius: 1)
          .fill(theme.accent)
          .frame(width: 2)
          .padding(.vertical, 6)
      }
    }
    .contentShape(.rect)
  }
}

private enum DiffDisplayMode: String, CaseIterable, Identifiable {
  case unified
  case split

  var id: String { rawValue }

  var title: String {
    switch self {
    case .unified: "Unified Diff"
    case .split: "Side-by-Side Diff"
    }
  }

  var symbol: String {
    switch self {
    case .unified: "rectangle"
    case .split: "rectangle.split.2x1"
    }
  }
}

private extension DiffFileStatus {
  var title: String {
    switch self {
    case .added: "Added"
    case .modified: "Modified"
    case .deleted: "Deleted"
    case .renamed: "Renamed"
    case .binary: "Binary"
    }
  }

  var symbol: String {
    switch self {
    case .added: "doc.badge.plus"
    case .modified: "doc.text"
    case .deleted: "doc.badge.minus"
    case .renamed: "arrow.right.doc.on.clipboard"
    case .binary: "doc.zipper"
    }
  }

  var tint: Color {
    switch self {
    case .added: .green
    case .modified: .orange
    case .deleted: .red
    case .renamed: .blue
    case .binary: .purple
    }
  }

  func tint(in theme: OrchestratorTheme) -> Color {
    switch self {
    case .added:
      theme.success
    case .modified:
      theme.warning
    case .deleted:
      theme.danger
    case .renamed:
      theme.accent
    case .binary:
      theme.muted
    }
  }
}

private struct PullRequestSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let task: OrchestrationTask
  let files: [String]
  let dismiss: () -> Void

  @State private var title = ""
  @State private var bodyText = ""
  @State private var commitMessage = ""
  @State private var isCreating = false

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 12) {
        Image(systemName: "arrow.triangle.branch")
          .font(.title2)
          .foregroundStyle(theme.accent)
          .frame(width: 32, height: 32)
          .background(
            theme.accent.opacity(0.12),
            in: RoundedRectangle(cornerRadius: 8)
          )
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text("Commit & Create Pull Request")
            .font(.title2.bold())
            .foregroundStyle(theme.foreground)
          Text("\(files.count) selected \(files.count == 1 ? "file" : "files")")
            .font(.callout)
            .foregroundStyle(theme.muted)
        }
      }

      Form {
        TextField("Title", text: $title)
        TextField("Description", text: $bodyText, axis: .vertical)
          .lineLimit(4...10)
        TextField("Commit message", text: $commitMessage)
        LabeledContent("Branch") {
          Text(task.branchName)
            .font(.caption.monospaced())
            .textSelection(.enabled)
        }
        LabeledContent("Base") {
          Text(task.baseRef)
            .font(.caption.monospaced())
        }
      }
      .formStyle(.grouped)
      .scrollContentBackground(.hidden)

      HStack {
        Button("Cancel", role: .cancel) { dismiss() }
          .keyboardShortcut(.cancelAction)
          .buttonStyle(OrchestratorButtonStyle(variant: .ghost))
        Spacer()
        if isCreating {
          ProgressView()
            .controlSize(.small)
        }
        Button("Commit & Create PR") {
          Task { await create() }
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .primary))
        .keyboardShortcut(.defaultAction)
        .disabled(
          title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || files.isEmpty || isCreating
        )
      }
    }
    .padding(24)
    .frame(width: 620)
    .foregroundStyle(theme.foreground)
    .background(theme.surface0)
    .onAppear {
      title = task.title
      commitMessage = task.title
      bodyText = task.goal
    }
  }

  private func create() async {
    isCreating = true
    await model.createPullRequest(
      taskID: task.id,
      title: title.trimmingCharacters(in: .whitespacesAndNewlines),
      body: bodyText.trimmingCharacters(in: .whitespacesAndNewlines),
      files: files,
      commitMessage: commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    )
    isCreating = false
    if model.alertMessage == nil {
      dismiss()
    }
  }
}
