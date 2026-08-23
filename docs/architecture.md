# Architecture

## Product and implementation boundary

Neocode is an agent cockpit, not a code editor. The repository has one implementation: a TypeScript Node.js server in `apps/server`, a React/Vite client in `apps/web`, and shared TypeScript protocol definitions in `packages/protocol`. The client is a WebSocket consumer and contains no Node.js runtime dependencies. There is no editor-plugin or alternate application runtime.

Pi owns model/provider integration, the tool loop, context compaction, and agent sessions. Neocode owns workspaces, background jobs, worktrees, navigation, review, and context selection.

## Coordinator model context and compaction

Neocode transports only aggregate coordinator model-context usage (used tokens,
model capacity, and percentage) and safe compaction lifecycle metadata. It never
transports hidden prompts, reasoning, context contents, or generated compaction
summaries. After successful compaction, usage is intentionally unknown until the
SDK observes a trustworthy response in the compacted context.

The Pi SDK supports automatic compaction. When settings do not override it, the
current SDK defaults are enabled with `reserveTokens: 16384` and
`keepRecentTokens: 20000`. Neocode reads and displays that setting without
changing it. Previously, Neocode had no compaction UI, status transport, or
manual action despite that automatic SDK behavior.

Manual compaction requires an explicit coordinator action while fully idle, with
no queued prompt, model change, compaction, or shutdown in progress. It lossily
summarizes only the active SDK model session; the independent paginated Neocode
transcript remains durable and is never deleted or rewritten.

## Runtime model

The main coordinator's primary job is reconciliation and integration. Alongside read/search it receives explicit orchestration tools: `delegate_task`, `list_jobs`, `inspect_job`, `start_judge`, `request_worker_changes`, `retry_infrastructure`, `guarded_merge`, `verify_integration`, and evidence-gated `mark_not_required`.

It cannot edit the checkout directly and is always anchored at the repository root. Implementation workers run asynchronously in worktrees and never mutate or merge root/main. Explicit root isolation remains selectable and recorded, but shared-root background workers are prompted to inspect and report only. Completion emits a durable structured handoff (report, requirements, exact diff hash, branch/worktree, tests, and risks), appends it to the main transcript, and schedules one coordinator wake. User prompts retain priority while lifecycle events wait durably.

Review is coordinator-owned: the coordinator explicitly starts a fresh independent judge, which reports but cannot integrate. Before CI and judgment, the server commits pending worker changes and rebases that worktree onto the current target. Standard candidate CI records reviewer-visible Git identity, direct-main name-status and canonical binary diff hash, clean porcelain, and diff-check command/output/exit evidence alongside test/check/build results. Git metadata is informational evidence, never a substitute for at least one configured product-CI command; without product CI the candidate cannot be judged or integrated. The immutable creation `baseRef` remains provenance while a separate `reviewBaseRef` records the exact target commit used by that review. Autonomous reconciliation uses bounded concurrent review/remediation lanes (two by default) while root integration remains a single serialized lane. Candidates are ordered by a deterministic complexity score combining changed lines, file count, overlap with files changed on main, and an aging credit that prevents starvation. Worker CI, isolated candidate CI, judge-requested changes, conflicts, and post-integration verification failures create durable `action_required` records containing exact command/output evidence and wake the coordinator once. The coordinator sends specific feedback to the same worker worktree; every feedback → resume → handoff → CI → fresh-judge transition is persisted and shown in the main thread and review UI. Transient infrastructure failures use an explicitly authorized exponential-backoff retry instead of source feedback.

Repair accounting is persisted per failure class and material diff/commit fingerprint (default three rounds). Nondeterministic diagnostic text cannot reset the budget; only a materially changed diff or commit can. Exhaustion marks the job `needs_attention` while retaining every diagnostic. A post-integration failure therefore never becomes Done. Only `guarded_merge` (retained as a compatibility tool name) records coordinator authorization through a private, non-forgeable capability bound to the main coordinator tool; judge approval remains separate and arbitrary server callers cannot impersonate the coordinator with an actor label. The server serializes the authorized root operation, validates the exact judged rebased commit in an isolated checkout, refuses target-head races, and advances main with `git merge --ff-only`; it never creates merge commits. Workers and judges have no integration capability. Startup may resume an already claimed worker repair or safe infrastructure retry, but never invents a fix, verdict, integration authorization, or duplicate attempt.

## Application state

The WebSocket protocol carries snapshots and incremental updates for:

- coordinator status and transcript
- safe coordinator context usage, automatic-compaction state, and compaction lifecycle
- worker metadata, transcript, structured handoff, report and diff
- every concise lifecycle transition and its owner in the main transcript
- errors

UI-local context basket entries are materialized into the next coordinator prompt.

### Persistence and restart lifecycle

There are two intentionally separate persistence layers:

- The browser stores the active thread, applicable worker tab, unsent draft, and context basket in `localStorage`, keyed by the absolute workspace root received from the server. Invalid data and references to jobs no longer present are ignored. This is same-origin local browser storage: it is suitable for a local cockpit, but is not encrypted and should not be treated as a secrets vault.
- The server atomically replaces `.neocode/runtime/server-v1/state.json`. This stores coordinator/job transcripts, metadata, summaries, diffs, effective isolation paths and branches, and references to Pi session files. Pi JSONL sessions are kept below the adjacent `pi-sessions` directory and are opened through `SessionManager.open` when it is safe to continue the coordinator context. The `server-v1` namespace deliberately does not collide with legacy Lua `.neocode/sessions` metadata.


On startup, Neocode reconciles worktree jobs against `git worktree list`, their recorded branch, and filesystem paths. A process cannot survive a backend restart: persisted `queued` or `running` jobs become `interrupted`, never `running`. Their transcript, checkout, diff, and Pi session reference remain reviewable and are marked recoverable when the checkout still agrees with git. Worker execution is not automatically resumed because reopening a Pi transcript cannot safely recreate an in-flight tool subprocess. A missing/corrupt Pi file starts fresh model context without discarding Neocode's own transcript.

A browser reconnect always receives a current snapshot and then continues to consume incremental WebSocket updates, so refreshing the page does not turn a live server job into a static restored copy. State is workspace-local; moving a workspace to another absolute path creates a new browser/server state scope.

## Tauri path

The architectural boundary is deliberately process-safe:

```text
Tauri webview ↔ WebSocket/IPC ↔ packaged Neocode server ↔ Pi SDK
```

Development uses the React client through Vite and the TypeScript server in a local Node.js process. Once the backend protocol and lifecycle stabilize:

1. produce a standalone server artifact
2. register it as a Tauri sidecar
3. have Rust choose an available local port and launch the sidecar
4. pass a per-launch authentication token and workspace path
5. terminate workers gracefully when the application exits
6. serve the existing `apps/web` build in the Tauri webview

This avoids coupling product behavior to browser, Electron or Tauri APIs.
