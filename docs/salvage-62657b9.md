# Renewable lease salvage provenance

This candidate was reconstructed after inspecting source commit
`62657b930701a392e943be402982f2fdf43b765b` directly against parent
`bb615e9f1f3d874ee3498bdc16faa8636cd8e5d4`.

The canonical source binary diff SHA-256 is
`fadecde3b564a28b1ce0e8e73cd511f9103a341c4d3c3c2f515cdab91f1f7bcd`.
The executed command transcript is persisted in
[`source-62657b9-evidence.txt`](source-62657b9-evidence.txt). Its direct
name-status was:

```text
M .env.example
M apps/server/src/completion-pipeline.test.ts
M apps/server/src/orchestrator.ts
M apps/server/src/recovery.test.ts
M apps/server/src/recovery.ts
M packages/protocol/src/index.ts
```

## Reconciliation mapping

Retained and independently hardened:

- configurable renewable generation leases and expiry-aware takeover;
- generation/token callback validation, now coupled to canonical ownership;
- durable startup, renewal, terminal, shutdown, and takeover transitions, now
  serialized with inter-process locking and revision CAS;
- cancellation/completion non-resumption and dirty-root/interrupted-merge safety;
- exactly-once Git integration only after explicit coordinator authorization.

Omitted or superseded:

- process-local-only renewal and stale whole-snapshot persistence from the source
  implementation were replaced by durable CAS and merge protection;
- source assumptions that no process survives restart were superseded by lease
  expiry plus a coordinator/model readiness barrier;
- the source test's merge-commit expectation was omitted because current main
  intentionally performs exact reviewed `--ff-only` integration;
- no autonomous server-owned judging, product remediation, conflict resolution,
  or merge authority was retained or introduced.
