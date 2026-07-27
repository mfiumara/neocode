import Foundation
import OrchestratorCore
import ProviderKit

actor BackendRouter {
  private enum Implementation {
    case service(OrchestratorServiceClient)
    case local(OrchestrationCoordinator, ACPRegistryClient)
  }

  private let implementation: Implementation

  init(service: OrchestratorServiceClient) {
    implementation = .service(service)
  }

  init(local: OrchestrationCoordinator, registry: ACPRegistryClient) {
    implementation = .local(local, registry)
  }

  var isUsingBackgroundService: Bool {
    if case .service = implementation { return true }
    return false
  }

  func allProjects() async throws -> [Project] {
    switch implementation {
    case .service(let client):
      guard case .projects(let projects) = try await client.perform(.allProjects) else {
        throw unexpected("projects")
      }
      return projects
    case .local(let coordinator, _):
      return try await coordinator.allProjects()
    }
  }

  func providerInspections() async -> [ProviderInspection] {
    switch implementation {
    case .service(let client):
      guard let response = try? await client.perform(.providerInspections),
        case .providerInspections(let inspections) = response
      else {
        return []
      }
      return inspections
    case .local(let coordinator, _):
      return await coordinator.providerInspections()
    }
  }

  func refreshACPRegistry() async throws -> [ProviderInspection] {
    switch implementation {
    case .service(let client):
      guard
        case .providerInspections(let inspections) = try await client.perform(
          .refreshACPRegistry
        )
      else {
        throw unexpected("provider inspections")
      }
      return inspections
    case .local(let coordinator, let registry):
      let providers = try await registry.refresh()
      for provider in ProviderCatalog.makeACPAdapters(from: providers) {
        await coordinator.register(provider: provider)
      }
      return await coordinator.providerInspections()
    }
  }

  func openProject(_ request: OpenProjectRequest) async throws -> Project {
    switch implementation {
    case .service(let client):
      guard case .project(let project) = try await client.perform(.openProject(request)) else {
        throw unexpected("project")
      }
      return project
    case .local(let coordinator, _):
      return try await coordinator.openProject(request)
    }
  }

  func snapshot(projectID: String) async throws -> CoreSnapshot {
    switch implementation {
    case .service(let client):
      guard
        case .snapshot(let snapshot) = try await client.perform(
          .snapshot(projectID: projectID)
        )
      else {
        throw unexpected("snapshot")
      }
      return snapshot
    case .local(let coordinator, _):
      return try await coordinator.snapshot(projectID: projectID)
    }
  }

  func createTask(_ request: CreateTaskRequest) async throws -> OrchestrationTask {
    switch implementation {
    case .service(let client):
      guard case .task(let task) = try await client.perform(.createTask(request)) else {
        throw unexpected("task")
      }
      return task
    case .local(let coordinator, _):
      return try await coordinator.createTask(request)
    }
  }

  func launchAgent(_ request: LaunchAgentRequest) async throws -> AgentSession {
    switch implementation {
    case .service(let client):
      guard case .agent(let agent) = try await client.perform(.launchAgent(request)) else {
        throw unexpected("agent")
      }
      return agent
    case .local(let coordinator, _):
      return try await coordinator.launchAgent(request)
    }
  }

  func send(_ request: SendAgentMessageRequest) async throws {
    switch implementation {
    case .service(let client):
      guard case .success = try await client.perform(.sendMessage(request)) else {
        throw unexpected("success")
      }
    case .local(let coordinator, _):
      try await coordinator.send(request)
    }
  }

  func interrupt(agentID: String) async throws {
    let request = InterruptAgentRequest(agentID: agentID)
    switch implementation {
    case .service(let client):
      guard case .success = try await client.perform(.interrupt(request)) else {
        throw unexpected("success")
      }
    case .local(let coordinator, _):
      try await coordinator.interrupt(request)
    }
  }

  func resolveApproval(_ request: ResolveApprovalRequest) async throws {
    switch implementation {
    case .service(let client):
      guard case .success = try await client.perform(.resolveApproval(request)) else {
        throw unexpected("success")
      }
    case .local(let coordinator, _):
      try await coordinator.resolveApproval(request)
    }
  }

  func respondToInput(_ request: RespondToInputRequest) async throws {
    switch implementation {
    case .service(let client):
      guard
        case .success = try await client.perform(.respondToInput(request))
      else {
        throw unexpected("success")
      }
    case .local(let coordinator, _):
      try await coordinator.respondToInput(request)
    }
  }

  func archiveTask(_ request: ArchiveTaskRequest) async throws {
    switch implementation {
    case .service(let client):
      guard case .success = try await client.perform(.archiveTask(request)) else {
        throw unexpected("success")
      }
    case .local(let coordinator, _):
      try await coordinator.archiveTask(request)
    }
  }

  func diff(taskID: String) async throws -> GitDiff {
    switch implementation {
    case .service(let client):
      guard case .diff(let diff) = try await client.perform(.diff(taskID: taskID)) else {
        throw unexpected("diff")
      }
      return diff
    case .local(let coordinator, _):
      return try await coordinator.diff(taskID: taskID)
    }
  }

  func createPullRequest(_ request: CreatePullRequestRequest) async throws -> PullRequest {
    switch implementation {
    case .service(let client):
      guard
        case .pullRequest(let pullRequest) = try await client.perform(
          .createPullRequest(request)
        )
      else {
        throw unexpected("pull request")
      }
      return pullRequest
    case .local(let coordinator, _):
      return try await coordinator.createPullRequest(request)
    }
  }

  func events(after sequence: Int64, taskID: String? = nil) async throws -> [AgentEvent] {
    switch implementation {
    case .service(let client):
      guard
        case .events(let events) = try await client.perform(
          .events(after: sequence, taskID: taskID)
        )
      else {
        throw unexpected("events")
      }
      return events
    case .local(let coordinator, _):
      return try await coordinator.events(after: sequence, taskID: taskID)
    }
  }

  func startTerminal(_ request: StartTerminalRequest) async throws -> TerminalSession {
    switch implementation {
    case .service(let client):
      guard
        case .terminal(let terminal) = try await client.perform(
          .startTerminal(request)
        )
      else {
        throw unexpected("terminal")
      }
      return terminal
    case .local(let coordinator, _):
      return try await coordinator.startTerminal(request)
    }
  }

  func sendTerminalInput(terminalID: String, data: Data) async throws {
    let request = TerminalInputRequest(
      terminalID: terminalID,
      data: data
    )
    switch implementation {
    case .service(let client):
      guard
        case .success = try await client.perform(
          .terminalInput(request)
        )
      else {
        throw unexpected("success")
      }
    case .local(let coordinator, _):
      try await coordinator.sendTerminalInput(request)
    }
  }

  func resizeTerminal(_ request: TerminalResizeRequest) async throws {
    switch implementation {
    case .service(let client):
      guard
        case .success = try await client.perform(
          .terminalResize(request)
        )
      else {
        throw unexpected("success")
      }
    case .local(let coordinator, _):
      try await coordinator.resizeTerminal(request)
    }
  }

  func terminalOutput(
    terminalID: String,
    after sequence: Int64
  ) async throws -> TerminalOutputBatch {
    switch implementation {
    case .service(let client):
      guard
        case .terminalOutput(let output) = try await client.perform(
          .terminalOutput(terminalID: terminalID, after: sequence)
        )
      else {
        throw unexpected("terminal output")
      }
      return output
    case .local(let coordinator, _):
      return try await coordinator.terminalOutput(
        terminalID: terminalID,
        after: sequence
      )
    }
  }

  func stopTerminal(terminalID: String) async throws {
    let request = StopTerminalRequest(terminalID: terminalID)
    switch implementation {
    case .service(let client):
      guard
        case .success = try await client.perform(
          .stopTerminal(request)
        )
      else {
        throw unexpected("success")
      }
    case .local(let coordinator, _):
      try await coordinator.stopTerminal(request)
    }
  }

  func savePanelLayout(_ layout: PanelLayout) async throws {
    let request = SavePanelLayoutRequest(layout: layout)
    switch implementation {
    case .service(let client):
      guard
        case .success = try await client.perform(
          .savePanelLayout(request)
        )
      else {
        throw unexpected("success")
      }
    case .local(let coordinator, _):
      try await coordinator.savePanelLayout(request)
    }
  }

  func recoverTask(_ request: RecoverTaskRequest) async throws -> OrchestrationTask {
    switch implementation {
    case .service(let client):
      guard
        case .task(let task) = try await client.perform(
          .recoverTask(request)
        )
      else {
        throw unexpected("task")
      }
      return task
    case .local(let coordinator, _):
      return try await coordinator.recoverTask(request)
    }
  }

  private func unexpected(_ expected: String) -> CoreServiceFailure {
    CoreServiceFailure(
      code: "unexpected_response",
      message: "The core returned an unexpected response; expected \(expected)."
    )
  }
}
