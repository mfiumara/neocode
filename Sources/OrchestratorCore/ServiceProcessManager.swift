import Darwin
import Foundation

private final class ManagedProcessBox: @unchecked Sendable {
  let process: Process
  let output: Pipe
  let state: ManagedProcessState

  init(process: Process, output: Pipe, state: ManagedProcessState) {
    self.process = process
    self.output = output
    self.state = state
  }
}

private final class ManagedProcessState: @unchecked Sendable {
  private let lock = NSLock()
  private var storedStatus: ServiceStatus = .starting
  private var storedExitCode: Int32?
  private var storedSignal: String?
  private var storedOutput = Data()
  private var outputWasTruncated = false
  private let maximumBytes: Int

  init(maximumBytes: Int) {
    self.maximumBytes = maximumBytes
  }

  func set(
    status: ServiceStatus,
    exitCode: Int32? = nil,
    signal: String? = nil
  ) {
    lock.lock()
    storedStatus = status
    storedExitCode = exitCode
    storedSignal = signal
    lock.unlock()
  }

  func append(_ data: Data) {
    lock.lock()
    storedOutput.append(data)
    if storedOutput.count > maximumBytes {
      outputWasTruncated = true
      storedOutput.removeFirst(storedOutput.count - maximumBytes)
    }
    lock.unlock()
  }

  func snapshot() -> (ServiceStatus, Int32?, String?, String, Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (
      storedStatus,
      storedExitCode,
      storedSignal,
      String(decoding: storedOutput, as: UTF8.self),
      outputWasTruncated
    )
  }
}

public struct ManagedProcessSnapshot: Sendable, Equatable {
  public var status: ServiceStatus
  public var exitCode: Int32?
  public var signal: String?
  public var output: String
  public var wasTruncated: Bool

  public init(
    status: ServiceStatus,
    exitCode: Int32?,
    signal: String? = nil,
    output: String,
    wasTruncated: Bool = false
  ) {
    self.status = status
    self.exitCode = exitCode
    self.signal = signal
    self.output = output
    self.wasTruncated = wasTruncated
  }
}

/// Owns long-running project services. When hosted by OrchestratorService these
/// processes continue running after every UI window has closed.
public actor ServiceProcessManager {
  private struct RunningProcess {
    var box: ManagedProcessBox
    var outputTask: Task<Void, Never>
    var waitTask: Task<Void, Never>
  }

  private var processes: [String: RunningProcess] = [:]
  private let maximumOutputBytes: Int

  public init(maximumOutputBytes: Int = 1_000_000) {
    self.maximumOutputBytes = maximumOutputBytes
  }

  @discardableResult
  public func start(
    id: String,
    command: String,
    workingDirectory: String,
    environment: [String: String]
  ) throws -> Int32 {
    try start(
      id: id,
      spec: CommandSpec(
        executable: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
        arguments: ["-lc", command],
        workingDirectory: workingDirectory,
        environment: environment
      )
    )
  }

  @discardableResult
  public func start(
    id: String,
    spec: CommandSpec
  ) throws -> Int32 {
    if let existing = processes[id], existing.box.process.isRunning {
      return existing.box.process.processIdentifier
    }

    let process = Process()
    let output = Pipe()
    ProcessPipe.prepareForChildProcess(output)
    let state = ManagedProcessState(maximumBytes: maximumOutputBytes)
    process.executableURL = URL(fileURLWithPath: spec.executable)
    process.arguments = spec.arguments
    if let workingDirectory = spec.workingDirectory {
      process.currentDirectoryURL = URL(fileURLWithPath: workingDirectory)
    }
    process.environment = ProcessInfo.processInfo.environment.merging(
      spec.environment,
      uniquingKeysWith: { _, new in new }
    )
    process.standardOutput = output
    process.standardError = output
    try process.run()
    ProcessPipe.closeParentWriteEnd(output)
    state.set(status: .running)

    let box = ManagedProcessBox(process: process, output: output, state: state)
    let outputTask = Task.detached(priority: .utility) {
      while !Task.isCancelled {
        do {
          guard let data = try box.output.fileHandleForReading.read(upToCount: 8_192),
            !data.isEmpty
          else {
            break
          }
          box.state.append(data)
        } catch {
          break
        }
      }
    }
    let waitTask = Task.detached(priority: .utility) {
      box.process.waitUntilExit()
      let terminatedBySignal = box.process.terminationReason == .uncaughtSignal
      let signal =
        terminatedBySignal
        ? String(cString: strsignal(box.process.terminationStatus))
        : nil
      box.state.set(
        status: !terminatedBySignal && box.process.terminationStatus == 0
          ? .stopped
          : .failed,
        exitCode: terminatedBySignal ? nil : box.process.terminationStatus,
        signal: signal
      )
    }
    processes[id] = RunningProcess(
      box: box,
      outputTask: outputTask,
      waitTask: waitTask
    )
    return process.processIdentifier
  }

  public func snapshot(id: String) -> ManagedProcessSnapshot? {
    guard let running = processes[id] else { return nil }
    let snapshot = running.box.state.snapshot()
    return ManagedProcessSnapshot(
      status: snapshot.0,
      exitCode: snapshot.1,
      signal: snapshot.2,
      output: snapshot.3,
      wasTruncated: snapshot.4
    )
  }

  public func waitForExit(id: String) async -> ManagedProcessSnapshot? {
    guard let running = processes[id] else { return nil }
    await running.waitTask.value
    await running.outputTask.value
    return snapshot(id: id)
  }

  public func terminate(id: String) {
    guard let running = processes[id], running.box.process.isRunning else {
      return
    }
    running.box.process.terminate()
  }

  public func stop(id: String) {
    guard let running = processes.removeValue(forKey: id) else { return }
    if running.box.process.isRunning {
      running.box.process.terminate()
    }
    running.box.state.set(status: .stopped)
    running.outputTask.cancel()
    running.waitTask.cancel()
  }

  public func stopAll() {
    for id in Array(processes.keys) {
      stop(id: id)
    }
  }
}
