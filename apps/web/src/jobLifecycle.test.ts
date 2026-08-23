import assert from "node:assert/strict";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import { isDoneJob, jobLifecycleLabel } from "./jobLifecycle";

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

test("only verified merges and non-actionable terminal failures are Done", () => {
  assert.equal(isDoneJob(job("completed", { status: "merged" })), true);
  assert.equal(jobLifecycleLabel(job("completed", { status: "merged" })), "Merged · verified");
  assert.equal(isDoneJob(job("failed")), true);
  assert.equal(isDoneJob(job("cancelled")), true);
});
