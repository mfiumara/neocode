import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentJob, CheckEvidence, JudgeEvidence } from "@neocode/protocol";
import {
  CompletionPipeline,
  LocalReviewAdapter,
  type ReconcileResult,
  type ReviewAdapter,
} from "./completion-pipeline.js";

const execFileAsync = promisify(execFile);
const pass: CheckEvidence = { command: "test", ok: true, exitCode: 0, durationMs: 1, output: "ok" };

function job(id = "job-1"): AgentJob {
  return {
    id, title: `job ${id}`, prompt: "implement and test it", status: "completed",
    branch: `neocode/${id}`, worktree: `/tmp/${id}`,
    isolation: { requested: "worktree", mode: "worktree", path: `/tmp/${id}` },
    baseRef: "base", createdAt: 1, updatedAt: 1, messages: [], diff: `diff-${id}`,
  };
}

function verdict(diffSha256: string): JudgeEvidence {
  return {
    approved: true, summary: "all requirements proven",
    requirements: [{ requirement: "implementation", satisfied: true, evidence: "diff and CI" }],
    model: { provider: "test", id: "fresh" }, diffSha256, raw: "{}",
  };
}

class FakeAdapter implements ReviewAdapter {
  ciCalls = 0;
  judgeCalls = 0;
  reconcileCalls = 0;
  postCalls = 0;
  concurrentMerges = 0;
  maxConcurrentMerges = 0;
  mergeGate?: Promise<void>;

  async runCi(cwd: string): Promise<CheckEvidence[]> {
    if (cwd === "/root") this.postCalls += 1;
    else this.ciCalls += 1;
    return [pass];
  }
  async readDiff(value: AgentJob): Promise<string> { return value.diff || ""; }
  async judge(_job: AgentJob, _diff: string, hash: string): Promise<JudgeEvidence> {
    this.judgeCalls += 1;
    return verdict(hash);
  }
  async reconcile(value: AgentJob): Promise<ReconcileResult> {
    this.reconcileCalls += 1;
    this.concurrentMerges += 1;
    this.maxConcurrentMerges = Math.max(this.maxConcurrentMerges, this.concurrentMerges);
    await this.mergeGate;
    this.concurrentMerges -= 1;
    return { commit: `commit-${value.id}` };
  }
}

test("successful completion fires one automatic review and persists every transition", async () => {
  const adapter = new FakeAdapter();
  const value = job();
  const snapshots: string[] = [];
  const pipeline = new CompletionPipeline(adapter, (updated) => {
    snapshots.push(structuredClone(updated.review!).status);
  }, "main", "/root");

  assert.equal(pipeline.enqueue(value), true);
  assert.equal(pipeline.enqueue(value), false, "duplicate terminal events must not fire another hook");
  await pipeline.idle();

  assert.equal(adapter.ciCalls, 1);
  assert.equal(adapter.judgeCalls, 1);
  assert.equal(adapter.reconcileCalls, 1);
  assert.equal(adapter.postCalls, 1);
  assert.equal(value.review?.status, "merged");
  assert.ok(value.review?.hookToken);
  assert.deepEqual(value.review?.transitions.map((entry) => entry.status), [
    "queued", "ci_running", "judging", "approved", "merge_queued", "merging", "post_merge_ci", "merged",
  ]);
  assert.deepEqual(snapshots, [
    "queued", "ci_running", "ci_running", "judging", "judging", "approved", "merge_queued", "merging", "post_merge_ci", "post_merge_ci", "merged",
  ]);
});

test("integration is serialized across concurrently completed workers", async () => {
  const adapter = new FakeAdapter();
  let release!: () => void;
  adapter.mergeGate = new Promise<void>((resolve) => { release = resolve; });
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  const first = job("first");
  const second = job("second");

  pipeline.enqueue(first);
  pipeline.enqueue(second);
  while (adapter.reconcileCalls < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(adapter.reconcileCalls, 1, "second integration must wait on the lock");
  release();
  await pipeline.idle();
  assert.equal(adapter.reconcileCalls, 2);
  assert.equal(adapter.maxConcurrentMerges, 1);
});

test("restart recovery resumes durable review states without replacing the hook token", async () => {
  const adapter = new FakeAdapter();
  const value = job();
  const hash = createHash("sha256").update(value.diff!).digest("hex");
  value.review = {
    hookToken: "stable-token", status: "judging", attempt: 1, targetBranch: "main", updatedAt: 2,
    transitions: [{ status: "queued", at: 1 }, { status: "judging", at: 2 }],
  };
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.recover([value]);
  await pipeline.idle();
  assert.equal(value.review.hookToken, "stable-token");
  assert.equal(value.review.status, "merged");
  assert.equal(adapter.judgeCalls, 1);
  assert.equal(value.review.judge?.diffSha256, hash);
});

test("changed diff after approval blocks integration", async () => {
  const adapter = new FakeAdapter();
  let reads = 0;
  adapter.readDiff = async () => ++reads === 1 ? "reviewed" : "changed";
  const value = job();
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value);
  await pipeline.idle();
  assert.equal(value.review?.status, "blocked");
  assert.match(value.review?.error || "", /changed after independent review/);
  assert.equal(adapter.reconcileCalls, 0);
});

test("local reconciliation includes untracked work before checking already-merged ancestry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neocode-pipeline-"));
  const root = join(directory, "root");
  const worker = join(directory, "worker");
  try {
    await execFileAsync("git", ["init", "-b", "main", root]);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
    const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["worktree", "add", "-b", "neocode/test", worker, base], { cwd: root });
    await writeFile(join(worker, "new-file.txt"), "new content\n");

    const adapter = new LocalReviewAdapter(root, {
      targetBranch: "main",
      command: "true",
      judge: async (_job, _diff, hash) => verdict(hash),
    });
    const value = job("local");
    value.branch = "neocode/test";
    value.baseRef = base;
    value.isolation.path = worker;
    value.worktree = worker;
    const diff = await adapter.readDiff(value);
    assert.match(diff, /new-file\.txt/);
    assert.match(diff, /new content/);

    const result = await adapter.reconcile(value);
    assert.equal(result.alreadyMerged, undefined);
    assert.equal(await readFile(join(root, "new-file.txt"), "utf8"), "new content\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
