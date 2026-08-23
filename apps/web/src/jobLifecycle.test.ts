import assert from "node:assert/strict";
import test from "node:test";
import type { AgentJob, JobTerminalDisposition } from "@neocode/protocol";
import { isDoneJob, jobLifecycleLabel, splitJobs } from "./jobLifecycle";

function job(status: AgentJob["status"], integration?: AgentJob["integration"], terminalDisposition?: JobTerminalDisposition): AgentJob {
  return {
    id: `${status}-${terminalDisposition?.kind || integration?.status || "plain"}`, title: status, prompt: "", status,
    branch: "branch", worktree: "/worktree", isolation: { requested: "worktree", mode: "worktree", path: "/worktree" },
    baseRef: "base", createdAt: 1, updatedAt: 1, messages: [], integration, terminalDisposition,
  };
}
const disposition = (kind: JobTerminalDisposition["kind"], supersededBy?: string): JobTerminalDisposition => ({
  kind, recordedAt: 2, evidence: { method: kind === "superseded" ? "migration-manifest" : kind === "merged_verified" ? "commit-ancestry" : kind === "cancelled" ? "explicit-cancellation" : kind === "archived" ? "manual-archive" : "process-failure", detail: "proof" }, supersededBy,
});

test("filters and counts expose only non-terminal workers as actionable", () => {
  const jobs = [
    job("running"), job("completed", { status: "unmerged" }), job("completed", { status: "reviewing" }),
    job("needs_attention", { status: "conflicted" }), job("completed", { status: "merged" }),
    job("completed", { status: "merged" }, disposition("merged_verified")),
    job("interrupted", undefined, disposition("superseded", "replacement")),
    job("cancelled", undefined, disposition("cancelled")), job("failed", undefined, disposition("failed_terminal")),
  ];
  const split = splitJobs(jobs);
  assert.equal(split.actionable.length, 5);
  assert.equal(split.done.length, 4);
  assert.equal(isDoneJob(job("completed", { status: "merged" })), false, "legacy merged labels are not sufficient evidence");
});

test("labels distinguish unverified completion, terminal outcomes, and cleaned history", () => {
  assert.equal(jobLifecycleLabel(job("completed", { status: "unmerged" })), "Completed · unmerged");
  assert.equal(jobLifecycleLabel(job("completed", { status: "merged" })), "Merged · verification pending");
  assert.equal(jobLifecycleLabel(job("interrupted", undefined, disposition("superseded", "new-job"))), "Superseded by new-job");
  const merged = job("completed", { status: "merged" }, disposition("merged_verified"));
  assert.equal(jobLifecycleLabel(merged), "Merged · verified");
  merged.cleanup = { status: "removed", checkedAt: 3, removedAt: 4, evidence: { checkedAt: 3, targetRef: "main", targetHead: "target", completionHead: "source", intendedCommits: ["source"], mergeMethod: "commit-ancestry", cleanPorcelain: true, registeredPath: "/worktree", registeredBranch: "branch" } };
  assert.equal(jobLifecycleLabel(merged), "Merged · verified · cleaned");
});
