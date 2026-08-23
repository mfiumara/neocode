import assert from "node:assert/strict";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import {
  canAutomaticallyResume,
  continuationPrompt,
  isDurableAttemptCurrent,
  openRecoverySession,
  recoveryConfig,
  retryDelay,
} from "./recovery.js";

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "job-1",
    title: "task",
    prompt: "Implement the task",
    status: "interrupted",
    branch: "neocode/task-job-1",
    worktree: "/repo/.worktrees/task-job-1",
    isolation: { requested: "auto", mode: "worktree", path: "/repo/.worktrees/task-job-1" },
    baseRef: "abc",
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { id: "u", role: "user", text: "Implement the task", timestamp: 1 },
      { id: "a", role: "assistant", text: "Parser changed; tests remain.", timestamp: 2 },
    ],
    recoverable: true,
    recovery: { retryCount: 1, maxRetries: 3, generation: 2, leaseToken: "current" },
    ...overrides,
  };
}

test("verified worktree interruption is eligible for automatic resume", () => {
  assert.equal(canAutomaticallyResume(job()), true);
});

test("session open is preferred and corrupt session falls back fresh", () => {
  const opened = openRecoverySession(true, () => "old", () => "new");
  assert.deepEqual(opened, { manager: "old", mode: "opened", reopened: true });
  const fallback = openRecoverySession(true, () => { throw new Error("corrupt"); }, () => "new");
  assert.deepEqual(fallback, { manager: "new", mode: "fresh_fallback", reopened: false });
  assert.match(continuationPrompt(job(), false), /ORIGINAL TASK:[\s\S]*Parser changed[\s\S]*git status/);
});

test("durable generation token rejects duplicate and stale worker callbacks", () => {
  const value = job();
  assert.equal(isDurableAttemptCurrent(value, 2, "current"), true);
  assert.equal(isDurableAttemptCurrent(value, 1, "current"), false);
  assert.equal(isDurableAttemptCurrent(value, 2, "other"), false);
});

test("restart backoff is configurable, exponential, capped, and bounded", () => {
  const config = recoveryConfig({
    NEOCODE_WORKER_RESTART_MAX_RETRIES: "2",
    NEOCODE_WORKER_RESTART_BACKOFF_MS: "25",
    NEOCODE_WORKER_RESTART_MAX_BACKOFF_MS: "60",
  });
  assert.deepEqual(config, { maxRetries: 2, backoffMs: 25, maxBackoffMs: 60 });
  assert.equal(retryDelay(config, 1), 25);
  assert.equal(retryDelay(config, 2), 50);
  assert.equal(retryDelay(config, 3), 60);
  assert.equal(job().recovery!.retryCount >= job().recovery!.maxRetries, false);
  const exhausted = job({ recovery: { retryCount: 3, maxRetries: 3, generation: 4 } });
  assert.equal(exhausted.recovery!.retryCount >= exhausted.recovery!.maxRetries, true);
});

test("root automatic recovery permits only clearly read-only auto isolation", () => {
  assert.equal(canAutomaticallyResume(job({
    isolation: { requested: "auto", mode: "root", path: "/repo" }, worktree: "/repo", branch: "main",
  })), true);
  assert.equal(canAutomaticallyResume(job({
    isolation: { requested: "root", mode: "root", path: "/repo" }, worktree: "/repo", branch: "main",
  })), false);
});

test("cancelled, failed, completed and review handoff jobs never auto-resume", () => {
  for (const status of ["cancelled", "failed", "completed"] as const) {
    assert.equal(canAutomaticallyResume(job({ status })), false, status);
  }
  assert.equal(canAutomaticallyResume(job({
    status: "completed",
    review: { hookToken: "one-hook", status: "judging", attempt: 1, targetBranch: "main", updatedAt: 3, transitions: [] },
  })), false);
});

test("missing, corrupt, or branch-mismatched worktrees need attention", () => {
  assert.equal(canAutomaticallyResume(job({ recoverable: false, recoveryIssue: "missing" })), false);
  assert.equal(canAutomaticallyResume(job({ recoverable: true, recoveryIssue: "wrong branch" })), false);
  assert.equal(canAutomaticallyResume(job({ status: "needs_attention", recoverable: true })), false);
});
