@preconcurrency import Foundation
import OrchestratorCore

enum JSONLineProcessEvent: Sendable {
  case value(JSONValue)
  case standardError(String)
  case terminated(Int32)
}

actor JSONLineProcess {
  private let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private let error = Pipe()
  private var outputBuffer = Data()
  private var errorBuffer = Data()
  private var started = false
  private let stream: AsyncStream<JSONLineProcessEvent>
  private let continuation: AsyncStream<JSONLineProcessEvent>.Continuation

  init() {
    ProcessPipe.prepareForChildProcess(input)
    ProcessPipe.prepareForChildProcess(output)
    ProcessPipe.prepareForChildProcess(error)
    let pair = AsyncStream.makeStream(of: JSONLineProcessEvent.self)
    stream = pair.stream
    continuation = pair.continuation
  }

  func start(_ spec: CommandSpec) throws {
    guard !started else { return }
    started = true
    process.executableURL = URL(fileURLWithPath: spec.executable)
    process.arguments = spec.arguments
    process.standardInput = input
    process.standardOutput = output
    process.standardError = error
    if let workingDirectory = spec.workingDirectory {
      process.currentDirectoryURL = URL(fileURLWithPath: workingDirectory)
    }
    process.environment = ProcessInfo.processInfo.environment.merging(
      spec.environment,
      uniquingKeysWith: { _, new in new }
    )

    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      Task { await self?.consumeOutput(data) }
    }
    error.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      Task { await self?.consumeError(data) }
    }
    process.terminationHandler = { [weak self] process in
      Task { await self?.didTerminate(process.terminationStatus) }
    }

    do {
      try process.run()
      ProcessPipe.closeParentReadEnd(input)
      ProcessPipe.closeParentWriteEnd(output)
      ProcessPipe.closeParentWriteEnd(error)
    } catch {
      output.fileHandleForReading.readabilityHandler = nil
      self.error.fileHandleForReading.readabilityHandler = nil
      throw ProviderError.processExited(-1, error.localizedDescription)
    }
  }

  func events() -> AsyncStream<JSONLineProcessEvent> {
    stream
  }

  func send(_ value: JSONValue) throws {
    let data = try JSONEncoder.orchestrator.encode(value)
    try input.fileHandleForWriting.write(contentsOf: data + Data([0x0A]))
  }

  func interrupt() {
    guard process.isRunning else { return }
    process.interrupt()
  }

  func terminate() {
    guard process.isRunning else { return }
    process.terminate()
  }

  func processIdentifier() -> Int32? {
    process.isRunning ? process.processIdentifier : nil
  }

  private func consumeOutput(_ data: Data) {
    outputBuffer.append(data)
    while let newline = outputBuffer.firstIndex(of: 0x0A) {
      var line = outputBuffer[..<newline]
      outputBuffer.removeSubrange(...newline)
      if line.last == 0x0D {
        line = line.dropLast()
      }
      guard !line.isEmpty else { continue }
      do {
        let value = try JSONDecoder.orchestrator.decode(JSONValue.self, from: Data(line))
        continuation.yield(.value(value))
      } catch {
        continuation.yield(
          .value(
            .object([
              "_orchestrator": .string("malformedJSON"),
              "text": .string(String(decoding: line, as: UTF8.self)),
              "error": .string(error.localizedDescription),
            ])
          )
        )
      }
    }
  }

  private func consumeError(_ data: Data) {
    errorBuffer.append(data)
    if errorBuffer.count > 262_144 {
      errorBuffer.removeFirst(errorBuffer.count - 262_144)
    }
    continuation.yield(.standardError(String(decoding: data, as: UTF8.self)))
  }

  private func didTerminate(_ status: Int32) {
    output.fileHandleForReading.readabilityHandler = nil
    error.fileHandleForReading.readabilityHandler = nil
    if !outputBuffer.isEmpty {
      consumeOutput(Data([0x0A]))
    }
    continuation.yield(.terminated(status))
    continuation.finish()
  }
}
