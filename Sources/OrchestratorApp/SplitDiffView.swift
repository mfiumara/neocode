import AppKit
import SwiftUI

struct SplitDiffView: View {
  @Environment(\.orchestratorTheme) private var theme
  let text: String
  var language: SourceLanguage? = nil
  var onOpenLine: ((Int) -> Void)? = nil

  private var document: SplitDiffDocument {
    SplitDiffDocument(text: text)
  }

  var body: some View {
    GeometryReader { proxy in
      let width = max(proxy.size.width, document.preferredWidth)
      VStack(spacing: 0) {
        columnHeader(width: width)

        ScrollView([.horizontal, .vertical]) {
          LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
            ForEach(document.sections) { section in
              Section {
                ForEach(section.rows) { row in
                  SplitDiffRowView(
                    row: row,
                    language: language,
                    width: width,
                    onOpenLine: onOpenLine
                  )
                }
              } header: {
                if let header = section.header {
                  SplitDiffSpanningRow(
                    text: header,
                    kind: .hunk,
                    width: width
                  )
                }
              }
            }
          }
          .frame(width: width, alignment: .leading)
        }
        .scrollIndicators(.automatic)
      }
      .background(theme.surface0)
    }
  }

  private func columnHeader(width: CGFloat) -> some View {
    HStack(spacing: 0) {
      Label("Before", systemImage: "minus")
        .frame(width: width / 2, alignment: .leading)
        .padding(.leading, 12)
      Label("After", systemImage: "plus")
        .frame(width: width / 2, alignment: .leading)
        .padding(.leading, 12)
        .overlay(alignment: .leading) {
          Rectangle()
            .fill(theme.borderStrong)
            .frame(width: 1)
        }
    }
    .font(OrchestratorTheme.Typography.captionMedium)
    .foregroundStyle(theme.muted)
    .frame(width: width, height: 25)
    .background(theme.surface1)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(theme.border)
        .frame(height: 1)
    }
  }
}

private struct SplitDiffRowView: View {
  @Environment(\.orchestratorTheme) private var theme
  let row: SplitDiffRow
  let language: SourceLanguage?
  let width: CGFloat
  let onOpenLine: ((Int) -> Void)?

  var body: some View {
    switch row.kind {
    case .file, .metadata, .notice:
      SplitDiffSpanningRow(
        text: row.label ?? "",
        kind: row.kind,
        width: width
      )
    case .hunk:
      EmptyView()
    case .code:
      HStack(spacing: 0) {
        SplitDiffSideView(
          side: row.left,
          language: language,
          edge: .left,
          onOpenLine: onOpenLine
        )
        .frame(width: width / 2)

        SplitDiffSideView(
          side: row.right,
          language: language,
          edge: .right,
          onOpenLine: onOpenLine
        )
        .frame(width: width / 2)
        .overlay(alignment: .leading) {
          Rectangle()
            .fill(theme.borderStrong)
            .frame(width: 1)
        }
      }
      .frame(width: width, height: 22)
    }
  }
}

private struct SplitDiffSideView: View {
  @Environment(\.orchestratorTheme) private var theme
  let side: SplitDiffSide?
  let language: SourceLanguage?
  let edge: Edge
  let onOpenLine: ((Int) -> Void)?

  var body: some View {
    HStack(spacing: 0) {
      Text(side?.line.map(String.init) ?? "")
        .font(.system(size: 10.5, design: .monospaced))
        .foregroundStyle(theme.tertiary)
        .multilineTextAlignment(.trailing)
        .padding(.trailing, 7)
        .frame(width: 48, alignment: .trailing)
        .frame(maxHeight: .infinity)
        .background(gutterBackground)

      Text(marker)
        .font(.system(size: 12, weight: .semibold, design: .monospaced))
        .foregroundStyle(markerColor)
        .frame(width: 22)

      if let side {
        Text(
          AttributedString(
            DiffSyntaxHighlighter.highlight(
              side.content,
              language: language,
              palette: DiffRenderPalette(theme: theme)
            )
          )
        )
        .lineLimit(1)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, 8)
      } else {
        Spacer(minLength: 0)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(rowBackground)
    .contentShape(.rect)
    .onTapGesture(count: 2) {
      guard let line = side?.line else { return }
      onOpenLine?(line)
    }
    .accessibilityLabel(accessibilityLabel)
  }

  private var marker: String {
    switch side?.kind {
    case .addition: "+"
    case .deletion: "−"
    case .context, nil: ""
    }
  }

  private var markerColor: Color {
    switch side?.kind {
    case .addition: theme.success
    case .deletion: theme.danger
    case .context, nil: theme.tertiary
    }
  }

  private var rowBackground: Color {
    switch side?.kind {
    case .addition: theme.success.opacity(0.09)
    case .deletion: theme.danger.opacity(0.09)
    case .context: theme.surface0
    case nil: theme.surface1.opacity(0.42)
    }
  }

  private var gutterBackground: Color {
    switch side?.kind {
    case .addition: theme.success.opacity(0.14)
    case .deletion: theme.danger.opacity(0.14)
    case .context: theme.surface1
    case nil: theme.surface1.opacity(0.7)
    }
  }

  private var accessibilityLabel: String {
    guard let side else {
      return edge == .left ? "No previous line" : "No resulting line"
    }
    let change = switch side.kind {
    case .context: "unchanged"
    case .addition: "added"
    case .deletion: "removed"
    }
    return "\(change), line \(side.line ?? 0), \(side.content)"
  }

  enum Edge {
    case left
    case right
  }
}

private struct SplitDiffSpanningRow: View {
  @Environment(\.orchestratorTheme) private var theme
  let text: String
  let kind: SplitDiffRowKind
  let width: CGFloat

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: symbol)
        .font(.system(size: 10, weight: .semibold))
      Text(text)
        .font(font)
        .lineLimit(1)
      Spacer()
    }
    .foregroundStyle(foreground)
    .padding(.horizontal, 10)
    .frame(width: width, height: height)
    .background(background)
    .overlay(alignment: .bottom) {
      if kind == .file {
        Rectangle()
          .fill(theme.border)
          .frame(height: 1)
      }
    }
  }

  private var symbol: String {
    switch kind {
    case .file: "doc.text"
    case .hunk: "ellipsis"
    case .metadata: "info.circle"
    case .notice: "exclamationmark"
    case .code: ""
    }
  }

  private var font: Font {
    switch kind {
    case .file:
      OrchestratorTheme.Typography.bodyMedium
    case .hunk:
      OrchestratorTheme.Typography.captionMedium.monospaced()
    case .metadata, .notice:
      OrchestratorTheme.Typography.caption
    case .code:
      OrchestratorTheme.Typography.code
    }
  }

  private var foreground: Color {
    kind == .hunk ? theme.accent : theme.muted
  }

  private var background: Color {
    switch kind {
    case .file: theme.surface1
    case .hunk: theme.accent.opacity(0.12)
    case .metadata, .notice: theme.surface0
    case .code: theme.surface0
    }
  }

  private var height: CGFloat {
    switch kind {
    case .file: 30
    case .hunk: 26
    case .metadata, .notice: 23
    case .code: 22
    }
  }
}

private enum SplitDiffSideKind {
  case context
  case addition
  case deletion
}

private struct SplitDiffSide {
  let line: Int?
  let content: String
  let kind: SplitDiffSideKind
}

private enum SplitDiffRowKind: Equatable {
  case file
  case hunk
  case metadata
  case notice
  case code
}

private struct SplitDiffRow: Identifiable {
  let id: Int
  let kind: SplitDiffRowKind
  let label: String?
  let left: SplitDiffSide?
  let right: SplitDiffSide?
}

private struct SplitDiffSection: Identifiable {
  let id: Int
  let header: String?
  let rows: [SplitDiffRow]
}

private struct SplitDiffDocument {
  let sections: [SplitDiffSection]
  let preferredWidth: CGFloat

  init(text: String) {
    let unified = UnifiedDiffDocument(text: text).lines
    var rows: [SplitDiffRow] = []
    var rowID = 0
    var index = 0

    func append(
      _ kind: SplitDiffRowKind,
      label: String? = nil,
      left: SplitDiffSide? = nil,
      right: SplitDiffSide? = nil
    ) {
      rows.append(
        SplitDiffRow(
          id: rowID,
          kind: kind,
          label: label,
          left: left,
          right: right
        )
      )
      rowID += 1
    }

    while index < unified.count {
      let line = unified[index]
      switch line.kind {
      case .file:
        append(.file, label: line.content)
        index += 1
      case .metadata:
        append(.metadata, label: line.content)
        index += 1
      case .hunk:
        append(.hunk, label: line.content)
        index += 1
      case .notice:
        append(.notice, label: line.content)
        index += 1
      case .context:
        let side = SplitDiffSide(
          line: line.newLine,
          content: line.content,
          kind: .context
        )
        append(
          .code,
          left: SplitDiffSide(
            line: line.oldLine,
            content: line.content,
            kind: .context
          ),
          right: side
        )
        index += 1
      case .addition:
        append(
          .code,
          right: SplitDiffSide(
            line: line.newLine,
            content: line.content,
            kind: .addition
          )
        )
        index += 1
      case .deletion:
        var deletions: [DiffDisplayLine] = []
        var additions: [DiffDisplayLine] = []
        while index < unified.count, unified[index].kind == .deletion {
          deletions.append(unified[index])
          index += 1
        }
        while index < unified.count, unified[index].kind == .addition {
          additions.append(unified[index])
          index += 1
        }
        for offset in 0..<max(deletions.count, additions.count) {
          let deletion = deletions.indices.contains(offset) ? deletions[offset] : nil
          let addition = additions.indices.contains(offset) ? additions[offset] : nil
          append(
            .code,
            left: deletion.map {
              SplitDiffSide(
                line: $0.oldLine,
                content: $0.content,
                kind: .deletion
              )
            },
            right: addition.map {
              SplitDiffSide(
                line: $0.newLine,
                content: $0.content,
                kind: .addition
              )
            }
          )
        }
      }
    }

    var nextSections: [SplitDiffSection] = []
    var header: String?
    var sectionRows: [SplitDiffRow] = []
    var sectionID = 0
    for row in rows {
      if row.kind == .hunk {
        if !sectionRows.isEmpty || header != nil {
          nextSections.append(
            SplitDiffSection(id: sectionID, header: header, rows: sectionRows)
          )
          sectionID += 1
        }
        header = row.label
        sectionRows = []
      } else {
        sectionRows.append(row)
      }
    }
    if !sectionRows.isEmpty || header != nil {
      nextSections.append(
        SplitDiffSection(id: sectionID, header: header, rows: sectionRows)
      )
    }
    sections = nextSections

    let longestLeft = rows.compactMap(\.left?.content.count).max() ?? 0
    let longestRight = rows.compactMap(\.right?.content.count).max() ?? 0
    preferredWidth = min(
      5_000,
      max(900, CGFloat(max(longestLeft, longestRight)) * 7.4 * 2 + 160)
    )
  }
}
