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
  PipelineError,
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

test("completion records one handoff but performs no judge or merge decision", async () => {
  const adapter = new FakeAdapter();
  const value = job();
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  assert.equal(pipeline.enqueue(value), true);
  assert.equal(pipeline.enqueue(value), false, "completion wake identity is exactly once");
  await pipeline.idle();
  assert.equal(value.review?.status, "queued");
  assert.equal(value.handoff?.round, 1);
  assert.equal(adapter.ciCalls, 0);
  assert.equal(adapter.judgeCalls, 0);
  assert.equal(adapter.reconcileCalls, 0, "worker completion cannot merge");
});

test("legacy queued reviews gain a durable exact-diff handoff before autonomous judging", async () => {
  const adapter = new FakeAdapter();
  const value = job();
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value);
  delete value.handoff;
  value.diff = "freshly-read-legacy-diff";
  assert.equal(pipeline.migrateLegacyHandoff(value), true);
  assert.equal(pipeline.migrateLegacyHandoff(value), false);
  assert.equal((value as AgentJob).handoff?.diffSha256, createHash("sha256").update(value.diff).digest("hex"));
  assert.match(value.review?.transitions.at(-1)?.detail || "", /upgraded/);
  pipeline.startJudge(value);
  await pipeline.idle();
  assert.equal(value.review?.status, "approved");
});

test("fresh judge and guarded merge require distinct coordinator actions", async () => {
  const adapter = new FakeAdapter();
  const value = job();
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value);
  assert.throws(() => pipeline.requestMerge(value), /judge approval/);
  pipeline.startJudge(value);
  await pipeline.idle();
  assert.equal(value.review?.status, "approved");
  assert.equal(adapter.reconcileCalls, 0);
  pipeline.requestMerge(value);
  await pipeline.idle();
  assert.equal(value.review?.status, "merged");
  assert.ok(value.review?.coordinatorAuthorizedAt);
  assert.equal(adapter.reconcileCalls, 1);
  assert.deepEqual(value.review?.transitions.map((entry) => entry.owner), ["worker", "coordinator", "server", "coordinator", "judge", "coordinator", "coordinator", "server", "server"]);
});

test("guarded integration remains serialized", async () => {
  const adapter = new FakeAdapter();
  let release!: () => void;
  adapter.mergeGate = new Promise<void>((resolve) => { release = resolve; });
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  const first = job("first"), second = job("second");
  pipeline.enqueue(first); pipeline.enqueue(second);
  pipeline.startJudge(first); pipeline.startJudge(second); await pipeline.idle();
  pipeline.requestMerge(first); pipeline.requestMerge(second);
  while (adapter.reconcileCalls < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(adapter.reconcileCalls, 1);
  release(); await pipeline.idle();
  assert.equal(adapter.reconcileCalls, 2); assert.equal(adapter.maxConcurrentMerges, 1);
});

test("feedback preserves worktree and creates a fresh handoff round", async () => {
  const adapter = new FakeAdapter(); const value = job();
  adapter.judge = async (_job, _diff, hash) => {
    adapter.judgeCalls += 1;
    return adapter.judgeCalls === 1
      ? { ...verdict(hash), approved: false, summary: "missing edge-case test" }
      : verdict(hash);
  };
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value); pipeline.startJudge(value); await pipeline.idle();
  pipeline.requestChanges(value, "Judge reported missing edge-case test; add test and implementation");
  pipeline.workerResumed(value);
  value.diff = "diff-round-two"; value.summary = "Tests: edge case passes";
  pipeline.nextHandoff(value);
  assert.equal(value.handoff?.round, 2);
  assert.equal(value.handoff?.worktree, "/tmp/job-1");
  assert.equal(value.review?.judge, undefined);
  pipeline.startJudge(value); await pipeline.idle();
  assert.equal(adapter.judgeCalls, 2);
});

test("rejected handoff cannot be rejudged unchanged before a claimed repair and new handoff", async () => {
  const adapter = new FakeAdapter();
  adapter.judge = async (_job, _diff, hash) => {
    adapter.judgeCalls += 1;
    return { ...verdict(hash), approved: false, summary: "mandatory finding remains" };
  };
  const value = job("rejudge-gate");
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value); pipeline.startJudge(value); await pipeline.idle();
  assert.equal(value.review?.status, "rejected");
  assert.throws(() => pipeline.startJudge(value), /Cannot judge from rejected/);
  assert.throws(() => pipeline.startJudge(value), /Cannot judge from rejected/);
  assert.equal(adapter.ciCalls, 1);
  assert.equal(adapter.judgeCalls, 1, "unchanged rejected evidence cannot trigger unlimited judges");

  pipeline.requestChanges(value, "Address mandatory finding and add its reproduction test");
  assert.throws(() => pipeline.startJudge(value), /Cannot judge from feedback_sent/);
  pipeline.workerResumed(value);
  assert.throws(() => pipeline.startJudge(value), /Cannot judge from worker_resumed/);
  value.diff = "corrected implementation";
  pipeline.nextHandoff(value);
  pipeline.startJudge(value); await pipeline.idle();
  assert.equal(adapter.judgeCalls, 2, "only the genuinely new handoff gets another judge");
});

test("CI-failed handoff cannot create unlimited unchanged action-required rounds", async () => {
  const adapter = new FakeAdapter();
  const failed: CheckEvidence = { command: "npm test", ok: false, exitCode: 1, durationMs: 1, output: "same deterministic failure" };
  adapter.runCi = async () => { adapter.ciCalls += 1; return [failed]; };
  const value = job("ci-rejudge-gate");
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value); pipeline.startJudge(value); await pipeline.idle();
  assert.equal(value.review?.status, "ci_failed");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => pipeline.startJudge(value), /Cannot judge from ci_failed/);
  }
  assert.equal(adapter.ciCalls, 1);
  assert.equal(value.review?.remediation?.actions.length, 1, "repeated start requests cannot mint unchanged failures");
  assert.equal(value.review?.remediation?.rounds.worker_ci?.attempts, 0);
});

test("a failing branch is resumed, corrected, rechecked, and freshly judged on the next round", async () => {
  const adapter = new FakeAdapter();
  const value = job("repair");
  const failed: CheckEvidence = { command: "npm test", ok: false, exitCode: 1, durationMs: 2, output: "AssertionError: expected 2" };
  adapter.runCi = async () => adapter.ciCalls++ === 0 ? [failed] : [pass];
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value);
  pipeline.startJudge(value); await pipeline.idle();
  assert.equal(value.review?.status, "ci_failed");
  assert.equal(value.review?.remediation?.actions[0]?.evidence.checks?.[0]?.output, failed.output);

  pipeline.requestChanges(value, "npm test failed with 'expected 2'; correct the assertion source and rerun that exact command");
  pipeline.workerResumed(value);
  assert.equal(value.review?.transitions.at(-1)?.status, "worker_resumed");
  assert.equal(value.review?.transitions.at(-1)?.detail?.includes(value.isolation.path), true);
  value.diff = "materially corrected diff";
  value.summary = "Tests: npm test passes";
  pipeline.nextHandoff(value);
  pipeline.startJudge(value); await pipeline.idle();
  assert.equal(value.review?.status, "approved");
  assert.equal(adapter.judgeCalls, 1, "the failed round never judges; corrected handoff gets a fresh judge");
  assert.deepEqual(value.review?.transitions.slice(-5).map((entry) => entry.status),
    ["handoff_received", "ci_running", "ci_running", "judging", "approved"]);
});

test("unchanged failures are bounded per class and preserve complete evidence", async () => {
  const adapter = new FakeAdapter();
  const value = job("bounded");
  const failed: CheckEvidence = { command: "npm test", ok: false, exitCode: 1, durationMs: 1, output: "same deterministic source failure" };
  adapter.runCi = async () => [failed];
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value);
  for (let repair = 0; repair < 3; repair += 1) {
    pipeline.startJudge(value); await pipeline.idle();
    pipeline.requestChanges(value, `Round ${repair + 1}: fix npm test output: ${failed.output}`);
    pipeline.workerResumed(value);
    pipeline.nextHandoff(value); // deliberately unchanged diff
  }
  pipeline.startJudge(value); await pipeline.idle();
  assert.equal(value.status, "needs_attention");
  assert.equal(value.review?.status, "needs_attention");
  assert.equal(value.review?.remediation?.rounds.worker_ci?.attempts, 3);
  assert.equal(value.review?.remediation?.actions.at(-1)?.state, "exhausted");
  assert.equal(value.review?.remediation?.actions.at(-1)?.evidence.checks?.[0]?.output, failed.output);
});

test("no-content completion commit does not reset the unchanged failure budget", async () => {
  const adapter = new FakeAdapter(); const value = job("no-content-commit");
  const failed: CheckEvidence = { command: "npm test", ok: false, exitCode: 1, durationMs: 1, output: "same failure" };
  adapter.runCi = async () => [failed];
  value.completion = { head: "implementation-commit", finishedAt: 1 };
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value); pipeline.startJudge(value); await pipeline.idle();
  const fingerprint = value.review!.remediation!.rounds.worker_ci!.fingerprint;
  pipeline.requestChanges(value, "Fix exact deterministic test failure");
  pipeline.workerResumed(value);
  value.completion.head = "empty-follow-up-commit";
  pipeline.nextHandoff(value); pipeline.startJudge(value); await pipeline.idle();
  assert.equal(value.review?.remediation?.rounds.worker_ci?.fingerprint, fingerprint);
  assert.equal(value.review?.remediation?.rounds.worker_ci?.attempts, 1);
  assert.equal(value.review?.remediation?.actions.length, 2);
});

test("successful infrastructure retry resolves durably and restart cannot reschedule terminal work", async () => {
  const previousBackoff = process.env.NEOCODE_REMEDIATION_BACKOFF_MS;
  process.env.NEOCODE_REMEDIATION_BACKOFF_MS = "0";
  try {
    const adapter = new FakeAdapter(); const value = job("infra-success");
    const transient: CheckEvidence = { command: "npm test", ok: false, exitCode: null, durationMs: 1, output: "runner disappeared", timedOut: true };
    adapter.runCi = async () => adapter.ciCalls++ === 0 ? [transient] : [pass];
    const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
    pipeline.enqueue(value); pipeline.startJudge(value); await pipeline.idle();
    pipeline.retryInfrastructure(value, "ephemeral runner timeout");
    while (value.review?.status !== "approved") await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(value.review.remediation?.actions[0]?.state, "resolved");
    assert.equal(value.review.remediation?.currentActionId, undefined);
    pipeline.requestMerge(value); await pipeline.idle();
    assert.equal(value.review.status, "merged");

    const callsAfterSuccess = adapter.ciCalls;
    const restored = structuredClone(value);
    const restarted = new CompletionPipeline(adapter, () => undefined, "main", "/root");
    restarted.recover([restored]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(adapter.ciCalls, callsAfterSuccess);
    assert.equal(restored.review?.status, "merged");
    assert.equal(restored.integration?.status, "merged");
  } finally {
    if (previousBackoff === undefined) delete process.env.NEOCODE_REMEDIATION_BACKOFF_MS;
    else process.env.NEOCODE_REMEDIATION_BACKOFF_MS = previousBackoff;
  }
});

test("restart recovery does not duplicate a claimed source repair attempt", async () => {
  const adapter = new FakeAdapter(); const value = job("restart-repair");
  adapter.runCi = async () => [{ command: "test", ok: false, exitCode: 1, durationMs: 1, output: "broken" }];
  const first = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  first.enqueue(value); first.startJudge(value); await first.idle();
  first.requestChanges(value, "Fix exact failure: broken");
  const restored = structuredClone(value);
  const restarted = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  restarted.recover([restored]); await restarted.idle();
  assert.equal(restored.review?.remediation?.rounds.worker_ci?.attempts, 1);
  assert.equal(restored.review?.remediation?.actions.length, 1);
  assert.equal(adapter.judgeCalls, 0);
});

test("conflict returns to worker handoff and fresh judge before retry", async () => {
  const adapter = new FakeAdapter(); const value = job(); let conflict = true;
  adapter.reconcile = async () => { adapter.reconcileCalls += 1; if (conflict) throw new PipelineError("conflict", "content conflict"); return { commit: "resolved" }; };
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value); pipeline.startJudge(value); await pipeline.idle(); pipeline.requestMerge(value); await pipeline.idle();
  assert.equal(value.review?.status, "conflict");
  pipeline.requestChanges(value, "Resolve conflict on the worker branch, never root"); pipeline.workerResumed(value);
  conflict = false; value.diff = "resolved diff"; pipeline.nextHandoff(value); pipeline.startJudge(value); await pipeline.idle();
  pipeline.requestMerge(value); await pipeline.idle(); assert.equal(value.review?.status, "merged"); assert.equal(adapter.judgeCalls, 2);
});

test("restart invalidates legacy server-owned auto-decision verdicts", async () => {
  const adapter = new FakeAdapter(); const value = job();
  value.review = { hookToken: "legacy", status: "approved", attempt: 1, targetBranch: "main", updatedAt: 2,
    judge: verdict(createHash("sha256").update(value.diff!).digest("hex")), transitions: [{ status: "approved", at: 2 }] };
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root"); pipeline.recover([value]); await pipeline.idle();
  assert.equal(value.review.status, "queued"); assert.equal(value.review.judge, undefined); assert.equal(adapter.reconcileCalls, 0);
});

test("restart recovery never replays a transient product decision", async () => {
  const adapter = new FakeAdapter(); const value = job();
  value.review = { hookToken: "stable", status: "merging", attempt: 1, targetBranch: "main", updatedAt: 2,
    coordinatorAuthorizedAt: 2, judge: verdict(createHash("sha256").update(value.diff!).digest("hex")), transitions: [{ status: "judging", at: 1, owner: "coordinator" }, { status: "merging", at: 2, owner: "coordinator" }] };
  const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.recover([value]); await pipeline.idle();
  assert.equal(value.review.status, "blocked");
  assert.equal(value.review.coordinatorAuthorizedAt, undefined);
  assert.equal(adapter.reconcileCalls, 0);
});

test("candidate and post-merge verification failures become evidence-complete action-required states", async () => {
  const candidateAdapter = new FakeAdapter();
  const candidateCheck: CheckEvidence = { command: "npm run build", ok: false, exitCode: 2, durationMs: 4, output: "TS2345 candidate failure" };
  candidateAdapter.reconcile = async () => { throw new PipelineError("failed", "Candidate CI failed before main changed", "candidate_ci", [candidateCheck]); };
  const candidate = job("candidate-fail");
  const candidatePipeline = new CompletionPipeline(candidateAdapter, () => undefined, "main", "/root");
  candidatePipeline.enqueue(candidate); candidatePipeline.startJudge(candidate); await candidatePipeline.idle();
  candidatePipeline.requestMerge(candidate); await candidatePipeline.idle();
  assert.equal(candidate.review?.remediation?.actions.at(-1)?.failureClass, "candidate_ci");
  assert.equal(candidate.review?.remediation?.actions.at(-1)?.evidence.checks?.[0]?.output, candidateCheck.output);
  assert.notEqual(candidate.integration?.status, "merged");

  const postAdapter = new FakeAdapter();
  postAdapter.runCi = async (cwd) => cwd === "/root"
    ? [{ command: "npm test", ok: false, exitCode: 1, durationMs: 3, output: "post merge regression" }]
    : [pass];
  const post = job("post-fail");
  const postPipeline = new CompletionPipeline(postAdapter, () => undefined, "main", "/root");
  postPipeline.enqueue(post); postPipeline.startJudge(post); await postPipeline.idle();
  postPipeline.requestMerge(post); await postPipeline.idle();
  assert.equal(post.review?.status, "post_ci_failed");
  assert.equal(post.review?.remediation?.actions.at(-1)?.failureClass, "post_merge_ci");
  assert.equal(post.review?.remediation?.actions.at(-1)?.evidence.mergeCommit, "commit-post-fail");
  assert.notEqual(post.integration?.status, "merged", "post-merge failure must never appear Done");
});

test("changed diff after approval blocks guarded integration", async () => {
  const adapter = new FakeAdapter(); let reads = 0;
  adapter.readDiff = async () => ++reads === 1 ? "reviewed" : "changed";
  const value = job(); const pipeline = new CompletionPipeline(adapter, () => undefined, "main", "/root");
  pipeline.enqueue(value); pipeline.startJudge(value); await pipeline.idle(); pipeline.requestMerge(value); await pipeline.idle();
  assert.equal(value.review?.status, "blocked"); assert.equal(adapter.reconcileCalls, 0);
});

test("local integration rebases untracked work and fast-forwards main without a merge commit", async () => {
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
    await writeFile(join(root, "main-only.txt"), "main advanced\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "advance main"], { cwd: root });

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
    new CompletionPipeline(adapter, () => undefined, "main", root).enqueue(value);
    const creationBase = value.baseRef;
    const currentMain = (await execFileAsync("git", ["rev-parse", "main"], { cwd: root })).stdout.trim();
    await adapter.prepareForReview(value);
    const reviewedHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worker })).stdout.trim();
    assert.equal(value.baseRef, creationBase, "creation provenance stays immutable");
    assert.equal(value.review?.reviewBaseRef, currentMain, "review base records the exact rebase target separately");
    assert.equal((await execFileAsync("git", ["merge-base", "--is-ancestor", currentMain, reviewedHead], { cwd: root })).stderr, "");
    const diff = await adapter.readDiff(value);
    assert.match(diff, /new-file\.txt/);
    assert.match(diff, /new content/);

    const result = await adapter.reconcile(value);
    assert.equal(result.alreadyMerged, undefined);
    assert.equal(result.commit, reviewedHead, "main must fast-forward to the exact reviewed rebased commit");
    assert.equal((await execFileAsync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: root })).stdout.trim().split(/\s+/).length, 2,
      "integrated commit has exactly one parent, not a merge commit");
    assert.equal(await readFile(join(root, "new-file.txt"), "utf8"), "new content\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
