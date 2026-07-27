import Foundation
import OrchestratorCore
import Testing

struct GitServiceTests {
  @Test
  func worktreeLifecycleAndDirtyProtection() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let repository = root.appending(path: "repository")
    let worktree = root.appending(path: "worktree")
    try FileManager.default.createDirectory(
      at: repository,
      withIntermediateDirectories: true
    )
    let runner = ProcessRunner()
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["init", "-b", "main"],
        workingDirectory: repository.path
      )
    )
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["config", "user.email", "tests@example.invalid"],
        workingDirectory: repository.path
      )
    )
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["config", "user.name", "Orchestrator Tests"],
        workingDirectory: repository.path
      )
    )
    try Data("hello\n".utf8).write(to: repository.appending(path: "README.md"))
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["add", "README.md"],
        workingDirectory: repository.path
      )
    )
    _ = try await runner.run(
      CommandSpec(
        executable: "/usr/bin/git",
        arguments: ["commit", "-m", "Initial"],
        workingDirectory: repository.path
      )
    )

    let git = GitService()
    try await git.createWorktree(
      sourcePath: repository.path,
      destinationPath: worktree.path,
      branchName: "orch/test",
      baseRef: "main"
    )
    #expect(try await git.currentBranch(at: worktree.path) == "orch/test")
    let linked = try await git.linkedWorktrees(at: worktree.path)
    let repositoryRoot = try await git.repositoryRoot(at: repository.path)
    let worktreeRoot = try await git.repositoryRoot(at: worktree.path)
    #expect(
      linked.map(\.path)
        == [repositoryRoot, worktreeRoot]
    )
    #expect(linked.map(\.branch) == ["main", "orch/test"])
    #expect(linked.allSatisfy { !$0.isBare && !$0.isPrunable })
    let initiallyAhead = try await git.hasCommits(since: "main", at: worktree.path)
    #expect(!initiallyAhead)

    try Data("hello from the task\n".utf8).write(
      to: worktree.appending(path: "README.md")
    )
    try await git.stage(files: ["README.md"], at: worktree.path)
    _ = try await git.commit(message: "Task commit", at: worktree.path)
    #expect(try await git.hasCommits(since: "main", at: worktree.path))

    try Data("dirty\n".utf8).write(to: worktree.appending(path: "new.txt"))
    do {
      try await git.removeWorktree(
        sourcePath: repository.path,
        worktreePath: worktree.path
      )
      Issue.record("A dirty worktree should not be removed.")
    } catch GitServiceError.dirtyWorktree {
      // Expected.
    }
    #expect(FileManager.default.fileExists(atPath: worktree.path))
    try await git.removeWorktree(
      sourcePath: repository.path,
      worktreePath: worktree.path,
      force: true
    )
    #expect(!FileManager.default.fileExists(atPath: worktree.path))
  }

  private func temporaryDirectory() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appending(path: "orchestrator-git-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: root,
      withIntermediateDirectories: true
    )
    return root
  }
}
