import Foundation
import ProviderKit
import Testing

struct ACPRegistryTests {
  @Test
  func registryDecodingCreatesReviewableNPMProviders() throws {
    let data = Data(
      """
      {
        "version": "1.0.0",
        "agents": [
          {
            "id": "example-agent",
            "name": "Example Agent",
            "version": "2.3.4",
            "description": "An ACP agent",
            "distribution": {
              "npx": {
                "package": "@example/agent@2.3.4",
                "args": ["--acp"],
                "env": {"EXAMPLE_MODE": "acp"}
              }
            }
          },
          {
            "id": "binary-only",
            "name": "Binary Only",
            "version": "1.0.0",
            "description": "Not installed automatically",
            "distribution": {
              "binary": {
                "darwin-aarch64": {
                  "archive": "https://example.invalid/agent.tgz",
                  "cmd": "./agent"
                }
              }
            }
          }
        ]
      }
      """.utf8
    )

    let providers = try ACPRegistryClient.decodeProviders(data)
    let provider = try #require(providers.first)
    #expect(providers.count == 1)
    #expect(provider.id == "example-agent")
    #expect(provider.command == ["@example/agent@2.3.4", "--acp"])
    #expect(
      provider.installCommand == "npm install --global -- '@example/agent@2.3.4'"
    )
    #expect(
      provider.runtime == .npmGlobal(package: "@example/agent@2.3.4")
    )
    #expect(provider.environment["EXAMPLE_MODE"] == "acp")
    #expect(provider.registryVersion == "2.3.4")
  }

  @Test
  func unsupportedRegistrySchemaIsRejected() {
    let data = Data(#"{"version":"2.0.0","agents":[]}"#.utf8)
    #expect(throws: ACPRegistryError.self) {
      _ = try ACPRegistryClient.decodeProviders(data)
    }
  }

  @Test
  func liveRegistryFixtureDecodesWhenProvided() throws {
    guard
      let path = ProcessInfo.processInfo.environment[
        "ORCHESTRATOR_LIVE_REGISTRY"
      ]
    else {
      return
    }
    let providers = try ACPRegistryClient.decodeProviders(
      Data(contentsOf: URL(fileURLWithPath: path))
    )
    #expect(!providers.isEmpty)
    #expect(providers.allSatisfy { !$0.command.isEmpty })
  }
}
