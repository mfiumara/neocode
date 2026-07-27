import Darwin
import Foundation

public struct CommandSpec: Sendable, Equatable {
  public var executable: String
  public var arguments: [String]
  public var workingDirectory: String?
  public var environment: [String: String]

  public init(
    executable: String,
    arguments: [String] = [],
    workingDirectory: String? = nil,
    environment: [String: String] = [:]
  ) {
    self.executable = executable
    self.arguments = arguments
    self.workingDirectory = workingDirectory
    self.environment = environment
  }
}

public struct CommandResult: Sendable, Equatable {
  public var exitCode: Int32
  public var standardOutput: String
  public var standardError: String

  public init(exitCode: Int32, standardOutput: String, standardError: String) {
    self.exitCode = exitCode
    self.standardOutput = standardOutput
    self.standardError = standardError
  }
}

public enum ProcessRunnerError: LocalizedError, Sendable {
  case launchFailed(String)
  case nonZeroExit(CommandResult)

  public var errorDescription: String? {
    switch self {
    case .launchFailed(let message):
      "Could not launch process: \(message)"
    case .nonZeroExit(let result):
      result.standardError.isEmpty
        ? "Command exited with status \(result.exitCode)."
        : result.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
}

public struct ProcessRunner: Sendable {
  public init() {}

  public func run(_ spec: CommandSpec, requireSuccess: Bool = true) async throws -> CommandResult {
    try await Task.detached(priority: .utility) {
      let process = Process()
      let output = Pipe()
      let error = Pipe()
      ProcessPipe.prepareForChildProcess(output)
      ProcessPipe.prepareForChildProcess(error)

      process.executableURL = URL(fileURLWithPath: spec.executable)
      process.arguments = spec.arguments
      process.standardOutput = output
      process.standardError = error
      if let workingDirectory = spec.workingDirectory {
        process.currentDirectoryURL = URL(fileURLWithPath: workingDirectory)
      }
      process.environment = ProcessInfo.processInfo.environment.merging(
        spec.environment,
        uniquingKeysWith: { _, new in new }
      )

      do {
        try process.run()
        ProcessPipe.closeParentWriteEnd(output)
        ProcessPipe.closeParentWriteEnd(error)
      } catch {
        throw ProcessRunnerError.launchFailed(error.localizedDescription)
      }

      let outputTask = Task.detached {
        output.fileHandleForReading.readDataToEndOfFile()
      }
      let errorTask = Task.detached {
        error.fileHandleForReading.readDataToEndOfFile()
      }
      process.waitUntilExit()
      let outputData = await outputTask.value
      let errorData = await errorTask.value
      let result = CommandResult(
        exitCode: process.terminationStatus,
        standardOutput: String(decoding: outputData, as: UTF8.self),
        standardError: String(decoding: errorData, as: UTF8.self)
      )
      if requireSuccess, result.exitCode != 0 {
        throw ProcessRunnerError.nonZeroExit(result)
      }
      return result
    }.value
  }
}

/// Prevents unrelated concurrently launched children from inheriting pipe
/// descriptors and keeping another process's output stream open forever.
public enum ProcessPipe {
  public static func prepareForChildProcess(_ pipe: Pipe) {
    markCloseOnExec(pipe.fileHandleForReading.fileDescriptor)
    markCloseOnExec(pipe.fileHandleForWriting.fileDescriptor)
  }

  public static func closeParentWriteEnd(_ pipe: Pipe) {
    try? pipe.fileHandleForWriting.close()
  }

  public static func closeParentReadEnd(_ pipe: Pipe) {
    try? pipe.fileHandleForReading.close()
  }

  private static func markCloseOnExec(_ descriptor: Int32) {
    let flags = fcntl(descriptor, F_GETFD)
    guard flags >= 0 else { return }
    _ = fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC)
  }
}

public enum BinaryLocator {
  public static func locate(_ name: String) -> String? {
    let environmentPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
    var directories = environmentPath.split(separator: ":").map(String.init)
    directories.append(contentsOf: [
      "\(NSHomeDirectory())/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ])

    var seen = Set<String>()
    for directory in directories where seen.insert(directory).inserted {
      let path = URL(fileURLWithPath: directory).appending(path: name).path
      if FileManager.default.isExecutableFile(atPath: path) {
        return path
      }
    }
    return nil
  }
}
