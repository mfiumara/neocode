import Foundation
import OrchestratorCore

enum DelegationConfiguration {
  static func load(path: String?) -> JSONValue? {
    guard let path,
      let data = FileManager.default.contents(atPath: path)
    else {
      return nil
    }
    return try? JSONDecoder.orchestrator.decode(JSONValue.self, from: data)
  }

  static func codexOverrides(path: String?) -> JSONValue? {
    load(path: path)?["codex"]
  }

  static func acpServers(path: String?) -> JSONValue {
    load(path: path)?["acp"] ?? .array([])
  }

  static func claudePath(path: String?) throws -> String? {
    guard let path, let root = load(path: path),
      let servers = root["mcpServers"]
    else {
      return nil
    }
    let filtered: JSONValue = .object(["mcpServers": servers])
    let source = URL(fileURLWithPath: path)
    let output =
      source
      .deletingPathExtension()
      .appendingPathExtension("claude.json")
    try JSONEncoder.orchestrator.encode(filtered).write(to: output, options: .atomic)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: output.path
    )
    return output.path
  }
}
