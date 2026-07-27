import Darwin
import Foundation
import OrchestratorCore
import Testing

struct ProcessManagerTests {
  @Test
  func persistentTerminalReplaysSequencedOutput() async throws {
    let manager = PersistentTerminalManager(maximumScrollbackBytes: 32_000)
    let id = "terminal-test"
    let pid = await manager.start(
      terminalID: id,
      workingDirectory: FileManager.default.temporaryDirectory.path,
      columns: 100,
      rows: 30,
      environment: [:]
    )
    #expect(pid > 0)
    await manager.send(
      terminalID: id,
      data: Data("printf 'orchestrator-pty-marker\\n'\n".utf8)
    )

    var batch: TerminalOutputBatch?
    for _ in 0..<100 {
      let candidate = await manager.output(terminalID: id, after: 0)
      if candidate.map({
        String(decoding: $0.data, as: UTF8.self)
          .contains("orchestrator-pty-marker")
      }) == true {
        batch = candidate
        break
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    let replay = try #require(batch)
    #expect(replay.lastSequence >= replay.firstSequence)
    #expect(String(decoding: replay.data, as: UTF8.self).contains("orchestrator-pty-marker"))

    let noDuplicate = try #require(
      await manager.output(terminalID: id, after: replay.lastSequence)
    )
    #expect(noDuplicate.data.isEmpty)
    await manager.stop(terminalID: id)

    var shellExited = false
    for _ in 0..<50 {
      if Darwin.kill(pid, 0) == -1, errno == ESRCH {
        shellExited = true
        break
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(shellExited)
  }

  @Test
  func managedServiceCapturesBoundedOutputAndExitStatus() async throws {
    let manager = ServiceProcessManager(maximumOutputBytes: 1_024)
    let pid = try await manager.start(
      id: "service-test",
      spec: CommandSpec(
        executable: "/usr/bin/printf",
        arguments: ["service-marker\n"],
        workingDirectory: FileManager.default.temporaryDirectory.path
      )
    )
    #expect(pid > 0)

    let snapshot = try #require(
      await manager.waitForExit(id: "service-test")
    )
    #expect(snapshot.exitCode == 0)
    #expect(snapshot.output.contains("service-marker"))
    await manager.stop(id: "service-test")
  }

  @Test
  func portReservationsAreUniqueUntilReleased() async throws {
    let allocator = PortAllocator()
    let first = try await allocator.reserve()
    let second = try await allocator.reserve()
    #expect(first != second)
    await allocator.release(first)
    await allocator.release(second)
  }
}
