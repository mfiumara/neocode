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

UI-local context basket entries are materialized into the next coordinator prompt. They should eventually become durable structured references such as file ranges, diff hunks, commits and session message IDs.

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
