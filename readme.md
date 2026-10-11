# Neocode

A keyboard-first cockpit for coordinating AI coding agents. Neocode uses Pi as its agent runtime, delegates implementation to isolated background workers, and treats conversations, jobs and diffs as navigable buffers.

## Prototype

The current vertical slice includes:

- a persistent Pi coordinator with read/search and orchestration tools
- background Pi workers in isolated git worktrees
- live coordinator and worker transcripts
- worker status, cancellation and diff inspection
- a context basket for carrying messages into a prompt
- Neovim-inspired normal/insert modes and a global picker
- a browser UI designed to become the frontend of a Tauri application

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
| `Ctrl/Command-P`, `:` | Open global picker |
| `Enter` | Send prompt |
| `Shift-Enter` | Insert newline |
| `Shift-Tab` | Cycle the Pi coordinator mode (`Build` / `Plan`) |
| `Ctrl-.` | Cycle the selected model's supported reasoning effort |

The composer always shows its current mode and effort. **Build** exposes Neocode's delegation capability; **Plan** keeps the coordinator read-only and disables hand-off. Effort values come from Pi's active model capability map, so models without configurable reasoning show `not supported` rather than a cosmetic setting. New workers capture the coordinator's model and effort at delegation time.

Use **Hand off** to start a worker directly, or ask the coordinator to implement something and let its `delegate_task` tool create the worker.

## Architecture

```text
React UI
   ↕ WebSocket
Neocode orchestration server
   ├─ Pi coordinator session
   ├─ Pi worker session → git worktree A
   ├─ Pi worker session → git worktree B
   └─ workspace/job state
```

- `apps/web` — graphical, keyboard-first frontend
- `apps/server` — Pi sessions, delegation and worktree orchestration
- `packages/protocol` — transport and application state types
- `lua/neocode` — the earlier Neovim prototype; retained while useful

The frontend intentionally has no Node dependency. The intended desktop packaging is Tauri with the orchestration server packaged as a local sidecar. Until that boundary is stable, the browser development shell keeps iteration fast.

## Next milestones

1. Persist and restore jobs across application restarts.
2. Add worker review, merge, discard and conflict-resolution actions.
3. Add file, git-log, search-result and terminal buffer types.
4. Generalize the picker across files, symbols, commits, messages and diff hunks.
5. Make context entries structured references instead of copied text.
6. Package the server as a sidecar and add the Tauri shell.
