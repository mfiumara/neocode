# Neocode

Neocode manages local agent sessions in isolated Git worktrees. Delegated work can be admitted to `main` through a strict, local review and integration pipeline.

## Integration policy

A successful worker exit is necessary, but is never treated as approval. `pipeline.worker_finished` persists completion and automatically runs:

1. worktree and non-empty diff validation;
2. deterministic repository-local CI in the worker worktree;
3. a **new** judge process/session, with the requirements and complete Git diff;
4. structured report validation, including explicit security, data-loss, and architecture risks.

Only an approved job becomes `merge_ready`. Merge-ready jobs form the persisted integration queue. `process_queue` handles them oldest-first and a lock in the common Git directory serializes all root checkout mutation. Integration then:

1. verifies that the root checkout is clean and on the configured main branch;
2. creates a commit in the worker worktree (including `Neocode-Job` and `Neocode-Judge` trailers) if the worker left changes uncommitted;
3. reconciles the worker branch with the current local main branch without forcing;
4. reruns CI on the reconciled result;
5. rechecks the root guard and performs a fast-forward-only merge;
6. verifies the resulting root HEAD and cleanliness before marking the job merged;
7. removes the clean worktree only after that verification.

Root changes are never stashed, reset, overwritten, or force-merged. The coordinator can remain in the root checkout and does not edit it; only the serialized integration operation invokes the guarded fast-forward. No model prose can bypass the structured report and command exit-code checks.

Persisted pipeline states are `completed`, `reviewing`, `changes_requested`, `merge_ready`, `merging`, `merged`, and `conflict`. Session metadata contains command output/exit codes, judge report/run ID, merge SHA, failures, and transition timestamps; transitions are also appended to the transcript. JSON state writes are atomic. On restart, `recover` moves an interrupted integration back to `merge_ready` unless a previously persisted merge SHA can be verified. It does not infer success from a transcript. `integrate` is idempotent for a verified `merged` job.

This feature does **not** restart the current server, migrate transient running jobs, or mutate a root checkout merely because Neocode was upgraded. Recovery/integration must be explicitly invoked by the coordinator.

## Repository configuration

Commit `.neocode-pipeline.json` (or `neocode.pipeline.json`) at the repository root:

```json
{
  "main_branch": "main",
  "commands": [
    ["npm", "run", "format:check"],
    { "cmd": ["npm", "run", "typecheck"], "timeout_ms": 180000 },
    ["npm", "test"],
    ["npm", "run", "build"]
  ],
  "timeout_ms": 300000,
  "judge_timeout_ms": 600000,
  "output_limit": 262144,
  "diff_limit": 2097152,
  "judge_command": ["review-agent", "--fresh", "--prompt", "{prompt}", "--json-out", "{report}"],
  "allow_manual_approval": false
}
```

`{prompt}`, `{report}`, and `{worktree}` are replaced without shell interpolation. The judge must write (or print) JSON of this shape:

```json
{
  "approved": true,
  "summary": "All requirements are met",
  "requirements": [{ "requirement": "...", "met": true }],
  "risks": { "security": [], "data_loss": [], "architecture": [] },
  "session_id": "fresh-backend-session-id"
}
```

If commands are omitted, Neocode safely detects conventional package scripts (`format:check`, `lint`, `typecheck`, `test`, `build`), Cargo checks, Go checks, or installed Python tools. No detected/configured checks is a failure by default. Set `require_commands: false` only for a repository that intentionally has no local checks. Commands use argument arrays; string commands are supported as an explicit shell escape hatch. Output, diff size, and duration are bounded and evidence records truncation/timeouts.

## Controls and escape hatches

- `:NeocodeReview <session> <requirements>` records worker success and starts review.
- `:NeocodeRetryReview <session> <requirements>` launches a fresh CI/judge attempt after changes.
- `:NeocodeIntegrate <session>` tries the guarded serialized integration.
- Lua APIs: `require('neocode').worker_complete`, `.review`, `.integrate`, `.process_queue`, and `.recover`.
- Judge and CI failures stay `changes_requested`; conflicts stay `conflict`; dirty/wrong-branch roots stay `merge_ready`. Fix the cause, then explicitly retry.
- `pipeline.manual_approve(repo, id, reason)` exists for emergencies, but is disabled unless repository policy sets `allow_manual_approval: true`. It requires a recorded reason and does not bypass reconciliation, post-reconciliation CI, root guards, or merge verification.
- Resolve a `conflict` in the worker branch, mark/review the worker again, and obtain a fresh approval. Never force the integration lock or delete a dirty worktree as part of normal integration.

## Tests

```sh
nvim --headless -u NONE -l tests/smoke.lua
nvim --headless -u NONE -l tests/pipeline.lua
```

The pipeline suite covers approval, CI failure, judge rejection, dirty root protection, conflict handling, traceable uncommitted changes, idempotent merge, and restart recovery.
