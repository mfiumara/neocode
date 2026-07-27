import Darwin
import Foundation
import SwiftTerm

private struct TerminalChunk: Sendable {
  var sequence: Int64
  var data: Data
}

private final class TerminalProcessState: @unchecked Sendable {
  private let lock = NSLock()
  private let maximumBytes: Int
  private var chunks: [TerminalChunk] = []
  private var byteCount = 0
  private var nextSequence: Int64 = 1
  private var storedStatus: TerminalStatus = .starting
  private var storedExitCode: Int32?
  var columns: Int
  var rows: Int

  init(maximumBytes: Int, columns: Int, rows: Int) {
    self.maximumBytes = maximumBytes
    self.columns = columns
    self.rows = rows
  }

  func append(_ bytes: ArraySlice<UInt8>) {
    lock.lock()
    let data = Data(bytes)
    chunks.append(TerminalChunk(sequence: nextSequence, data: data))
    nextSequence += 1
    byteCount += data.count
    while byteCount > maximumBytes, let first = chunks.first {
      byteCount -= first.data.count
      chunks.removeFirst()
    }
    lock.unlock()
  }

  func set(status: TerminalStatus, exitCode: Int32? = nil) {
    lock.lock()
    storedStatus = status
    storedExitCode = exitCode
    lock.unlock()
  }

  func resize(columns: Int, rows: Int) {
    lock.lock()
    self.columns = columns
    self.rows = rows
    lock.unlock()
  }

  func windowSize() -> winsize {
    lock.lock()
    defer { lock.unlock() }
    return winsize(
      ws_row: UInt16(clamping: rows),
      ws_col: UInt16(clamping: columns),
      ws_xpixel: 0,
      ws_ypixel: 0
    )
  }

  func output(terminalID: String, after sequence: Int64) -> TerminalOutputBatch {
    lock.lock()
    defer { lock.unlock() }
    let firstAvailable = chunks.first?.sequence ?? nextSequence
    let wasTruncated = sequence > 0 && sequence < firstAvailable - 1
    let selected =
      wasTruncated
      ? chunks
      : chunks.filter { $0.sequence > sequence }
    var data = Data()
    for chunk in selected {
      data.append(chunk.data)
    }
    return TerminalOutputBatch(
      terminalID: terminalID,
      firstSequence: selected.first?.sequence ?? sequence,
      lastSequence: selected.last?.sequence ?? sequence,
      data: data,
      status: storedStatus,
      exitCode: storedExitCode,
      wasTruncated: wasTruncated
    )
  }
}

private final class TerminalProcessDelegate: LocalProcessDelegate, @unchecked Sendable {
  let state: TerminalProcessState

  init(state: TerminalProcessState) {
    self.state = state
  }

  func processTerminated(_ source: LocalProcess, exitCode: Int32?) {
    state.set(
      status: exitCode == 0 ? .exited : .failed,
      exitCode: exitCode
    )
  }

  func dataReceived(slice: ArraySlice<UInt8>) {
    state.append(slice)
  }

  func getWindowSize() -> winsize {
    state.windowSize()
  }
}

private final class TerminalProcessBox: @unchecked Sendable {
  let process: LocalProcess
  let delegate: TerminalProcessDelegate

  init(process: LocalProcess, delegate: TerminalProcessDelegate) {
    self.process = process
    self.delegate = delegate
  }
}

/// PTY owner used by the background helper. Output is bounded and sequenced so
/// a newly connected window can replay what it missed without duplicating data.
public actor PersistentTerminalManager {
  private var processes: [String: TerminalProcessBox] = [:]
  private let maximumScrollbackBytes: Int
  private let callbackQueue = DispatchQueue(
    label: "com.mattiafiumara.Orchestrator.terminal-output"
  )

  public init(maximumScrollbackBytes: Int = 2_000_000) {
    self.maximumScrollbackBytes = maximumScrollbackBytes
  }

  public func start(
    terminalID: String,
    workingDirectory: String,
    columns: Int,
    rows: Int,
    environment: [String: String]
  ) -> Int32 {
    if let running = processes[terminalID] {
      return running.process.shellPid
    }
    let state = TerminalProcessState(
      maximumBytes: maximumScrollbackBytes,
      columns: columns,
      rows: rows
    )
    let delegate = TerminalProcessDelegate(state: state)
    let process = LocalProcess(
      delegate: delegate,
      dispatchQueue: callbackQueue
    )
    let merged = ProcessInfo.processInfo.environment.merging(
      environment,
      uniquingKeysWith: { _, new in new }
    )
    process.startProcess(
      executable: merged["SHELL"] ?? "/bin/zsh",
      args: ["-l"],
      environment: merged.map { "\($0.key)=\($0.value)" },
      execName: nil,
      currentDirectory: workingDirectory
    )
    state.set(status: .running)
    processes[terminalID] = TerminalProcessBox(
      process: process,
      delegate: delegate
    )
    return process.shellPid
  }

  public func send(terminalID: String, data: Data) {
    guard let process = processes[terminalID]?.process else { return }
    process.send(data: Array(data)[...])
  }

  public func resize(terminalID: String, columns: Int, rows: Int) {
    guard let box = processes[terminalID] else { return }
    box.delegate.state.resize(columns: columns, rows: rows)
    var size = box.delegate.state.windowSize()
    _ = PseudoTerminalHelpers.setWinSize(
      masterPtyDescriptor: box.process.childfd,
      windowSize: &size
    )
  }

  public func output(
    terminalID: String,
    after sequence: Int64
  ) -> TerminalOutputBatch? {
    processes[terminalID]?.delegate.state.output(
      terminalID: terminalID,
      after: sequence
    )
  }

  public func stop(terminalID: String) async {
    guard let box = processes.removeValue(forKey: terminalID) else { return }
    let pid = box.process.shellPid
    if pid > 1 {
      // Interactive login shells can ignore SIGTERM. forkpty makes the child
      // the leader of its own process group, so hang up that session first;
      // this also closes commands the shell launched inside the terminal.
      _ = Darwin.kill(-pid, SIGHUP)
      _ = Darwin.kill(pid, SIGHUP)
    }
    box.process.terminate()
    if pid > 1, !(await reap(pid: pid, attempts: 25)) {
      _ = Darwin.kill(-pid, SIGKILL)
      _ = Darwin.kill(pid, SIGKILL)
      _ = await reap(pid: pid, attempts: 25)
    }
    box.delegate.state.set(status: .exited)
  }

  private func reap(pid: pid_t, attempts: Int) async -> Bool {
    for _ in 0..<attempts {
      var status: Int32 = 0
      let result = Darwin.waitpid(pid, &status, WNOHANG)
      if result == pid || (result == -1 && errno == ECHILD) {
        return true
      }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return false
  }
}
