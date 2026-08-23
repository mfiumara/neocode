# Neocode

A keyboard-first cockpit for coordinating AI coding agents. Neocode uses Pi as its agent runtime, delegates implementation to isolated background workers, and treats conversations, jobs and diffs as navigable buffers.

## Prototype

The current vertical slice includes:

- a persistent Pi coordinator with read/search and orchestration tools
- background Pi workers with configurable worktree/root isolation
- durable coordinator/job transcripts plus workspace-scoped browser state
- live coordinator/worker activity, cancellation and diff inspection
- configurable worker isolation and per-thread cursor/viewport restoration
- safe GFM Markdown and bounded clipboard image attachments (4 × 8 MiB)
- visible Pi model, Build/Plan mode and reasoning-effort controls
- a context basket and Neovim-inspired normal/insert navigation
- a backtick command palette with `j`/`k` selection

## Run

Authenticate Pi first if needed:

```sh
pi
/login
```

Then install and start Neocode from the repository you want it to operate on:

```sh
npm install
NEOCODE_CWD=/path/to/project npm run dev
```

Open <http://127.0.0.1:4317>. If `NEOCODE_CWD` is omitted, the directory where the root npm command was invoked is used.

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

Every delegated job records both its requested mode and effective mode/path, which are visible in worker rows and headers:

- **auto** (default) conservatively creates a worktree for implementation, ambiguous, or potentially mutating tasks. It uses the root checkout only when the task is clearly phrased as non-mutating investigation.
- **worktree** always creates a new branch and worktree under `.worktrees/`. This is the safe choice for concurrent implementation jobs.
- **root** runs the worker directly in the root checkout and never creates or removes a worktree. Root workers share files and branch state, so use this explicitly for read-only work or when shared-checkout edits are intentional.

An explicit mode selected in the UI or requested by the user takes precedence over auto classification. The coordinator itself is separate from this setting: it always runs from the repository root with read/search/orchestration tools only and is instructed never to edit. Starting Neocode in a repository subdirectory still anchors it at the Git root.

## Architecture

```text
React UI
   ↕ WebSocket
Neocode orchestration server
   ├─ Pi coordinator session
   ├─ Pi worker session → git worktree A
   ├─ Pi worker session → git worktree B or root checkout
   └─ workspace/job state
```

- `apps/web` — graphical, keyboard-first frontend
- `apps/server` — Pi sessions, delegation and worktree orchestration
- `packages/protocol` — transport and application state types
- `lua/neocode` — the earlier Neovim prototype; retained while useful

The frontend intentionally has no Node dependency. The intended desktop packaging is Tauri with the orchestration server packaged as a local sidecar. Until that boundary is stable, the browser development shell keeps iteration fast.

## Next milestones

1. Add worker review, merge, discard and conflict-resolution actions.
2. Add file, git-log, search-result and terminal buffer types.
3. Generalize the picker across files, symbols, commits, messages and diff hunks.
4. Make context entries structured references instead of copied text.
5. Package the server as a sidecar and add the Tauri shell.
