import Foundation

public struct CoreNotification: Sendable, Equatable {
  public var title: String
  public var body: String

  public init(title: String, body: String) {
    self.title = title
    self.body = body
  }
}

public enum CoreNotificationPolicy {
  public static func notification(for event: AgentEvent) -> CoreNotification? {
    switch event.kind {
    case .approvalRequested:
      return CoreNotification(
        title: "Approval needed",
        body: event.payload["summary"]?.stringValue ?? "An agent is waiting."
      )
    case .inputRequested:
      return CoreNotification(
        title: "Agent needs input",
        body: event.payload["title"]?.stringValue
          ?? "Open Orchestrator to answer a question."
      )
    case .error:
      return CoreNotification(
        title: event.agentID == nil ? "Task setup failed" : "Agent failed",
        body: event.payload["message"]?.stringValue
          ?? "Open Orchestrator for recovery details."
      )
    case .status:
      guard
        let rawStatus = event.payload["status"]?.stringValue,
        let status = AgentStatus(rawValue: rawStatus)
      else {
        return nil
      }
      switch status {
      case .completed:
        return CoreNotification(
          title: "Agent finished",
          body: "Work is ready to review."
        )
      case .waitingForInput:
        return CoreNotification(
          title: "Agent needs input",
          body: "Open Orchestrator to continue the task."
        )
      case .failed:
        return CoreNotification(
          title: "Agent failed",
          body: "Open Orchestrator for provider diagnostics."
        )
      case .disconnected:
        return CoreNotification(
          title: "Provider disconnected",
          body: "The agent session needs attention."
        )
      default:
        return nil
      }
    default:
      return nil
    }
  }
}
