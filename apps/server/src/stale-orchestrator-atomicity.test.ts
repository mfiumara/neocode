import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentJob, ServerMessage } from "@neocode/protocol";
import { Orchestrator } from "./orchestrator.js";
import { RuntimeStateStore, type DurableRuntimeState } from "./runtime-state.js";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) { return (await exec("git", args, { cwd })).stdout.trim(); }

function gate() {
  let entered!: () => void; let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => { entered = resolve; }),
    release: new Promise<void>((resolve) => { release = resolve; }),
    arrive: () => { entered(); }, releaseNow: () => { release(); },
  };
}

async function fixture(status: AgentJob["status"] = "interrupted", dirty = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neocode-stale-orchestrator-")));
  await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.email", "test@example.com"]); await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "base.txt"), "base\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]); const path = join(root, ".worktrees", "atomic-job");
  await mkdir(join(root, ".worktrees"), { recursive: true }); await git(root, ["worktree", "add", "-b", "neocode/atomic-job", path, base]);
  if (dirty) await writeFile(join(path, "retained.txt"), "unique retained content\n");
  const job: AgentJob = {
    id: "atomic-job", title: "Atomic stale lifecycle", prompt: "work", status, branch: "neocode/atomic-job", worktree: path,
    isolation: { requested: "worktree", mode: "worktree", path }, baseRef: base, createdAt: 1, updatedAt: 2, messages: [],
    recoverable: status !== "completed", recovery: { retryCount: 0, maxRetries: 3, generation: 0 },
    worktreeIdentity: { path, branch: "neocode/atomic-job", baseRef: base, createdAt: 1 },
    completion: status === "completed" ? { head: base, finishedAt: 1 } : undefined,
  };
  const events: ServerMessage[] = [];
  const orchestrator = new Orchestrator(root, (event) => events.push(event), { startup: false, intervalMs: 0, sweepIntervalMs: 0, graceMs: 0 });
  type Harness = {
    jobs: Map<string, AgentJob>; workers: Map<string, unknown>; coordinator: { model: object; thinkingLevel: string };
    staleLifecycleHooks?: Record<string, (...args: any[]) => void | Promise<void>>;
    startWorkerRun: (job: AgentJob, attachments: unknown[], options: unknown) => void;
    stateStore: { writeAtomic(state: DurableRuntimeState): Promise<void>; flush(): Promise<void> };
    startCleanup(source: "manual", ignoreGrace?: boolean): void; janitorRun?: Promise<void>;
    scheduleBacklogSweep(): void; persist(): void;
  };
  const harness = orchestrator as unknown as Harness;
  harness.jobs.set(job.id, job); harness.coordinator = { model: {}, thinkingLevel: "medium" };
  harness.startWorkerRun = (owned) => { harness.workers.set(owned.id, { generation: owned.recovery?.generation, token: owned.recovery?.leaseToken }); };
  return { root, path, base, job, events, orchestrator, harness, cleanup: async () => { await harness.stateStore.flush().catch(() => undefined); await rm(root, { recursive: true, force: true }); } };
}

const nomination = { reason: "A durable semantic audit identified this retained implementation as potentially replaced.", evidenceSource: "audit.json" };

async function durablePending(value: Awaited<ReturnType<typeof fixture>>) {
  await value.orchestrator.nominateStale(value.job.id, { ...nomination, suspectedReplacementCommit: value.base });
  assert.equal(value.job.staleCandidate?.state, "pending");
}

test("nomination audit and real resumeJob serialize in both orderings without stale live ownership", async () => {
  const first = await fixture();
  try {
    const paused = gate();
    first.harness.staleLifecycleHooks = { beforeNominationMutation: async () => { paused.arrive(); await paused.release; } };
    const nominate = first.orchestrator.nominateStale(first.job.id, nomination);
    await paused.entered;
    let resumeSettled = false;
    const resume = first.orchestrator.resumeJob(first.job.id).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })).finally(() => { resumeSettled = true; });
    await Promise.resolve(); assert.equal(resumeSettled, false, "resume waits for nomination authority");
    paused.releaseNow(); await nominate;
    const resumeOutcome = await resume; assert.equal(resumeOutcome.ok, false); if (!resumeOutcome.ok) assert.match(String(resumeOutcome.error), /stale-candidate decision/);
    assert.equal(first.job.staleCandidate?.state, "pending");
    assert.equal(first.harness.workers.has(first.job.id), false);
    assert.notEqual(first.job.status, "running");
  } finally { await first.cleanup(); }

  const second = await fixture();
  try {
    const paused = gate();
    second.harness.staleLifecycleHooks = { beforeWorkerOwnership: async () => { paused.arrive(); await paused.release; } };
    const resume = second.orchestrator.resumeJob(second.job.id);
    await paused.entered;
    let nominationSettled = false;
    const nominate = second.orchestrator.nominateStale(second.job.id, nomination).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })).finally(() => { nominationSettled = true; });
    await Promise.resolve(); assert.equal(nominationSettled, false, "nomination waits for worker ownership authority");
    paused.releaseNow(); await resume;
    const nominationOutcome = await nominate; assert.equal(nominationOutcome.ok, false); if (!nominationOutcome.ok) assert.match(String(nominationOutcome.error), /Active jobs/);
    assert.equal(second.job.staleCandidate, undefined);
    assert.equal(second.job.status, "running");
    assert.equal(second.harness.workers.has(second.job.id), true);
  } finally { await second.cleanup(); }
});

test("nomination persistence failure publishes nothing and leaves ownership eligibility unchanged", async () => {
  const value = await fixture();
  try {
    value.harness.persist(); await value.harness.stateStore.flush(); value.events.length = 0;
    const originalWrite = value.harness.stateStore.writeAtomic.bind(value.harness.stateStore); let fail = true;
    value.harness.stateStore.writeAtomic = async (state) => { if (fail) { fail = false; throw new Error("injected nomination flush failure"); } await originalWrite(state); };
    await assert.rejects(value.orchestrator.nominateStale(value.job.id, nomination), /injected nomination flush failure/);
    assert.equal(value.job.staleCandidate, undefined); assert.equal(value.job.recoverable, true); assert.equal(value.events.length, 0);
    const restored = await new RuntimeStateStore(value.root).load();
    assert.equal(restored?.jobs.find((entry) => entry.job.id === value.job.id)?.job.staleCandidate, undefined);
  } finally { await value.cleanup(); }
});

test("failed confirmation flush rolls back pending state while operation-locked janitor retains checkout and orphan archive", async () => {
  const value = await fixture("completed", true);
  try {
    await durablePending(value); value.events.length = 0;
    const paused = gate();
    value.harness.staleLifecycleHooks = { afterArchivePublication: async () => { paused.arrive(); await paused.release; } };
    const originalWrite = value.harness.stateStore.writeAtomic.bind(value.harness.stateStore); let fail = true;
    value.harness.stateStore.writeAtomic = async (state) => { if (fail) { fail = false; throw new Error("injected stale flush failure"); } await originalWrite(state); };
    const confirmation = value.orchestrator.decideStale(value.job.id, "confirm_superseded");
    await paused.entered;
    value.harness.startCleanup("manual"); const cleanup = value.harness.janitorRun!;
    let cleanupSettled = false; void cleanup.finally(() => { cleanupSettled = true; });
    await Promise.resolve(); assert.equal(cleanupSettled, false, "janitor waits behind stale decision lock");
    assert.equal(await stat(value.path).then(() => true), true);
    paused.releaseNow(); await assert.rejects(confirmation, /injected stale flush failure/); await cleanup;
    assert.equal(value.job.staleCandidate?.state, "pending");
    assert.equal(value.job.staleCandidate?.archive, undefined);
    assert.notEqual(value.job.integration?.status, "superseded");
    assert.equal(await readFile(join(value.path, "retained.txt"), "utf8"), "unique retained content\n");
    const archiveRoot = join(value.root, ".neocode", "runtime", "stale-archives", value.job.id, String(value.job.staleCandidate!.nominatedAt));
    assert.equal((await stat(join(archiveRoot, "evidence.json"))).isFile(), true, "published archive is inert orphan evidence");
    const restored = await new RuntimeStateStore(value.root).load();
    assert.equal(restored?.jobs.find((entry) => entry.job.id === value.job.id)?.job.staleCandidate?.state, "pending");
    assert.equal(value.events.some((event) => event.type === "job_updated" && event.job.integration?.status === "superseded"), false);
  } finally { await value.cleanup(); }
});

test("successful confirmation flushes before terminal publication and later operation-locked cleanup", async () => {
  const value = await fixture("completed", false);
  try {
    await durablePending(value); value.events.length = 0;
    const publication = gate(); let diskWasTerminal = false;
    value.harness.staleLifecycleHooks = { beforeStalePublish: async (_job, action) => {
      if (action !== "confirm_superseded") return;
      const restored = await new RuntimeStateStore(value.root).load();
      diskWasTerminal = restored?.jobs.find((entry) => entry.job.id === value.job.id)?.job.staleCandidate?.state === "superseded";
      publication.arrive(); await publication.release;
    } };
    const confirmation = value.orchestrator.decideStale(value.job.id, "confirm_superseded");
    await publication.entered;
    assert.equal(diskWasTerminal, true);
    assert.equal(value.events.some((event) => event.type === "job_updated" && event.job.integration?.status === "superseded"), false);
    value.harness.startCleanup("manual"); const cleanup = value.harness.janitorRun!;
    let cleanupSettled = false; void cleanup.finally(() => { cleanupSettled = true; }); await Promise.resolve();
    assert.equal(cleanupSettled, false, "janitor cannot interleave before terminal publication");
    publication.releaseNow(); await confirmation; await cleanup;
    const terminalIndex = value.events.findIndex((event) => event.type === "job_updated" && event.job.integration?.status === "superseded");
    const removedIndex = value.events.findIndex((event) => event.type === "job_updated" && event.job.cleanup?.status === "removed");
    assert.ok(terminalIndex >= 0 && removedIndex > terminalIndex, "durable terminal publication precedes validated cleanup");
    assert.equal(await stat(value.path).then(() => true, () => false), false);
  } finally { await value.cleanup(); }
});

test("still_wanted is durable before publication and sweep, and flush failure restores pending", async () => {
  const success = await fixture();
  try {
    await durablePending(success); success.events.length = 0;
    let sweeps = 0; success.harness.scheduleBacklogSweep = () => { sweeps += 1; };
    const paused = gate(); let diskWasKept = false;
    success.harness.staleLifecycleHooks = { beforeStalePublish: async (_job, action) => {
      if (action !== "still_wanted") return;
      const restored = await new RuntimeStateStore(success.root).load();
      diskWasKept = restored?.jobs.find((entry) => entry.job.id === success.job.id)?.job.staleCandidate?.state === "kept";
      paused.arrive(); await paused.release;
    } };
    const decision = success.orchestrator.decideStale(success.job.id, "still_wanted"); await paused.entered;
    assert.equal(diskWasKept, true); assert.equal(sweeps, 0); assert.equal(success.events.length, 0);
    paused.releaseNow(); await decision;
    assert.equal(success.job.staleCandidate?.state, "kept"); assert.equal(sweeps, 1);
    assert.equal(success.events.some((event) => event.type === "job_updated" && event.job.staleCandidate?.state === "kept"), true);
  } finally { await success.cleanup(); }

  const failed = await fixture();
  try {
    await durablePending(failed); failed.events.length = 0; let sweeps = 0; failed.harness.scheduleBacklogSweep = () => { sweeps += 1; };
    const originalWrite = failed.harness.stateStore.writeAtomic.bind(failed.harness.stateStore); let fail = true;
    failed.harness.stateStore.writeAtomic = async (state) => { if (fail) { fail = false; throw new Error("injected kept flush failure"); } await originalWrite(state); };
    await assert.rejects(failed.orchestrator.decideStale(failed.job.id, "still_wanted"), /injected kept flush failure/);
    assert.equal(failed.job.staleCandidate?.state, "pending"); assert.equal(sweeps, 0); assert.equal(failed.events.length, 0);
    const restored = await new RuntimeStateStore(failed.root).load();
    assert.equal(restored?.jobs.find((entry) => entry.job.id === failed.job.id)?.job.staleCandidate?.state, "pending");
  } finally { await failed.cleanup(); }
});
