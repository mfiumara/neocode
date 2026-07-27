import AppKit
import SwiftUI

enum DiffFileStatus: String, Sendable {
  case added
  case modified
  case deleted
  case renamed
  case binary
}

struct DiffFileSummary: Equatable, Sendable {
  let path: String
  let status: DiffFileStatus
  let additions: Int
  let deletions: Int

  static func make(path: String, patch: String) -> DiffFileSummary {
    let lines = patch.split(separator: "\n", omittingEmptySubsequences: false)
    let additions = lines.count {
      $0.hasPrefix("+") && !$0.hasPrefix("+++")
    }
    let deletions = lines.count {
      $0.hasPrefix("-") && !$0.hasPrefix("---")
    }

    let status: DiffFileStatus
    if lines.contains(where: { $0.hasPrefix("Binary files ") }) {
      status = .binary
    } else if lines.contains(where: { $0.hasPrefix("new file mode ") }) {
      status = .added
    } else if lines.contains(where: { $0.hasPrefix("deleted file mode ") }) {
      status = .deleted
    } else if lines.contains(where: {
      $0.hasPrefix("rename from ") || $0.hasPrefix("rename to ")
    }) {
      status = .renamed
    } else {
      status = .modified
    }

    return DiffFileSummary(
      path: path,
      status: status,
      additions: additions,
      deletions: deletions
    )
  }
}

enum DiffDisplayLineKind: Sendable, Equatable {
  case file
  case metadata
  case hunk
  case context
  case addition
  case deletion
  case notice
}

struct DiffDisplayLine: Sendable {
  let kind: DiffDisplayLineKind
  let oldLine: Int?
  let newLine: Int?
  let content: String

  var accessibilityDescription: String {
    let location: String
    switch (oldLine, newLine) {
    case (.some(let old), .some(let new)):
      location = "old line \(old), new line \(new)"
    case (.some(let old), nil):
      location = "old line \(old)"
    case (nil, .some(let new)):
      location = "new line \(new)"
    case (nil, nil):
      location = ""
    }

    let change = switch kind {
    case .file: "file"
    case .metadata: "metadata"
    case .hunk: "change section"
    case .context: "unchanged"
    case .addition: "added"
    case .deletion: "removed"
    case .notice: "notice"
    }
    return [change, location, content].filter { !$0.isEmpty }.joined(separator: ", ")
  }
}

struct UnifiedDiffDocument: Sendable {
  let lines: [DiffDisplayLine]

  init(text: String) {
    var displayLines: [DiffDisplayLine] = []
    var oldLine: Int?
    var newLine: Int?

    for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
      if line.hasPrefix("diff --git ") {
        oldLine = nil
        newLine = nil
        displayLines.append(
          DiffDisplayLine(
            kind: .file,
            oldLine: nil,
            newLine: nil,
            content: Self.filePath(from: line)
          )
        )
      } else if line.hasPrefix("@@") {
        let starts = Self.hunkStarts(from: line)
        oldLine = starts.old
        newLine = starts.new
        displayLines.append(
          DiffDisplayLine(
            kind: .hunk,
            oldLine: nil,
            newLine: nil,
            content: line
          )
        )
      } else if line.hasPrefix("+") && !line.hasPrefix("+++") {
        displayLines.append(
          DiffDisplayLine(
            kind: .addition,
            oldLine: nil,
            newLine: newLine,
            content: String(line.dropFirst())
          )
        )
        newLine = newLine.map { $0 + 1 }
      } else if line.hasPrefix("-") && !line.hasPrefix("---") {
        displayLines.append(
          DiffDisplayLine(
            kind: .deletion,
            oldLine: oldLine,
            newLine: nil,
            content: String(line.dropFirst())
          )
        )
        oldLine = oldLine.map { $0 + 1 }
      } else if line.hasPrefix(" ") {
        displayLines.append(
          DiffDisplayLine(
            kind: .context,
            oldLine: oldLine,
            newLine: newLine,
            content: String(line.dropFirst())
          )
        )
        oldLine = oldLine.map { $0 + 1 }
        newLine = newLine.map { $0 + 1 }
      } else if line.hasPrefix("\\ No newline") {
        displayLines.append(
          DiffDisplayLine(
            kind: .notice,
            oldLine: nil,
            newLine: nil,
            content: "No newline at end of file"
          )
        )
      } else if let metadata = Self.presentableMetadata(line) {
        displayLines.append(
          DiffDisplayLine(
            kind: .metadata,
            oldLine: nil,
            newLine: nil,
            content: metadata
          )
        )
      }
    }

    lines = displayLines
  }

  private static func filePath(from line: String) -> String {
    let components = line.split(separator: " ", maxSplits: 3).map(String.init)
    guard components.count == 4 else { return line }
    let path = components[3]
    return path.hasPrefix("b/") ? String(path.dropFirst(2)) : path
  }

  private static func hunkStarts(from line: String) -> (old: Int?, new: Int?) {
    let parts = line.split(separator: " ")
    guard parts.count >= 3 else { return (nil, nil) }

    func number(_ value: Substring, prefix: Character) -> Int? {
      guard value.first == prefix else { return nil }
      return Int(value.dropFirst().split(separator: ",", maxSplits: 1)[0])
    }

    return (number(parts[1], prefix: "-"), number(parts[2], prefix: "+"))
  }

  private static func presentableMetadata(_ line: String) -> String? {
    if line.hasPrefix("new file mode ") {
      return "New file"
    }
    if line.hasPrefix("deleted file mode ") {
      return "Deleted file"
    }
    if line.hasPrefix("rename from ") {
      return "Renamed from \(line.dropFirst("rename from ".count))"
    }
    if line.hasPrefix("rename to ") {
      return "Renamed to \(line.dropFirst("rename to ".count))"
    }
    if line.hasPrefix("Binary files ") {
      return "Binary file changed"
    }
    if line.hasPrefix("similarity index ") {
      return line
    }
    return nil
  }
}

struct DiffRenderPalette {
  let background: NSColor
  let surface1: NSColor
  let gutter: NSColor
  let border: NSColor
  let text: NSColor
  let muted: NSColor
  let tertiary: NSColor
  let accent: NSColor
  let success: NSColor
  let danger: NSColor
  let hunkBackground: NSColor
  let hunkGutter: NSColor
  let additionBackground: NSColor
  let additionGutter: NSColor
  let deletionBackground: NSColor
  let deletionGutter: NSColor
  let syntaxKeyword: NSColor
  let syntaxString: NSColor
  let syntaxNumber: NSColor
  let syntaxComment: NSColor
  let syntaxType: NSColor

  init(theme: OrchestratorTheme) {
    background = theme.surface0.nsColor
    surface1 = theme.surface1.nsColor
    gutter = theme.surface1.nsColor
    border = theme.border.nsColor
    text = theme.foreground.nsColor
    muted = theme.muted.nsColor
    tertiary = theme.tertiary.nsColor
    accent = theme.accent.nsColor
    success = theme.success.nsColor
    danger = theme.danger.nsColor
    hunkBackground = theme.accent.nsColor.withAlphaComponent(0.09)
    hunkGutter = theme.accent.nsColor.withAlphaComponent(0.14)
    additionBackground = theme.success.nsColor.withAlphaComponent(0.09)
    additionGutter = theme.success.nsColor.withAlphaComponent(0.14)
    deletionBackground = theme.danger.nsColor.withAlphaComponent(0.09)
    deletionGutter = theme.danger.nsColor.withAlphaComponent(0.14)
    syntaxKeyword = theme.isDark
      ? NSColor(srgbRed: 0.99, green: 0.37, blue: 0.64, alpha: 1)
      : NSColor(srgbRed: 0.55, green: 0.13, blue: 0.52, alpha: 1)
    syntaxString = theme.isDark
      ? NSColor(srgbRed: 0.99, green: 0.42, blue: 0.36, alpha: 1)
      : NSColor(srgbRed: 0.77, green: 0.10, blue: 0.09, alpha: 1)
    syntaxNumber = theme.isDark
      ? NSColor(srgbRed: 0.82, green: 0.75, blue: 0.41, alpha: 1)
      : NSColor(srgbRed: 0.11, green: 0.0, blue: 0.81, alpha: 1)
    syntaxComment = theme.isDark
      ? NSColor(srgbRed: 0.50, green: 0.56, blue: 0.62, alpha: 1)
      : NSColor(srgbRed: 0.42, green: 0.45, blue: 0.49, alpha: 1)
    syntaxType = theme.isDark
      ? NSColor(srgbRed: 0.36, green: 0.85, blue: 1.0, alpha: 1)
      : NSColor(srgbRed: 0.04, green: 0.31, blue: 0.48, alpha: 1)
  }
}

@MainActor
enum DiffSyntaxHighlighter {
  private static let font = NSFont.monospacedSystemFont(
    ofSize: 12.25,
    weight: .regular
  )
  private static let mediumFont = NSFont.monospacedSystemFont(
    ofSize: 12.25,
    weight: .medium
  )

  static func highlight(
    _ source: String,
    language: SourceLanguage?,
    palette: DiffRenderPalette
  ) -> NSAttributedString {
    let result = NSMutableAttributedString(
      string: source,
      attributes: [
        .font: font,
        .foregroundColor: palette.text,
      ]
    )
    guard let language, !source.isEmpty else { return result }
    let fullRange = NSRange(location: 0, length: (source as NSString).length)

    apply(
      pattern: #""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'"#,
      color: palette.syntaxString,
      to: result,
      range: fullRange
    )
    apply(
      pattern: #"\b(?:0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)\b"#,
      color: palette.syntaxNumber,
      to: result,
      range: fullRange
    )

    let keywords = keywords(for: language)
    if !keywords.isEmpty {
      let alternatives = keywords
        .map(NSRegularExpression.escapedPattern(for:))
        .joined(separator: "|")
      apply(
        pattern: "\\b(?:\(alternatives))\\b",
        color: palette.syntaxKeyword,
        font: mediumFont,
        to: result,
        range: fullRange
      )
    }

    switch language {
    case .markdown:
      apply(
        pattern: #"^(?:#{1,6}\s+|>\s+|[-*+]\s+)"#,
        color: palette.syntaxType,
        font: mediumFont,
        to: result,
        range: fullRange
      )
      apply(
        pattern: #"`[^`]+`"#,
        color: palette.syntaxString,
        to: result,
        range: fullRange
      )
    case .html:
      apply(
        pattern: #"</?[A-Za-z][^>]*>"#,
        color: palette.syntaxType,
        to: result,
        range: fullRange
      )
    default:
      break
    }

    let commentPattern: String? = switch language {
    case .bash, .python, .ruby, .yaml, .toml:
      #"#.*$"#
    case .sql:
      #"--.*$"#
    case .markdown, .json:
      nil
    default:
      #"//.*$"#
    }
    if let commentPattern {
      apply(
        pattern: commentPattern,
        color: palette.syntaxComment,
        to: result,
        range: fullRange
      )
    }
    return result
  }

  private static func apply(
    pattern: String,
    color: NSColor,
    font: NSFont? = nil,
    to value: NSMutableAttributedString,
    range: NSRange
  ) {
    guard
      let expression = try? NSRegularExpression(
        pattern: pattern,
        options: [.anchorsMatchLines]
      )
    else {
      return
    }
    expression.enumerateMatches(in: value.string, range: range) { match, _, _ in
      guard let range = match?.range else { return }
      value.addAttribute(.foregroundColor, value: color, range: range)
      if let font {
        value.addAttribute(.font, value: font, range: range)
      }
    }
  }

  private static func keywords(for language: SourceLanguage) -> [String] {
    switch language {
    case .swift:
      [
        "actor", "associatedtype", "async", "await", "case", "class", "deinit",
        "do", "else", "enum", "extension", "false", "for", "func", "guard",
        "if", "import", "in", "init", "let", "nil", "private", "protocol",
        "public", "return", "some", "static", "struct", "switch", "throw",
        "throws", "true", "try", "var", "where", "while",
      ]
    case .javascript, .typescript:
      [
        "async", "await", "break", "case", "class", "const", "continue",
        "default", "else", "export", "extends", "false", "for", "from",
        "function", "if", "import", "in", "interface", "let", "new", "null",
        "return", "switch", "this", "true", "type", "undefined", "var", "while",
      ]
    case .python:
      [
        "and", "as", "async", "await", "break", "class", "continue", "def",
        "elif", "else", "except", "False", "finally", "for", "from", "if",
        "import", "in", "is", "lambda", "None", "not", "or", "pass", "raise",
        "return", "True", "try", "while", "with", "yield",
      ]
    case .rust:
      [
        "as", "async", "await", "break", "const", "continue", "crate", "else",
        "enum", "false", "fn", "for", "if", "impl", "in", "let", "loop",
        "match", "mod", "move", "mut", "pub", "ref", "return", "self",
        "static", "struct", "trait", "true", "type", "unsafe", "use", "where",
        "while",
      ]
    case .c, .cpp, .csharp, .java:
      [
        "auto", "bool", "break", "case", "catch", "char", "class", "const",
        "continue", "default", "do", "double", "else", "enum", "false", "final",
        "float", "for", "if", "int", "interface", "long", "new", "null",
        "private", "protected", "public", "return", "short", "static", "struct",
        "switch", "this", "throw", "true", "try", "void", "while",
      ]
    case .go:
      [
        "break", "case", "chan", "const", "continue", "default", "defer", "else",
        "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
        "map", "package", "range", "return", "select", "struct", "switch", "type",
        "var",
      ]
    case .bash:
      ["case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "then", "while"]
    case .ruby:
      ["begin", "case", "class", "def", "do", "else", "elsif", "end", "false", "if", "module", "nil", "return", "true", "unless", "until", "while"]
    case .php:
      ["class", "echo", "else", "elseif", "false", "for", "foreach", "function", "if", "namespace", "null", "private", "protected", "public", "return", "true", "use", "while"]
    case .sql:
      ["ALTER", "AND", "AS", "CREATE", "DELETE", "DROP", "FROM", "GROUP", "INSERT", "INTO", "JOIN", "LIMIT", "NOT", "NULL", "ON", "OR", "ORDER", "SELECT", "SET", "TABLE", "UPDATE", "VALUES", "WHERE"]
    case .css:
      ["important", "inherit", "initial", "media", "none", "unset", "var"]
    case .html, .json, .markdown, .toml, .yaml:
      []
    }
  }
}

@MainActor
struct UnifiedDiffView: NSViewRepresentable {
  @Environment(\.orchestratorTheme) private var theme
  let text: String
  var language: SourceLanguage? = nil
  var onOpenLine: ((Int) -> Void)? = nil

  func makeNSView(context: Context) -> DiffTableContainer {
    let view = DiffTableContainer()
    view.setPresentation(
      palette: DiffRenderPalette(theme: theme),
      language: language,
      onOpenLine: onOpenLine
    )
    view.setText(text)
    return view
  }

  func updateNSView(_ nsView: DiffTableContainer, context: Context) {
    nsView.setPresentation(
      palette: DiffRenderPalette(theme: theme),
      language: language,
      onOpenLine: onOpenLine
    )
    nsView.setText(text)
  }

  func sizeThatFits(
    _ proposal: ProposedViewSize,
    nsView: DiffTableContainer,
    context: Context
  ) -> CGSize? {
    CGSize(
      width: proposal.width ?? nsView.frame.width,
      height: proposal.height ?? nsView.frame.height
    )
  }
}

@MainActor
final class DiffTableContainer: NSView, NSTableViewDataSource, NSTableViewDelegate {
  private let scrollView = NSScrollView()
  private let tableView = NSTableView()
  private let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("diff"))
  private var renderedText: String?
  private var lines: [DiffDisplayLine] = []
  private var preferredContentWidth: CGFloat = 700
  private var palette = DiffRenderPalette(theme: .dark)
  private var language: SourceLanguage?
  private var onOpenLine: ((Int) -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)

    wantsLayer = true
    layer?.backgroundColor = palette.background.cgColor

    scrollView.translatesAutoresizingMaskIntoConstraints = false
    scrollView.autohidesScrollers = true
    scrollView.borderType = .noBorder
    scrollView.drawsBackground = true
    scrollView.backgroundColor = palette.background
    scrollView.hasHorizontalScroller = true
    scrollView.hasVerticalScroller = true
    scrollView.scrollerStyle = .overlay

    column.resizingMask = []
    tableView.addTableColumn(column)
    tableView.allowsColumnReordering = false
    tableView.allowsColumnResizing = false
    tableView.allowsEmptySelection = true
    tableView.backgroundColor = palette.background
    tableView.columnAutoresizingStyle = .noColumnAutoresizing
    tableView.dataSource = self
    tableView.delegate = self
    tableView.focusRingType = .none
    tableView.gridStyleMask = []
    tableView.headerView = nil
    tableView.intercellSpacing = .zero
    tableView.rowSizeStyle = .custom
    tableView.selectionHighlightStyle = .none
    tableView.usesAlternatingRowBackgroundColors = false
    tableView.target = self
    tableView.doubleAction = #selector(openSelectedLine)

    scrollView.documentView = tableView
    addSubview(scrollView)
    NSLayoutConstraint.activate([
      scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
      scrollView.topAnchor.constraint(equalTo: topAnchor),
      scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layout() {
    super.layout()
    let visibleWidth = max(1, scrollView.contentSize.width)
    column.width = max(visibleWidth, preferredContentWidth)
  }

  func setPresentation(
    palette: DiffRenderPalette,
    language: SourceLanguage?,
    onOpenLine: ((Int) -> Void)?
  ) {
    self.palette = palette
    self.language = language
    self.onOpenLine = onOpenLine
    layer?.backgroundColor = palette.background.cgColor
    scrollView.backgroundColor = palette.background
    tableView.backgroundColor = palette.background
    tableView.reloadData()
  }

  func setText(_ text: String) {
    guard renderedText != text else { return }
    renderedText = text
    lines = UnifiedDiffDocument(text: text).lines

    let font = NSFont.monospacedSystemFont(ofSize: 12.25, weight: .regular)
    preferredContentWidth = min(
      6_000,
      max(
        700,
        lines.map {
          ($0.content as NSString).size(withAttributes: [.font: font]).width + 140
        }.max() ?? 700
      )
    )

    tableView.reloadData()
    needsLayout = true
    layoutSubtreeIfNeeded()
    tableView.scrollRowToVisible(0)
    scrollView.contentView.scroll(to: .zero)
    scrollView.reflectScrolledClipView(scrollView.contentView)
  }

  func numberOfRows(in tableView: NSTableView) -> Int {
    lines.count
  }

  func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
    switch lines[row].kind {
    case .file: 32
    case .hunk: 26
    case .metadata, .notice: 23
    case .context, .addition, .deletion: 21
    }
  }

  func tableView(
    _ tableView: NSTableView,
    viewFor tableColumn: NSTableColumn?,
    row: Int
  ) -> NSView? {
    let identifier = NSUserInterfaceItemIdentifier("DiffLineCell")
    let cell =
      tableView.makeView(withIdentifier: identifier, owner: self) as? DiffLineCell
      ?? DiffLineCell(identifier: identifier)
    cell.configure(with: lines[row], palette: palette, language: language)
    return cell
  }

  @objc
  private func openSelectedLine() {
    let row = tableView.clickedRow
    guard lines.indices.contains(row) else { return }
    guard let line = lines[row].newLine ?? lines[row].oldLine else { return }
    onOpenLine?(line)
  }
}

@MainActor
private final class DiffLineCell: NSTableCellView {
  private let gutterBackground = NSView()
  private let oldNumber = NSTextField(labelWithString: "")
  private let newNumber = NSTextField(labelWithString: "")
  private let marker = NSTextField(labelWithString: "")
  private let content = NSTextField(labelWithString: "")
  private let gutterSeparator = NSBox()
  private let bottomSeparator = NSBox()

  init(identifier: NSUserInterfaceItemIdentifier) {
    super.init(frame: .zero)
    self.identifier = identifier
    wantsLayer = true

    gutterBackground.translatesAutoresizingMaskIntoConstraints = false
    gutterBackground.wantsLayer = true
    addSubview(gutterBackground)

    let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
    for field in [oldNumber, newNumber] {
      field.translatesAutoresizingMaskIntoConstraints = false
      field.alignment = .right
      field.font = numberFont
      field.lineBreakMode = .byClipping
      field.maximumNumberOfLines = 1
      field.textColor = .tertiaryLabelColor
      addSubview(field)
    }

    marker.translatesAutoresizingMaskIntoConstraints = false
    marker.alignment = .center
    marker.font = .monospacedSystemFont(ofSize: 12, weight: .semibold)
    addSubview(marker)

    content.translatesAutoresizingMaskIntoConstraints = false
    content.cell?.usesSingleLineMode = true
    content.font = .monospacedSystemFont(ofSize: 12.25, weight: .regular)
    content.isSelectable = true
    content.lineBreakMode = .byClipping
    content.maximumNumberOfLines = 1
    content.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    addSubview(content)

    gutterSeparator.translatesAutoresizingMaskIntoConstraints = false
    gutterSeparator.boxType = .separator
    addSubview(gutterSeparator)

    bottomSeparator.translatesAutoresizingMaskIntoConstraints = false
    bottomSeparator.boxType = .separator
    addSubview(bottomSeparator)

    NSLayoutConstraint.activate([
      gutterBackground.leadingAnchor.constraint(equalTo: leadingAnchor),
      gutterBackground.topAnchor.constraint(equalTo: topAnchor),
      gutterBackground.bottomAnchor.constraint(equalTo: bottomAnchor),
      gutterBackground.widthAnchor.constraint(equalToConstant: 112),

      oldNumber.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
      oldNumber.widthAnchor.constraint(equalToConstant: 39),
      oldNumber.centerYAnchor.constraint(equalTo: centerYAnchor),

      newNumber.leadingAnchor.constraint(equalTo: oldNumber.trailingAnchor, constant: 5),
      newNumber.widthAnchor.constraint(equalToConstant: 39),
      newNumber.centerYAnchor.constraint(equalTo: centerYAnchor),

      marker.leadingAnchor.constraint(equalTo: newNumber.trailingAnchor, constant: 5),
      marker.widthAnchor.constraint(equalToConstant: 18),
      marker.centerYAnchor.constraint(equalTo: centerYAnchor),

      gutterSeparator.leadingAnchor.constraint(equalTo: gutterBackground.trailingAnchor),
      gutterSeparator.widthAnchor.constraint(equalToConstant: 1),
      gutterSeparator.topAnchor.constraint(equalTo: topAnchor),
      gutterSeparator.bottomAnchor.constraint(equalTo: bottomAnchor),

      content.leadingAnchor.constraint(equalTo: gutterSeparator.trailingAnchor, constant: 10),
      content.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
      content.centerYAnchor.constraint(equalTo: centerYAnchor),

      bottomSeparator.leadingAnchor.constraint(equalTo: leadingAnchor),
      bottomSeparator.trailingAnchor.constraint(equalTo: trailingAnchor),
      bottomSeparator.bottomAnchor.constraint(equalTo: bottomAnchor),
      bottomSeparator.heightAnchor.constraint(equalToConstant: 1),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func configure(
    with line: DiffDisplayLine,
    palette: DiffRenderPalette,
    language: SourceLanguage?
  ) {
    oldNumber.stringValue = line.oldLine.map(String.init) ?? ""
    newNumber.stringValue = line.newLine.map(String.init) ?? ""
    setAccessibilityLabel(line.accessibilityDescription)

    let rowBackground: NSColor
    let gutterColor: NSColor

    oldNumber.isHidden = false
    newNumber.isHidden = false
    marker.isHidden = false
    gutterSeparator.isHidden = false
    content.font = .monospacedSystemFont(ofSize: 12.25, weight: .regular)
    content.textColor = palette.text
    oldNumber.textColor = palette.tertiary
    newNumber.textColor = palette.tertiary
    bottomSeparator.isHidden = true
    bottomSeparator.contentView?.wantsLayer = true
    bottomSeparator.borderColor = palette.border
    gutterSeparator.borderColor = palette.border

    switch line.kind {
    case .file:
      rowBackground = palette.surface1
      gutterColor = palette.surface1
      oldNumber.isHidden = true
      newNumber.isHidden = true
      marker.stringValue = "▾"
      marker.textColor = palette.muted
      content.font = .systemFont(ofSize: 12.5, weight: .semibold)
      bottomSeparator.isHidden = false
    case .metadata:
      rowBackground = palette.background
      gutterColor = palette.gutter
      marker.stringValue = "·"
      marker.textColor = palette.tertiary
      content.font = .systemFont(ofSize: 11.5, weight: .regular)
      content.textColor = palette.muted
    case .hunk:
      rowBackground = palette.hunkBackground
      gutterColor = palette.hunkGutter
      oldNumber.isHidden = true
      newNumber.isHidden = true
      marker.stringValue = "•••"
      marker.textColor = palette.accent
      content.font = .monospacedSystemFont(ofSize: 11.5, weight: .medium)
      content.textColor = palette.accent
    case .context:
      rowBackground = palette.background
      gutterColor = palette.gutter
      marker.stringValue = ""
    case .addition:
      rowBackground = palette.additionBackground
      gutterColor = palette.additionGutter
      marker.stringValue = "+"
      marker.textColor = palette.success
    case .deletion:
      rowBackground = palette.deletionBackground
      gutterColor = palette.deletionGutter
      marker.stringValue = "−"
      marker.textColor = palette.danger
    case .notice:
      rowBackground = palette.background
      gutterColor = palette.gutter
      oldNumber.isHidden = true
      newNumber.isHidden = true
      marker.stringValue = "!"
      marker.textColor = palette.tertiary
      content.font = .systemFont(ofSize: 11, weight: .regular)
      content.textColor = palette.tertiary
    }

    if [.context, .addition, .deletion].contains(line.kind) {
      content.attributedStringValue = DiffSyntaxHighlighter.highlight(
        line.content,
        language: language,
        palette: palette
      )
    } else {
      content.stringValue = line.content
      content.textColor =
        line.kind == .hunk ? palette.accent
        : (line.kind == .metadata || line.kind == .notice ? palette.muted : palette.text)
    }
    layer?.backgroundColor = rowBackground.cgColor
    gutterBackground.layer?.backgroundColor = gutterColor.cgColor
  }
}
