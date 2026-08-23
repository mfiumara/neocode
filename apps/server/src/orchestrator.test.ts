import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentJob, CheckEvidence, JudgeEvidence } from "@neocode/protocol";
import { CompletionPipeline, type ReviewAdapter } from "./completion-pipeline.js";
import { Orchestrator } from "./orchestrator.js";
import { RuntimeStateStore } from "./runtime-state.js";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function repository(): Promise<{ root: string; base: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "neocode-orchestrator-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  return { root, base: await git(root, ["rev-parse", "HEAD"]), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function installCoordinatorStub(orchestrator: Orchestrator): void {
  (orchestrator as unknown as { coordinator: unknown }).coordinator = { model: undefined, thinkingLevel: "high" };
}

async function flush(orchestrator: Orchestrator): Promise<void> {
  await (orchestrator as unknown as { stateStore: { flush(): Promise<void> } }).stateStore.flush();
}

test("delegate worktree-creation failure is immediately durable Done/non-actionable history", async () => {
  const fixture = await repository();
  const updates: AgentJob[] = [];
  try {
    await writeFile(join(fixture.root, ".worktrees"), "blocks worktree directory\n");
    const orchestrator = new Orchestrator(fixture.root, (event) => {
      if (event.type === "job_updated") updates.push(event.job);
    }, { startup: false, sweepIntervalMs: 0 });
    installCoordinatorStub(orchestrator);

    await assert.rejects(orchestrator.delegate("Implement a focused change", "creation failure", "worktree"));
    const failed = updates.at(-1)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.terminalDisposition?.kind, "failed_terminal",
      "terminal disposition is the authoritative Done/non-actionable marker");
    assert.equal(failed.terminalDisposition?.evidence.method, "process-failure");
    assert.match(failed.terminalDisposition?.evidence.detail || "", /\.worktrees|exist|directory/i);
    await flush(orchestrator);
  } finally {
    await fixture.cleanup();
  }
});

test("clean_worktrees tool invocation never removes a job it just reconciled", async () => {
  const fixture = await repository();
  const worktree = join(fixture.root, ".worktrees", "integrated");
  try {
    await mkdir(join(fixture.root, ".worktrees"));
    await git(fixture.root, ["worktree", "add", "-b", "neocode/integrated", worktree, fixture.base]);
    await writeFile(join(worktree, "worker.txt"), "integrated\n");
    await git(worktree, ["add", "."]);
    await git(worktree, ["commit", "-m", "worker"]);
    const head = await git(worktree, ["rev-parse", "HEAD"]);
    await git(fixture.root, ["merge", "--no-ff", "neocode/integrated", "-m", "integrate worker"]);

    const orchestrator = new Orchestrator(fixture.root, () => undefined, { startup: false, sweepIntervalMs: 0, graceMs: 0 });
    const value: AgentJob = {
      id: "integrated", title: "integrated", prompt: "integrated", status: "completed",
      branch: "neocode/integrated", worktree, isolation: { requested: "worktree", mode: "worktree", path: worktree },
      baseRef: fixture.base, createdAt: 1, updatedAt: 2, messages: [],
      completion: { head, finishedAt: 2 },
      worktreeIdentity: { path: worktree, branch: "neocode/integrated", baseRef: fixture.base, createdAt: 1 },
    };
    (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs.set(value.id, value);

    await orchestrator.cleanWorktrees();
    assert.equal(value.terminalDisposition?.kind, "merged_verified");
    assert.equal(value.cleanup, undefined, "the tool carries reconciliation IDs into the janitor hold set");
    assert.equal(await stat(worktree).then(() => true, () => false), true,
      "newly reconciled checkout remains physically present for the whole invocation");

    await orchestrator.cleanNow(true);
    const cleaned = (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs.get(value.id)!;
    assert.equal(cleaned.cleanup?.status, "removed", "a later independent cleanup pass may remove verified history");
    assert.equal(await stat(worktree).then(() => true, () => false), false);
    await flush(orchestrator);
  } finally {
    await fixture.cleanup();
  }
});

test("explicit coordinator archive is durable and reconciliation never overwrites it", async () => {
  const fixture = await repository();
  const worktree = join(fixture.root, ".worktrees", "archived");
  try {
    await mkdir(join(fixture.root, ".worktrees"));
    await git(fixture.root, ["worktree", "add", "-b", "neocode/archived", worktree, fixture.base]);
    await writeFile(join(worktree, "archived.txt"), "historical work\n");
    await git(worktree, ["add", "."]);
    await git(worktree, ["commit", "-m", "historical work"]);
    const head = await git(worktree, ["rev-parse", "HEAD"]);
    await git(fixture.root, ["merge", "--no-ff", "neocode/archived", "-m", "integrate historical work"]);

    const orchestrator = new Orchestrator(fixture.root, () => undefined, { startup: false, sweepIntervalMs: 0 });
    const value: AgentJob = {
      id: "archived", title: "archived", prompt: "archived", status: "completed",
      branch: "neocode/archived", worktree, isolation: { requested: "worktree", mode: "worktree", path: worktree },
      baseRef: fixture.base, createdAt: 1, updatedAt: 2, messages: [], completion: { head, finishedAt: 2 },
    };
    (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs.set(value.id, value);

    await orchestrator.archiveJob(value.id, "Coordinator explicitly retained this settled historical record.");
    assert.equal(value.terminalDisposition?.kind, "archived");
    assert.equal(value.terminalDisposition?.evidence.method, "manual-archive");
    assert.equal(await stat(worktree).then(() => true, () => false), true, "archive records history without cleanup");

    await (orchestrator as unknown as { reconcileIntegratedJobs(): Promise<unknown> }).reconcileIntegratedJobs();
    const reconciler = (orchestrator as unknown as { terminalReconciler: { reconcile(jobs: AgentJob[]): Promise<number> } }).terminalReconciler;
    assert.equal(await reconciler.reconcile([value]), 0);
    assert.equal(value.terminalDisposition?.kind, "archived", "all reconciliation paths preserve settled coordinator dispositions");
    await orchestrator.cleanNow(true);
    assert.equal(value.cleanup?.status, "refused");
    if (value.cleanup?.status === "refused") assert.equal(value.cleanup.reason, "terminal_not_cleanup_eligible");
    assert.equal(await stat(worktree).then(() => true, () => false), true);
    await flush(orchestrator);
  } finally {
    await fixture.cleanup();
  }
});

test("backlog sweep excludes every settled terminal disposition despite stale lifecycle metadata", async () => {
  const fixture = await repository();
  try {
    const requested: string[] = [];
    const orchestrator = new Orchestrator(fixture.root, () => undefined, { startup: false, sweepIntervalMs: 0 });
    (orchestrator as unknown as { coordinator: unknown }).coordinator = { isIdle: true };
    (orchestrator as unknown as { coordinatorNotifications: unknown }).coordinatorNotifications = {
      hasPendingWake: () => false,
      requestBacklogSweep: (job: AgentJob) => { requested.push(job.id); return true; },
    };
    const settled = (id: string, kind: "archived" | "superseded"): AgentJob => ({
      id, title: id, prompt: id, status: "completed", branch: `neocode/${id}`, worktree: join(fixture.root, ".worktrees", id),
      isolation: { requested: "worktree", mode: "worktree", path: join(fixture.root, ".worktrees", id) },
      baseRef: fixture.base, createdAt: 1, updatedAt: 2, messages: [], integration: { status: "unmerged" },
      terminalDisposition: {
        kind, recordedAt: 3, ...(kind === "superseded" ? { supersededBy: "replacement" } : {}),
        evidence: { method: kind === "archived" ? "manual-archive" : "migration-manifest", detail: "Settled coordinator history." },
      },
    });
    const jobs = (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs;
    jobs.set("archived", settled("archived", "archived"));
    jobs.set("superseded", settled("superseded", "superseded"));

    await (orchestrator as unknown as { runBacklogSweep(): Promise<void> }).runBacklogSweep();
    assert.deepEqual(requested, []);
    await flush(orchestrator);
  } finally { await fixture.cleanup(); }
});

test("startup, reconcile, and clean_worktrees share conservative identity checks", async () => {
  const fixture = await repository();
  try {
    await mkdir(join(fixture.root, ".worktrees"));
    const orchestrator = new Orchestrator(fixture.root, () => undefined, { startup: false, sweepIntervalMs: 0, graceMs: 0 });
    const jobs = (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs;
    const paths: string[] = [];
    const make = async (id: string): Promise<AgentJob> => {
      const path = join(fixture.root, ".worktrees", id); paths.push(path);
      const branch = `neocode/${id}`;
      await git(fixture.root, ["worktree", "add", "-b", branch, path, fixture.base]);
      await writeFile(join(path, `${id}.txt`), `${id}\n`);
      await git(path, ["add", "."]); await git(path, ["commit", "-m", id]);
      const head = await git(path, ["rev-parse", "HEAD"]);
      await git(fixture.root, ["merge", "--no-ff", branch, "-m", `integrate ${id}`]);
      return {
        id, title: id, prompt: id, status: "completed", branch, worktree: path,
        isolation: { requested: "worktree", mode: "worktree", path }, baseRef: fixture.base,
        createdAt: 1, updatedAt: 2, messages: [], completion: { head, finishedAt: 2 },
        worktreeIdentity: { path, branch, baseRef: fixture.base, createdAt: 1 },
      };
    };

    const moved = await make("moved-startup");
    await writeFile(join(moved.isolation.path, "moved-later.txt"), "later\n");
    await git(moved.isolation.path, ["add", "."]); await git(moved.isolation.path, ["commit", "-m", "move head"]);
    const pathMismatch = await make("path-mismatch-startup");
    const durablePath = join(fixture.root, ".worktrees", "unregistered-durable-path"); await mkdir(durablePath);
    pathMismatch.worktree = durablePath; pathMismatch.isolation.path = durablePath; pathMismatch.worktreeIdentity!.path = durablePath;
    const branchMismatch = await make("branch-mismatch-startup"); branchMismatch.branch = "neocode/other";
    const baseMismatch = await make("base-mismatch-startup"); baseMismatch.worktreeIdentity!.baseRef = "other-base";
    const completionMismatch = await make("completion-mismatch-startup"); completionMismatch.completion!.head = fixture.base;
    for (const value of [moved, pathMismatch, branchMismatch, baseMismatch, completionMismatch]) jobs.set(value.id, value);

    const reconcile = () => (orchestrator as unknown as { reconcileIntegratedJobs(): Promise<unknown> }).reconcileIntegratedJobs();
    await reconcile(); // same method used during startup and reconcile_jobs
    for (const value of jobs.values()) assert.equal(value.terminalDisposition, undefined, `${value.id} remains actionable`);
    assert.notEqual(moved.completion?.head, await git(moved.isolation.path, ["rev-parse", "HEAD"]), "moved HEAD never overwrites completion evidence");

    await orchestrator.cleanWorktrees();
    for (const value of jobs.values()) assert.equal(value.terminalDisposition, undefined);
    for (const path of paths) assert.equal(await stat(path).then(() => true, () => false), true, `${path} is preserved`);
    await flush(orchestrator);
  } finally { await fixture.cleanup(); }
});

test("archived interrupted and needs-attention jobs cannot restart, resume, or re-enter review", async () => {
  const fixture = await repository();
  const orchestrator = new Orchestrator(fixture.root, () => undefined, { startup: false, sweepIntervalMs: 0 });
  try {
    const make = (id: string, status: "interrupted" | "needs_attention"): AgentJob => ({
      id, title: id, prompt: id, status, branch: `neocode/${id}`, worktree: join(fixture.root, ".worktrees", id),
      isolation: { requested: "worktree", mode: "worktree", path: join(fixture.root, ".worktrees", id) },
      baseRef: fixture.base, createdAt: 1, updatedAt: 2, messages: [], recoverable: true,
      recovery: { retryCount: 0, maxRetries: 3, generation: 1, nextRetryAt: Date.now() + 60_000 },
      review: {
        hookToken: `hook-${id}`, status: "blocked", attempt: 1, targetBranch: "main", updatedAt: 2,
        transitions: [{ status: "blocked", at: 2 }], remediation: { maxAttempts: 3, rounds: {}, actions: [] },
      },
    });
    const interrupted = make("archived-interrupted", "interrupted");
    const attention = make("archived-attention", "needs_attention");
    const jobs = (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs;
    const timers = (orchestrator as unknown as { recoveryTimers: Map<string, NodeJS.Timeout> }).recoveryTimers;
    const startup = (orchestrator as unknown as { startupRecoveryIds: Set<string> }).startupRecoveryIds;
    for (const value of [interrupted, attention]) {
      jobs.set(value.id, value);
      const timer = setTimeout(() => undefined, 60_000); timer.unref(); timers.set(value.id, timer);
      startup.add(value.id);
      await orchestrator.archiveJob(value.id, `Coordinator explicitly archived ${value.id} as settled history.`);
      assert.equal(value.terminalDisposition?.kind, "archived");
      assert.equal(value.recoverable, false);
      assert.equal(value.recovery?.nextRetryAt, undefined);
      assert.equal(timers.has(value.id), false);
      assert.equal(startup.has(value.id), false);
      await assert.rejects(orchestrator.resumeJob(value.id), /settled as archived/);
      await assert.rejects(
        (orchestrator as unknown as { startRecoveryAttempt(job: AgentJob, reason: "manual_resume"): Promise<void> }).startRecoveryAttempt(value, "manual_resume"),
        /recovery is fenced/,
      );
    }
    const states = [interrupted.status, attention.status];
    await (orchestrator as unknown as { reconcileRestoredJobs(): Promise<void> }).reconcileRestoredJobs();
    await (orchestrator as unknown as { resumeRestoredJobs(): Promise<void> }).resumeRestoredJobs();
    assert.deepEqual([interrupted.status, attention.status], states);
    assert.equal((orchestrator as unknown as { workers: Map<string, unknown> }).workers.size, 0);
    for (const value of [interrupted, attention]) {
      assert.equal(value.terminalDisposition?.kind, "archived");
      assert.equal(value.review?.status, "blocked");
    }
    await flush(orchestrator);
  } finally { await fixture.cleanup(); }
});

test("mark_not_required tool path preserves every immutable terminal kind and checkout byte-for-byte", async () => {
  const fixture = await repository();
  const worktree = join(fixture.root, ".worktrees", "immutable-terminal");
  try {
    await mkdir(join(fixture.root, ".worktrees"));
    await git(fixture.root, ["worktree", "add", "-b", "neocode/immutable-terminal", worktree, fixture.base]);
    await writeFile(join(worktree, "terminal.txt"), "durable terminal work\n");
    await git(worktree, ["add", "."]); await git(worktree, ["commit", "-m", "terminal work"]);
    const head = await git(worktree, ["rev-parse", "HEAD"]);
    const orchestrator = new Orchestrator(fixture.root, () => undefined, { startup: false, sweepIntervalMs: 0 });
    const jobs = (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs;
    const mark = (params: { jobId: string; reason: string; supersededByCommit: string }) =>
      (orchestrator as unknown as { markNotRequired(value: typeof params): Promise<AgentJob> }).markNotRequired(params);
    const kinds = ["archived", "cancelled", "failed_terminal", "merged_verified", "superseded"] as const;
    for (const kind of kinds) {
      const value: AgentJob = {
        id: `immutable-${kind}`, title: kind, prompt: kind, status: "completed", branch: "neocode/immutable-terminal", worktree,
        isolation: { requested: "worktree", mode: "worktree", path: worktree }, baseRef: fixture.base,
        createdAt: 1, updatedAt: 2, messages: [], completion: { head, finishedAt: 2 },
        worktreeIdentity: { path: worktree, branch: "neocode/immutable-terminal", baseRef: fixture.base, createdAt: 1 },
        integration: kind === "merged_verified"
          ? { status: "merged", targetRef: "main", targetHead: fixture.base, completionHead: head, verifiedAt: 2 }
          : { status: "unmerged" },
        terminalDisposition: {
          kind, recordedAt: 2, ...(kind === "superseded" ? { supersededBy: fixture.base } : {}),
          evidence: {
            method: kind === "archived" ? "manual-archive" : kind === "cancelled" ? "explicit-cancellation"
              : kind === "failed_terminal" ? "process-failure" : kind === "superseded" ? "coordinator-supersession" : "commit-ancestry",
            detail: `Existing immutable ${kind} evidence.`, sourceCommit: head, targetRef: "main", targetCommit: fixture.base,
          },
        },
      };
      jobs.set(value.id, value);
      const before = structuredClone(value);
      const beforeListing = await git(fixture.root, ["worktree", "list", "--porcelain"]);
      await assert.rejects(mark({ jobId: value.id, reason: "A fully verified replacement already exists on main.", supersededByCommit: fixture.base }), new RegExp(`settled as ${kind}`));
      assert.deepEqual(value, before, `${kind} metadata remains immutable`);
      assert.equal(await git(worktree, ["rev-parse", "HEAD"]), head);
      assert.equal(await git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
      assert.equal(await git(fixture.root, ["worktree", "list", "--porcelain"]), beforeListing);
    }
    await flush(orchestrator);
  } finally { await fixture.cleanup(); }
});

test("verify_integration requires consistent authoritative merged_verified identity", async () => {
  const fixture = await repository();
  const worktree = join(fixture.root, ".worktrees", "verify-authority");
  try {
    await mkdir(join(fixture.root, ".worktrees"));
    await git(fixture.root, ["worktree", "add", "-b", "neocode/verify-authority", worktree, fixture.base]);
    await writeFile(join(worktree, "worker.txt"), "worker\n");
    await git(worktree, ["add", "."]); await git(worktree, ["commit", "-m", "worker"]);
    const source = await git(worktree, ["rev-parse", "HEAD"]);
    const orchestrator = new Orchestrator(fixture.root, () => undefined, { startup: false, sweepIntervalMs: 0 });
    const jobs = (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs;
    const verify = (jobId: string) => (orchestrator as unknown as {
      verifyIntegration(id: string): Promise<{ evidence: { targetHead: string; completionHead: string } }>;
    }).verifyIntegration(jobId);
    const make = (id: string): AgentJob => ({
      id, title: id, prompt: id, status: "completed", branch: "neocode/verify-authority", worktree,
      isolation: { requested: "worktree", mode: "worktree", path: worktree }, baseRef: fixture.base,
      createdAt: 1, updatedAt: 2, messages: [], completion: { head: source, finishedAt: 2 },
      worktreeIdentity: { path: worktree, branch: "neocode/verify-authority", baseRef: fixture.base, createdAt: 1 },
      integration: { status: "merged", targetRef: "main", targetHead: fixture.base, completionHead: source, verifiedAt: 2 },
    });

    const stale = make("stale-merged-flag");
    jobs.set(stale.id, stale);
    await assert.rejects(verify(stale.id), /authoritative merged_verified/);
    assert.equal(stale.terminalDisposition, undefined, "a stale merged flag cannot create authority");

    const inconsistent = make("inconsistent-merged-evidence");
    inconsistent.integration = { ...inconsistent.integration!, completionHead: fixture.base };
    inconsistent.terminalDisposition = {
      kind: "merged_verified", recordedAt: 3,
      evidence: { method: "commit-ancestry", detail: "Deliberately inconsistent durable identity.", sourceCommit: source, targetRef: "main", targetCommit: fixture.base },
    };
    jobs.set(inconsistent.id, inconsistent);
    const inconsistentBefore = structuredClone(inconsistent);
    await assert.rejects(verify(inconsistent.id), /consistent authoritative merged_verified/);
    assert.deepEqual(inconsistent, inconsistentBefore);

    const inconsistentTarget = make("inconsistent-target-evidence");
    inconsistentTarget.terminalDisposition = {
      kind: "merged_verified", recordedAt: 3,
      evidence: { method: "commit-ancestry", detail: "Target identity disagrees with integration metadata.", sourceCommit: source, targetRef: "other-target", targetCommit: fixture.base },
    };
    jobs.set(inconsistentTarget.id, inconsistentTarget);
    await assert.rejects(verify(inconsistentTarget.id), /consistent authoritative merged_verified/);

    await git(fixture.root, ["merge", "--no-ff", "neocode/verify-authority", "-m", "integrate worker"]);
    const target = await git(fixture.root, ["rev-parse", "HEAD"]);
    const valid = make("valid-merged-evidence");
    valid.integration = { status: "merged", targetRef: "main", targetHead: target, completionHead: source, verifiedAt: 4 };
    valid.terminalDisposition = {
      kind: "merged_verified", recordedAt: 4,
      evidence: { method: "commit-ancestry", detail: "Source and target identity are durably verified.", sourceCommit: source, targetRef: "main", targetCommit: source },
    };
    jobs.set(valid.id, valid);
    const result = await verify(valid.id);
    assert.equal(result.evidence.targetHead, target);
    assert.equal(result.evidence.completionHead, source);
    await flush(orchestrator);
  } finally { await fixture.cleanup(); }
});

test("real cancellation and supersession cannot race judge authority in either ordering", async () => {
  const fixture = await repository();
  try {
    const orchestrator = new Orchestrator(fixture.root, () => undefined, { startup: false, sweepIntervalMs: 0 });
    let releaseCi!: () => void;
    const ciGate = new Promise<void>((resolve) => { releaseCi = resolve; });
    const pass: CheckEvidence = { command: "npm test", ok: true, exitCode: 0, durationMs: 1, output: "pass" };
    const adapter: ReviewAdapter = {
      runCi: async () => { await ciGate; return [pass]; },
      readDiff: async (value) => value.diff || "",
      judge: async (_value, _diff, hash): Promise<JudgeEvidence> => ({
        approved: true, summary: "approved", diffSha256: hash,
        requirements: [{ requirement: "race safety", satisfied: true, evidence: "deterministic gate" }],
        model: { provider: "test", id: "judge" }, raw: "{}",
      }),
      reconcile: async () => ({ commit: fixture.base }),
    };
    const pipeline = new CompletionPipeline(adapter, () => undefined, "main", fixture.root);
    (orchestrator as unknown as { completionPipeline: CompletionPipeline }).completionPipeline = pipeline;
    const jobs = (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs;
    const active: AgentJob = {
      id: "active-judge-terminal", title: "active", prompt: "active", status: "completed", branch: "neocode/active",
      worktree: "/tmp/active", isolation: { requested: "worktree", mode: "worktree", path: "/tmp/active" },
      baseRef: fixture.base, createdAt: 1, updatedAt: 2, messages: [], diff: "active-diff",
    };
    jobs.set(active.id, active); pipeline.enqueue(active); pipeline.startJudge(active);
    await assert.rejects(orchestrator.cancelJob(active.id), /active lifecycle operation/);
    await assert.rejects(
      (orchestrator as unknown as { markNotRequired(value: { jobId: string; reason: string; supersededByCommit: string }): Promise<AgentJob> })
        .markNotRequired({ jobId: active.id, reason: "A verified replacement already exists on main.", supersededByCommit: fixture.base }),
      /active lifecycle operation/,
    );
    assert.equal(active.terminalDisposition, undefined);
    releaseCi(); await pipeline.idle();
    assert.equal(active.review?.status, "approved");

    const cancelFirst: AgentJob = { ...active, id: "cancel-first", review: undefined, handoff: undefined, terminalDisposition: undefined, integration: undefined };
    jobs.set(cancelFirst.id, cancelFirst); pipeline.enqueue(cancelFirst);
    const cancellation = orchestrator.cancelJob(cancelFirst.id);
    assert.throws(() => pipeline.startJudge(cancelFirst), /terminal settlement operation/);
    await cancellation;
    const cancelledReview = structuredClone(cancelFirst.review);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelFirst.terminalDisposition?.kind, "cancelled");
    assert.deepEqual(cancelFirst.review, cancelledReview);

    const path = join(fixture.root, ".worktrees", "supersede-first");
    await mkdir(join(fixture.root, ".worktrees"), { recursive: true });
    await git(fixture.root, ["worktree", "add", "-b", "neocode/supersede-first", path, fixture.base]);
    await writeFile(join(path, "superseded.txt"), "superseded\n");
    await git(path, ["add", "."]); await git(path, ["commit", "-m", "superseded"]);
    const head = await git(path, ["rev-parse", "HEAD"]);
    const supersedeFirst: AgentJob = {
      id: "supersede-first", title: "supersede", prompt: "supersede", status: "completed", branch: "neocode/supersede-first",
      worktree: path, isolation: { requested: "worktree", mode: "worktree", path }, baseRef: fixture.base,
      createdAt: 1, updatedAt: 2, messages: [], completion: { head, finishedAt: 2 }, diff: "supersede-diff",
      worktreeIdentity: { path, branch: "neocode/supersede-first", baseRef: fixture.base, createdAt: 1 },
    };
    jobs.set(supersedeFirst.id, supersedeFirst); pipeline.enqueue(supersedeFirst);
    const supersession = (orchestrator as unknown as { markNotRequired(value: { jobId: string; reason: string; supersededByCommit: string }): Promise<AgentJob> })
      .markNotRequired({ jobId: supersedeFirst.id, reason: "A verified replacement already exists on main.", supersededByCommit: fixture.base });
    assert.throws(() => pipeline.startJudge(supersedeFirst), /terminal settlement operation/);
    await supersession;
    assert.equal(supersedeFirst.terminalDisposition?.kind, "superseded");
    assert.equal(await git(fixture.root, ["rev-parse", "main"]), fixture.base, "terminal decisions never advance main");
    await flush(orchestrator);
  } finally { await fixture.cleanup(); }
});

test("janitor removal requires a successfully flushed terminal generation", async () => {
  const fixture = await repository();
  const path = join(fixture.root, ".worktrees", "durable-cleanup");
  try {
    await mkdir(join(fixture.root, ".worktrees"));
    await git(fixture.root, ["worktree", "add", "-b", "neocode/durable-cleanup", path, fixture.base]);
    await writeFile(join(path, "integrated.txt"), "integrated\n");
    await git(path, ["add", "."]); await git(path, ["commit", "-m", "integrated"]);
    const source = await git(path, ["rev-parse", "HEAD"]);
    await git(fixture.root, ["merge", "--no-ff", "neocode/durable-cleanup", "-m", "integrate"]);
    const target = await git(fixture.root, ["rev-parse", "HEAD"]);
    const orchestrator = new Orchestrator(fixture.root, () => undefined, { startup: false, sweepIntervalMs: 0, graceMs: 0 });
    const value: AgentJob = {
      id: "durable-cleanup", title: "cleanup", prompt: "cleanup", status: "completed", branch: "neocode/durable-cleanup",
      worktree: path, isolation: { requested: "worktree", mode: "worktree", path }, baseRef: fixture.base,
      createdAt: 1, updatedAt: 3, messages: [], completion: { head: source, finishedAt: 2 },
      worktreeIdentity: { path, branch: "neocode/durable-cleanup", baseRef: fixture.base, createdAt: 1 },
      integration: { status: "merged", targetRef: "main", targetHead: target, completionHead: source, verifiedAt: 3 },
      terminalDisposition: {
        kind: "merged_verified", recordedAt: 3,
        evidence: { method: "commit-ancestry", detail: "Integrated source is durable only after flush.", sourceCommit: source, targetRef: "main", targetCommit: source },
      },
    };
    (orchestrator as unknown as { jobs: Map<string, AgentJob> }).jobs.set(value.id, value);
    const store = (orchestrator as unknown as { stateStore: RuntimeStateStore }).stateStore;
    const originalSave = store.save.bind(store);
    const originalFlush = store.flush.bind(store);
    store.save = () => undefined;
    store.flush = async () => { throw new Error("injected durable flush failure"); };

    await orchestrator.cleanNow(true);
    assert.equal(await stat(path).then(() => true, () => false), true, "failed flush preserves checkout");
    assert.equal(value.cleanup, undefined, "janitor never consumed unflushed terminal history");
    const maintenance = (orchestrator as unknown as { maintenance: { error?: string } }).maintenance;
    assert.match(maintenance.error || "", /injected durable flush failure/);
    const restarted = await new RuntimeStateStore(fixture.root).load();
    assert.equal(restarted?.jobs.some((entry) => entry.job.id === value.id) ?? false, false,
      "a restart cannot observe the unflushed in-memory terminal generation");

    store.save = originalSave;
    let terminalFlushed = false;
    store.flush = async () => { await originalFlush(); terminalFlushed = true; };
    await orchestrator.cleanNow(true);
    assert.equal(terminalFlushed, true);
    assert.equal((value as AgentJob).cleanup?.status, "removed");
    assert.equal(await stat(path).then(() => true, () => false), false, "later independent durable pass may remove checkout");
    await originalFlush();
  } finally { await fixture.cleanup(); }
});
