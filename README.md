# Neocode

Neocode is a keyboard-first web application for coordinating AI coding agents. It uses Pi as its agent runtime, delegates implementation to isolated background workers, and presents conversations, jobs, and diffs in a React interface.

## Implementation

The TypeScript application is the only Neocode implementation in this repository:

- `apps/web` — React frontend built with Vite
- `apps/server` — Node.js orchestration server, Pi sessions, delegation, and worktree management
- `packages/protocol` — shared WebSocket and application-state types

The React client communicates with the server over WebSocket. There is no editor plugin or alternate runtime in this repository.

## Features

- persistent Pi coordinator with read/search and orchestration tools
- background Pi workers with configurable worktree/root isolation
- durable coordinator/job transcripts and workspace-scoped browser state
- live coordinator/worker activity, cancellation, and diff inspection
- per-thread cursor and viewport restoration
- safe GFM Markdown and bounded clipboard image attachments (4 × 8 MiB)
- visible Pi model, Build/Plan mode, and reasoning-effort controls
- context basket and keyboard-first normal/insert navigation
- command palette with `j`/`k` selection

## Run

Requires Node.js and npm. Authenticate Pi first if needed:

```sh
pi
/login
```

Then install and start Neocode for the repository you want it to operate on:

```sh
npm install
NEOCODE_CWD=/path/to/project npm run dev
```

Open <http://127.0.0.1:4317>. If `NEOCODE_CWD` is omitted, Neocode uses the Git root containing the directory where the root npm command was invoked.

Useful project commands:

```sh
npm test
npm run check
npm run build
```

### Bindings

| Key | Action |
| --- | --- |
| `i` | Focus prompt / enter insert mode |
| `Esc` | Return to normal mode |
| `j`, `k` / `↓`, `↑` | Navigate transcript messages and worker lines |
| `l` / `→` | Enter the selected worker |
| `h` / `←` | Return to the coordinator |
| `a` | Add selected message to context basket |
| `]j`, `[j` | Next/previous worker |
| `q` | Return to coordinator |
| `` ` ``, `Ctrl/Command-P`, `:` | Open global picker |
| `j`, `k` in an empty picker | Move through picker results |
| `Shift-Tab` | Cycle Build/Plan mode |
| `Ctrl-.` | Cycle model reasoning effort |
| `Enter` | Send prompt / choose picker result |
| `Shift-Enter` | Insert newline |

Use **Hand off** to start a worker directly, or ask the coordinator to implement something and let its `delegate_task` tool create the worker. The handoff control exposes the same isolation policy as the tool API.

### Worker isolation

Every delegated job records both its requested mode and effective mode/path:

- **auto** (default) creates a worktree for implementation, ambiguous, or potentially mutating tasks. It uses the root checkout only for clearly non-mutating investigation.
- **worktree** always creates a branch and worktree under `.worktrees/`. This is the safe choice for concurrent implementation jobs.
- **root** runs the worker directly in the root checkout and never creates or removes a worktree. Use it explicitly for read-only work or intentional shared-checkout edits.

An explicit UI or user choice takes precedence over auto classification. The coordinator always runs from the repository root with read/search/orchestration tools only and is instructed never to edit.

## Architecture

```text
React web client
   ↕ WebSocket
TypeScript orchestration server
   ├─ Pi coordinator session
   ├─ Pi worker session → git worktree A
   ├─ Pi worker session → git worktree B or root checkout
   └─ workspace/job state
```

See [`docs/architecture.md`](docs/architecture.md) for runtime and persistence details. The intended desktop packaging is Tauri with the TypeScript server packaged as a local sidecar; development currently uses the Vite browser shell.

## Next milestones

1. Add worker review, merge, discard, and conflict-resolution actions.
2. Add file, git-log, search-result, and terminal views.
3. Generalize the picker across files, symbols, commits, messages, and diff hunks.
4. Make context entries structured references instead of copied text.
5. Package the server as a sidecar and add the Tauri shell.
