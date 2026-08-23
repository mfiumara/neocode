# Architecture

## Product boundary

Neocode is an agent cockpit, not a code editor. Pi owns model/provider integration, the tool loop, context compaction and agent sessions. Neocode owns workspaces, background jobs, worktrees, navigation, review and context selection.

## Runtime model

The coordinator receives read/search tools plus three orchestration tools:

- `delegate_task`
- `list_jobs`
- `inspect_job`

It cannot edit the checkout directly and is always anchored at the repository root. `delegate_task` starts a separate Pi session and returns immediately. Each request carries an `auto`, `worktree`, or `root` isolation choice. Auto uses a worktree unless a task is clearly non-mutating; explicit choices win. Worktree jobs create a branch and checkout under `.worktrees`, while root jobs use the existing checkout without worktree creation or cleanup. The worker gets Pi's normal coding tools and runs asynchronously. Completion updates application state but does not automatically inject the worker transcript or diff into the coordinator context.

## Application state

The WebSocket protocol carries snapshots and incremental updates for:

- coordinator status and transcript
- worker metadata, transcript, report and diff
- errors

UI-local context basket entries are materialized into the next coordinator prompt.

### Persistence and restart lifecycle

There are two intentionally separate persistence layers:

- The browser stores the active thread, applicable worker tab, unsent draft, isolation picker, and context basket in `localStorage`, keyed by the absolute workspace root received from the server. Invalid data and references to jobs no longer present are ignored. This is same-origin local browser storage: it is suitable for a local cockpit, but is not encrypted and should not be treated as a secrets vault.
- The server atomically replaces `.neocode/runtime/server-v1/state.json`. This stores coordinator/job transcripts, metadata, summaries, diffs, effective isolation paths and branches, and references to Pi session files. Pi JSONL sessions are kept below the adjacent `pi-sessions` directory and are opened through `SessionManager.open` when it is safe to continue the coordinator context. The `server-v1` namespace deliberately does not collide with legacy Lua `.neocode/sessions` metadata.

On startup, Neocode reconciles worktree jobs against `git worktree list`, their recorded branch, and filesystem paths. A process cannot survive a backend restart: persisted `queued` or `running` jobs become `interrupted`, never `running`. Their transcript, checkout, diff, and Pi session reference remain reviewable and are marked recoverable when the checkout still agrees with git. Worker execution is not automatically resumed because reopening a Pi transcript cannot safely recreate an in-flight tool subprocess. A missing/corrupt Pi file starts fresh model context without discarding Neocode's own transcript.

A browser reconnect always receives a current snapshot and then continues to consume incremental WebSocket updates, so refreshing the page does not turn a live server job into a static restored copy. State is workspace-local; moving a workspace to another absolute path creates a new browser/server state scope.

## Tauri path

The architectural boundary is deliberately process-safe:

```text
Tauri webview ↔ WebSocket/IPC ↔ packaged Neocode server ↔ Pi SDK
```

Development uses Vite and a local Node process. Once the backend protocol and lifecycle stabilize:

1. produce a standalone server artifact
2. register it as a Tauri sidecar
3. have Rust choose an available local port and launch the sidecar
4. pass a per-launch authentication token and workspace path
5. terminate workers gracefully when the application exits
6. serve the existing `apps/web` build in the Tauri webview

This avoids coupling product behavior to browser, Electron or Tauri APIs.
