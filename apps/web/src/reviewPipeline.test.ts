import assert from "node:assert/strict";
import test from "node:test";
import type { AgentJob, JudgeEvidence, ReviewStatus } from "@neocode/protocol";
import { latestHistoricalJudgeEvidence, latestJudgeEvidence, reviewPipeline } from "./reviewPipeline";

function job(status?: ReviewStatus, top: AgentJob["status"] = "completed"): AgentJob {
  return {
    id: "worker", title: "Worker", prompt: "", status: top, branch: "worker", worktree: "/tmp/worker",
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/worker" }, baseRef: "base",
    createdAt: 1_000, updatedAt: 2_000, messages: [], integration: { status: "reviewing" },
    handoff: { report: "done", requirements: [], diffSha256: "hash", branch: "worker", worktree: "/tmp/worker", tests: [], risks: [], round: 1, createdAt: 2_000 },
    review: status ? { hookToken: "hook", status, attempt: 1, targetBranch: "main", updatedAt: 3_000, transitions: [{ status, at: 3_000 }] } : undefined,
  };
}
const verdict = (summary: string, approved = false): JudgeEvidence => ({ approved, summary, requirements: [], model: { provider: "pi", id: "judge" }, diffSha256: "hash", raw: JSON.stringify({ approved, summary }) });
const stage = (value: AgentJob, id: ReturnType<typeof reviewPipeline>["stages"][number]["id"]) => reviewPipeline(value).stages.find((item) => item.id === id)!;

test("ready for review is explicitly distinct from active coordinator review", () => {
  const ready = reviewPipeline(job("handoff_received"));
  assert.equal(ready.headline, "Ready for review");
  assert.match(ready.guidance, /no review is currently running/i);
  assert.equal(ready.active, false);
  const preparing = reviewPipeline(job("ci_running"));
  assert.equal(preparing.headline, "Reviewing now");
  assert.equal(preparing.stages.find((item) => item.tone === "active")?.label, "Coordinator Git preparation");
  const judging = reviewPipeline(job("judging"));
  assert.equal(judging.headline, "Reviewing now");
  assert.equal(judging.stages.find((item) => item.tone === "active")?.label, "Independent judge");
});

test("no-handoff completed job truthfully awaits worker evidence without activity", () => {
  const value = job(); value.handoff = undefined;
  const pipeline = reviewPipeline(value);
  assert.equal(pipeline.headline, "Awaiting worker handoff");
  assert.match(pipeline.guidance, /No fresh handoff is available/);
  assert.equal(pipeline.active, false);
  assert.equal(pipeline.stages.some((item) => item.tone === "active"), false);
});

test("current-round queued judge claim remains claimed across disconnect without false activity", () => {
  for (const status of ["queued", "handoff_received"] as const) {
    const claimed = job(status); claimed.review!.judgeHandoffRound = claimed.handoff!.round;
    for (const connected of [true, false]) {
      const pipeline = reviewPipeline(claimed, connected);
      assert.equal(pipeline.headline, "Independent review claimed");
      assert.doesNotMatch(pipeline.guidance, /no review is currently running|Ready for review/i);
      assert.match(stage(claimed, "judge").summary, /claimed.*awaiting judge launch|claimed.*serialized coordinator/i);
      assert.equal(pipeline.active, false);
      assert.equal(pipeline.stages.some((item) => item.tone === "active"), false);
    }
  }
});

test("scheduled infrastructure backoff is coordinator-owned and target-attributed before active retry", () => {
  const retry = (postMerge: boolean) => {
    const value = job("feedback_sent");
    value.review!.remediation = { maxAttempts: 2, rounds: { infrastructure: { failureClass: "infrastructure", fingerprint: "f", attempts: 1, maxAttempts: 2, nextRetryAt: 9_000, updatedAt: 4_000 } }, currentActionId: "retry", actions: [{ id: "retry", failureClass: "infrastructure", fingerprint: "f", state: "repairing", attempt: 1, maxAttempts: 2, createdAt: 3_000, updatedAt: 4_000, evidence: { detail: "runner unavailable", ...(postMerge ? { mergeCommit: "merged-head" } : {}) } }] };
    return value;
  };
  const reviewRetry = retry(false); const waiting = reviewPipeline(reviewRetry);
  assert.equal(waiting.headline, "Coordinator retry scheduled");
  assert.match(waiting.guidance, /review prerequisite retry.*backoff.*judge remains queued/i);
  assert.match(stage(reviewRetry, "repair").summary, /Coordinator retry backoff/);
  assert.equal(waiting.active, false);
  assert.equal(waiting.stages.some((item) => item.tone === "active"), false);

  const postRetry = retry(true); const postWaiting = reviewPipeline(postRetry);
  assert.match(postWaiting.guidance, /post-merge verification retry.*backoff/i);
  assert.match(stage(postRetry, "verification").summary, /scheduled after backoff/i);
  assert.equal(stage(postRetry, "verification").tone, "waiting");

  reviewRetry.review!.status = "ci_running";
  assert.equal(reviewPipeline(reviewRetry).active, false, "restored backoff with stale coarse CI status has no spinner");
  assert.equal(reviewPipeline(reviewRetry).stages.some((item) => item.tone === "active"), false);
  reviewRetry.review!.activeRetry = { target: "review", startedAt: 9_000 };
  assert.equal(stage(reviewRetry, "preparation").tone, "active");
  assert.match(reviewPipeline(reviewRetry).guidance, /retrying review prerequisites/i);
});

test("conflicted integration does not erase specific production failure guidance", () => {
  const cases: Array<[ReviewStatus, RegExp, "ci" | "judge" | "verification" | "merge"]> = [
    ["ci_failed", /CI failed; repair is required/i, "ci"],
    ["rejected", /Judge rejected/, "judge"],
    ["post_ci_failed", /Post-merge CI failed/, "verification"],
    ["blocked", /Coordinator action.*exact diagnostics/i, "merge"],
    ["failed", /Coordinator action.*exact diagnostics/i, "merge"],
  ];
  for (const [status, guidance, failedStage] of cases) {
    const value = job(status); value.integration = { status: "conflicted" }; value.review!.error = `${status} exact diagnostic`;
    if (status === "ci_failed") value.review!.ci = [{ command: "npm run test", ok: false, exitCode: 1, durationMs: 40, output: "fail" }];
    if (status === "rejected") { value.review!.judge = verdict("Missing behavior"); value.review!.judgeHandoffRound = 1; }
    if (status === "post_ci_failed") value.review!.postMergeCi = [{ command: "npm test", ok: false, exitCode: 1, durationMs: 50, output: "fail" }];
    if (status === "blocked" || status === "failed") value.review!.coordinatorAuthorizedAt = 2_500;
    const pipeline = reviewPipeline(value);
    assert.match(pipeline.guidance, guidance, status);
    assert.doesNotMatch(pipeline.guidance, /rebase conflict/i, status);
    assert.ok(["failed", "blocked"].includes(pipeline.stages.find((item) => item.id === failedStage)!.tone), status);
  }
});

test("action-required evidence marks its specific repair and failed stage without inventing conflict", () => {
  const value = job("blocked"); value.integration = { status: "conflicted" };
  value.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "ci-action", actions: [{ id: "ci-action", failureClass: "candidate_ci", fingerprint: "f", state: "pending", attempt: 1, maxAttempts: 2, createdAt: 3_000, updatedAt: 3_500, evidence: { detail: "candidate check failed" } }] };
  const pipeline = reviewPipeline(value);
  assert.match(pipeline.guidance, /Candidate verification requires coordinator action/i);
  assert.doesNotMatch(pipeline.guidance, /candidate check failed/i);
  assert.equal(pipeline.stages.find((item) => item.id === "ci")?.tone, "blocked");
  assert.equal(pipeline.stages.find((item) => item.id === "repair")?.tone, "blocked");
  assert.doesNotMatch(pipeline.guidance, /rebase conflict/i);
});

test("rebase conflict requires review conflict status and supporting durable evidence", () => {
  const unsupported = job("conflict"); unsupported.integration = { status: "conflicted" };
  assert.doesNotMatch(reviewPipeline(unsupported).guidance, /rebase conflict/i);
  const supported = job("conflict"); supported.integration = { status: "conflicted" }; supported.review!.error = "Worker rebase onto main conflicts";
  assert.match(reviewPipeline(supported).guidance, /rebase conflict/i);
  assert.equal(stage(supported, "preparation").tone, "blocked");
});

test("preparation completes only with durable base evidence and early CI remains truthful", () => {
  const early = job("ci_running");
  assert.equal(stage(early, "preparation").tone, "active");
  assert.match(stage(early, "preparation").summary, /preparing candidate/i);
  early.review!.reviewBaseRef = "prepared-base";
  early.review!.preparedHandoffRound = 1;
  assert.equal(stage(early, "preparation").tone, "complete");
});

test("pre-CI preparation transitions to actual product CI and excludes informational Git checks", () => {
  const value = job("ci_running");
  value.handoff!.round = 2;
  value.review!.reviewBaseRef = "round-1-base";
  value.review!.preparedHandoffRound = 1;
  value.review!.ciHandoffRound = 1;
  value.review!.ci = [
    { command: "git diff --check main HEAD", purpose: "preparation", handoffRound: 1, ok: true, exitCode: 0, durationMs: 10, output: "" },
    { command: "git status --porcelain", purpose: "preparation", handoffRound: 1, ok: true, exitCode: 0, durationMs: 10, output: "" },
  ];
  assert.equal(stage(value, "preparation").tone, "active");
  assert.equal(stage(value, "ci").tone, "waiting");
  assert.match(stage(value, "ci").summary, /queued.*durably started/i);
  assert.doesNotMatch(stage(value, "ci").summary, /2\/2/);

  value.review!.reviewBaseRef = "prepared-main";
  value.review!.preparedHandoffRound = 2;
  assert.equal(stage(value, "preparation").tone, "complete");
  assert.equal(stage(value, "ci").tone, "active");
  assert.match(stage(value, "ci").summary, /no completed product commands/i);
  value.review!.ciHandoffRound = 2;
  value.review!.ci.push({ command: "npm run test", purpose: "product_ci", handoffRound: 2, ok: false, exitCode: 1, durationMs: 40, output: "current completed failure" });
  assert.equal(stage(value, "ci").tone, "failed");
  assert.match(reviewPipeline(value).guidance, /completed with failures.*awaiting durable remediation/i);
  assert.match(stage(value, "ci").summary, /^0\/1 product checks passed/);
  assert.equal(stage(value, "ci").durationMs, 40);
});

test("published successful current-round checks complete before judge launch without live activity", () => {
  const value = job("ci_running");
  value.review!.reviewBaseRef = "prepared"; value.review!.preparedHandoffRound = 1; value.review!.ciHandoffRound = 1;
  value.review!.ci = [
    { command: "npm run test", purpose: "product_ci", handoffRound: 1, ok: true, exitCode: 0, durationMs: 30, output: "passed" },
    { command: "npm run check", purpose: "product_ci", handoffRound: 1, ok: true, exitCode: 0, durationMs: 20, output: "passed" },
  ];
  value.review!.transitions = [{ status: "ci_running", at: 2_000, owner: "coordinator" }, { status: "ci_running", at: 3_000, owner: "server", detail: "CI passed: npm run test, npm run check" }];
  const pipeline = reviewPipeline(value);
  assert.equal(stage(value, "ci").tone, "complete");
  assert.equal(stage(value, "ci").durationMs, 50);
  assert.match(pipeline.guidance, /completed.*preparing the next review stage/i);
  assert.equal(pipeline.stages.some((item) => item.tone === "active"), false);
});

test("current-round verdict published during judging is terminal evidence, not a spinner", () => {
  for (const approved of [true, false]) {
    const value = job("judging"); value.review!.judgeHandoffRound = 1; value.review!.judge = verdict(approved ? "Current approval" : "Current rejection", approved);
    const pipeline = reviewPipeline(value);
    assert.equal(stage(value, "judge").tone, approved ? "complete" : "failed");
    assert.match(stage(value, "judge").summary, new RegExp(approved ? "Current approved conclusion — Current approval" : "Current rejected conclusion — Current rejection"));
    assert.equal(pipeline.stages.some((item) => item.tone === "active"), false);
    assert.match(pipeline.guidance, /awaiting durable coordinator transition/i);
  }
});

test("legacy records use only the narrow product-command fallback and remain historical without round authority", () => {
  const value = job("approved");
  value.review!.ci = [
    { command: "npm run check", ok: true, exitCode: 0, durationMs: 12, output: "passed" },
    { command: "custom legacy shell", ok: true, exitCode: 0, durationMs: 9, output: "passed" },
    { command: "git diff --check main HEAD", ok: true, exitCode: 0, durationMs: 3, output: "" },
  ];
  assert.match(stage(value, "ci").summary, /Historical prior-round evidence: 1\/1/);
  assert.doesNotMatch(stage(value, "ci").summary, /2\/2|3\/3/);
});

test("durable stage durations use checks, transitions, and remediation timestamps", () => {
  const value = job("rejected");
  value.review!.transitions = [{ status: "ci_running", at: 3_000 }, { status: "judging", at: 4_000 }, { status: "rejected", at: 5_500 }];
  value.review!.ciHandoffRound = 1;
  value.review!.ci = [{ command: "npm run test", purpose: "product_ci", handoffRound: 1, ok: true, exitCode: 0, durationMs: 700, output: "" }];
  value.review!.judge = verdict("No"); value.review!.judgeHandoffRound = 1;
  value.review!.remediation = { maxAttempts: 2, rounds: {}, actions: [{ id: "a", failureClass: "judge_changes", fingerprint: "f", state: "pending", attempt: 1, maxAttempts: 2, createdAt: 5_500, updatedAt: 6_250, evidence: { detail: "repair" } }] };
  assert.equal(stage(value, "ci").durationMs, 700);
  assert.equal(stage(value, "judge").durationMs, 1_500);
  assert.equal(stage(value, "repair").durationMs, 750);
});

test("latest judge survives remediation and superseded outcomes remain terminal", () => {
  const value = job("blocked");
  const preserved = verdict("Fresh approval required");
  value.review!.remediation = { maxAttempts: 2, rounds: {}, actions: [
    { id: "older", failureClass: "judge_changes", fingerprint: "1", state: "resolved", attempt: 1, maxAttempts: 2, createdAt: 1, updatedAt: 10, evidence: { detail: "old", judge: verdict("Old") } },
    { id: "latest", failureClass: "judge_changes", fingerprint: "2", state: "pending", attempt: 2, maxAttempts: 2, createdAt: 11, updatedAt: 20, evidence: { detail: "new", judge: preserved } },
  ] };
  assert.equal(latestJudgeEvidence(value), undefined);
  assert.equal(latestHistoricalJudgeEvidence(value), preserved);
  assert.match(stage(value, "judge").summary, /Latest prior-round verdict.*rejected.*Fresh approval required/i);
  assert.equal(stage(value, "judge").tone, "waiting");

  value.integration = { status: "superseded" };
  const pipeline = reviewPipeline(value);
  assert.equal(pipeline.headline, "Verified outcome");
  assert.equal(pipeline.active, false);
  assert.equal(pipeline.stages.some((item) => item.tone === "active"), false);
  assert.equal(stage(value, "merge").tone, "complete");
  assert.equal(stage(value, "verification").summary, "Superseded terminal outcome");
});

test("fresh handoff and pre-judge CI never promote resolved prior remediation verdict", () => {
  for (const status of ["handoff_received", "ci_running"] as const) {
    const value = job(status); value.handoff!.round = 2;
    value.review!.judgeHandoffRound = 1;
    value.review!.preparedHandoffRound = status === "ci_running" ? 2 : 1;
    value.review!.reviewBaseRef = "base";
    value.review!.remediation = { maxAttempts: 2, rounds: {}, actions: [{ id: "old", failureClass: "judge_changes", fingerprint: "f", state: "resolved", attempt: 1, maxAttempts: 2, createdAt: 2, updatedAt: 3, evidence: { detail: "old rejection", judge: verdict("Prior rejected verdict") } }] };
    assert.equal(latestJudgeEvidence(value), undefined);
    assert.match(stage(value, "judge").summary, /Latest prior-round verdict.*rejected.*Prior rejected verdict/i);
    assert.equal(stage(value, "judge").tone, "waiting");
  }
});

test("major approval, repair, integration, and terminal states have production guidance", () => {
  const cases: Array<[ReviewStatus, string, "waiting" | "active" | "complete"]> = [
    ["approved", "Approved — merge not started", "waiting"],
    ["merge_queued", "Approved — integration queued", "waiting"],
    ["merging", "Integrating now", "active"],
    ["post_merge_ci", "Integrating now", "active"],
    ["merged", "Verified outcome", "complete"],
    ["feedback_sent", "Repair requested", "waiting"],
    ["worker_resumed", "Repairing feedback", "waiting"],
  ];
  for (const [status, headline, tone] of cases) {
    const value = job(status);
    if (status === "merged") value.integration = { status: "merged", verifiedAt: 4_000 };
    const pipeline = reviewPipeline(value);
    assert.equal(pipeline.headline, headline, status);
    if (status === "merging") assert.equal(pipeline.stages.find((item) => item.id === "merge")?.tone, tone);
    if (status === "post_merge_ci" || status === "merged") assert.equal(pipeline.stages.find((item) => item.id === "verification")?.tone, tone);
  }
});

test("interrupted judge infrastructure evidence is surfaced without inventing a verdict", () => {
  const value = job("blocked");
  value.review!.transitions = [{ status: "judging", at: 3_000 }, { status: "blocked", at: 4_000 }];
  value.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "infra", actions: [{ id: "infra", failureClass: "infrastructure", fingerprint: "f", state: "pending", attempt: 1, maxAttempts: 2, createdAt: 4_000, updatedAt: 4_000, evidence: { detail: "Judge process interrupted" } }] };
  assert.match(stage(value, "judge").summary, /judge interrupted.*coordinator recovery/i);
  assert.doesNotMatch(stage(value, "judge").summary, /Judge process interrupted/);
  assert.equal(stage(value, "judge").tone, "blocked");
  assert.doesNotMatch(stage(value, "judge").summary, /has not started/);
});

test("repair claims remain inactive until the worker is genuinely running", () => {
  const conflict = (state: "pending" | "repairing", top: AgentJob["status"] = "completed") => {
    const value = job("conflict", top); value.integration = { status: "conflicted" }; value.review!.error = "Worker rebase onto main conflicts";
    value.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "conflict", actions: [{ id: "conflict", failureClass: "conflict", fingerprint: "f", state, attempt: 1, maxAttempts: 2, createdAt: 3_000, updatedAt: 4_000, evidence: { detail: "rebase conflict" } }] };
    return value;
  };
  assert.match(reviewPipeline(conflict("pending")).guidance, /awaiting coordinator action/i);
  assert.doesNotMatch(reviewPipeline(conflict("pending")).guidance, /worker is resolving/i);
  const claimedConflict = reviewPipeline(conflict("repairing"));
  assert.match(claimedConflict.guidance, /repair is claimed.*awaiting worker resume/i);
  assert.doesNotMatch(claimedConflict.guidance, /worker is resolving/i);
  assert.equal(claimedConflict.active, false);
  assert.equal(claimedConflict.stages.some((item) => item.tone === "active"), false);
  const runningConflict = reviewPipeline(conflict("repairing", "running"));
  assert.match(runningConflict.guidance, /worker is resolving.*same worktree/i);
  assert.equal(runningConflict.active, true);

  const source = job("feedback_sent");
  source.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "source", actions: [{ id: "source", failureClass: "worker_ci", fingerprint: "f", state: "repairing", attempt: 1, maxAttempts: 2, createdAt: 3_000, updatedAt: 4_000, evidence: { detail: "exact command and path" } }] };
  assert.equal(reviewPipeline(source).active, false);
  assert.equal(reviewPipeline(source).stages.some((item) => item.tone === "active"), false);
  source.status = "interrupted";
  assert.equal(reviewPipeline(source).active, false);
  assert.match(reviewPipeline(source).guidance, /repair is claimed.*worker is interrupted/i);
  source.status = "running";
  assert.equal(reviewPipeline(source).active, true);
  assert.match(reviewPipeline(source).guidance, /Worker is repairing feedback/);
});

test("target advancement and a fresh handoff invalidate an older prepared base", () => {
  const advanced = job("handoff_received"); advanced.review!.reviewBaseRef = "old-main"; advanced.review!.judgeHandoffRound = 1;
  advanced.handoff!.round = 2; advanced.review!.transitions = [{ status: "handoff_received", at: 4_000, detail: "Main advanced to new-main; prior approval invalidated" }];
  assert.equal(stage(advanced, "preparation").tone, "waiting");
  assert.match(stage(advanced, "preparation").summary, /fresh approval required/i);
  assert.match(reviewPipeline(advanced).guidance, /rebase and preparation plus fresh approval/i);
});

test("fresh active rounds label retained checks and verdicts as historical", () => {
  const ci = job("ci_running"); ci.handoff!.round = 2; ci.review!.reviewBaseRef = "round-1-base"; ci.review!.preparedHandoffRound = 1; ci.review!.ciHandoffRound = 1; ci.review!.ci = [{ command: "npm run test", purpose: "product_ci", handoffRound: 1, ok: false, exitCode: 1, durationMs: 20, output: "old" }];
  assert.equal(stage(ci, "preparation").tone, "active");
  assert.equal(stage(ci, "ci").tone, "waiting");
  assert.match(stage(ci, "ci").summary, /^Historical prior-round evidence/);
  assert.equal(stage(ci, "ci").durationMs, undefined);
  const judging = job("judging"); judging.review!.judge = verdict("Old rejection");
  assert.match(stage(judging, "judge").summary, /Latest prior-round verdict.*rejected.*Old rejection/i);
  assert.equal(stage(judging, "judge").tone, "active");
});

test("offline judging, pre-merge verification evidence, and needs-attention reasons remain truthful", () => {
  const offline = job("judging");
  assert.match(reviewPipeline(offline, false).guidance, /live activity is not confirmed/i);
  assert.match(reviewPipeline(offline, false).stages.find((item) => item.id === "judge")!.summary, /judging recorded.*unsynchronized/i);
  assert.doesNotMatch(reviewPipeline(offline, false).stages.find((item) => item.id === "judge")!.summary, /has not started/i);

  const verifying = job("post_merge_ci");
  verifying.review!.postMergeCi = [{ command: "npm test", ok: true, exitCode: 0, durationMs: 20, output: "passed" }];
  assert.equal(stage(verifying, "verification").tone, "complete");
  assert.match(reviewPipeline(verifying).guidance, /completed.*awaiting verified terminal/i);
  verifying.review!.postMergeCi = [{ command: "npm test", ok: false, exitCode: 1, durationMs: 20, output: "failed" }];
  assert.equal(stage(verifying, "verification").tone, "failed");
  assert.match(reviewPipeline(verifying).guidance, /completed with failures/i);

  const attention = job("blocked", "needs_attention");
  attention.recoveryIssue = "Checkout identity changed\nexact diagnostic";
  attention.review!.remediation = { maxAttempts: 1, rounds: {}, currentActionId: "exhausted", actions: [{ id: "exhausted", failureClass: "infrastructure", fingerprint: "f", state: "exhausted", attempt: 1, maxAttempts: 1, createdAt: 3, updatedAt: 4, evidence: { detail: "Judge backend unavailable" } }] };
  assert.match(reviewPipeline(attention).guidance, /Review infrastructure requires coordinator attention/i);
  assert.doesNotMatch(reviewPipeline(attention).guidance, /Judge backend unavailable|Checkout identity changed/);
});

test("durable infrastructure retry target overrides retained completed evidence", () => {
  const retry = (target: "review" | "post_merge") => {
    const value = job("ci_running"); value.review!.reviewBaseRef = "prepared"; value.review!.preparedHandoffRound = 1; value.review!.ciHandoffRound = 1;
    value.review!.ci = [{ command: "npm test", purpose: "product_ci", handoffRound: 1, ok: true, exitCode: 0, durationMs: 20, output: "prior" }];
    value.review!.activeRetry = { target, startedAt: 5_000 };
    value.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "infra", actions: [{ id: "infra", failureClass: "infrastructure", fingerprint: "f", state: "repairing", attempt: 1, maxAttempts: 2, createdAt: 4_000, updatedAt: 5_000, evidence: { detail: "runner interrupted", ...(target === "post_merge" ? { mergeCommit: "merged" } : {}) } }] };
    return value;
  };
  const judgeRetry = retry("review");
  assert.equal(stage(judgeRetry, "preparation").tone, "active");
  assert.equal(stage(judgeRetry, "ci").tone, "waiting");
  assert.match(stage(judgeRetry, "ci").summary, /Historical prior-round evidence/);
  assert.match(stage(judgeRetry, "judge").summary, /queued behind retry prerequisite checks/);
  assert.match(reviewPipeline(judgeRetry).guidance, /retrying review prerequisites/);
  judgeRetry.review!.remediation!.actions[0]!.failureClass = "candidate_ci";
  assert.equal(stage(judgeRetry, "preparation").tone, "active", "candidate transient retry uses durable retry target");

  const postRetry = retry("post_merge");
  postRetry.review!.postMergeCi = [{ command: "npm test", ok: false, exitCode: null, durationMs: 20, output: "prior interruption" }];
  assert.equal(stage(postRetry, "verification").tone, "active");
  assert.equal(reviewPipeline(postRetry).stages.filter((item) => item.tone === "active").map((item) => item.id).join(","), "verification");
  assert.match(reviewPipeline(postRetry).guidance, /retrying post-merge verification/);
});

test("generic blocked and failed states surface concise human-readable reasons", () => {
  for (const status of ["blocked", "failed"] as const) {
    const value = job(status); value.integration = { status: "conflicted" }; value.review!.error = "Target branch moved while checks ran\nopaque diagnostics";
    assert.match(reviewPipeline(value).guidance, /Coordinator action.*exact diagnostics/i);
    assert.doesNotMatch(reviewPipeline(value).guidance, /Target branch moved|opaque diagnostics/);
  }
});

test("terminal disposition suppresses stale post-merge repair metadata without mutating audit history", () => {
  for (const integration of ["merged", "superseded"] as const) {
    const value = job("ci_running", "needs_attention");
    value.integration = { status: integration, ...(integration === "merged" ? { verifiedAt: 8_000 } : { disposition: "superseded" as const }) };
    value.review!.activeRetry = { target: "post_merge", startedAt: 7_000 };
    value.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "stale-post", actions: [{ id: "stale-post", failureClass: "post_merge_ci", fingerprint: "f", state: "repairing", attempt: 1, maxAttempts: 2, createdAt: 6_000, updatedAt: 7_000, evidence: { detail: "exact stale diagnostics", mergeCommit: "merged-head" } }] };
    const pipeline = reviewPipeline(value);
    assert.equal(pipeline.headline, "Verified outcome");
    assert.match(pipeline.guidance, integration === "merged" ? /complete and verified/ : /durably marked as superseded/);
    assert.equal(pipeline.active, false);
    assert.equal(pipeline.stages.some((item) => item.tone === "active" || item.tone === "blocked"), false);
    assert.match(stage(value, "repair").summary, /No active repair.*terminal disposition/i);
    assert.doesNotMatch(pipeline.stages.map((item) => item.summary).join(" "), /stale-post|post_merge_ci.*repairing|exact stale diagnostics/);
    assert.equal(value.review!.remediation!.actions[0]!.state, "repairing", "presentation never mutates stale audit evidence");
  }
});

test("top-level authority and reconnect suppress stale active phases while recovered work wins", () => {
  const interrupted = job("judging", "interrupted");
  assert.equal(reviewPipeline(interrupted).active, false);
  assert.equal(reviewPipeline(interrupted).stages.some((item) => item.tone === "active"), false);
  const recovered = job("blocked", "running");
  assert.equal(reviewPipeline(recovered).headline, "Repairing now");
  assert.equal(reviewPipeline(recovered, false).headline, "Action required");
  assert.equal(reviewPipeline(job("judging"), false).stages.some((item) => item.tone === "active"), false);
});
