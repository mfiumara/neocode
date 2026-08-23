# Registered worktree and job reconciliation — 2026-08-23

Baseline: `main` at `71f7cc5be8c9bdb9eabeb07efb55bdb65c1a5fb1`. Root/main was inventoried but never modified.

## Salvage

- `/Users/mattiafiumara/repos/neocode/.neocode/runtime/worktree-salvage/20260823T150623Z` — captures the initial 38 registrations and the lifecycle conflict/index state. `SHA256SUMS.ALL` hash: `1e2acd609aee4cee30db7ed742c4722d4219263ae8420561546aa8eecb064442`.
- `/Users/mattiafiumara/repos/neocode/.neocode/runtime/worktree-salvage/20260823T150859Z` — refreshed 39-registration inventory; all 14 worktrees dirty at that capture are preserved. `SHA256SUMS.ALL` hash: `eedcd5b77fa6bc516be2247e100a3896421fcacf3e0352d991cd47528c7b9940`.
- `/Users/mattiafiumara/repos/neocode/.neocode/runtime/worktree-salvage/20260823T151256Z` — authoritative 40-registration refresh; all 16 then-dirty worktrees are preserved. `SHA256SUMS.ALL` hash: `8ca84920448b669f943071c5bb2d86e4b33f1a029ee0c38bd4de52ab0c0cb472`.
- Each dirty snapshot contains binary tracked/index/worktree patches, a portable binary untracked patch, exact changed/untracked files tarball, raw index/in-progress Git metadata, per-file hashes, status, branch and HEAD metadata. Both aggregate checksum sets verified.

## Candidate handoff

- `75352e2` (`e32120ea`): image paste StrictMode fix, direct child of baseline. Recorded full CI passed; independent system-Chrome Playwright rerun passed 1/1. Re-judge, then guarded merge only.
- `684f2ad` (`62c4e517`): coordinator-owned guarded lifecycle reconciliation, direct child of baseline. Review rejected for the async-judge coordinator wake/evidence gap; preserve it as input to remediation and do not merge or overwrite.
- `f91c790b`: running coordinator CI-remediation work, dirty and preserved; no candidate yet.
- `a8102299`: running durable disposition/backfill migration, dirty and preserved; it explicitly consumes this manifest and performs no cleanup.

## Registered worktrees

| Worktree | HEAD | Dirty | Disposition | Evidence |
|---|---:|:---:|---|---|
| `neocode` | `71f7cc5` | no | already merged/content-equivalent | Root checkout is clean at the fixed baseline 71f7cc5; it was inventoried read-only and never mutated. |
| `rampant-parrot` | `b09d36c` | ? | broken registration | git worktree lists it, but its .git points to missing /Users/mattiafiumara/repos/orchestrator/.git/worktrees/rampant-parrot; status fails. It belongs to orchestrator-macos, not this Neocode backlog. |
| `add-coordinator-ci-remediation-l-f91c790b` | `3337f00` | yes | actionable unique work | Coordinator-spawned job f91c790b is running and owns its dirty files. Preserved in refreshed snapshots; do not commit/rebase/overwrite while active. |
| `add-model-selection-ui-98cf0e6a` | `578c7eb` | yes | superseded duplicate | Dirty pre-integration web implementation was semantically reconciled by d913671; current main exposes the runtime-backed model picker. Snapshot preserves all 20 paths. |
| `add-per-step-activity-timers-011964e9` | `49f5b8a` | no | already merged/content-equivalent | Feature commit 49f5b8a was semantically reconciled as main commit c1a6d09; transcript records the same timing requirements and passing tests. |
| `adopt-shadcn-ui-components-ee87c4d3` | `d913671` | yes | superseded duplicate | Interrupted dirty prototype was resumed by job 00779657 (2ac7c54) and semantically landed as ab72094; 13 UI primitive files are byte-identical to main. |
| `automated-review-and-merge-pipel-e8b1a035` | `578c7eb` | yes | intentionally cancelled | Implemented the pipeline in removed legacy Lua. Explicit follow-up 3ca0d2c3 rejected that target; TypeScript pipeline was delivered by 663fc0f/80952ea. |
| `automatically-resume-interrupted-be3dbf65` | `7d573d7` | no | already merged/content-equivalent | 7d573d7 was reconciled into main as 83840ab, with prerequisite pipeline represented by 80952ea. |
| `backtick-command-palette-navigat-541a551d` | `578c7eb` | yes | intentionally cancelled | Wrong-target legacy Lua implementation. Its intended web behavior was ported in d913671 and retained by 5322a17; legacy Lua was removed by 409b1f0. |
| `change-palette-shortcut-to-comma-9d06babc` | `578c7eb` | yes | superseded duplicate | No current durable job/transcript. Its comma shortcut conflicts with the later explicit Cmd/Ctrl-K plus NORMAL-mode backtick architecture in 5322a17. |
| `clipboard-image-attachments-f7324f9f` | `578c7eb` | yes | superseded duplicate | Dirty initial implementation was semantically reconciled into d913671, then hardened by 47b416d and candidate 75352e2. Snapshot preserves the original 20 paths. |
| `correct-done-and-stale-job-class-a8102299` | `4ae6a6d` | yes | actionable unique work | Coordinator-spawned job a8102299 is running the metadata/disposition migration requested by this audit and owns its dirty files. Preserved in the third snapshot; do not duplicate or overwrite. |
| `fix-transcript-bottom-scrolling-c616e48c` | `4144b98` | no | already merged/content-equivalent | 4144b98 was semantically reconciled as c676606; both implement local near-bottom scrolling and clipping fixes. |
| `flexible-worker-isolation-policy-6e7402c3` | `e1930fb` | no | already merged/content-equivalent | Patch-id a8fbda8b0fd10cd8769348641bd8449f5ea4222c is identical for e1930fb and main commit 531db9a. |
| `investigate-and-fix-image-paste-59dc2307` | `530e1a4` | no | already merged/content-equivalent | 530e1a4 was semantically reconciled as 47b416d. The StrictMode follow-up remains separately actionable at 75352e2. |
| `live-agent-activity-visibility-a38c2084` | `578c7eb` | yes | superseded duplicate | Dirty initial implementation was semantically reconciled into d913671; main contains activity.ts/tests and integrated UI. |
| `make-coordinator-own-review-and--870fa4f3` | `d913671` | no | superseded duplicate | Interrupted before producing a commit; its explicit coordinator-owned architecture was implemented by 83d2a97 and reconciled by 684f2ad. |
| `make-reconciliation-a-durable-ha-6e225474` | `d913671` | yes | superseded duplicate | Dirty auto-supervisor design is superseded by the later explicit coordinator-owned architecture. Snapshot preserves lifecycle-supervisor files; do not combine its autonomous product decisions. |
| `model-variant-and-effort-control-5e425212` | `578c7eb` | yes | superseded duplicate | Dirty initial implementation was semantically reconciled into d913671 with live Pi capability handling. |
| `persist-and-restore-neocode-stat-d4d5f95c` | `0f21b7b` | no | already merged/content-equivalent | 0f21b7b and 7dd4bc2 have identical stable patch-id 68a28e5c980be39b3d922e201bed066a3268ca96. |
| `port-completion-hooks-pipeline-t-3ca0d2c3` | `d913671` | yes | superseded duplicate | Interrupted dirty TypeScript implementation was resumed as 663fc0f and landed patch-equivalently as 80952ea (stable patch-id 3dca43e4c7f13891ba08a5b7a333edd1c836ad41). |
| `reconcile-and-integrate-complete-6a2c4ad2` | `d913671` | no | already merged/content-equivalent | d913671 is an ancestor of main and is the explicit semantic reconciliation for the first feature batch. |
| `reconcile-coordinator-lifecycle--62c4e517` | `684f2ad` | no | actionable unique work | External lifecycle worker completed clean commit 684f2ada1193b62370fb9f172b7c872cbb863eae directly on 71f7cc5 and entered independent review. Its earlier conflicted/index state is preserved in snapshot 20260823T150623Z; do not duplicate or overwrite. |
| `remove-legacy-lua-implementation-8c8c3865` | `26d4290` | no | already merged/content-equivalent | 26d4290 was semantically reconciled as main commit 409b1f0; main has no lua/neocode or plugin legacy tree. |
| `render-transcript-markdown-ac316d50` | `578c7eb` | yes | superseded duplicate | Dirty implementation was semantically reconciled into d913671; Markdown.tsx and Markdown.test.tsx are byte-identical to main. |
| `restore-cursor-per-thread-50a773d3` | `578c7eb` | yes | superseded duplicate | Dirty implementation was semantically reconciled into d913671; threadNavigation.ts and its test are byte-identical to main. |
| `restore-root-after-audit-violati-ae65aed6` | `71f7cc5` | no | already merged/content-equivalent | Clean no-op worktree equals main at 71f7cc5; root recovery evidence remains under ignored runtime storage. |
| `resume-blocked-batch-reconciliat-e883120c` | `d913671` | no | already merged/content-equivalent | Its continuation produced/fed 1832651, which is an ancestor of main; stale branch pointer d913671 contains no unique remaining tree. |
| `resume-coordinator-owned-lifecyc-1a1855a0` | `83d2a97` | no | superseded duplicate | 83d2a97 is the source architecture reconciled by active follow-up 62c4e517 into candidate 684f2ad on current main. |
| `resume-interrupted-shadcn-migrat-00779657` | `2ac7c54` | no | already merged/content-equivalent | 2ac7c54 was semantically reconciled as ab72094 while preserving later overlapping UI changes. |
| `resume-web-completion-pipeline-770d3f76` | `663fc0f` | no | already merged/content-equivalent | 663fc0f and main 80952ea share stable patch-id 3dca43e4c7f13891ba08a5b7a333edd1c836ad41. |
| `review-reconcile-and-land-comple-e50094b9` | `1832651` | no | already merged/content-equivalent | 1832651 is an ancestor of main and contains the coordinator notification/lifecycle reconciliation batch. |
| `safely-land-reconciled-ui-on-mai-ba959014` | `578c7eb` | no | superseded duplicate | Interrupted landing helper made no branch commit; root recovery and later guarded integration landed d913671 and successors without needing this stale checkout. |
| `salvage-and-reconcile-every-work-4856566e` | `ac011cd` | no | actionable unique work | This isolated worker owns only the tracked manifest candidate and never mutates root/main. |
| `session-6a8a0557cb51` | `28261f0` | no | unknown | Legacy metadata says active, but branch remains at initial 28261f0 and transcript is empty; no evidence supports merge or deletion. |
| `session-6a8ac2319711` | `28261f0` | no | unknown | Legacy metadata says active, but branch remains at initial 28261f0 and transcript is empty; no evidence supports merge or deletion. |
| `simplify-composer-and-polish-pal-39ba9695` | `8af5710` | no | already merged/content-equivalent | 8af5710 was semantically reconciled as main commit 5322a17, preserving Cmd-K/backtick and removing handoff/isolation composer UI. |
| `verify-image-paste-on-current-ma-e32120ea` | `75352e2` | no | actionable unique work | Clean commit 75352e21fdda78c89964b9c600665ff9b7cf9d7b is directly based on 71f7cc5. Review rejected only for absent captured browser evidence; independent rerun with system Chrome passed 1/1. |
| `visual-model-picker-0476be99` | `578c7eb` | yes | intentionally cancelled | Wrong-target legacy Lua implementation. Intended runtime-backed web picker was ported in d913671; legacy tree was deliberately removed. |
| `worker-done-section-and-safe-jan-a2547df6` | `9c22c70` | no | already merged/content-equivalent | 9c22c70 was semantically reconciled as main commit 5a26172 with guarded janitor behavior. |

## Neocode jobs

| Job | Status | Review / integration | Disposition | Evidence |
|---|---|---|---|---|
| `a8102299` Correct Done and stale job classification | running | — / — | actionable unique work | Coordinator-owned backlog-disposition migration is running; preserved dirty and reserved. It explicitly consumes this manifest when available. |
| `f91c790b` Add coordinator CI remediation loops | running | — / — | actionable unique work | Coordinator-owned CI-remediation worker is running; preserved dirty and reserved. |
| `4856566e` Salvage and reconcile every worktree | running | — / — | actionable unique work | Current inventory/salvage worker; output is this manifest commit. |
| `62c4e517` Reconcile coordinator lifecycle onto main | completed | rejected / conflicted | actionable unique work | Produced candidate 684f2ad on current main; independent review is coordinator-owned. |
| `e32120ea` Verify image paste on current main | completed | rejected / conflicted | actionable unique work | Produced candidate 75352e2. Automated judge rejected solely because pipeline evidence omitted the E2E command; independent E2E rerun passed. |
| `ae65aed6` Restore root after audit violation | completed | rejected / conflicted | already merged/content-equivalent | No-op clean branch equals main; audit/root restoration already complete. |
| `1a1855a0` Resume coordinator-owned lifecycle work | completed | rejected / conflicted | superseded duplicate | Superseded by lifecycle reconciliation job 62c4e517. |
| `6044712e` Audit all registered worktrees | needs_attention | — / — | superseded duplicate | Audit job needs_attention but its scope is superseded by 4856566e; prior root-recovery archive remains preserved. |
| `870fa4f3` Make coordinator own review and merging | interrupted | — / — | superseded duplicate | Interrupted predecessor to 1a1855a0/62c4e517. |
| `6e225474` Make reconciliation a durable harness responsibility | interrupted | — / — | superseded duplicate | Autonomous supervisor architecture explicitly superseded by coordinator-owned lifecycle. |
| `e883120c` Resume blocked batch reconciliation | interrupted | — / — | already merged/content-equivalent | Recovery integration outcome 1832651 is in main. |
| `e50094b9` Review, reconcile, and land completed batch | interrupted | — / — | already merged/content-equivalent | Its 1832651 output is an ancestor of main. |
| `be3dbf65` Automatically resume interrupted workers | completed | rejected / conflicted | already merged/content-equivalent | Recovery feature semantically landed as 83840ab. |
| `59dc2307` Investigate and fix image paste | completed | rejected / conflicted | already merged/content-equivalent | Image handling fix semantically landed as 47b416d. |
| `39ba9695` Simplify composer and polish palette | completed | ci_failed / conflicted | already merged/content-equivalent | UI polish semantically landed as 5322a17. |
| `a2547df6` Worker done section and safe janitor | completed | rejected / conflicted | already merged/content-equivalent | Done/janitor behavior semantically landed as 5a26172. |
| `011964e9` Add per-step activity timers | completed | rejected / conflicted | already merged/content-equivalent | Timing behavior semantically landed as c1a6d09. |
| `770d3f76` Resume web completion pipeline | completed | rejected / conflicted | already merged/content-equivalent | Pipeline patch-equivalently landed as 80952ea. |
| `00779657` Resume interrupted shadcn migration | completed | rejected / conflicted | already merged/content-equivalent | Shadcn work semantically landed as ab72094. |
| `ee87c4d3` Adopt shadcn UI components | interrupted | — / — | superseded duplicate | Interrupted source resumed by 00779657. |
| `8c8c3865` Remove legacy Lua implementation | completed | rejected / conflicted | already merged/content-equivalent | Legacy removal semantically landed as 409b1f0. |
| `3ca0d2c3` Port completion hooks pipeline to web backend | interrupted | — / — | superseded duplicate | Interrupted source resumed by 770d3f76. |
| `ba959014` Safely land reconciled UI on main | interrupted | — / — | superseded duplicate | Stale landing helper superseded by completed root recovery/integration. |
| `6a2c4ad2` Reconcile and integrate completed feature batch | completed | rejected / conflicted | already merged/content-equivalent | d913671 and its reconciled feature batch are ancestors/content in main. |
| `e8b1a035` Automated review and merge pipeline | completed | ci_failed / conflicted | intentionally cancelled | Wrong-target legacy Lua implementation; superseded by TypeScript pipeline. |
| `c616e48c` Fix transcript bottom scrolling | completed | rejected / conflicted | already merged/content-equivalent | Scrolling fix semantically landed as c676606. |
| `50a773d3` Restore cursor per thread | completed | rejected / conflicted | already merged/content-equivalent | Cursor restoration integrated by d913671. |
| `d4d5f95c` Persist and restore Neocode state | completed | rejected / conflicted | already merged/content-equivalent | Persistence patch-equivalently landed as 7dd4bc2. |
| `541a551d` Backtick command palette navigation | completed | ci_failed / conflicted | intentionally cancelled | Wrong-target Lua implementation; intent ported to web. |
| `0476be99` Visual model picker | completed | ci_failed / conflicted | intentionally cancelled | Wrong-target Lua implementation; intent ported to web. |
| `ac316d50` Render transcript markdown | completed | rejected / conflicted | already merged/content-equivalent | Markdown feature integrated by d913671. |
| `5e425212` Model variant and effort controls | completed | rejected / conflicted | already merged/content-equivalent | Variant/effort feature integrated by d913671. |
| `a38c2084` Live agent activity visibility | completed | rejected / conflicted | already merged/content-equivalent | Activity feature integrated by d913671. |
| `f7324f9f` Clipboard image attachments | completed | rejected / conflicted | already merged/content-equivalent | Clipboard attachments integrated by d913671 and later hardened. |
| `6e7402c3` Flexible worker isolation policy | completed | rejected / conflicted | already merged/content-equivalent | Isolation patch-equivalently landed as 531db9a. |

## Legacy sessions

- `6a8a0557b2e7` and `6a8ac231c0d3`: **unknown** — metadata says active, transcripts are empty, worktrees remain at the initial commit. Do not clean automatically.
- `6a8ac1ddb2e7`: **broken registration** — archived metadata points to an absent worktree; retain metadata until guarded repair.

## Metadata backfill and cleanup plan

1. Under the shared serialized lifecycle lock, backfill merged evidence for the explicit mappings above (target/main head, source/completion head, ancestry/patch-id/semantic evidence, timestamp).
2. Backfill `supersededBy` for resumed/duplicate jobs and explicit cancellation reasons/replacement commits for wrong-target Lua jobs.
3. Do not mark `e32120ea`, `62c4e517`, `f91c790b`, `a8102299`, or this job merged until fresh independent judgment and guarded integration.
4. Cleanup remains a separate guarded operation: require clean status including untracked files, durable branch/path/head identity, no active process/review/integration, grace expiry, verified ancestry/content evidence, clean root, unchanged main, and the shared integration lock. Retain branches and salvage archives.
5. Never delete dirty worktrees or unknown legacy sessions.

The JSON sibling is canonical and contains exact paths, full SHAs, current statuses, candidates, test evidence, and plans.
