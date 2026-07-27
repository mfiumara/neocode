import AppKit
import OrchestratorCore
import SwiftUI

struct WorkspaceSplitView<First: View, Second: View>: NSViewRepresentable {
  let axis: WorkspaceSplitAxis
  @Binding var fraction: Double
  @ViewBuilder let first: () -> First
  @ViewBuilder let second: () -> Second

  func makeCoordinator() -> Coordinator {
    Coordinator(fraction: $fraction)
  }

  func makeNSView(context: Context) -> NSSplitView {
    let splitView = NSSplitView()
    splitView.isVertical = axis == .horizontal
    splitView.dividerStyle = .thin
    splitView.delegate = context.coordinator
    splitView.autosaveName = nil

    let firstView = NSHostingView(rootView: AnyView(first()))
    let secondView = NSHostingView(rootView: AnyView(second()))
    firstView.translatesAutoresizingMaskIntoConstraints = false
    secondView.translatesAutoresizingMaskIntoConstraints = false
    splitView.addArrangedSubview(firstView)
    splitView.addArrangedSubview(secondView)

    context.coordinator.firstHost = firstView
    context.coordinator.secondHost = secondView
    context.coordinator.splitView = splitView
    context.coordinator.axis = axis

    DispatchQueue.main.async {
      context.coordinator.applyFractionIfPossible(fraction)
    }
    return splitView
  }

  func updateNSView(_ splitView: NSSplitView, context: Context) {
    context.coordinator.firstHost?.rootView = AnyView(first())
    context.coordinator.secondHost?.rootView = AnyView(second())
    if context.coordinator.axis != axis {
      context.coordinator.axis = axis
      splitView.isVertical = axis == .horizontal
      splitView.adjustSubviews()
    }
    context.coordinator.applyFractionIfPossible(fraction)
  }

  @MainActor
  final class Coordinator: NSObject, NSSplitViewDelegate {
    @Binding var fraction: Double
    weak var splitView: NSSplitView?
    var firstHost: NSHostingView<AnyView>?
    var secondHost: NSHostingView<AnyView>?
    var axis: WorkspaceSplitAxis = .horizontal
    private var isApplyingFraction = false
    private var lastAppliedFraction: Double?

    init(fraction: Binding<Double>) {
      _fraction = fraction
    }

    func applyFractionIfPossible(_ requestedFraction: Double) {
      guard let splitView else { return }
      let dimension = splitView.isVertical
        ? splitView.bounds.width
        : splitView.bounds.height
      guard dimension > 0 else { return }
      let clamped = min(max(requestedFraction, 0.2), 0.8)
      if
        let lastAppliedFraction,
        abs(lastAppliedFraction - clamped) < 0.002
      {
        return
      }
      isApplyingFraction = true
      splitView.setPosition(dimension * clamped, ofDividerAt: 0)
      lastAppliedFraction = clamped
      isApplyingFraction = false
    }

    func splitViewDidResizeSubviews(_ notification: Notification) {
      guard !isApplyingFraction, let splitView else { return }
      let dimension = splitView.isVertical
        ? splitView.bounds.width
        : splitView.bounds.height
      guard dimension > 0, let first = splitView.arrangedSubviews.first else {
        return
      }
      let firstDimension = splitView.isVertical
        ? first.frame.width
        : first.frame.height
      let next = min(max(firstDimension / dimension, 0.2), 0.8)
      guard abs(next - fraction) > 0.002 else { return }
      lastAppliedFraction = next
      DispatchQueue.main.async {
        self.fraction = next
      }
    }

    func splitView(
      _ splitView: NSSplitView,
      constrainSplitPosition proposedPosition: CGFloat,
      ofSubviewAt dividerIndex: Int
    ) -> CGFloat {
      let dimension = splitView.isVertical
        ? splitView.bounds.width
        : splitView.bounds.height
      let minimum = min(320, dimension * 0.45)
      return min(max(proposedPosition, minimum), max(minimum, dimension - minimum))
    }
  }
}
