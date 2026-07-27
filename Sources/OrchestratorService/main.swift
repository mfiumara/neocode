import Darwin
import Foundation
import OrchestratorCore
import ProviderKit
import UserNotifications

private actor ServiceRuntime {
  private let coordinator: OrchestrationCoordinator
  private let registry: ACPRegistryClient
  private var notificationTask: Task<Void, Never>?

  init() throws {
    let manager = FileManager.default
    guard
      let base = manager.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first
    else {
      throw CoreServiceFailure(
        code: "support_directory_unavailable",
        message: "Application Support is unavailable."
      )
    }
    let support = base.appending(path: "Orchestrator")
    let worktrees = support.appending(path: "Worktrees")
    try manager.createDirectory(
      at: support,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try manager.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: support.path
    )
    try manager.createDirectory(
      at: worktrees,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let database = try AppDatabase(
      path: support.appending(path: "orchestrator.sqlite").path
    )
    registry = ACPRegistryClient(
      cacheURL:
        support
        .appending(path: "ACPRegistry")
        .appending(path: "registry.json")
    )
    coordinator = OrchestrationCoordinator(
      database: database,
      worktreesRoot: worktrees.path
    )
  }

  func prepare() async throws {
    for provider in ProviderCatalog.makeDefaultAdapters(
      includeDemo: Self.includesDemoProvider
    ) {
      await coordinator.register(provider: provider)
    }
    if let cached = try? await registry.cachedProviders() {
      for provider in ProviderCatalog.makeACPAdapters(from: cached) {
        await coordinator.register(provider: provider)
      }
    }
    let events = await coordinator.liveEvents()
    notificationTask = Task {
      for await event in events {
        guard !Task.isCancelled else { break }
        Self.deliverNotification(for: event)
      }
    }
    try await coordinator.restorePersistentState()
  }

  private static var includesDemoProvider: Bool {
    #if DEBUG
      true
    #else
      false
    #endif
  }

  private nonisolated static func deliverNotification(for event: AgentEvent) {
    guard let notification = CoreNotificationPolicy.notification(for: event) else {
      return
    }
    let content = UNMutableNotificationContent()
    content.title = notification.title
    content.body = notification.body
    content.sound = .default
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(
        identifier: event.id,
        content: content,
        trigger: nil
      )
    )
  }

  func perform(_ request: CoreRPCRequest) async throws -> CoreRPCResponse {
    switch request {
    case .handshake(let handshake):
      guard handshake.protocolVersion == OrchestratorProtocol.version else {
        throw CoreServiceFailure(
          code: "protocol_mismatch",
          message: "Client protocol \(handshake.protocolVersion) is unsupported."
        )
      }
      return .serviceInfo(
        CoreServiceInfo(
          serviceVersion: "0.1.0",
          processIdentifier: ProcessInfo.processInfo.processIdentifier
        )
      )
    case .allProjects:
      return .projects(try await coordinator.allProjects())
    case .providerInspections:
      return .providerInspections(await coordinator.providerInspections())
    case .refreshACPRegistry:
      let providers = try await registry.refresh()
      for provider in ProviderCatalog.makeACPAdapters(from: providers) {
        await coordinator.register(provider: provider)
      }
      return .providerInspections(await coordinator.providerInspections())
    case .openProject(let value):
      return .project(try await coordinator.openProject(value))
    case .snapshot(let projectID):
      return .snapshot(try await coordinator.snapshot(projectID: projectID))
    case .createTask(let value):
      return .task(try await coordinator.createTask(value))
    case .launchAgent(let value):
      return .agent(try await coordinator.launchAgent(value))
    case .sendMessage(let value):
      try await coordinator.send(value)
      return .success
    case .interrupt(let request):
      try await coordinator.interrupt(request)
      return .success
    case .resolveApproval(let value):
      try await coordinator.resolveApproval(value)
      return .success
    case .respondToInput(let value):
      try await coordinator.respondToInput(value)
      return .success
    case .archiveTask(let value):
      try await coordinator.archiveTask(value)
      return .success
    case .diff(let taskID):
      return .diff(try await coordinator.diff(taskID: taskID))
    case .createPullRequest(let value):
      return .pullRequest(try await coordinator.createPullRequest(value))
    case .events(let sequence, let taskID):
      return .events(try await coordinator.events(after: sequence, taskID: taskID))
    case .delegation(let value):
      return .json(try await coordinator.performDelegation(value))
    case .startTerminal(let value):
      return .terminal(try await coordinator.startTerminal(value))
    case .terminalInput(let request):
      try await coordinator.sendTerminalInput(request)
      return .success
    case .terminalResize(let value):
      try await coordinator.resizeTerminal(value)
      return .success
    case .terminalOutput(let terminalID, let sequence):
      return .terminalOutput(
        try await coordinator.terminalOutput(
          terminalID: terminalID,
          after: sequence
        )
      )
    case .stopTerminal(let request):
      try await coordinator.stopTerminal(request)
      return .success
    case .savePanelLayout(let request):
      try await coordinator.savePanelLayout(request)
      return .success
    case .recoverTask(let request):
      return .task(try await coordinator.recoverTask(request))
    }
  }
}

private final class ServiceEndpoint: NSObject, OrchestratorServiceXPC, @unchecked Sendable {
  private let runtime: ServiceRuntime

  init(runtime: ServiceRuntime) {
    self.runtime = runtime
  }

  func perform(
    _ request: Data,
    withReply reply: @escaping @Sendable (Data) -> Void
  ) {
    Task { @Sendable in
      let response: CoreRPCResponse
      do {
        let command = try CoreRPCCodec.decode(CoreRPCRequest.self, from: request)
        response = try await runtime.perform(command)
      } catch let error as OrchestrationError {
        if case .configurationTrustRequired(let requirement) = error {
          response = .configurationTrustRequired(requirement)
        } else {
          response = .failure(
            CoreServiceFailure(
              code: String(reflecting: type(of: error)),
              message: error.localizedDescription
            )
          )
        }
      } catch let failure as CoreServiceFailure {
        response = .failure(failure)
      } catch let error as GitServiceError {
        if case .dirtyWorktree(let path) = error {
          response = .dirtyWorktree(path: path)
        } else {
          response = .failure(
            CoreServiceFailure(
              code: String(reflecting: type(of: error)),
              message: error.localizedDescription
            )
          )
        }
      } catch {
        response = .failure(
          CoreServiceFailure(
            code: String(reflecting: type(of: error)),
            message: error.localizedDescription
          )
        )
      }
      let data = (try? CoreRPCCodec.encode(response)) ?? Data()
      reply(data)
    }
  }
}

private final class ServiceDelegate: NSObject, NSXPCListenerDelegate {
  private let endpoint: ServiceEndpoint
  private let clientValidator = ServiceClientValidator()

  init(endpoint: ServiceEndpoint) {
    self.endpoint = endpoint
  }

  func listener(
    _ listener: NSXPCListener,
    shouldAcceptNewConnection newConnection: NSXPCConnection
  ) -> Bool {
    guard clientValidator.accepts(newConnection) else {
      return false
    }
    newConnection.exportedInterface = NSXPCInterface(
      with: OrchestratorServiceXPC.self
    )
    newConnection.exportedObject = endpoint
    newConnection.resume()
    return true
  }
}

private struct ServiceClientValidator {
  private let allowedRoot: URL

  init() {
    let executable =
      Self.executableURL(
        processIdentifier: ProcessInfo.processInfo.processIdentifier
      ) ?? URL(fileURLWithPath: CommandLine.arguments[0])
    let directory =
      executable
      .resolvingSymlinksInPath()
      .deletingLastPathComponent()
    if directory.lastPathComponent == "Helpers",
      directory.deletingLastPathComponent().lastPathComponent == "Contents"
    {
      allowedRoot = directory.deletingLastPathComponent()
    } else {
      allowedRoot = directory
    }
  }

  func accepts(_ connection: NSXPCConnection) -> Bool {
    guard connection.effectiveUserIdentifier == geteuid(),
      let executable = Self.executableURL(
        processIdentifier: connection.processIdentifier
      )?.resolvingSymlinksInPath(),
      ["Orchestrator", "OrchestratorBridge"].contains(
        executable.lastPathComponent
      )
    else {
      return false
    }
    let root =
      allowedRoot.path.hasSuffix("/")
      ? allowedRoot.path
      : allowedRoot.path + "/"
    return executable.path.hasPrefix(root)
  }

  private static func executableURL(processIdentifier: pid_t) -> URL? {
    var buffer = [CChar](repeating: 0, count: 4_096)
    let count = proc_pidpath(
      processIdentifier,
      &buffer,
      UInt32(buffer.count)
    )
    guard count > 0 else { return nil }
    let bytes =
      buffer
      .prefix { $0 != 0 }
      .map { UInt8(bitPattern: $0) }
    return URL(fileURLWithPath: String(decoding: bytes, as: UTF8.self))
  }
}

do {
  let runtime = try ServiceRuntime()
  try await runtime.prepare()

  let endpoint = ServiceEndpoint(runtime: runtime)
  let delegate = ServiceDelegate(endpoint: endpoint)
  let listener = NSXPCListener(
    machServiceName: OrchestratorProtocol.serviceName
  )
  listener.delegate = delegate
  listener.resume()
  let lifetime = AsyncStream<Void>.makeStream()
  for await _ in lifetime.stream {}
} catch {
  FileHandle.standardError.write(
    Data("OrchestratorService failed: \(error.localizedDescription)\n".utf8)
  )
  exit(EXIT_FAILURE)
}
