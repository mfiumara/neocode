import OrchestratorCore
import SwiftUI

struct WorkspaceCommandActions {
  let showPalette: () -> Void
  let selectPanel: (PanelKind) -> Void
  let launchAgent: () -> Void
  let newTask: () -> Void
  let closeTab: () -> Void
  let split: (WorkspaceSplitAxis) -> Void
}

private struct WorkspaceCommandActionsKey: FocusedValueKey {
  typealias Value = WorkspaceCommandActions
}

extension FocusedValues {
  var workspaceCommandActions: WorkspaceCommandActions? {
    get { self[WorkspaceCommandActionsKey.self] }
    set { self[WorkspaceCommandActionsKey.self] = newValue }
  }
}

struct PaletteCommand: Identifiable {
  let id: String
  let title: String
  let detail: String
  let symbol: String
  let shortcut: String?
  let keywords: [String]
  let action: () -> Void

  init(
    id: String,
    title: String,
    detail: String,
    symbol: String,
    shortcut: String? = nil,
    keywords: [String] = [],
    action: @escaping () -> Void
  ) {
    self.id = id
    self.title = title
    self.detail = detail
    self.symbol = symbol
    self.shortcut = shortcut
    self.keywords = keywords
    self.action = action
  }
}

struct CommandPalette: View {
  @Environment(\.orchestratorTheme) private var theme
  @AppStorage("commandPalette.recentCommandIDs") private var recentCommandIDs = ""
  let commands: [PaletteCommand]
  let dismiss: () -> Void

  @State private var query = ""
  @State private var selectedID: String?
  @FocusState private var searchIsFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 11) {
        Image(systemName: "command")
          .font(.system(size: 16, weight: .medium))
          .foregroundStyle(theme.accent)

        TextField("Type a command…", text: $query)
          .textFieldStyle(.plain)
          .font(.system(size: 17))
          .foregroundStyle(theme.foreground)
          .focused($searchIsFocused)
          .onSubmit { runSelection() }
          .onKeyPress(.downArrow) {
            moveSelection(by: 1)
            return .handled
          }
          .onKeyPress(.upArrow) {
            moveSelection(by: -1)
            return .handled
          }

        Text("⌘K")
          .font(.caption.monospaced())
          .foregroundStyle(theme.tertiary)
          .padding(.horizontal, 7)
          .padding(.vertical, 3)
          .background(theme.surface3, in: .rect(cornerRadius: 5))
      }
      .padding(.horizontal, 16)
      .frame(height: 52)

      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      if filteredCommands.isEmpty {
        ContentUnavailableView.search(text: query)
          .frame(height: 180)
      } else {
        ScrollViewReader { proxy in
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
              ForEach(Array(filteredCommands.enumerated()), id: \.element.id) { entry in
                let index = entry.offset
                let command = entry.element
                if let heading = heading(at: index) {
                  Text(heading)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.tertiary)
                    .padding(.horizontal, 10)
                    .padding(.top, index == 0 ? 4 : 9)
                    .padding(.bottom, 3)
                }
                Button {
                  run(command)
                } label: {
                  CommandPaletteRow(
                    command: command,
                    isSelected: command.id == effectiveSelectionID
                  )
                }
                .buttonStyle(.plain)
                .id(command.id)
                .onHover { hovering in
                  if hovering {
                    selectedID = command.id
                  }
                }
              }
            }
            .padding(6)
          }
          .frame(maxHeight: 390)
          .onChange(of: selectedID) {
            guard let selectedID else { return }
            withAnimation(.easeOut(duration: 0.08)) {
              proxy.scrollTo(selectedID, anchor: .center)
            }
          }
        }
      }

      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      HStack(spacing: 13) {
        Label("Navigate", systemImage: "arrow.up.arrow.down")
        Label("Run", systemImage: "return")
        Spacer()
        Text("\(filteredCommands.count) commands")
      }
      .font(.caption2)
      .foregroundStyle(theme.tertiary)
      .padding(.horizontal, 14)
      .frame(height: 30)
    }
    .frame(maxWidth: 590)
    .background(.ultraThinMaterial, in: .rect(cornerRadius: 12))
    .background(
      theme.surface1.opacity(0.9),
      in: .rect(cornerRadius: 12)
    )
    .overlay {
      RoundedRectangle(cornerRadius: 12)
        .stroke(theme.borderStrong, lineWidth: 1)
    }
    .shadow(color: .black.opacity(0.3), radius: 32, y: 14)
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isModal)
    .accessibilityLabel("Command Palette")
    .onAppear {
      selectedID = filteredCommands.first?.id
      DispatchQueue.main.async {
        searchIsFocused = true
      }
    }
    .onChange(of: query) {
      selectedID = filteredCommands.first?.id
    }
    .onExitCommand(perform: dismiss)
  }

  private var filteredCommands: [PaletteCommand] {
    let terms = query
      .lowercased()
      .split(whereSeparator: \.isWhitespace)
      .map(String.init)
    guard !terms.isEmpty else {
      let recent = recentCommands
      return recent + commands.filter { candidate in
        !recent.contains(where: { $0.id == candidate.id })
      }
    }

    return commands.filter { command in
      let searchable = (
        [command.title, command.detail] + command.keywords
      )
      .joined(separator: " ")
      .lowercased()
      return terms.allSatisfy(searchable.contains)
    }
  }

  private var recentCommands: [PaletteCommand] {
    recentCommandIDs
      .split(separator: ",")
      .prefix(4)
      .compactMap { id in commands.first { $0.id == id } }
  }

  private func heading(at index: Int) -> String? {
    if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let recentCount = recentCommands.count
      if index == 0 {
        return recentCount > 0 ? "RECENT" : "COMMANDS"
      }
      if recentCount > 0, index == recentCount {
        return "ALL COMMANDS"
      }
      return nil
    }
    return index == 0 ? "RESULTS" : nil
  }

  private var effectiveSelectionID: String? {
    guard
      let selectedID,
      filteredCommands.contains(where: { $0.id == selectedID })
    else {
      return filteredCommands.first?.id
    }
    return selectedID
  }

  private func moveSelection(by offset: Int) {
    let commands = filteredCommands
    guard !commands.isEmpty else { return }
    let currentIndex = effectiveSelectionID.flatMap { id in
      commands.firstIndex(where: { $0.id == id })
    } ?? 0
    let nextIndex = min(
      max(currentIndex + offset, commands.startIndex),
      commands.index(before: commands.endIndex)
    )
    selectedID = commands[nextIndex].id
  }

  private func runSelection() {
    guard
      let selectedID = effectiveSelectionID,
      let command = filteredCommands.first(where: { $0.id == selectedID })
    else {
      return
    }
    run(command)
  }

  private func run(_ command: PaletteCommand) {
    var ids = recentCommandIDs.split(separator: ",").map(String.init)
    ids.removeAll { $0 == command.id }
    ids.insert(command.id, at: 0)
    recentCommandIDs = ids.prefix(8).joined(separator: ",")
    dismiss()
    command.action()
  }
}

private struct CommandPaletteRow: View {
  @Environment(\.orchestratorTheme) private var theme
  let command: PaletteCommand
  let isSelected: Bool

  var body: some View {
    HStack(spacing: 11) {
      Image(systemName: command.symbol)
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(isSelected ? theme.foreground : theme.accent)
        .frame(width: 27, height: 27)
        .background(
          isSelected ? theme.accent.opacity(0.18) : theme.accent.opacity(0.1),
          in: .rect(cornerRadius: 6)
        )

      VStack(alignment: .leading, spacing: 1) {
        Text(command.title)
          .font(.callout.weight(.medium))
          .lineLimit(1)
        Text(command.detail)
          .font(.caption)
          .foregroundStyle(isSelected ? theme.muted : theme.tertiary)
          .lineLimit(1)
      }

      Spacer(minLength: 10)

      if let shortcut = command.shortcut {
        Text(shortcut)
          .font(.caption.monospaced())
          .foregroundStyle(isSelected ? theme.muted : theme.tertiary)
          .padding(.horizontal, 6)
          .frame(height: 20)
          .background(theme.surface3, in: .rect(cornerRadius: 4))
      }
    }
    .foregroundStyle(isSelected ? theme.foreground : theme.muted)
    .padding(.horizontal, 10)
    .frame(height: 44)
    .background(
      isSelected ? theme.accent.opacity(0.14) : Color.clear,
      in: .rect(cornerRadius: 7)
    )
    .overlay(alignment: .leading) {
      if isSelected {
        RoundedRectangle(cornerRadius: 1)
          .fill(theme.accent)
          .frame(width: 2)
          .padding(.vertical, 7)
      }
    }
    .contentShape(Rectangle())
  }
}
