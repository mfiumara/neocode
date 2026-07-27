import Foundation

public struct OpenProjectRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var path: String

  public init(requestID: String = UUID().uuidString, path: String) {
    self.requestID = requestID
    self.path = path
  }
}

public struct CreateTaskRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var projectID: String
  public var title: String
  public var goal: String
  public var baseRef: String
  public var branchName: String
  public var useWorktree: Bool
  public var trustConfigurationHash: String?

  public init(
    requestID: String = UUID().uuidString,
    projectID: String,
    title: String,
    goal: String,
    baseRef: String,
    branchName: String,
    useWorktree: Bool = true,
    trustConfigurationHash: String? = nil
  ) {
    self.requestID = requestID
    self.projectID = projectID
    self.title = title
    self.goal = goal
    self.baseRef = baseRef
    self.branchName = branchName
    self.useWorktree = useWorktree
    self.trustConfigurationHash = trustConfigurationHash
  }
}

public struct LaunchAgentRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var taskID: String
  public var parentAgentID: String?
  public var title: String
  public var providerID: String
  public var prompt: String
  public var model: String?
  public var mode: String?

  public init(
    requestID: String = UUID().uuidString,
    taskID: String,
    parentAgentID: String? = nil,
    title: String,
    providerID: String,
    prompt: String,
    model: String? = nil,
    mode: String? = nil
  ) {
    self.requestID = requestID
    self.taskID = taskID
    self.parentAgentID = parentAgentID
    self.title = title
    self.providerID = providerID
    self.prompt = prompt
    self.model = model
    self.mode = mode
  }
}

public struct SendAgentMessageRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var agentID: String
  public var text: String
  public var steerActiveTurn: Bool

  public init(
    requestID: String = UUID().uuidString,
    agentID: String,
    text: String,
    steerActiveTurn: Bool = false
  ) {
    self.requestID = requestID
    self.agentID = agentID
    self.text = text
    self.steerActiveTurn = steerActiveTurn
  }
}

public struct InterruptAgentRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var agentID: String

  public init(
    requestID: String = UUID().uuidString,
    agentID: String
  ) {
    self.requestID = requestID
    self.agentID = agentID
  }
}

public struct ResolveApprovalRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var approvalID: String
  public var decision: ApprovalDecision

  public init(
    requestID: String = UUID().uuidString,
    approvalID: String,
    decision: ApprovalDecision
  ) {
    self.requestID = requestID
    self.approvalID = approvalID
    self.decision = decision
  }
}

public struct RespondToInputRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var inputRequestID: String
  public var answers: [String: [String]]
  public var cancelled: Bool

  public init(
    requestID: String = UUID().uuidString,
    inputRequestID: String,
    answers: [String: [String]],
    cancelled: Bool = false
  ) {
    self.requestID = requestID
    self.inputRequestID = inputRequestID
    self.answers = answers
    self.cancelled = cancelled
  }
}

public struct ArchiveTaskRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var taskID: String
  public var forceDirtyWorktree: Bool

  public init(
    requestID: String = UUID().uuidString,
    taskID: String,
    forceDirtyWorktree: Bool = false
  ) {
    self.requestID = requestID
    self.taskID = taskID
    self.forceDirtyWorktree = forceDirtyWorktree
  }
}

public struct CreatePullRequestRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var taskID: String
  public var title: String
  public var body: String
  public var stageFiles: [String]
  public var commitMessage: String

  public init(
    requestID: String = UUID().uuidString,
    taskID: String,
    title: String,
    body: String,
    stageFiles: [String],
    commitMessage: String
  ) {
    self.requestID = requestID
    self.taskID = taskID
    self.title = title
    self.body = body
    self.stageFiles = stageFiles
    self.commitMessage = commitMessage
  }
}

public struct StartTerminalRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var taskID: String
  public var title: String
  public var columns: Int
  public var rows: Int

  public init(
    requestID: String = UUID().uuidString,
    taskID: String,
    title: String = "Shell",
    columns: Int = 100,
    rows: Int = 30
  ) {
    self.requestID = requestID
    self.taskID = taskID
    self.title = title
    self.columns = columns
    self.rows = rows
  }
}

public struct TerminalInputRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var terminalID: String
  public var data: Data

  public init(
    requestID: String = UUID().uuidString,
    terminalID: String,
    data: Data
  ) {
    self.requestID = requestID
    self.terminalID = terminalID
    self.data = data
  }
}

public struct TerminalResizeRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var terminalID: String
  public var columns: Int
  public var rows: Int

  public init(
    requestID: String = UUID().uuidString,
    terminalID: String,
    columns: Int,
    rows: Int
  ) {
    self.requestID = requestID
    self.terminalID = terminalID
    self.columns = columns
    self.rows = rows
  }
}

public struct StopTerminalRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var terminalID: String

  public init(
    requestID: String = UUID().uuidString,
    terminalID: String
  ) {
    self.requestID = requestID
    self.terminalID = terminalID
  }
}

public struct SavePanelLayoutRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var layout: PanelLayout

  public init(
    requestID: String = UUID().uuidString,
    layout: PanelLayout
  ) {
    self.requestID = requestID
    self.layout = layout
  }
}

public struct TerminalOutputBatch: Codable, Sendable, Equatable {
  public var terminalID: String
  public var firstSequence: Int64
  public var lastSequence: Int64
  public var data: Data
  public var status: TerminalStatus
  public var exitCode: Int32?
  public var wasTruncated: Bool

  public init(
    terminalID: String,
    firstSequence: Int64,
    lastSequence: Int64,
    data: Data,
    status: TerminalStatus,
    exitCode: Int32?,
    wasTruncated: Bool
  ) {
    self.terminalID = terminalID
    self.firstSequence = firstSequence
    self.lastSequence = lastSequence
    self.data = data
    self.status = status
    self.exitCode = exitCode
    self.wasTruncated = wasTruncated
  }
}

public enum TaskRecoveryAction: String, Codable, Sendable, Equatable {
  case retrySetup
  case skipSetup
}

public struct RecoverTaskRequest: Codable, Sendable, Equatable {
  public var requestID: String
  public var taskID: String
  public var action: TaskRecoveryAction

  public init(
    requestID: String = UUID().uuidString,
    taskID: String,
    action: TaskRecoveryAction
  ) {
    self.requestID = requestID
    self.taskID = taskID
    self.action = action
  }
}

public struct ConfigurationTrustRequirement: Codable, Sendable, Equatable {
  public var projectID: String
  public var path: String
  public var hash: String
  public var setupCommands: [String]
  public var teardownCommands: [String]

  public init(
    projectID: String,
    path: String,
    hash: String,
    setupCommands: [String],
    teardownCommands: [String]
  ) {
    self.projectID = projectID
    self.path = path
    self.hash = hash
    self.setupCommands = setupCommands
    self.teardownCommands = teardownCommands
  }
}

public enum OrchestrationError: LocalizedError, Sendable {
  case projectNotFound(String)
  case taskNotFound(String)
  case workspaceNotFound(String)
  case agentNotFound(String)
  case approvalNotFound(String)
  case inputRequestNotFound(String)
  case providerNotFound(String)
  case configurationTrustRequired(ConfigurationTrustRequirement)
  case childLaunchLimit(Int)
  case childLaunchDenied
  case invalidState(String)

  public var errorDescription: String? {
    switch self {
    case .projectNotFound(let id):
      "Project \(id) was not found."
    case .taskNotFound(let id):
      "Task \(id) was not found."
    case .workspaceNotFound(let id):
      "Workspace \(id) was not found."
    case .agentNotFound(let id):
      "Agent \(id) was not found."
    case .approvalNotFound(let id):
      "Approval \(id) was not found."
    case .inputRequestNotFound(let id):
      "Input request \(id) was not found."
    case .providerNotFound(let id):
      "Provider \(id) was not found."
    case .configurationTrustRequired(let requirement):
      "Executable configuration at \(requirement.path) requires approval."
    case .childLaunchLimit(let limit):
      "This parent already has the maximum of \(limit) live child agents."
    case .childLaunchDenied:
      "This task does not allow agent-initiated child launches."
    case .invalidState(let message):
      message
    }
  }
}
