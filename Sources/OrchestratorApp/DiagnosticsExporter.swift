import Foundation
import OrchestratorCore

struct DiagnosticsBundle: Codable {
  var generatedAt: Date
  var appVersion: String
  var operatingSystem: String
  var architecture: String
  var backgroundServiceStatus: String
  var providers: [ProviderInspection]
  var projects: [Project]
  var snapshots: [CoreSnapshot]
  var events: [String: [AgentEvent]]
}

enum DiagnosticsExporter {
  static func make(
    projects: [Project],
    snapshots: [String: CoreSnapshot],
    events: [String: [AgentEvent]],
    providers: [ProviderInspection],
    backgroundServiceStatus: String
  ) -> DiagnosticsBundle {
    DiagnosticsBundle(
      generatedAt: .now,
      appVersion: "0.1.0",
      operatingSystem: ProcessInfo.processInfo.operatingSystemVersionString,
      architecture: "arm64",
      backgroundServiceStatus: backgroundServiceStatus,
      providers: providers.map(\.redactedForDiagnostics),
      projects: projects,
      snapshots: snapshots.values.map(\.redactedForDiagnostics).sorted {
        ($0.project?.name ?? "") < ($1.project?.name ?? "")
      },
      events: events.mapValues {
        $0.map(\.redactedForDiagnostics)
      }
    )
  }
}

extension ProviderInspection {
  fileprivate var redactedForDiagnostics: ProviderInspection {
    var copy = self
    copy.descriptor.installationCommand = nil
    return copy
  }
}

extension AgentEvent {
  fileprivate var redactedForDiagnostics: AgentEvent {
    var copy = self
    copy.payload = payload.redactedForDiagnostics
    copy.rawProviderPayload = nil
    return copy
  }
}

extension CoreSnapshot {
  fileprivate var redactedForDiagnostics: CoreSnapshot {
    var copy = self
    copy.workspaces = workspaces.map {
      var workspace = $0
      workspace.configuration = nil
      return workspace
    }
    copy.approvals = approvals.map {
      var approval = $0
      approval.details = approval.details.redactedForDiagnostics
      return approval
    }
    copy.inputRequests = inputRequests.map {
      var input = $0
      input.details = input.details.redactedForDiagnostics
      return input
    }
    copy.services = services.map {
      var service = $0
      service.command = "<redacted command>"
      return service
    }
    return copy
  }
}

extension JSONValue {
  fileprivate var redactedForDiagnostics: JSONValue {
    switch self {
    case .array(let values):
      .array(values.map(\.redactedForDiagnostics))
    case .object(let values):
      .object(
        values.mapValues { value in
          value.redactedForDiagnostics
        }.mapValuesWithKeys { key, value in
          Self.sensitiveKey(key) ? .string("<redacted>") : value
        }
      )
    default:
      self
    }
  }

  fileprivate static func sensitiveKey(_ key: String) -> Bool {
    let normalized = key.lowercased()
    return [
      "token", "secret", "password", "authorization", "cookie",
      "api_key", "apikey", "credential", "environment", "env",
    ].contains { normalized.contains($0) }
  }
}

extension Dictionary where Key == String, Value == JSONValue {
  fileprivate func mapValuesWithKeys(
    _ transform: (String, JSONValue) -> JSONValue
  ) -> [String: JSONValue] {
    Dictionary(
      uniqueKeysWithValues: map { key, value in
        (key, transform(key, value))
      })
  }
}
