import AppKit
import OrchestratorCore
import SwiftUI
import WebKit

struct BrowserPanel: View {
  @Environment(AppModel.self) private var model
  @Environment(\.orchestratorTheme) private var theme
  let projectID: String
  let task: OrchestrationTask
  var initialURL: String? = nil

  @State private var address = ""
  @State private var currentURL: URL?
  @State private var canGoBack = false
  @State private var canGoForward = false
  @State private var backRequest = 0
  @State private var forwardRequest = 0
  @State private var reloadRequest = 0
  @State private var addressError: String?
  @State private var loadError: String?

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Button {
          backRequest += 1
        } label: {
          Image(systemName: "chevron.left")
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 24))
        .disabled(!canGoBack)
        .help("Back")
        .accessibilityLabel("Back")

        Button {
          forwardRequest += 1
        } label: {
          Image(systemName: "chevron.right")
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 24))
        .disabled(!canGoForward)
        .help("Forward")
        .accessibilityLabel("Forward")

      Button {
        loadError = nil
        reloadRequest += 1
      } label: {
          Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 24))
        .disabled(currentURL == nil)
        .help("Reload")
        .accessibilityLabel("Reload")

        HStack(spacing: 6) {
          Image(systemName: currentURL?.scheme == "https" ? "lock.fill" : "globe")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(theme.tertiary)
          TextField("Local preview URL", text: $address)
            .textFieldStyle(.plain)
            .font(OrchestratorTheme.Typography.caption)
            .onSubmit { navigate() }
            .accessibilityLabel("Preview address")
        }
        .padding(.horizontal, 8)
        .frame(height: 24)
        .background(
          theme.surface2,
          in: .rect(cornerRadius: OrchestratorTheme.Radius.medium)
        )
        .overlay {
          RoundedRectangle(cornerRadius: OrchestratorTheme.Radius.medium)
            .stroke(theme.border, lineWidth: 1)
        }

        Button { navigate() } label: {
          Image(systemName: "arrow.right")
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 24))
        .help("Open address")

        Button {
          if let currentURL {
            NSWorkspace.shared.open(currentURL)
          }
        } label: {
          Image(systemName: "safari")
        }
        .buttonStyle(OrchestratorIconButtonStyle(size: 24))
        .disabled(currentURL == nil)
        .help("Open in default browser")
        .accessibilityLabel("Open in default browser")
      }
      .padding(.horizontal, 8)
      .frame(height: 32)
      .background(theme.surface1)

      Rectangle()
        .fill(theme.border)
        .frame(height: 1)

      if let addressError {
        Label(addressError, systemImage: "exclamationmark.circle.fill")
          .font(.caption)
          .foregroundStyle(theme.danger)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 12)
          .frame(height: 31)
          .background(theme.danger.opacity(0.08))
        Rectangle()
          .fill(theme.border)
          .frame(height: 1)
      }

      if let loadError {
        BrowserFailureState(
          message: loadError,
          url: currentURL,
          retry: {
            self.loadError = nil
            reloadRequest += 1
          }
        )
      } else if let previewURL = currentURL {
        WebPreview(
          url: previewURL,
          backRequest: backRequest,
          forwardRequest: forwardRequest,
          reloadRequest: reloadRequest
        ) { state in
          canGoBack = state.canGoBack
          canGoForward = state.canGoForward
          loadError = state.errorDescription
          if let url = state.url {
            currentURL = url
            address = url.absoluteString
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ContentUnavailableView {
          Label("No preview selected", systemImage: "safari")
        } description: {
          Text("Start a configured service or enter a local URL.")
        } actions: {
          if let serviceURL {
            Button("Open \(serviceURL.absoluteString)") {
              address = serviceURL.absoluteString
              currentURL = serviceURL
            }
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .foregroundStyle(theme.foreground)
    .background(theme.surface0)
    .onAppear {
      guard address.isEmpty else { return }
      if let initialURL, let url = URL(string: initialURL) {
        address = url.absoluteString
        currentURL = url
      } else if let serviceURL {
        address = serviceURL.absoluteString
        currentURL = serviceURL
      }
    }
    .onChange(of: serviceURL) {
      guard currentURL == nil, let serviceURL else { return }
      address = serviceURL.absoluteString
      currentURL = serviceURL
    }
  }

  private var serviceURL: URL? {
    model.snapshot(for: projectID).services
      .first {
        $0.taskID == task.id && ($0.status == .running || $0.status == .orphaned)
      }?
      .previewURL
      .flatMap(URL.init(string:))
  }

  private func navigate() {
    var value = address.trimmingCharacters(in: .whitespacesAndNewlines)
    if !value.contains("://") {
      value = "http://\(value)"
    }
    guard
      let url = URL(string: value),
      ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
      url.host != nil
    else {
      addressError = "Enter a valid http:// or https:// URL."
      return
    }
    addressError = nil
    loadError = nil
    address = url.absoluteString
    currentURL = url
  }
}

private struct WebNavigationState {
  var url: URL?
  var canGoBack: Bool
  var canGoForward: Bool
  var errorDescription: String?
}

private struct WebPreview: NSViewRepresentable {
  let url: URL
  let backRequest: Int
  let forwardRequest: Int
  let reloadRequest: Int
  let onNavigation: (WebNavigationState) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(onNavigation: onNavigation)
  }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.underPageBackgroundColor = NSColor(
      calibratedRed: 14 / 255,
      green: 16 / 255,
      blue: 24 / 255,
      alpha: 1
    )
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.onNavigation = onNavigation

    if context.coordinator.backRequest != backRequest {
      context.coordinator.backRequest = backRequest
      if webView.canGoBack {
        webView.goBack()
      }
    }
    if context.coordinator.forwardRequest != forwardRequest {
      context.coordinator.forwardRequest = forwardRequest
      if webView.canGoForward {
        webView.goForward()
      }
    }
    if context.coordinator.reloadRequest != reloadRequest {
      context.coordinator.reloadRequest = reloadRequest
      webView.reload()
    }
    if webView.url != url, context.coordinator.requestedURL != url {
      context.coordinator.requestedURL = url
      webView.load(URLRequest(url: url))
    }
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate {
    var onNavigation: (WebNavigationState) -> Void
    var requestedURL: URL?
    var backRequest = 0
    var forwardRequest = 0
    var reloadRequest = 0

    init(onNavigation: @escaping (WebNavigationState) -> Void) {
      self.onNavigation = onNavigation
    }

    func webView(
      _ webView: WKWebView,
      didFinish navigation: WKNavigation!
    ) {
      publish(webView, error: nil)
    }

    func webView(
      _ webView: WKWebView,
      didFail navigation: WKNavigation!,
      withError error: any Error
    ) {
      guard (error as NSError).code != NSURLErrorCancelled else { return }
      publish(webView, error: error)
    }

    func webView(
      _ webView: WKWebView,
      didFailProvisionalNavigation navigation: WKNavigation!,
      withError error: any Error
    ) {
      guard (error as NSError).code != NSURLErrorCancelled else { return }
      publish(webView, error: error)
    }

    private func publish(_ webView: WKWebView, error: (any Error)?) {
      onNavigation(
        WebNavigationState(
          url: webView.url,
          canGoBack: webView.canGoBack,
          canGoForward: webView.canGoForward,
          errorDescription: error?.localizedDescription
        )
      )
    }
  }
}

private struct BrowserFailureState: View {
  @Environment(\.orchestratorTheme) private var theme
  let message: String
  let url: URL?
  let retry: () -> Void

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "network.slash")
        .font(.system(size: 30, weight: .medium))
        .foregroundStyle(theme.danger)

      VStack(spacing: 5) {
        Text("Preview is unavailable")
          .font(.headline)
          .foregroundStyle(theme.foreground)
        Text(message)
          .font(OrchestratorTheme.Typography.body)
          .foregroundStyle(theme.muted)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 440)
      }

      HStack(spacing: 8) {
        Button("Try Again", systemImage: "arrow.clockwise", action: retry)
          .buttonStyle(
            OrchestratorButtonStyle(variant: .primary, compact: true)
          )
        if let url {
          Button("Open in Browser", systemImage: "safari") {
            NSWorkspace.shared.open(url)
          }
          .buttonStyle(
            OrchestratorButtonStyle(variant: .secondary, compact: true)
          )
        }
      }
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(theme.surface0)
  }
}
