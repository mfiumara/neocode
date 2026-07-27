import AppKit
import STPluginNeon
import STTextView
import SwiftUI

enum SourceLanguage: String, Sendable {
  case bash
  case c
  case cpp
  case csharp
  case css
  case go
  case html
  case java
  case javascript
  case json
  case markdown
  case php
  case python
  case ruby
  case rust
  case sql
  case swift
  case toml
  case typescript
  case yaml

  var displayName: String {
    switch self {
    case .bash: "Shell"
    case .c: "C"
    case .cpp: "C++"
    case .csharp: "C#"
    case .css: "CSS"
    case .go: "Go"
    case .html: "HTML"
    case .java: "Java"
    case .javascript: "JavaScript"
    case .json: "JSON"
    case .markdown: "Markdown"
    case .php: "PHP"
    case .python: "Python"
    case .ruby: "Ruby"
    case .rust: "Rust"
    case .sql: "SQL"
    case .swift: "Swift"
    case .toml: "TOML"
    case .typescript: "TypeScript"
    case .yaml: "YAML"
    }
  }

  static func detect(path: String) -> SourceLanguage? {
    let url = URL(fileURLWithPath: path)
    let name = url.lastPathComponent.lowercased()
    let extensionName = url.pathExtension.lowercased()

    if ["bashrc", "zshrc", ".bashrc", ".zshrc"].contains(name) {
      return .bash
    }

    return switch extensionName {
    case "bash", "sh", "zsh": .bash
    case "c": .c
    case "cc", "cpp", "cxx", "h", "hh", "hpp": .cpp
    case "cs": .csharp
    case "css", "scss": .css
    case "go": .go
    case "htm", "html": .html
    case "java": .java
    case "cjs", "js", "jsx", "mjs": .javascript
    case "json", "jsonc": .json
    case "markdown", "md", "mdx": .markdown
    case "php": .php
    case "py", "pyi": .python
    case "rb": .ruby
    case "rs": .rust
    case "sql": .sql
    case "swift": .swift
    case "toml": .toml
    case "ts", "tsx": .typescript
    case "yaml", "yml": .yaml
    default: nil
    }
  }
}

@MainActor
struct SourceCodeView: NSViewRepresentable {
  let text: String
  let language: SourceLanguage?
  let wrapsLines: Bool
  var initialLine: Int? = nil

  final class Coordinator {
    var lastScrolledLine: Int?
  }

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeNSView(context: Context) -> NSScrollView {
    let scrollView = STTextView.scrollableTextView()
    let textView = scrollView.documentView as! STTextView
    let backgroundColor = context.environment.orchestratorTheme.surface0.nsColor
    let isDark = context.environment.orchestratorTheme.isDark
    let font = SourceEditorTheme.regularFont
    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.defaultTabInterval = 28
    paragraphStyle.lineHeightMultiple = 1.16

    scrollView.autohidesScrollers = true
    scrollView.automaticallyAdjustsContentInsets = false
    scrollView.borderType = .noBorder
    scrollView.clipsToBounds = true
    scrollView.contentInsets = NSEdgeInsets(top: 10, left: 0, bottom: 12, right: 8)
    scrollView.drawsBackground = true
    scrollView.backgroundColor = backgroundColor
    scrollView.hasHorizontalScroller = !wrapsLines
    scrollView.scrollerStyle = .overlay
    scrollView.contentView.clipsToBounds = true

    textView.allowsUndo = false
    textView.backgroundColor = backgroundColor
    textView.defaultParagraphStyle = paragraphStyle
    textView.font = font
    textView.highlightSelectedLine = true
    textView.isEditable = false
    textView.isHorizontallyResizable = !wrapsLines
    textView.isIncrementalSearchingEnabled = true
    textView.isSelectable = true
    textView.textColor = SourceEditorTheme.plainColor(forDarkAppearance: isDark)
    textView.textContainer.lineFragmentPadding = 14
    textView.text = text
    textView.textFinder.incrementalSearchingShouldDimContentView = true
    textView.showsLineNumbers = true

    if let gutter = textView.gutterView {
      gutter.drawSeparator = true
      gutter.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
      gutter.minimumThickness = 44
      gutter.separatorColor = context.environment.orchestratorTheme.border.nsColor
      gutter.textColor = context.environment.orchestratorTheme.tertiary.nsColor
    }

    addSyntaxPlugin(
      to: textView,
      theme: SourceEditorTheme.theme(forDarkAppearance: isDark)
    )
    scrollToInitialLineIfNeeded(textView, context: context)
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    guard let textView = scrollView.documentView as? STTextView else { return }
    let backgroundColor = context.environment.orchestratorTheme.surface0.nsColor
    scrollView.backgroundColor = backgroundColor
    textView.backgroundColor = backgroundColor
    textView.textColor = SourceEditorTheme.plainColor(
      forDarkAppearance: context.environment.orchestratorTheme.isDark
    )
    if let gutter = textView.gutterView {
      gutter.separatorColor = context.environment.orchestratorTheme.border.nsColor
      gutter.textColor = context.environment.orchestratorTheme.tertiary.nsColor
    }

    let shouldWrap = wrapsLines
    if textView.isHorizontallyResizable == shouldWrap {
      textView.isHorizontallyResizable = !shouldWrap
      scrollView.hasHorizontalScroller = !shouldWrap
    }

    if textView.text != text {
      textView.text = text
      scrollView.contentView.scroll(to: .zero)
      scrollView.reflectScrolledClipView(scrollView.contentView)
      context.coordinator.lastScrolledLine = nil
    }
    scrollToInitialLineIfNeeded(textView, context: context)
  }

  private func scrollToInitialLineIfNeeded(
    _ textView: STTextView,
    context: Context
  ) {
    guard
      let initialLine,
      initialLine > 0,
      context.coordinator.lastScrolledLine != initialLine
    else {
      return
    }
    let lines = text.split(
      separator: "\n",
      maxSplits: max(0, initialLine - 1),
      omittingEmptySubsequences: false
    )
    let offset: Int
    if initialLine <= 1 {
      offset = 0
    } else {
      offset = lines.prefix(initialLine - 1).reduce(0) { partial, line in
        partial + line.utf16.count + 1
      }
    }
    let safeOffset = min(max(0, offset), (text as NSString).length)
    context.coordinator.lastScrolledLine = initialLine
    DispatchQueue.main.async {
      textView.scrollRangeToVisible(NSRange(location: safeOffset, length: 0))
    }
  }

  func sizeThatFits(
    _ proposal: ProposedViewSize,
    nsView: NSScrollView,
    context: Context
  ) -> CGSize? {
    CGSize(
      width: proposal.width ?? nsView.frame.width,
      height: proposal.height ?? nsView.frame.height
    )
  }

  private func addSyntaxPlugin(to textView: STTextView, theme: Theme) {
    switch language {
    case .bash:
      textView.addPlugin(NeonPlugin(theme: theme, language: .bash))
    case .c:
      textView.addPlugin(NeonPlugin(theme: theme, language: .c))
    case .cpp:
      textView.addPlugin(NeonPlugin(theme: theme, language: .cpp))
    case .csharp:
      textView.addPlugin(NeonPlugin(theme: theme, language: .csharp))
    case .css:
      textView.addPlugin(NeonPlugin(theme: theme, language: .css))
    case .go:
      textView.addPlugin(NeonPlugin(theme: theme, language: .go))
    case .html:
      textView.addPlugin(NeonPlugin(theme: theme, language: .html))
    case .java:
      textView.addPlugin(NeonPlugin(theme: theme, language: .java))
    case .javascript:
      textView.addPlugin(NeonPlugin(theme: theme, language: .javascript))
    case .json:
      textView.addPlugin(NeonPlugin(theme: theme, language: .json))
    case .markdown:
      textView.addPlugin(NeonPlugin(theme: theme, language: .markdown))
    case .php:
      textView.addPlugin(NeonPlugin(theme: theme, language: .php))
    case .python:
      textView.addPlugin(NeonPlugin(theme: theme, language: .python))
    case .ruby:
      textView.addPlugin(NeonPlugin(theme: theme, language: .ruby))
    case .rust:
      textView.addPlugin(NeonPlugin(theme: theme, language: .rust))
    case .sql:
      textView.addPlugin(NeonPlugin(theme: theme, language: .sql))
    case .swift:
      textView.addPlugin(NeonPlugin(theme: theme, language: .swift))
    case .toml:
      textView.addPlugin(NeonPlugin(theme: theme, language: .toml))
    case .typescript:
      textView.addPlugin(NeonPlugin(theme: theme, language: .typescript))
    case .yaml:
      textView.addPlugin(NeonPlugin(theme: theme, language: .yaml))
    case nil:
      break
    }
  }
}

@MainActor
private enum SourceEditorTheme {
  static let regularFont = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
  static let mediumFont = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .medium)

  static func plainColor(forDarkAppearance isDark: Bool) -> NSColor {
    color(light: 0x24292F, dark: 0xD4D4D4, isDark: isDark)
  }

  static func theme(forDarkAppearance isDark: Bool) -> Theme {
    let plain = plainColor(forDarkAppearance: isDark)
    return Theme(
      colors: Theme.Colors(
        colors: [
          "plain": plain,
          "boolean": color(light: 0x7F00A8, dark: 0xDDA0DD, isDark: isDark),
          "comment": color(light: 0x6A737D, dark: 0x7F8C98, isDark: isDark),
          "constructor": color(light: 0x0B4F79, dark: 0x5DD8FF, isDark: isDark),
          "function.call": color(light: 0x326D74, dark: 0x67B7A4, isDark: isDark),
          "include": color(light: 0x9B2393, dark: 0xFC5FA3, isDark: isDark),
          "keyword": color(light: 0x9B2393, dark: 0xFC5FA3, isDark: isDark),
          "keyword.function": color(light: 0x9B2393, dark: 0xFC5FA3, isDark: isDark),
          "keyword.return": color(light: 0x9B2393, dark: 0xFC5FA3, isDark: isDark),
          "method": color(light: 0x326D74, dark: 0x67B7A4, isDark: isDark),
          "number": color(light: 0x1C00CF, dark: 0xD0BF69, isDark: isDark),
          "operator": plain,
          "parameter": color(light: 0x6F42C1, dark: 0xB281EB, isDark: isDark),
          "property": color(light: 0x0B4F79, dark: 0x67B7A4, isDark: isDark),
          "punctuation.special": plain,
          "string": color(light: 0xC41A16, dark: 0xFC6A5D, isDark: isDark),
          "text.literal": color(light: 0xC41A16, dark: 0xFC6A5D, isDark: isDark),
          "text.title": color(light: 0x0B4F79, dark: 0x5DD8FF, isDark: isDark),
          "type": color(light: 0x0B4F79, dark: 0x5DD8FF, isDark: isDark),
          "variable.builtin": color(light: 0x7F00A8, dark: 0xDDA0DD, isDark: isDark),
          "variable": plain,
        ]
      ),
      fonts: Theme.Fonts(
        fonts: [
          "plain": regularFont,
          "boolean": regularFont,
          "comment": regularFont,
          "constructor": mediumFont,
          "function.call": regularFont,
          "include": mediumFont,
          "keyword": mediumFont,
          "keyword.function": mediumFont,
          "keyword.return": mediumFont,
          "method": regularFont,
          "number": regularFont,
          "operator": regularFont,
          "parameter": regularFont,
          "property": regularFont,
          "punctuation.special": regularFont,
          "string": regularFont,
          "text.literal": regularFont,
          "text.title": mediumFont,
          "type": mediumFont,
          "variable.builtin": regularFont,
          "variable": regularFont,
        ]
      )
    )
  }

  private static func color(
    light: UInt32,
    dark: UInt32,
    isDark: Bool
  ) -> NSColor {
    let value = isDark ? dark : light
    return NSColor(
      srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: 1
    )
  }
}
