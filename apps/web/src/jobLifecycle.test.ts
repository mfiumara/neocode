import assert from "node:assert/strict";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import { isDoneJob, jobActiveState, jobLifecycleLabel } from "./jobLifecycle";

function job(status: AgentJob["status"], integration?: AgentJob["integration"]): AgentJob {
  return {
    id: status, title: status, prompt: "", status, branch: "branch", worktree: "/worktree",
    isolation: { requested: "worktree", mode: "worktree", path: "/worktree" }, baseRef: "base",
    createdAt: 1, updatedAt: 1, messages: [], integration,
  };
}

test("completed unmerged, review, conflict, and interrupted jobs remain actionable", () => {
  for (const value of [
    job("completed", { status: "unmerged" }), job("completed", { status: "reviewing" }),
    job("completed", { status: "conflicted" }), job("interrupted"),
  ]) assert.equal(isDoneJob(value), false);
  assert.equal(jobLifecycleLabel(job("completed", { status: "unmerged" })), "Completed · unmerged");
  assert.equal(jobLifecycleLabel(job("completed", { status: "conflicted" })), "Conflict · needs attention");
});

test("verified integration, supersession, and non-actionable terminal failures are Done", () => {
  assert.equal(isDoneJob(job("completed", { status: "merged" })), true);
  assert.equal(jobLifecycleLabel(job("completed", { status: "merged" })), "Integrated · verified");
  assert.equal(isDoneJob(job("completed", { status: "merged", disposition: "already_integrated" })), true);
  assert.equal(jobLifecycleLabel(job("completed", { status: "merged", disposition: "already_integrated" })), "Already integrated · verified");
  assert.equal(isDoneJob(job("completed", { status: "superseded", disposition: "superseded", dispositionReason: "replaced" })), true);
  assert.equal(jobLifecycleLabel(job("completed", { status: "superseded" })), "Not required · superseded");
  assert.equal(isDoneJob(job("failed")), true);
  assert.equal(isDoneJob(job("cancelled")), true);
});

function reviewed(status: NonNullable<AgentJob["review"]>["status"], jobStatus: AgentJob["status"] = "completed"): AgentJob {
  const value = job(jobStatus, { status: ["merge_queued", "merging", "post_merge_ci"].includes(status) ? "integrating" : "reviewing" });
  value.review = { hookToken: "hook", status, attempt: 1, targetBranch: "main", updatedAt: 2, transitions: [{ status, at: 2 }] };
  return value;
}

test("active state requires genuine worker execution and covers synchronized coordinator phases", () => {
  assert.equal(jobActiveState(reviewed("worker_resumed")), undefined, "stale resumed metadata is not live worker authority");
  assert.equal(jobActiveState(reviewed("worker_resumed"), false), undefined);
  assert.deepEqual(jobActiveState(reviewed("ci_running")), { kind: "review", label: "Preparing review" });
  const checking = reviewed("ci_running"); checking.handoff = { report: "done", requirements: [], diffSha256: "hash", branch: checking.branch, worktree: checking.worktree, tests: [], risks: [], round: 2, createdAt: 2 }; checking.review!.reviewBaseRef = "prepared"; checking.review!.preparedHandoffRound = 2;
  assert.deepEqual(jobActiveState(checking), { kind: "checks", label: "Running product checks" });
  checking.review!.ciHandoffRound = 2;
  assert.equal(jobActiveState(checking), undefined, "published current checks are no longer live");
  const judging = reviewed("judging");
  assert.deepEqual(jobActiveState(judging), { kind: "review", label: "Under review" });
  judging.handoff = checking.handoff; judging.review!.judgeHandoffRound = 2; judging.review!.judge = { approved: true, summary: "done", requirements: [], model: { provider: "test", id: "judge" }, diffSha256: "hash", raw: "{}" };
  assert.equal(jobActiveState(judging), undefined, "published current verdict is no longer live");
  assert.deepEqual(jobActiveState(reviewed("merging")), { kind: "integration", label: "Integrating" });
  const retry = reviewed("ci_running"); retry.review!.activeRetry = { target: "review", startedAt: 3 }; retry.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "retry", actions: [{ id: "retry", failureClass: "infrastructure", fingerprint: "f", state: "repairing", attempt: 1, maxAttempts: 2, createdAt: 2, updatedAt: 3, evidence: { detail: "retry" } }] };
  assert.deepEqual(jobActiveState(retry), { kind: "review", label: "Retrying review prerequisites" });
  retry.review!.activeRetry.target = "post_merge";
  assert.deepEqual(jobActiveState(retry), { kind: "checks", label: "Retrying verification" });
  assert.deepEqual(jobActiveState(job("running")), { kind: "worker", label: "Worker working" });
});

test("claimed judge and scheduled coordinator retry stay settled without false sidebar activity", () => {
  const claimed = reviewed("queued"); claimed.handoff = { report: "done", requirements: [], diffSha256: "hash", branch: claimed.branch, worktree: claimed.worktree, tests: [], risks: [], round: 3, createdAt: 2 }; claimed.review!.judgeHandoffRound = 3;
  assert.equal(jobLifecycleLabel(claimed), "Review claimed · awaiting launch");
  assert.equal(jobActiveState(claimed), undefined);
  assert.equal(jobActiveState(claimed, false), undefined);

  const scheduled = reviewed("feedback_sent"); scheduled.review!.remediation = { maxAttempts: 2, rounds: { infrastructure: { failureClass: "infrastructure", fingerprint: "f", attempts: 1, maxAttempts: 2, nextRetryAt: 10_000, updatedAt: 3 } }, currentActionId: "retry", actions: [{ id: "retry", failureClass: "infrastructure", fingerprint: "f", state: "repairing", attempt: 1, maxAttempts: 2, createdAt: 2, updatedAt: 3, evidence: { detail: "backoff" } }] };
  assert.equal(jobLifecycleLabel(scheduled), "Review retry scheduled");
  assert.equal(jobActiveState(scheduled), undefined);
  scheduled.review!.remediation.actions[0]!.evidence.mergeCommit = "merged";
  assert.equal(jobLifecycleLabel(scheduled), "Verification retry scheduled");
});

test("a recovered running worker wins over preserved settled review evidence", () => {
  const recovered = reviewed("blocked", "running");
  assert.deepEqual(jobActiveState(recovered), { kind: "worker", label: "Worker repairing" });
});

test("a recovered running worker wins over preserved conflicted integration evidence", () => {
  const recovered = reviewed("rejected", "running");
  recovered.integration = { status: "conflicted" };
  assert.deepEqual(jobActiveState(recovered), { kind: "worker", label: "Worker repairing" });

  const withoutReview = job("running", { status: "conflicted" });
  assert.deepEqual(jobActiveState(withoutReview), { kind: "worker", label: "Worker working" });
});

test("settled and disconnected lifecycle state never appears active", () => {
  for (const value of [
    reviewed("blocked"), reviewed("failed"), reviewed("approved"), reviewed("rejected"), reviewed("merge_queued"),
    reviewed("judging", "queued"), reviewed("worker_resumed", "queued"),
    reviewed("needs_attention", "needs_attention"), job("queued"), job("interrupted"), job("failed"),
  ]) assert.equal(jobActiveState(value), undefined);

  assert.equal(jobLifecycleLabel(reviewed("approved")), "Approved · awaiting merge");
  assert.equal(jobLifecycleLabel(reviewed("merge_queued")), "Approved · awaiting integration");
  assert.equal(jobActiveState(reviewed("judging"), false), undefined, "a stale snapshot is inactive during reconnect");
  assert.equal(jobActiveState(job("completed", { status: "integrating" })), undefined, "an orphaned transient integration flag is not live");
  const publishedPost = reviewed("post_merge_ci"); publishedPost.review!.postMergeCi = [{ command: "npm test", ok: true, exitCode: 0, durationMs: 1, output: "passed" }];
  assert.equal(jobActiveState(publishedPost), undefined, "published post-merge evidence settles the spinner before status advances");
  const historical = reviewed("approved");
  historical.review!.transitions.unshift({ status: "judging", at: 1 });
  assert.equal(jobActiveState(historical), undefined, "historical transient transitions are ignored");
});

test("verified and superseded terminal labels override stale remediation disposition", () => {
  for (const [integration, label] of [["merged", "Integrated · verified"], ["superseded", "Not required · superseded"]] as const) {
    const value = reviewed("ci_running", "needs_attention"); value.integration = { status: integration };
    value.review!.activeRetry = { target: "post_merge", startedAt: 3 };
    value.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "stale", actions: [{ id: "stale", failureClass: "post_merge_ci", fingerprint: "f", state: "repairing", attempt: 1, maxAttempts: 2, createdAt: 2, updatedAt: 3, evidence: { detail: "stale", mergeCommit: "merged" } }] };
    assert.equal(jobActiveState(value), undefined);
    assert.equal(jobLifecycleLabel(value), label);
    assert.equal(isDoneJob(value), true);
  }
});

test("top-level queued and terminal labels override stale transient lifecycle metadata", () => {
  for (const [value, label] of [
    [reviewed("judging", "queued"), "Queued"],
    [reviewed("worker_resumed", "queued"), "Queued"],
    [reviewed("worker_resumed", "interrupted"), "Interrupted · recoverable"],
    [reviewed("worker_resumed", "failed"), "Failed"],
    [reviewed("judging", "needs_attention"), "Needs attention"],
  ] as const) {
    assert.equal(jobActiveState(value), undefined);
    assert.equal(jobLifecycleLabel(value), label);
  }
});
