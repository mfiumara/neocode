import AppKit
import Foundation
@testable import OrchestratorApp
import SwiftUI
import Testing

@Suite("Orchestrator theme")
@MainActor
struct OrchestratorThemeTests {
  @Test("Dark theme text and accent meet readable contrast")
  func darkContrast() {
    #expect(contrast(OrchestratorTheme.dark.foreground, OrchestratorTheme.dark.surface0) >= 7)
    #expect(contrast(OrchestratorTheme.dark.muted, OrchestratorTheme.dark.surface0) >= 4.5)
    #expect(contrast(OrchestratorTheme.dark.accent, OrchestratorTheme.dark.surface0) >= 4.5)
    #expect(contrast(OrchestratorTheme.dark.danger, OrchestratorTheme.dark.surface0) >= 4.5)
  }

  @Test("Light theme text and semantic colors remain legible")
  func lightContrast() {
    #expect(contrast(OrchestratorTheme.light.foreground, OrchestratorTheme.light.surface0) >= 7)
    #expect(contrast(OrchestratorTheme.light.muted, OrchestratorTheme.light.surface0) >= 4.5)
    #expect(contrast(OrchestratorTheme.light.accent, OrchestratorTheme.light.surface0) >= 4.5)
    #expect(contrast(OrchestratorTheme.light.danger, OrchestratorTheme.light.surface0) >= 4.5)
  }

  private func contrast(_ foreground: Color, _ background: Color) -> Double {
    let light = luminance(foreground)
    let dark = luminance(background)
    return (max(light, dark) + 0.05) / (min(light, dark) + 0.05)
  }

  private func luminance(_ color: Color) -> Double {
    let converted = NSColor(color).usingColorSpace(.sRGB) ?? NSColor(color)
    return [converted.redComponent, converted.greenComponent, converted.blueComponent]
      .map(Double.init)
      .map { component in
        component <= 0.04045
          ? component / 12.92
          : pow((component + 0.055) / 1.055, 2.4)
      }
      .enumerated()
      .reduce(0) { result, item in
        let weight = [0.2126, 0.7152, 0.0722][item.offset]
        return result + item.element * weight
      }
  }
}
