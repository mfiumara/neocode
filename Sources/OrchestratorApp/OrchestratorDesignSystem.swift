import AppKit
import OrchestratorCore
import SwiftUI

enum OrchestratorAppearance: String, CaseIterable, Identifiable {
  case system
  case dark
  case light

  var id: String { rawValue }

  var title: String {
    switch self {
    case .system: "Follow System"
    case .dark: "Dark"
    case .light: "Light"
    }
  }

  var preferredColorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .dark: .dark
    case .light: .light
    }
  }
}

struct OrchestratorTheme {
  let surface0: Color
  let surface1: Color
  let surface2: Color
  let surface3: Color
  let sidebar: Color
  let foreground: Color
  let muted: Color
  let tertiary: Color
  let border: Color
  let borderStrong: Color
  let accent: Color
  let accentHover: Color
  let success: Color
  let warning: Color
  let danger: Color
  let isDark: Bool

  static let dark = OrchestratorTheme(
    surface0: Color(hex: 0x0E1018),
    surface1: Color(hex: 0x131622),
    surface2: Color(hex: 0x191D2B),
    surface3: Color(hex: 0x23283A),
    sidebar: Color(hex: 0x0B0D14),
    foreground: Color(hex: 0xF3F5FA),
    muted: Color(hex: 0xA3AABD),
    tertiary: Color(hex: 0x6F778B),
    border: Color(hex: 0x262C3D),
    borderStrong: Color(hex: 0x343C52),
    accent: Color(hex: 0x7C83FF),
    accentHover: Color(hex: 0x9298FF),
    success: Color(hex: 0x4FC38D),
    warning: Color(hex: 0xE2A85B),
    danger: Color(hex: 0xE06C75),
    isDark: true
  )

  static let light = OrchestratorTheme(
    surface0: Color(hex: 0xFFFFFF),
    surface1: Color(hex: 0xF7F8FB),
    surface2: Color(hex: 0xEFF1F6),
    surface3: Color(hex: 0xE4E7EF),
    sidebar: Color(hex: 0xF1F3F8),
    foreground: Color(hex: 0x171A23),
    muted: Color(hex: 0x61697A),
    tertiary: Color(hex: 0x8A92A3),
    border: Color(hex: 0xDDE1EA),
    borderStrong: Color(hex: 0xC9CEDA),
    accent: Color(hex: 0x5B61E8),
    accentHover: Color(hex: 0x484FD5),
    success: Color(hex: 0x218358),
    warning: Color(hex: 0xA86612),
    danger: Color(hex: 0xB6424D),
    isDark: false
  )

  static func resolve(_ colorScheme: ColorScheme) -> Self {
    colorScheme == .dark ? .dark : .light
  }

  enum Spacing {
    static let xsmall: CGFloat = 4
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let xlarge: CGFloat = 24
  }

  enum Radius {
    static let small: CGFloat = 4
    static let medium: CGFloat = 6
    static let large: CGFloat = 8
    static let xlarge: CGFloat = 12
  }

  enum Typography {
    static let body = Font.system(size: 13)
    static let bodyMedium = Font.system(size: 13, weight: .medium)
    static let title = Font.system(size: 15, weight: .semibold)
    static let caption = Font.system(size: 11)
    static let captionMedium = Font.system(size: 11, weight: .medium)
    static let code = Font.system(size: 12.5, design: .monospaced)
  }
}

private struct OrchestratorThemeKey: EnvironmentKey {
  static let defaultValue = OrchestratorTheme.dark
}

extension EnvironmentValues {
  var orchestratorTheme: OrchestratorTheme {
    get { self[OrchestratorThemeKey.self] }
    set { self[OrchestratorThemeKey.self] = newValue }
  }
}

private struct OrchestratorAppearanceModifier: ViewModifier {
  @AppStorage("appearance") private var appearanceRawValue =
    OrchestratorAppearance.system.rawValue
  @Environment(\.colorScheme) private var systemColorScheme

  private var appearance: OrchestratorAppearance {
    OrchestratorAppearance(rawValue: appearanceRawValue) ?? .system
  }

  private var effectiveColorScheme: ColorScheme {
    appearance.preferredColorScheme ?? systemColorScheme
  }

  func body(content: Content) -> some View {
    let theme = OrchestratorTheme.resolve(effectiveColorScheme)
    content
      .environment(\.orchestratorTheme, theme)
      .preferredColorScheme(appearance.preferredColorScheme)
      .tint(theme.accent)
  }
}

extension View {
  func orchestratorAppearance() -> some View {
    modifier(OrchestratorAppearanceModifier())
  }
}

enum OrchestratorButtonVariant {
  case primary
  case secondary
  case ghost
  case destructive
}

struct OrchestratorButtonStyle: ButtonStyle {
  @Environment(\.orchestratorTheme) private var theme
  @Environment(\.isEnabled) private var isEnabled

  var variant: OrchestratorButtonVariant = .secondary
  var compact = false

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(
        compact
          ? OrchestratorTheme.Typography.captionMedium
          : OrchestratorTheme.Typography.bodyMedium
      )
      .foregroundStyle(foreground)
      .padding(.horizontal, compact ? 8 : 11)
      .frame(minHeight: compact ? 26 : 30)
      .background(background(configuration.isPressed))
      .overlay {
        RoundedRectangle(
          cornerRadius: OrchestratorTheme.Radius.medium,
          style: .continuous
        )
        .stroke(border, lineWidth: 1)
      }
      .clipShape(
        RoundedRectangle(
          cornerRadius: OrchestratorTheme.Radius.medium,
          style: .continuous
        )
      )
      .contentShape(.rect)
      .opacity(isEnabled ? 1 : 0.45)
      .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
  }

  private var foreground: Color {
    switch variant {
    case .primary, .destructive:
      .white
    case .secondary:
      theme.foreground
    case .ghost:
      theme.muted
    }
  }

  private func background(_ pressed: Bool) -> Color {
    switch variant {
    case .primary:
      pressed ? theme.accent.opacity(0.78) : theme.accent
    case .secondary:
      pressed ? theme.surface3.opacity(0.78) : theme.surface3
    case .ghost:
      pressed ? theme.surface3 : .clear
    case .destructive:
      pressed ? theme.danger.opacity(0.78) : theme.danger
    }
  }

  private var border: Color {
    switch variant {
    case .primary:
      theme.accent
    case .secondary:
      theme.borderStrong
    case .ghost:
      .clear
    case .destructive:
      theme.danger
    }
  }
}

struct OrchestratorIconButtonStyle: ButtonStyle {
  @Environment(\.orchestratorTheme) private var theme
  @Environment(\.isEnabled) private var isEnabled
  @State private var isHovered = false

  var size: CGFloat = 28

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .medium))
      .foregroundStyle(isHovered ? theme.foreground : theme.muted)
      .frame(width: size, height: size)
      .background {
        RoundedRectangle(
          cornerRadius: OrchestratorTheme.Radius.medium,
          style: .continuous
        )
        .fill(
          configuration.isPressed
            ? theme.surface3
            : (isHovered ? theme.surface2 : .clear)
        )
      }
      .contentShape(.rect)
      .opacity(isEnabled ? 1 : 0.42)
      .onHover { isHovered = $0 }
      .animation(.easeOut(duration: 0.1), value: isHovered)
  }
}

struct OrchestratorSearchField: View {
  @Environment(\.orchestratorTheme) private var theme
  let placeholder: String
  @Binding var text: String

  var body: some View {
    HStack(spacing: OrchestratorTheme.Spacing.small) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(theme.tertiary)

      TextField(placeholder, text: $text)
        .textFieldStyle(.plain)
        .font(OrchestratorTheme.Typography.body)
        .foregroundStyle(theme.foreground)

      if !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 20))
        .accessibilityLabel("Clear search")
      }
    }
    .padding(.horizontal, OrchestratorTheme.Spacing.small)
    .frame(height: 28)
    .background(theme.surface2)
    .overlay {
      RoundedRectangle(
        cornerRadius: OrchestratorTheme.Radius.medium,
        style: .continuous
      )
      .stroke(theme.border, lineWidth: 1)
    }
    .clipShape(
      RoundedRectangle(
        cornerRadius: OrchestratorTheme.Radius.medium,
        style: .continuous
      )
    )
  }
}

extension Color {
  fileprivate init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255
    )
  }

  var nsColor: NSColor {
    NSColor(self)
  }
}

extension TaskStatus {
  func orchestratorTint(in theme: OrchestratorTheme) -> Color {
    switch self {
    case .preparing:
      theme.accent
    case .running:
      theme.success
    case .needsAttention:
      theme.warning
    case .reviewReady:
      theme.accentHover
    case .shipped:
      theme.success
    case .failed:
      theme.danger
    case .archived:
      theme.tertiary
    }
  }
}

extension AgentStatus {
  func orchestratorTint(in theme: OrchestratorTheme) -> Color {
    switch self {
    case .launching:
      theme.accent
    case .running, .completed:
      theme.success
    case .waitingForApproval, .waitingForInput:
      theme.warning
    case .failed:
      theme.danger
    case .idle, .interrupted, .disconnected:
      theme.tertiary
    }
  }
}
