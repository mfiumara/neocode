# Orchestrator

Orchestrator is a native, local-first macOS workspace for running coding agents
inside isolated Git worktrees. Each repository opens in its own window, with a
task sidebar and native Agent, Terminal, Preview, Diff, and Files panels.

The current build is a daily-driver alpha for Apple Silicon Macs running
macOS 26 or newer.

## What is implemented

- Worktree-isolated tasks with editable base revisions and branch names.
  Existing linked Git/Paseo worktrees are discovered automatically and remain
  externally owned, so forgetting one never removes it from disk.
- Persistent projects, tasks, agents, events, approvals, structured input
  requests, terminals, services, panel layouts, and pull requests in SQLite
  through GRDB.
- A bundled `SMAppService` launch agent and versioned XPC protocol. The helper
  owns processes and Git state so work can continue after the UI exits.
- Sequenced event replay and request-id idempotency across reconnects.
- Native timelines, normalized approval and provider-question cards, attention
  queue, notifications, task recovery, agent parent/child graph, and persisted
  split layouts.
- Codex app-server, Claude streaming JSON, and JSON-RPC-over-stdio ACP adapters.
- Official ACP Registry refresh with explicit, reviewable install commands.
  Orchestrator never silently installs provider binaries.
- A private, project-scoped MCP delegation bridge with child approval and
  concurrency limits.
- Persistent SwiftTerm PTYs, managed services, centrally allocated ports, and
  WKWebView previews.
- A searchable native command palette on `Command-K`, plus `Command-1` through
  `Command-5` for direct workspace-panel navigation.
- Base-branch diffs, file-level staging, commit, push, and GitHub pull-request
  creation through the authenticated `gh` CLI.
- Redacted, user-readable diagnostics exports and no account or telemetry.

## Build and run

Requirements:

- Apple Silicon Mac on macOS 26 or newer.
- Swift 6.3 / macOS 26 SDK. The current Command Line Tools can build the
  package; full Xcode is required for XCUITest, Developer ID release signing,
  archives, and notarization.
- Git. Install and authenticate the provider CLIs you want to use.
- Authenticated `gh` for pull-request creation.

Build and test every target:

```sh
swift build
swift test
```

Assemble an ad-hoc signed development app:

```sh
Scripts/build-app.sh debug
open .build/app/Orchestrator.app
```

Or use `Scripts/run-dev.sh`. In the app, open Settings and choose
**Register Background Helper**. macOS may ask you to allow the background item.
Until it is registered, the app uses an in-process fallback; work cannot survive
UI termination in that mode.

Debug builds expose a deterministic Demo provider for smoke testing. Release
builds omit it.

## Keyboard navigation

- `Command-K`: open the command palette.
- `Command-1`: Agent.
- `Command-2`: Terminal.
- `Command-3`: Preview.
- `Command-4`: Diff.
- `Command-5`: Files.
- `Shift-Command-A`: launch an agent.

## Provider setup

Orchestrator reuses the existing credentials and configuration of installed
CLIs. It does not store provider secrets.

- **Codex:** install and authenticate `codex`; Orchestrator launches
  `codex app-server --stdio`.
- **Claude:** install and authenticate `claude`; Orchestrator launches its
  streaming JSON interface with the private permission-prompt MCP server.
- **ACP:** open Provider Settings to refresh the official registry. Review and
  run a displayed installation command, then refresh provider status.

Unsupported or missing versions stay visible as diagnostics and are not
launched. Capabilities are negotiated per provider, so unsupported controls are
hidden.

## Repository configuration

Projects may opt into a committed `.orchestrator.json`:

```json
{
  "version": 1,
  "worktree": {
    "setup": ["npm ci"],
    "teardown": []
  },
  "scripts": {
    "test": {
      "kind": "task",
      "command": "npm test"
    },
    "web": {
      "kind": "service",
      "command": "npm run dev",
      "port": "auto",
      "url": "http://127.0.0.1:${PORT}"
    }
  }
}
```

Configuration is read from the selected base revision, validated, and hashed.
Orchestrator shows executable commands and requires explicit trust before
running them. A changed hash requires a new decision. Setup failure keeps the
worktree and offers retry, skip, reveal, and archive actions.

Service scripts receive both `PORT` and `ORCHESTRATOR_PORT`. An explicit archive
preflight refuses to remove a dirty worktree unless the user confirms.

## Architecture

| Target | Responsibility |
| --- | --- |
| `OrchestratorCore` | Domain model, GRDB persistence, Git/worktrees, PTYs, services, event replay, delegation policy, and XPC envelopes |
| `ProviderKit` | Codex, Claude, ACP, official registry, and fake-process adapters |
| `OrchestratorApp` | SwiftUI/AppKit application shell and project windows |
| `OrchestratorService` | Persistent launch agent and sole background state/process owner |
| `OrchestratorBridge` | Session-scoped stdio MCP bridge for agent delegation |

Local state is under `~/Library/Application Support/Orchestrator` with a
user-only directory mode. Provider raw payloads are retained in the local
database for forward compatibility, but excluded from diagnostics exports.

## Verification

The automated suite currently covers persistence and migrations, event ordering,
idempotency, configuration trust, provider payload preservation, ACP Registry
decoding, Git worktree lifecycle, dirty cleanup protection, helper recovery,
provider-session resume, persistent PTY replay, service output bounds, and port
allocation. It also exercises a real stdio ACP fixture, negotiated permissions,
ACP-created terminals, structured provider input, and every mutating XPC
envelope:

```sh
swift test
```

Release sign-off still requires live smoke tests against authenticated Codex,
Claude, and ACP CLIs, XCUITest with full Xcode, failure-injection runs, and the
seven-day daily-driver acceptance period.

## Licensing

The reusable orchestration core and provider contracts are Apache-2.0 licensed.
The alpha application shell is source-unpublished for redistribution purposes;
its source is present here only for private development. See
[LICENSE.md](LICENSE.md).
