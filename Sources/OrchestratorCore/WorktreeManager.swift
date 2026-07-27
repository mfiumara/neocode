import Foundation

public struct WorktreeCreationRequest: Sendable, Equatable {
  public var taskID: String
  public var sourcePath: String
  public var baseRef: String
  public var branchName: String
  public var worktreesRoot: String

  public init(
    taskID: String,
    sourcePath: String,
    baseRef: String,
    branchName: String,
    worktreesRoot: String
  ) {
    self.taskID = taskID
    self.sourcePath = sourcePath
    self.baseRef = baseRef
    self.branchName = branchName
    self.worktreesRoot = worktreesRoot
  }
}

public struct WorktreeManager: Sendable {
  private let git: GitService

  public init(git: GitService = .init()) {
    self.git = git
  }

  public func create(_ request: WorktreeCreationRequest) async throws -> Workspace {
    let sourceRoot = try await git.repositoryRoot(at: request.sourcePath)
    let baseCommit = try await git.headCommit(at: sourceRoot, ref: request.baseRef)
    let projectHash = stablePathHash(sourceRoot)
    let destination = URL(fileURLWithPath: request.worktreesRoot)
      .appending(path: projectHash)
      .appending(path: request.taskID)
    try FileManager.default.createDirectory(
      at: destination.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try await git.createWorktree(
      sourcePath: sourceRoot,
      destinationPath: destination.path,
      branchName: request.branchName,
      baseRef: request.baseRef
    )
    return Workspace(
      taskID: request.taskID,
      sourcePath: sourceRoot,
      path: destination.path,
      isolation: .worktree,
      baseCommit: baseCommit,
      branchName: request.branchName
    )
  }

  public func archive(_ workspace: Workspace, force: Bool = false) async throws {
    guard workspace.isolation == .worktree,
      workspace.ownership == .orchestrator
    else {
      return
    }
    try await git.removeWorktree(
      sourcePath: workspace.sourcePath,
      worktreePath: workspace.path,
      force: force
    )
  }

  public static func suggestedBranchName(for title: String) -> String {
    let slug =
      title
      .lowercased()
      .replacingOccurrences(
        of: "[^a-z0-9]+",
        with: "-",
        options: .regularExpression
      )
      .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    let compact = String(slug.prefix(40))
    let suffix = String(UUID().uuidString.lowercased().prefix(4))
    return "orch/\(compact.isEmpty ? "task" : compact)-\(suffix)"
  }

  private func stablePathHash(_ path: String) -> String {
    var hash: UInt64 = 14_695_981_039_346_656_037
    for byte in path.utf8 {
      hash ^= UInt64(byte)
      hash &*= 1_099_511_628_211
    }
    return String(hash, radix: 36)
  }
}
