import AppKit
import OrchestratorCore
import SwiftUI
import UniformTypeIdentifiers

struct FilePanel: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let task: OrchestrationTask
  var onOpenFile: ((String, Int?) -> Void)? = nil

  @State private var workspaceIndex = WorkspaceIndex()
  @State private var selectedPath: String?
  @State private var previewState = FilePreviewState.none
  @State private var search = ""
  @State private var isLoading = false
  @State private var showsNavigator = true
  @State private var wrapsLines = false

  var body: some View {
    Group {
      if showsNavigator {
        HSplitView {
          fileNavigator
            .frame(minWidth: 210, idealWidth: 270, maxWidth: 320)

          previewPane
            .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
        }
      } else {
        previewPane
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .task(id: workspacePath) { await loadFiles() }
    .task(id: selectedPath) { await loadPreview() }
    .onKeyPress(.return) {
      guard let selectedFile else { return .ignored }
      openInTab(selectedFile.relativePath)
      return .handled
    }
    .onKeyPress(.space) {
      guard let selectedFile else { return .ignored }
      QuickLookPreviewer.shared.present(path: selectedFile.absolutePath)
      return .handled
    }
  }

  private var fileNavigator: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: "folder.fill")
          .font(.system(size: 12))
          .foregroundStyle(.secondary)
        Text(workspaceName)
          .font(.callout.weight(.semibold))
          .lineLimit(1)
        Spacer(minLength: 8)
        Text(workspaceIndex.files.count.formatted())
          .font(.caption.monospacedDigit())
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 12)
      .frame(height: 35)

      OrchestratorSearchField(placeholder: "Filter files", text: $search)
        .padding(.horizontal, 9)
        .padding(.bottom, 7)

      Divider()

      Group {
        if search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          hierarchyList
        } else {
          searchResultsList
        }
      }
      .overlay {
        if isLoading {
          ProgressView()
            .controlSize(.small)
            .padding(12)
            .background(theme.surface3, in: RoundedRectangle(cornerRadius: 8))
        } else if workspaceIndex.files.isEmpty {
          ContentUnavailableView(
            "No files",
            systemImage: "folder",
            description: Text("This workspace does not contain any browsable files.")
          )
        }
      }
    }
    .foregroundStyle(theme.foreground)
    .background(theme.surface1)
  }

  private var hierarchyList: some View {
    List {
      OutlineGroup(workspaceIndex.roots, children: \.children) { node in
        FileTreeRow(node: node, isSelected: selectedPath == node.id)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
          .contextMenu {
            fileContextMenu(node)
          }
          .onTapGesture {
            guard !node.isDirectory else { return }
            selectedPath = node.id
          }
          .onTapGesture(count: 2) {
            guard !node.isDirectory else { return }
            selectedPath = node.id
            openInTab(node.relativePath)
          }
      }
    }
    .environment(\.defaultMinListRowHeight, 22)
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(theme.surface1)
  }

  private var searchResultsList: some View {
    List(filteredFiles) { file in
      HStack(spacing: 7) {
        Image(systemName: file.symbol)
          .foregroundStyle(file.tint)
          .frame(width: 16)
        VStack(alignment: .leading, spacing: 0) {
          Text(file.name)
            .font(.callout)
            .lineLimit(1)
          if !file.parentPath.isEmpty {
            Text(file.parentPath)
              .font(.caption2)
              .foregroundStyle(.tertiary)
              .lineLimit(1)
          }
        }
      }
      .padding(.horizontal, 7)
      .frame(minHeight: 32)
      .background(
        selectedPath == file.id
          ? theme.accent.opacity(0.16)
          : Color.clear,
        in: .rect(cornerRadius: OrchestratorTheme.Radius.medium)
      )
      .overlay(alignment: .leading) {
        if selectedPath == file.id {
          RoundedRectangle(cornerRadius: 1)
            .fill(theme.accent)
            .frame(width: 2)
            .padding(.vertical, 5)
        }
      }
      .contentShape(.rect)
      .listRowSeparator(.hidden)
      .listRowInsets(EdgeInsets(top: 1, leading: 5, bottom: 1, trailing: 5))
      .listRowBackground(Color.clear)
      .contextMenu {
        fileContextMenu(
          WorkspaceNode(
            name: file.name,
            relativePath: file.relativePath,
            absolutePath: file.absolutePath,
            children: nil
          )
        )
      }
      .onTapGesture {
        selectedPath = file.id
      }
      .onTapGesture(count: 2) {
        selectedPath = file.id
        openInTab(file.relativePath)
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(theme.surface1)
  }

  private var previewPane: some View {
    VStack(spacing: 0) {
      previewHeader
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      switch previewState {
      case .none:
        previewPlaceholder
      case .loading:
        VStack(spacing: 10) {
          ProgressView()
            .controlSize(.small)
          Text("Loading \(selectedFile?.name ?? "file")…")
            .font(OrchestratorTheme.Typography.caption)
            .foregroundStyle(theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      case .text(let text, let metadata):
        SourceCodeView(
          text: text,
          language: metadata.language,
          wrapsLines: wrapsLines
        )
          .id(
            "\(selectedPath ?? ""):\(metadata.language?.rawValue ?? "plain"):\(theme.isDark)"
          )
        previewStatus(metadata: metadata, mode: metadata.language?.displayName ?? "Plain Text")
      case .quickLook(let path, let byteCount):
        QuickLookFileView(path: path)
          .id(path)
        previewStatus(
          metadata: PreviewMetadata(byteCount: byteCount, lineCount: nil, language: nil),
          mode: "Quick Look"
        )
      case .failure(let message):
        ContentUnavailableView(
          "Couldn’t preview this file",
          systemImage: "doc.questionmark",
          description: Text(message)
        )
      }
    }
    .foregroundStyle(theme.foreground)
    .background(theme.surface0)
  }

  private var previewHeader: some View {
    HStack(spacing: 8) {
      Button {
        showsNavigator.toggle()
      } label: {
        Image(systemName: showsNavigator ? "sidebar.left" : "sidebar.right")
      }
      .buttonStyle(OrchestratorIconButtonStyle(size: 26))
      .help(showsNavigator ? "Hide File Navigator" : "Show File Navigator")
      .accessibilityLabel(showsNavigator ? "Hide File Navigator" : "Show File Navigator")

      Divider()
        .frame(height: 16)

      if let selectedFile {
        Image(systemName: selectedFile.symbol)
          .foregroundStyle(selectedFile.tint)
          .frame(width: 16)

        if !selectedFile.parentPath.isEmpty {
          Text(selectedFile.parentPath)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.head)
          Image(systemName: "chevron.right")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(theme.tertiary)
        }
        Text(selectedFile.name)
          .fontWeight(.semibold)
          .lineLimit(1)
      } else {
        Text(workspaceName)
          .fontWeight(.semibold)
          .foregroundStyle(.secondary)
      }

      Spacer(minLength: 12)

      if let selectedFile {
        Menu {
          Toggle("Wrap Lines", isOn: $wrapsLines)
          Divider()
          Button("Open in Tab", systemImage: "rectangle.stack.badge.plus") {
            openInTab(selectedFile.relativePath)
          }
          Button("Copy Relative Path", systemImage: "doc.on.doc") {
            copyRelativePath(selectedFile)
          }
          Button("Reveal in Finder", systemImage: "folder") {
            model.reveal(selectedFile.absolutePath)
          }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 26))
        .menuIndicator(.hidden)
        .help("File Options")

        Button {
          openInTab(selectedFile.relativePath)
        } label: {
          Label("Open in Tab", systemImage: "rectangle.stack.badge.plus")
        }
        .buttonStyle(OrchestratorButtonStyle(variant: .secondary, compact: true))
        .help("Open a dedicated source tab")

        Button {
          model.openFile(at: selectedFile.absolutePath, line: 1)
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
    .padding(.horizontal, 13)
    .frame(height: 34)
    .background(theme.surface1)
  }

  private var previewPlaceholder: some View {
    VStack(spacing: 9) {
      Image(systemName: "doc.text.magnifyingglass")
        .font(.system(size: 30, weight: .light))
        .foregroundStyle(theme.tertiary)
      Text("Select a file")
        .font(OrchestratorTheme.Typography.title)
        .foregroundStyle(theme.foreground)
      Text("Browse the workspace tree or filter by file name.")
        .font(OrchestratorTheme.Typography.body)
        .foregroundStyle(theme.muted)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func previewStatus(metadata: PreviewMetadata, mode: String) -> some View {
    HStack(spacing: 8) {
      Text(mode)
      if let lineCount = metadata.lineCount {
        Divider()
          .frame(height: 11)
        Text("\(lineCount.formatted()) lines")
          .monospacedDigit()
      }
      Divider()
        .frame(height: 11)
      Text(ByteCountFormatter.string(fromByteCount: Int64(metadata.byteCount), countStyle: .file))
        .monospacedDigit()
      Spacer()
      if wrapsLines {
        Label("Wrapped", systemImage: "arrow.turn.down.left")
      }
      Label("Read Only", systemImage: "lock")
    }
    .font(.caption2)
    .foregroundStyle(theme.tertiary)
    .padding(.horizontal, 11)
    .frame(height: 24)
    .background(theme.surface1)
    .overlay(alignment: .top) {
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)
    }
  }

  private var selectedFile: WorkspaceFile? {
    guard let selectedPath else { return nil }
    return workspaceIndex.filesByPath[selectedPath]
  }

  private var filteredFiles: [WorkspaceFile] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return workspaceIndex.files }
    return workspaceIndex.files.filter {
      $0.relativePath.localizedCaseInsensitiveContains(query)
    }
  }

  private var workspacePath: String? {
    model.snapshot(for: projectID).workspaces
      .first { $0.taskID == task.id }?
      .path
  }

  private var workspaceName: String {
    workspacePath.map {
      URL(fileURLWithPath: $0).lastPathComponent
    } ?? "Files"
  }

  @ViewBuilder
  private func fileContextMenu(_ node: WorkspaceNode) -> some View {
    if node.isDirectory {
      Button("Reveal in Finder", systemImage: "folder") {
        model.reveal(node.absolutePath)
      }
    } else {
      Button("Open in Tab", systemImage: "rectangle.stack.badge.plus") {
        openInTab(node.relativePath)
      }
      Button("Open in Editor", systemImage: "arrow.up.forward.app") {
        model.openFile(at: node.absolutePath, line: 1)
      }
      Button("Reveal in Finder", systemImage: "folder") {
        model.reveal(node.absolutePath)
      }
      Divider()
      Button("Copy Relative Path", systemImage: "doc.on.doc") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(node.relativePath, forType: .string)
      }
    }
  }

  private func copyRelativePath(_ file: WorkspaceFile) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(file.relativePath, forType: .string)
  }

  private func openInTab(_ relativePath: String) {
    if let onOpenFile {
      onOpenFile(relativePath, 1)
    } else if let file = workspaceIndex.files.first(where: {
      $0.relativePath == relativePath
    }) {
      model.openFile(at: file.absolutePath, line: 1)
    }
  }

  private func loadFiles() async {
    selectedPath = nil
    previewState = .none
    workspaceIndex = WorkspaceIndex()
    search = ""

    guard let workspacePath else {
      isLoading = false
      return
    }

    isLoading = true
    let loaded = await Task.detached(priority: .utility) {
      WorkspaceIndex.scan(root: workspacePath)
    }.value

    guard !Task.isCancelled, self.workspacePath == workspacePath else {
      return
    }

    workspaceIndex = loaded
    selectedPath = loaded.preferredFile?.id
    isLoading = false
  }

  private func loadPreview() async {
    guard let selectedFile else {
      previewState = .none
      return
    }

    previewState = .loading
    let result = await Task.detached(priority: .utility) {
      FilePreviewLoader.load(file: selectedFile)
    }.value

    guard !Task.isCancelled, self.selectedFile == selectedFile else {
      return
    }
    previewState = result
  }
}

private struct FileTreeRow: View {
  @Environment(\.orchestratorTheme) private var theme
  let node: WorkspaceNode
  let isSelected: Bool

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: node.symbol)
        .foregroundStyle(node.tint)
        .font(.system(size: 12))
        .frame(width: 15)
      Text(node.name)
        .font(.system(size: 12.5))
        .lineLimit(1)
      Spacer(minLength: 2)
    }
    .padding(.horizontal, 6)
    .frame(minHeight: 26)
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
          .padding(.vertical, 5)
      }
    }
    .contentShape(Rectangle())
  }
}

private struct WorkspaceIndex: Sendable {
  let roots: [WorkspaceNode]
  let files: [WorkspaceFile]
  let filesByPath: [String: WorkspaceFile]

  init(roots: [WorkspaceNode] = [], files: [WorkspaceFile] = []) {
    self.roots = roots
    self.files = files
    filesByPath = Dictionary(uniqueKeysWithValues: files.map { ($0.id, $0) })
  }

  var preferredFile: WorkspaceFile? {
    let preferredNames = ["Package.swift", "README.md", "readme.md"]
    for name in preferredNames {
      if let match = files.first(where: {
        $0.parentPath.isEmpty && $0.name == name
      }) {
        return match
      }
    }
    return files.first(where: \.parentPath.isEmpty) ?? files.first
  }

  static func scan(root: String) -> WorkspaceIndex {
    let rootURL = URL(fileURLWithPath: root).standardizedFileURL
    var files: [WorkspaceFile] = []
    let roots = scanDirectory(rootURL, root: rootURL, files: &files)
    return WorkspaceIndex(roots: roots, files: files)
  }

  private static func scanDirectory(
    _ directory: URL,
    root: URL,
    files: inout [WorkspaceFile]
  ) -> [WorkspaceNode] {
    guard files.count < 20_000 else { return [] }

    let keys: Set<URLResourceKey> = [
      .isDirectoryKey,
      .isRegularFileKey,
      .isSymbolicLinkKey,
    ]
    guard
      let urls = try? FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: Array(keys),
        options: []
      )
    else {
      return []
    }

    var nodes: [WorkspaceNode] = []
    for url in urls {
      guard files.count < 20_000 else { break }
      let name = url.lastPathComponent
      if [".git", ".build", ".DS_Store", "DerivedData", "node_modules"].contains(name) {
        continue
      }

      let values = try? url.resourceValues(forKeys: keys)
      let relativePath = String(url.path.dropFirst(root.path.count))
        .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

      if values?.isDirectory == true, values?.isSymbolicLink != true {
        let children = scanDirectory(url, root: root, files: &files)
        nodes.append(
          WorkspaceNode(
            name: name,
            relativePath: relativePath,
            absolutePath: url.path,
            children: children
          )
        )
      } else if values?.isRegularFile == true || values?.isSymbolicLink == true {
        let file = WorkspaceFile(relativePath: relativePath, absolutePath: url.path)
        files.append(file)
        nodes.append(
          WorkspaceNode(
            name: name,
            relativePath: relativePath,
            absolutePath: url.path,
            children: nil
          )
        )
      }
    }

    return nodes.sorted {
      if $0.isDirectory != $1.isDirectory {
        return $0.isDirectory
      }
      return $0.name.localizedStandardCompare($1.name) == .orderedAscending
    }
  }
}

private struct WorkspaceNode: Identifiable, Hashable, Sendable {
  var id: String { absolutePath }
  let name: String
  let relativePath: String
  let absolutePath: String
  let children: [WorkspaceNode]?

  var isDirectory: Bool {
    children != nil
  }

  var symbol: String {
    isDirectory ? "folder" : WorkspaceFile.symbol(for: absolutePath)
  }

  var tint: Color {
    isDirectory ? .secondary : WorkspaceFile.tint(for: absolutePath)
  }
}

struct WorkspaceFile: Identifiable, Hashable, Sendable {
  var id: String { absolutePath }
  let relativePath: String
  let absolutePath: String

  var name: String {
    URL(fileURLWithPath: relativePath).lastPathComponent
  }

  var parentPath: String {
    let parent = (relativePath as NSString).deletingLastPathComponent
    return parent == "." ? "" : parent
  }

  var symbol: String {
    Self.symbol(for: absolutePath)
  }

  var tint: Color {
    Self.tint(for: absolutePath)
  }

  static func symbol(for path: String) -> String {
    let url = URL(fileURLWithPath: path)
    let extensionName = url.pathExtension.lowercased()
    return switch extensionName {
    case "swift": "swift"
    case "bash", "sh", "zsh": "terminal"
    case "c", "cc", "cpp", "cxx", "h", "hh", "hpp": "chevron.left.forwardslash.chevron.right"
    case "css", "htm", "html", "js", "jsx", "ts", "tsx": "globe"
    case "json", "toml", "yaml", "yml": "curlybraces"
    case "markdown", "md", "txt": "doc.text"
    case "pdf": "doc.richtext"
    case "gif", "heic", "jpeg", "jpg", "png", "svg", "tiff", "webp": "photo"
    default: "doc"
    }
  }

  static func tint(for path: String) -> Color {
    switch URL(fileURLWithPath: path).pathExtension.lowercased() {
    case "swift": .orange
    case "bash", "sh", "zsh": .green
    case "c", "cc", "cpp", "cxx", "h", "hh", "hpp": .indigo
    case "css", "htm", "html": .pink
    case "js", "jsx": .yellow
    case "ts", "tsx": .blue
    case "markdown", "md", "txt": .blue
    case "json", "toml", "yaml", "yml": .purple
    case "gif", "heic", "jpeg", "jpg", "png", "svg", "tiff", "webp": .green
    default: .secondary
    }
  }
}

enum FilePreviewState: Equatable, Sendable {
  case none
  case loading
  case text(String, PreviewMetadata)
  case quickLook(path: String, byteCount: Int)
  case failure(String)
}

struct PreviewMetadata: Equatable, Sendable {
  let byteCount: Int
  let lineCount: Int?
  let language: SourceLanguage?
}

enum FilePreviewLoader {
  static func load(file: WorkspaceFile) -> FilePreviewState {
    let url = URL(fileURLWithPath: file.absolutePath)

    do {
      let values = try url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey])
      let byteCount = values.fileSize ?? 0
      let language = SourceLanguage.detect(path: file.absolutePath)
      let isText = values.contentType?.conforms(to: .text) == true || language != nil

      guard byteCount <= 2_000_000, isText else {
        return .quickLook(path: file.absolutePath, byteCount: byteCount)
      }

      let data = try Data(contentsOf: url, options: [.mappedIfSafe])
      guard
        let text = String(data: data, encoding: .utf8)
          ?? String(data: data, encoding: .utf16)
      else {
        return .quickLook(path: file.absolutePath, byteCount: byteCount)
      }

      let lineCount = text.isEmpty
        ? 1
        : text.utf8.reduce(into: 1) { count, byte in
          if byte == 0x0A { count += 1 }
        }
      return .text(
        text,
        PreviewMetadata(
          byteCount: byteCount,
          lineCount: lineCount,
          language: language
        )
      )
    } catch {
      return .failure(error.localizedDescription)
    }
  }
}
