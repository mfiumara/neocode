import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentJob, CheckEvidence, JudgeEvidence } from "@neocode/protocol";
import {
  CompletionPipeline,
  LocalReviewAdapter,
  PipelineError,
  runBounded,
  type ReconcileResult,
  type ReviewAdapter,
} from "./completion-pipeline.js";

function job(id: string): AgentJob {
  return {
    id, title: `task ${id}`, prompt: "Implement requirement A and test it", status: "completed",
    branch: `worker-${id}`, worktree: `/worker/${id}`,
    isolation: { requested: "worktree", mode: "worktree", path: `/worker/${id}` },
    baseRef: "base", createdAt: 1, updatedAt: 2, messages: [], diff: `+ change ${id}`,
  };
}
function check(ok = true): CheckEvidence {
  return { command: "npm test", ok, exitCode: ok ? 0 : 1, durationMs: 2, output: ok ? "ok" : "failed" };
}
function verdict(hash: string, approved = true): JudgeEvidence {
  return {
    approved, summary: approved ? "requirements met" : "missing coverage",
    requirements: [{ requirement: "requirement A", satisfied: approved, evidence: approved ? "diff and tests" : "not present" }],
    model: { provider: "test", id: "judge" }, diffSha256: hash, raw: "{}",
  };
}
class Adapter implements ReviewAdapter {
  ciOk = true;
  approved = true;
  judgeCalls = 0;
  reconcileCalls = 0;
  activeMerges = 0;
  maxActiveMerges = 0;
  error?: PipelineError;
  async runCi(): Promise<CheckEvidence[]> { return [check(this.ciOk)]; }
  async judge(_job: AgentJob, _diff: string, hash: string): Promise<JudgeEvidence> {
    this.judgeCalls += 1;
    return verdict(hash, this.approved);
  }
  async reconcile(current: AgentJob): Promise<ReconcileResult> {
    this.reconcileCalls += 1;
    this.activeMerges += 1;
    this.maxActiveMerges = Math.max(this.maxActiveMerges, this.activeMerges);
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.activeMerges -= 1;
    if (this.error) throw this.error;
    return { commit: `merge-${current.id}` };
  }
}

test("successful worker terminal event fires the hook exactly once and broadcasts every transition", async () => {
  const adapter = new Adapter();
  const current = job("one");
  const broadcasts: string[] = [];
  const pipeline = new CompletionPipeline(adapter, (updated) => broadcasts.push(updated.review!.status), "main", "/root");
  assert.equal(pipeline.enqueue(current), true);
  assert.equal(pipeline.enqueue(current), false);
  await pipeline.idle();
  assert.equal(current.review?.status, "merged");
  assert.equal(adapter.judgeCalls, 1);
  assert.equal(adapter.reconcileCalls, 1);
  assert.deepEqual(broadcasts, ["queued", "ci_running", "ci_running", "judging", "judging", "approved", "merge_queued", "merging", "post_merge_ci", "post_merge_ci", "merged"]);
  assert.equal(current.review?.mergeCommit, "merge-one");
});

test("CI failure stops before judge and reconciliation", async () => {
  const adapter = new Adapter(); adapter.ciOk = false;
  const current = job("ci-fail");
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(current); await pipeline.idle();
  assert.equal(current.review?.status, "ci_failed");
  assert.equal(adapter.judgeCalls, 0);
  assert.equal(adapter.reconcileCalls, 0);
  assert.equal(current.review?.ci?.[0]?.ok, false);
});

test("post-reconciliation CI failure is exposed with merge evidence", async () => {
  const adapter = new Adapter();
  let calls = 0;
  adapter.runCi = async () => [check(++calls === 1)];
  const current = job("post-fail");
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(current); await pipeline.idle();
  assert.equal(current.review?.status, "post_ci_failed");
  assert.equal(current.review?.mergeCommit, "merge-post-fail");
  assert.equal(current.review?.postMergeCi?.[0]?.ok, false);
});

test("structured judge rejection cannot merge", async () => {  const adapter = new Adapter(); adapter.approved = false;
  const current = job("reject");
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(current); await pipeline.idle();
  assert.equal(current.review?.status, "rejected");
  assert.equal(adapter.reconcileCalls, 0);
  assert.throws(() => pipeline.requestMerge(current), /approval is required/);
});

test("judge verdict must be tied to the exact diff hash", async () => {
  const adapter = new Adapter();
  adapter.judge = async () => verdict("wrong-hash", true);
  const current = job("wrong-hash");
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(current); await pipeline.idle();
  assert.equal(current.review?.status, "failed");
  assert.equal(adapter.reconcileCalls, 0);
  assert.match(current.review?.error || "", /not tied/);
});

test("dirty-root block and merge conflict are durable, retryable states", async (t) => {  for (const [code, expected] of [["blocked", "blocked"], ["conflict", "conflict"]] as const) {
    await t.test(code, async () => {
      const adapter = new Adapter();
      adapter.error = new PipelineError(code, code === "blocked" ? "Root checkout is dirty" : "Merge conflict");
      const current = job(code);
      const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
      pipeline.enqueue(current); await pipeline.idle();
      assert.equal(current.review?.status, expected);
      assert.match(current.review?.error || "", code === "blocked" ? /dirty/ : /conflict/i);
      assert.equal(current.review?.judge?.approved, true);
    });
  }
});

test("reconciliations are serialized across independently reviewed jobs", async () => {
  const adapter = new Adapter();
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  const first = job("first"); const second = job("second");
  pipeline.enqueue(first); pipeline.enqueue(second);
  await pipeline.idle();
  assert.equal(first.review?.status, "merged");
  assert.equal(second.review?.status, "merged");
  assert.equal(adapter.maxActiveMerges, 1);
});

test("restart recovery resumes transient state idempotently and leaves merged jobs alone", async () => {
  const adapter = new Adapter();
  const interrupted = job("restart");
  interrupted.review = {
    hookToken: "stable-token", status: "judging", attempt: 1, targetBranch: "main", updatedAt: 3,
    transitions: [{ status: "queued", at: 2 }, { status: "judging", at: 3 }],
  };
  const merged = job("done");
  merged.review = {
    hookToken: "done-token", status: "merged", attempt: 1, targetBranch: "main", updatedAt: 3,
    transitions: [{ status: "merged", at: 3 }], mergeCommit: "existing",
  };
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.recover([interrupted, merged]);
  pipeline.recover([interrupted, merged]);
  await pipeline.idle();
  assert.equal(interrupted.review.status, "merged");
  assert.equal(interrupted.review.hookToken, "stable-token");
  assert.equal(merged.review.mergeCommit, "existing");
  assert.equal(adapter.judgeCalls, 1);
  assert.equal(adapter.reconcileCalls, 1);
});

test("CI command execution bounds output and wall time", async () => {
  const output = await runBounded("printf 'abcdefghijklmnopqrstuvwxyz'", process.cwd(), 5_000, 10);
  assert.equal(output.ok, true); assert.equal(output.truncated, true); assert.ok(Buffer.byteLength(output.output) <= 10);
  const timeout = await runBounded("sleep 10", process.cwd(), 20, 1024);
  assert.equal(timeout.ok, false); assert.equal(timeout.timedOut, true); assert.ok(timeout.durationMs < 3_000);
});

test("LocalReviewAdapter commits approved uncommitted worker changes before merging", async () => {  const root = await mkdtemp(join(tmpdir(), "neocode-merge-root-"));
  const worker = `${root}-worker`;
  const run = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile("git", args, { cwd }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
  try {
    await run(root, ["init", "-b", "main"]); await run(root, ["config", "user.email", "test@example.com"]); await run(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "file.txt"), "base\n", "utf8"); await run(root, ["add", "."]); await run(root, ["commit", "-m", "base"]);
    const base = (await run(root, ["rev-parse", "HEAD"])).trim();
    await run(root, ["worktree", "add", "-b", "worker-merge", worker, base]);
    await writeFile(join(worker, "file.txt"), "approved worker change\n", "utf8");
    const diff = await run(worker, ["diff", "--no-ext-diff", base]);
    const current = job("real-merge");
    current.baseRef = base; current.branch = "worker-merge"; current.isolation.path = worker; current.worktree = worker; current.diff = diff;
    current.review = {
      hookToken: "hook", status: "approved", attempt: 1, targetBranch: "main", updatedAt: 1, transitions: [],
      judge: verdict(createHash("sha256").update(diff).digest("hex")),
    };
    const adapter = new LocalReviewAdapter(root, { judge: async (_job, _diff, hash) => verdict(hash) });
    const result = await adapter.reconcile(current);
    assert.equal(result.alreadyMerged, undefined);
    assert.equal(await readFile(join(root, "file.txt"), "utf8"), "approved worker change\n");
    assert.equal((await run(root, ["status", "--porcelain"])).trim(), "");
  } finally {
    await run(root, ["worktree", "remove", "--force", worker]).catch(() => undefined);
    await rm(root, { recursive: true, force: true }); await rm(worker, { recursive: true, force: true });
  }
});

test("LocalReviewAdapter aborts a real conflict and restores a clean root", async () => {  const root = await mkdtemp(join(tmpdir(), "neocode-conflict-root-"));
  const worker = `${root}-worker`;
  const run = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile("git", args, { cwd }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
  try {
    await run(root, ["init", "-b", "main"]);
    await run(root, ["config", "user.email", "test@example.com"]); await run(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "file.txt"), "base\n", "utf8"); await run(root, ["add", "."]); await run(root, ["commit", "-m", "base"]);
    const base = (await run(root, ["rev-parse", "HEAD"])).trim();
    await run(root, ["worktree", "add", "-b", "worker-conflict", worker, base]);
    await writeFile(join(worker, "file.txt"), "worker\n", "utf8"); await run(worker, ["add", "."]); await run(worker, ["commit", "-m", "worker"]);
    await writeFile(join(root, "file.txt"), "main\n", "utf8"); await run(root, ["add", "."]); await run(root, ["commit", "-m", "main"]);
    const diff = await run(worker, ["diff", "--no-ext-diff", base]);
    const current = job("real-conflict");
    current.baseRef = base; current.branch = "worker-conflict"; current.isolation.path = worker; current.worktree = worker; current.diff = diff;
    current.review = {
      hookToken: "hook", status: "approved", attempt: 1, targetBranch: "main", updatedAt: 1, transitions: [],
      judge: verdict(createHash("sha256").update(diff).digest("hex")),
    };
    const adapter = new LocalReviewAdapter(root, { judge: async (_job, _diff, hash) => verdict(hash) });
    await assert.rejects(() => adapter.reconcile(current), (error: unknown) => error instanceof PipelineError && error.code === "conflict");
    assert.equal((await run(root, ["status", "--porcelain"])).trim(), "");
    assert.equal(await readFile(join(root, "file.txt"), "utf8"), "main\n");
  } finally {
    await run(root, ["worktree", "remove", "--force", worker]).catch(() => undefined);
    await rm(root, { recursive: true, force: true }); await rm(worker, { recursive: true, force: true });
  }
});

test("LocalReviewAdapter refuses a dirty target checkout without mutation", async () => {  const root = await mkdtemp(join(tmpdir(), "neocode-dirty-root-"));
  try {
    const run = async (command: string) => {
      await new Promise<void>((resolve, reject) => execFile("sh", ["-lc", command], { cwd: root }, (error) => error ? reject(error) : resolve()));
    };
    await run("git init -b main && git config user.email test@example.com && git config user.name Test && touch tracked && git add tracked && git commit -m base");
    await writeFile(join(root, "dirty"), "do not overwrite", "utf8");
    const current = job("dirty-real");
    current.isolation.path = root;
    current.worktree = root;
    const adapter = new LocalReviewAdapter(root, { judge: async (_job, _diff, hash) => verdict(hash) });
    await assert.rejects(() => adapter.reconcile(current), (error: unknown) => error instanceof PipelineError && error.code === "blocked" && /dirty/.test(error.message));
    assert.equal(await readFile(join(root, "dirty"), "utf8"), "do not overwrite");
  } finally { await rm(root, { recursive: true, force: true }); }
});
