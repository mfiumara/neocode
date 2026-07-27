import Foundation

public enum GitServiceError: LocalizedError, Sendable {
  case notRepository(String)
  case dirtyWorktree(String)
  case invalidBranchName(String)
  case missingGitHubCLI
  case noChangesToCommit

  public var errorDescription: String? {
    switch self {
    case .notRepository(let path):
      "\(path) is not a Git repository."
    case .dirtyWorktree(let path):
      "The worktree at \(path) has uncommitted changes."
    case .invalidBranchName(let name):
      "\(name) is not a valid Git branch name."
    case .missingGitHubCLI:
      "The GitHub CLI is not installed."
    case .noChangesToCommit:
      "None of the selected files contain changes to commit."
    }
  }
}

public struct GitDiff: Codable, Sendable, Equatable {
  public var text: String
  public var changedFiles: [String]

  public init(text: String, changedFiles: [String]) {
    self.text = text
    self.changedFiles = changedFiles
  }
}

public struct CreatedPullRequest: Codable, Sendable, Equatable {
  public var url: String
  public var number: Int?

  public init(url: String, number: Int? = nil) {
    self.url = url
    self.number = number
  }
}

public struct LinkedGitWorktree: Codable, Sendable, Identifiable, Equatable {
  public var path: String
  public var head: String
  public var branch: String?
  public var isDetached: Bool
  public var isBare: Bool
  public var isLocked: Bool
  public var isPrunable: Bool

  public var id: String { path }

  public init(
    path: String,
    head: String,
    branch: String? = nil,
    isDetached: Bool = false,
    isBare: Bool = false,
    isLocked: Bool = false,
    isPrunable: Bool = false
  ) {
    self.path = path
    self.head = head
    self.branch = branch
    self.isDetached = isDetached
    self.isBare = isBare
    self.isLocked = isLocked
    self.isPrunable = isPrunable
  }
}

public struct GitService: Sendable {
  private let runner: ProcessRunner
  private let gitPath: String

  public init(runner: ProcessRunner = .init(), gitPath: String = "/usr/bin/git") {
    self.runner = runner
    self.gitPath = gitPath
  }

  public func repositoryRoot(at path: String) async throws -> String {
    do {
      return try await git(
        ["rev-parse", "--show-toplevel"],
        cwd: path
      ).standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
      throw GitServiceError.notRepository(path)
    }
  }

  public func currentBranch(at path: String) async throws -> String {
    try await git(
      ["branch", "--show-current"],
      cwd: path
    ).standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public func linkedWorktrees(at path: String) async throws -> [LinkedGitWorktree] {
    let output = try await git(
      ["worktree", "list", "--porcelain", "-z"],
      cwd: path
    ).standardOutput
    return Self.parseLinkedWorktrees(output)
  }

  public func headCommit(at path: String, ref: String = "HEAD") async throws -> String {
    try await git(
      ["rev-parse", ref],
      cwd: path
    ).standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public func fileContents(
    at repositoryPath: String,
    ref: String,
    relativePath: String
  ) async throws -> Data? {
    let result = try await git(
      ["show", "\(ref):\(relativePath)"],
      cwd: repositoryPath,
      requireSuccess: false
    )
    guard result.exitCode == 0 else {
      let error = result.standardError.lowercased()
      if error.contains("does not exist") || error.contains("exists on disk, but not in")
        || error.contains("path '\(relativePath.lowercased())'")
      {
        return nil
      }
      throw ProcessRunnerError.nonZeroExit(result)
    }
    return Data(result.standardOutput.utf8)
  }

  public func validateBranchName(_ name: String, at path: String) async throws {
    let result = try await git(
      ["check-ref-format", "--branch", name],
      cwd: path,
      requireSuccess: false
    )
    guard result.exitCode == 0 else {
      throw GitServiceError.invalidBranchName(name)
    }
  }

  public func createWorktree(
    sourcePath: String,
    destinationPath: String,
    branchName: String,
    baseRef: String
  ) async throws {
    try await validateBranchName(branchName, at: sourcePath)
    _ = try await git(
      ["worktree", "add", "-b", branchName, destinationPath, baseRef],
      cwd: sourcePath
    )
  }

  public func isDirty(at path: String) async throws -> Bool {
    let output = try await git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd: path
    ).standardOutput
    return !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  public func removeWorktree(
    sourcePath: String,
    worktreePath: String,
    force: Bool = false
  ) async throws {
    if try await isDirty(at: worktreePath), !force {
      throw GitServiceError.dirtyWorktree(worktreePath)
    }
    var arguments = ["worktree", "remove"]
    if force {
      arguments.append("--force")
    }
    arguments.append(worktreePath)
    _ = try await git(arguments, cwd: sourcePath)
  }

  public func diff(at path: String, baseRef: String) async throws -> GitDiff {
    async let diffResult = git(
      ["diff", "--no-ext-diff", "--no-color", baseRef, "--"],
      cwd: path
    )
    async let namesResult = git(
      ["diff", "--name-only", baseRef, "--"],
      cwd: path
    )
    async let statusResult = git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd: path
    )
    let (diff, names, status) = try await (diffResult, namesResult, statusResult)
    var changedFiles = Set(
      names.standardOutput.split(separator: "\n").map(String.init)
    )
    let untracked = status.standardOutput
      .split(separator: "\n")
      .compactMap { line -> String? in
        guard line.hasPrefix("?? "), line.count > 3 else { return nil }
        return String(line.dropFirst(3))
      }
    changedFiles.formUnion(untracked)

    var text = diff.standardOutput
    for relativePath in untracked {
      let result = try await git(
        [
          "diff", "--no-index", "--no-ext-diff", "--no-color",
          "--", "/dev/null", relativePath,
        ],
        cwd: path,
        requireSuccess: false
      )
      if result.exitCode == 1 {
        text += result.standardOutput
      }
    }
    return GitDiff(
      text: text,
      changedFiles: changedFiles.sorted()
    )
  }

  public func stage(files: [String], at path: String) async throws {
    guard !files.isEmpty else { return }
    _ = try await git(["add", "--"] + files, cwd: path)
  }

  public func commit(message: String, at path: String) async throws -> String {
    _ = try await git(["commit", "-m", message], cwd: path)
    return try await headCommit(at: path)
  }

  public func hasStagedChanges(at path: String) async throws -> Bool {
    let result = try await git(
      ["diff", "--cached", "--quiet", "--exit-code"],
      cwd: path,
      requireSuccess: false
    )
    if result.exitCode == 0 { return false }
    if result.exitCode == 1 { return true }
    throw ProcessRunnerError.nonZeroExit(result)
  }

  public func hasCommits(since baseRef: String, at path: String) async throws -> Bool {
    let output = try await git(
      ["rev-list", "--count", "\(baseRef)..HEAD"],
      cwd: path
    ).standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    return (Int(output) ?? 0) > 0
  }

  public func push(branch: String, at path: String) async throws {
    _ = try await git(["push", "--set-upstream", "origin", branch], cwd: path)
  }

  public func createPullRequest(
    title: String,
    body: String,
    base: String,
    head: String,
    at path: String
  ) async throws -> CreatedPullRequest {
    guard let gh = BinaryLocator.locate("gh") else {
      throw GitServiceError.missingGitHubCLI
    }
    let result = try await runner.run(
      CommandSpec(
        executable: gh,
        arguments: [
          "pr", "create",
          "--title", title,
          "--body", body,
          "--base", base,
          "--head", head,
        ],
        workingDirectory: path
      )
    )
    let url = result.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    let number = URL(string: url).flatMap { Int($0.lastPathComponent) }
    return CreatedPullRequest(url: url, number: number)
  }

  public func existingPullRequest(
    head: String,
    at path: String
  ) async throws -> CreatedPullRequest? {
    guard let gh = BinaryLocator.locate("gh") else {
      throw GitServiceError.missingGitHubCLI
    }
    let result = try await runner.run(
      CommandSpec(
        executable: gh,
        arguments: ["pr", "view", head, "--json", "url,number"],
        workingDirectory: path
      ),
      requireSuccess: false
    )
    guard result.exitCode == 0 else { return nil }
    struct GitHubPullRequest: Decodable {
      var url: String
      var number: Int?
    }
    guard let data = result.standardOutput.data(using: .utf8),
      let value = try? JSONDecoder().decode(
        GitHubPullRequest.self,
        from: data
      )
    else {
      return nil
    }
    return CreatedPullRequest(url: value.url, number: value.number)
  }

  private func git(
    _ arguments: [String],
    cwd: String,
    requireSuccess: Bool = true
  ) async throws -> CommandResult {
    try await runner.run(
      CommandSpec(
        executable: gitPath,
        arguments: arguments,
        workingDirectory: cwd
      ),
      requireSuccess: requireSuccess
    )
  }

  private static func parseLinkedWorktrees(
    _ output: String
  ) -> [LinkedGitWorktree] {
    var worktrees: [LinkedGitWorktree] = []
    var path: String?
    var head = ""
    var branch: String?
    var isDetached = false
    var isBare = false
    var isLocked = false
    var isPrunable = false

    func appendCurrent() {
      guard let path else { return }
      worktrees.append(
        LinkedGitWorktree(
          path: path,
          head: head,
          branch: branch,
          isDetached: isDetached,
          isBare: isBare,
          isLocked: isLocked,
          isPrunable: isPrunable
        )
      )
    }

    for field in output.split(
      separator: "\0",
      omittingEmptySubsequences: false
    ) {
      let value = String(field)
      if value.isEmpty {
        appendCurrent()
        path = nil
        head = ""
        branch = nil
        isDetached = false
        isBare = false
        isLocked = false
        isPrunable = false
      } else if value.hasPrefix("worktree ") {
        path = String(value.dropFirst("worktree ".count))
      } else if value.hasPrefix("HEAD ") {
        head = String(value.dropFirst("HEAD ".count))
      } else if value.hasPrefix("branch ") {
        let reference = String(value.dropFirst("branch ".count))
        branch =
          reference.hasPrefix("refs/heads/")
          ? String(reference.dropFirst("refs/heads/".count))
          : reference
      } else if value == "detached" {
        isDetached = true
      } else if value == "bare" {
        isBare = true
      } else if value == "locked" || value.hasPrefix("locked ") {
        isLocked = true
      } else if value == "prunable" || value.hasPrefix("prunable ") {
        isPrunable = true
      }
    }
    appendCurrent()
    return worktrees
  }
}
