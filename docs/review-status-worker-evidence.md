# Worker review-status repair evidence

This artifact records reviewer-verifiable worker evidence for the review-status UI repair. It does not grant judge or merge authority.

## Literal validation commands

Run from the assigned Neocode worktree:

```text
npm test
npm run check
npm run build
```

Latest `npm test` invocation completed its full scripts with these terminal results:

```text
@neocode/server: tests 90, pass 90, fail 0
@neocode/web: tests 78, pass 78, fail 0
Playwright: E2E_NATIVE_CLIPBOARD=passed; 1 passed
npm test exit=0
```

One earlier invocation was terminated by the worker command harness timeout while the server suite was in progress. A fresh complete invocation produced the successful results above. The captured full output is intentionally not committed because it contains thousands of volatile timing lines; the literal command and terminal suite totals are recorded here.

## Focused behavior evidence

Focused semantic tests cover:

- ready versus actively reviewing wording;
- connected-and-snapshot-synchronized active markers on reconnect;
- approved, merge queued, merging, post-merge CI, merged, feedback sent, and worker resumed states;
- interrupted judge infrastructure evidence;
- pending versus repairing rebase conflict guidance;
- target advancement and fresh-handoff invalidation of an older review base;
- retained prior-round CI and judge evidence labeled historical during a fresh active round;
- terminal and top-level authority precedence;
- durable durations and collapsed nested remediation/judge audit evidence.

## Git evidence procedure

The canonical packet is generated after the evidence commit so that the packet includes this file:

```text
node scripts/candidate-git-packet.mjs
```

That command reports `main`, `HEAD`, parent, tree, merge base, canonical binary-diff SHA-256, name status, author/committer identity, clean candidate/root status, and `git diff --check`. The exact final output is supplied in the worker handoff. Embedding the final commit/tree/diff hash inside this tracked file would mutate those same identities and cannot produce a fixed point.

Implementation checkpoint before this evidence-only commit:

```text
HEAD=2a137a7b3c1c891c55321e3fe1839afc3dcfe122
```

## Risks

- Review stage durations are shown only where durable bounded timestamps or check durations support them; active elapsed duration is deliberately not invented.
- Retained prior-round evidence remains available and collapsed, but is explicitly marked historical during fresh active CI/judge rounds.
- Target advancement is inferred only from durable handoff-round ordering and recorded target-advance transition detail.
- The UI does not start review, resolve conflicts, authorize merges, or alter coordinator-owned lifecycle state.
