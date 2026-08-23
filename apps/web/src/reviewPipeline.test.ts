import assert from "node:assert/strict";
import test from "node:test";
import type { AgentJob, ReviewStatus } from "@neocode/protocol";
import { reviewPipeline } from "./reviewPipeline";

function job(status?: ReviewStatus, top: AgentJob["status"] = "completed"): AgentJob {
  return {
    id: "worker", title: "Worker", prompt: "", status: top, branch: "worker", worktree: "/tmp/worker",
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/worker" }, baseRef: "base",
    createdAt: 1, updatedAt: 2, messages: [], integration: { status: "reviewing" },
    handoff: { report: "done", requirements: [], diffSha256: "hash", branch: "worker", worktree: "/tmp/worker", tests: [], risks: [], round: 1, createdAt: 2 },
    review: status ? { hookToken: "hook", status, attempt: 1, targetBranch: "main", updatedAt: 3, transitions: [{ status, at: 3 }] } : undefined,
  };
}

test("ready for review is explicitly distinct from active coordinator review", () => {
  const ready = reviewPipeline(job("handoff_received"));
  assert.equal(ready.headline, "Ready for review");
  assert.match(ready.guidance, /no review is currently running/i);
  assert.equal(ready.active, false);

  for (const [status, expected] of [["ci_running", "Product CI"], ["judging", "Independent judge"]] as const) {
    const pipeline = reviewPipeline(job(status));
    assert.equal(pipeline.headline, "Reviewing now");
    assert.equal(pipeline.active, true);
    assert.equal(pipeline.stages.find((stage) => stage.tone === "active")?.label, expected);
  }
});

test("pipeline covers CI failure, judge rejection, repair, authorization, conflict, integration, and verification", () => {
  const ci = job("ci_failed");
  ci.review!.ci = [{ command: "npm test", ok: false, exitCode: 1, durationMs: 4, output: "failed" }];
  assert.match(reviewPipeline(ci).guidance, /CI failed; repair is required/i);
  assert.equal(reviewPipeline(ci).stages.find((stage) => stage.id === "ci")?.tone, "failed");

  const rejected = job("rejected");
  rejected.review!.judge = { approved: false, summary: "Missing behavior", requirements: [], model: { provider: "pi", id: "judge" }, diffSha256: "hash", raw: "{}" };
  assert.match(reviewPipeline(rejected).guidance, /feedback repair/i);
  assert.match(reviewPipeline(rejected).stages.find((stage) => stage.id === "judge")!.summary, /Missing behavior/);

  const repairing = job("worker_resumed", "running");
  repairing.review!.remediation = { maxAttempts: 3, rounds: {}, currentActionId: "opaque", actions: [{ id: "opaque", failureClass: "judge_changes", fingerprint: "f", state: "repairing", attempt: 1, maxAttempts: 3, createdAt: 3, updatedAt: 4, evidence: { detail: "fix it" } }] };
  assert.equal(reviewPipeline(repairing).headline, "Repairing now");
  assert.match(reviewPipeline(repairing).guidance, /same worktree/);

  assert.match(reviewPipeline(job("approved")).guidance, /explicit coordinator authorization/);
  const conflict = job("conflict"); conflict.integration = { status: "conflicted" };
  assert.match(reviewPipeline(conflict).guidance, /rebase conflict/);
  assert.equal(reviewPipeline(job("post_merge_ci")).headline, "Integrating now");

  const merged = job("merged"); merged.integration = { status: "merged", verifiedAt: 5 };
  assert.equal(reviewPipeline(merged).headline, "Verified outcome");
  assert.equal(reviewPipeline(merged).stages.at(-1)?.tone, "complete");
});

test("top-level and terminal authority suppress stale active phases while recovered running work wins settled review", () => {
  const interrupted = job("judging", "interrupted");
  assert.equal(reviewPipeline(interrupted).headline, "Review blocked");
  assert.equal(reviewPipeline(interrupted).active, false);
  assert.equal(reviewPipeline(interrupted).stages.some((stage) => stage.tone === "active"), false);

  const merged = job("judging"); merged.integration = { status: "merged", verifiedAt: 4 };
  assert.equal(reviewPipeline(merged).headline, "Verified outcome");
  assert.equal(reviewPipeline(merged).active, false);

  const recovered = job("blocked", "running");
  assert.equal(reviewPipeline(recovered).headline, "Repairing now");
  assert.equal(reviewPipeline(recovered).active, true);
  assert.equal(reviewPipeline(recovered, false).headline, "Action required");
});

test("active markers require fresh activity authority", () => {
  assert.equal(reviewPipeline(job("judging"), false).active, false);
  assert.equal(reviewPipeline(job("judging"), false).stages.some((stage) => stage.tone === "active"), false);
  assert.equal(reviewPipeline(job("judging"), true).stages.find((stage) => stage.id === "judge")?.tone, "active");
});
