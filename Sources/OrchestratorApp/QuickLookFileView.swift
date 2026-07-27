import QuickLookUI
import SwiftUI

@MainActor
final class QuickLookPreviewer: NSObject, @preconcurrency QLPreviewPanelDataSource {
  static let shared = QuickLookPreviewer()

  private var previewURL: URL?

  func present(path: String) {
    previewURL = URL(fileURLWithPath: path)
    guard let panel = QLPreviewPanel.shared() else { return }
    panel.dataSource = self
    panel.reloadData()
    panel.makeKeyAndOrderFront(nil)
  }

  func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
    previewURL == nil ? 0 : 1
  }

  func previewPanel(
    _ panel: QLPreviewPanel!,
    previewItemAt index: Int
  ) -> any QLPreviewItem {
    (previewURL ?? URL(fileURLWithPath: "/")) as NSURL
  }
}

@MainActor
struct QuickLookFileView: NSViewRepresentable {
  let path: String

  func makeNSView(context: Context) -> QLPreviewView {
    let previewView = QLPreviewView(frame: .zero, style: .normal)!
    previewView.autostarts = true
    return previewView
  }

  func updateNSView(_ previewView: QLPreviewView, context: Context) {
    previewView.previewItem = URL(fileURLWithPath: path) as NSURL
  }

  func sizeThatFits(
    _ proposal: ProposedViewSize,
    nsView: QLPreviewView,
    context: Context
  ) -> CGSize? {
    CGSize(
      width: proposal.width ?? nsView.frame.width,
      height: proposal.height ?? nsView.frame.height
    )
  }
}
