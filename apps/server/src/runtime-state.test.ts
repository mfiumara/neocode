import assert from "node:assert/strict";
import { lutimes, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import {
  RUNTIME_STATE_VERSION,
  RuntimeStateStore,
  runtimeStatePath,
  type DurableRuntimeState,
  type RuntimeLockOwner,
} from "./runtime-state.js";

function fixture(root: string, title = "durable"): DurableRuntimeState {
  const job: AgentJob = {
    id: "job-1",
    title,
    prompt: "do work",
    status: "interrupted",
    branch: "neocode/durable-job-1",
    worktree: join(root, ".worktrees", "durable-job-1"),
    isolation: { requested: "auto", mode: "worktree", path: join(root, ".worktrees", "durable-job-1") },
    baseRef: "abc123",
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: "m1", role: "user", text: "do work", timestamp: 1 }],
    summary: "summary",
    diff: "+change",
    recoverable: true,
    worktreeIdentity: {
      path: join(root, ".worktrees", "durable-job-1"), branch: "neocode/durable-job-1", baseRef: "abc123", createdAt: 1,
    },
    completion: { head: "def456", finishedAt: 2 },
    integration: { status: "merged", targetRef: "main", verifiedAt: 3, targetHead: "fed789", completionHead: "def456" },
    cleanup: {
      status: "removed", checkedAt: 3, removedAt: 4,
      evidence: {
        checkedAt: 3, targetRef: "main", targetHead: "fed789", completionHead: "def456",
        intendedCommits: ["def456"], mergeMethod: "commit-ancestry", cleanPorcelain: true,
        registeredPath: join(root, ".worktrees", "durable-job-1"), registeredBranch: "neocode/durable-job-1",
      },
    },
  };
  return {
    version: RUNTIME_STATE_VERSION,
    workspaceRoot: root,
    updatedAt: 3,
    maintenance: { state: "idle", lastRunAt: 4, source: "scheduled", checked: 1, removed: 1, refused: 0 },
    coordinator: {
      messages: [{ id: "c1", role: "assistant", text: "hello", timestamp: 1 }],
      piSessionFile: join(root, ".neocode", "runtime", "server-v1", "pi-sessions", "coordinator", "session.jsonl"),
    },
    jobs: [{ job, piSessionFile: join(root, "worker.jsonl") }],
  };
}

test("runtime state atomically round-trips all job and session metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-"));
  try {
    const store = new RuntimeStateStore(root);
    store.save(fixture(root));
    await store.flush();
    const restored = await store.load();
    assert.equal(restored?.jobs[0]?.job.summary, "summary");
    assert.equal(restored?.jobs[0]?.job.diff, "+change");
    assert.equal(restored?.jobs[0]?.job.cleanup?.status, "removed");
    assert.equal(restored?.jobs[0]?.job.integration?.status, "merged");
    assert.equal(restored?.maintenance?.removed, 1);
    assert.match(restored?.coordinator.piSessionFile || "", /pi-sessions/);
    assert.match(runtimeStatePath(root), /\.neocode\/runtime\/server-v1\/state\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable transcripts preserve image data used by restored clickable threads", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-images-"));
  try {
    const state = fixture(root);
    state.coordinator.messages[0]!.attachments = [{
      id: "image-1",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
      size: 8,
      name: "restored.png",
    }];
    const store = new RuntimeStateStore(root);
    store.save(state);
    await store.flush();
    assert.deepEqual((await store.load())?.coordinator.messages[0]?.attachments, state.coordinator.messages[0]?.attachments);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming saves coalesce to the latest complete snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-"));
  try {
    const store = new RuntimeStateStore(root);
    for (let index = 0; index < 30; index += 1) {
      const state = fixture(root, `update-${index}`);
      state.jobs[0]!.job.runtimeRevision = index + 1;
      store.save(state);
    }
    await store.flush();
    assert.equal((await store.load())?.jobs[0]?.job.title, "update-29");
    const raw = await readFile(runtimeStatePath(root), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid or cross-workspace state is ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-"));
  try {
    const path = runtimeStatePath(root);
    await mkdir(join(root, ".neocode", "runtime", "server-v1"), { recursive: true });
    await writeFile(path, "{truncated", "utf8");
    assert.equal(await new RuntimeStateStore(root).load(), undefined);
    await writeFile(path, JSON.stringify(fixture(`${root}-other`)), "utf8");
    assert.equal(await new RuntimeStateStore(root).load(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inter-process CAS protects renewable generation ownership and terminal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-cas-"));
  try {
    let ownerNow = 50;
    let observerNow = 149;
    const owner = new RuntimeStateStore(root, () => ownerNow);
    const observer = new RuntimeStateStore(root, () => observerNow);
    const state = fixture(root);
    const live = state.jobs[0]!.job;
    live.status = "running";
    live.runtimeRevision = 1;
    live.recovery = {
      retryCount: 0, maxRetries: 3, generation: 1,
      leaseToken: "generation-1", leaseAcquiredAt: 10, leaseExpiresAt: 100,
    };
    owner.save(state);
    await owner.flush();

    const renewed = await owner.renewJobLease(live.id, {
      generation: 1, token: "generation-1",
    }, 100);
    assert.equal(renewed?.runtimeRevision, 2);
    assert.equal(renewed?.recovery?.leaseExpiresAt, 150);

    const premature = structuredClone(renewed!);
    premature.recovery!.generation = 2;
    premature.recovery!.leaseToken = "generation-2";
    assert.equal(await observer.compareAndSwapJob(premature, {
      revision: 2, generation: 1, token: "generation-1", requireExpiredLease: true,
    }), undefined, "a renewed unexpired lease cannot be stolen");

    observerNow = 150;
    const takeover = await observer.compareAndSwapJob(premature, {
      revision: 2, generation: 1, token: "generation-1", requireExpiredLease: true,
    });
    assert.equal(takeover?.recovery?.leaseToken, "generation-2");
    assert.equal(takeover?.runtimeRevision, 3);
    ownerNow = 151;
    assert.equal(await owner.renewJobLease(live.id, {
      generation: 1, token: "generation-1",
    }, 100), undefined, "stale generations cannot renew newer ownership");

    const cancelled = structuredClone(takeover!);
    cancelled.status = "cancelled";
    cancelled.recoverable = false;
    delete cancelled.recovery!.leaseToken;
    delete cancelled.recovery!.leaseExpiresAt;
    const terminal = await observer.compareAndSwapJob(cancelled, {
      revision: 3, generation: 2, token: "generation-2",
    });
    assert.equal(terminal?.status, "cancelled");

    const staleRunning = structuredClone(takeover!);
    staleRunning.runtimeRevision = 99;
    staleRunning.messages.push({ id: "stale", role: "assistant", text: "stale writer", timestamp: 200 });
    const staleState = structuredClone(state);
    staleState.jobs[0]!.job = staleRunning;
    owner.save(staleState);
    await owner.flush();
    const durable = (await observer.load())!.jobs[0]!.job;
    assert.equal(durable.status, "cancelled", "terminal cancellation wins over stale whole-state writes");
    assert.equal(durable.recoverable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease renewal covers initialization and takeover rereads latest durable progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-init-"));
  try {
    const initializing = new RuntimeStateStore(root, () => 20);
    const replacement = new RuntimeStateStore(root, () => 51);
    const state = fixture(root);
    const live = state.jobs[0]!.job;
    live.status = "running";
    live.runtimeRevision = 4;
    live.recovery = {
      retryCount: 0, maxRetries: 3, generation: 4,
      leaseToken: "initializing", leaseAcquiredAt: 0, leaseExpiresAt: 30,
    };
    initializing.save(state);
    await initializing.flush();

    // Renewal is a store operation and does not depend on a created AgentSession.
    const covered = await initializing.renewJobLease(live.id, {
      generation: 4, token: "initializing",
    }, 30);
    assert.equal(covered?.recovery?.leaseExpiresAt, 50);
    covered!.messages.push({ id: "latest", role: "assistant", text: "initialization progress", timestamp: 21 });
    covered!.runtimeRevision = 6;
    const latestState = structuredClone(state);
    latestState.jobs[0]!.job = covered!;
    initializing.save(latestState);
    await initializing.flush();

    const staleTakeover = structuredClone(live);
    staleTakeover.status = "interrupted";
    assert.equal(await replacement.compareAndSwapJob(staleTakeover, {
      revision: 4, generation: 4, token: "initializing", requireExpiredLease: true,
    }), undefined, "takeover cannot commit from its stale startup revision");
    const reread = (await replacement.load())!.jobs[0]!.job;
    assert.equal(reread.messages.at(-1)?.text, "initialization progress");
    assert.equal(reread.runtimeRevision, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed jobs reject stale running snapshots and remain non-resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-completed-"));
  try {
    const owner = new RuntimeStateStore(root);
    const stale = new RuntimeStateStore(root);
    const state = fixture(root);
    const running = state.jobs[0]!.job;
    running.status = "running";
    running.runtimeRevision = 1;
    running.recovery = { retryCount: 0, maxRetries: 3, generation: 1, leaseToken: "owner", leaseExpiresAt: 100 };
    owner.save(state);
    await owner.flush();
    const completed = structuredClone(running);
    completed.status = "completed";
    completed.recoverable = false;
    delete completed.recovery!.leaseToken;
    delete completed.recovery!.leaseExpiresAt;
    const committed = await owner.compareAndSwapJob(completed, {
      revision: 1, generation: 1, token: "owner",
    });
    assert.equal(committed?.status, "completed");

    running.runtimeRevision = 50;
    running.messages.push({ id: "late", role: "assistant", text: "late callback", timestamp: 2 });
    const staleState = structuredClone(state);
    staleState.jobs[0]!.job = running;
    stale.save(staleState);
    await stale.flush();
    const durable = (await owner.load())!.jobs[0]!.job;
    assert.equal(durable.status, "completed");
    assert.equal(durable.recoverable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delayed live lock owners are never reclaimed and cannot overwrite a successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-lock-live-"));
  try {
    const first = new RuntimeStateStore(root);
    const second = new RuntimeStateStore(root);
    const firstState = fixture(root, "stale-generation-1");
    firstState.jobs[0]!.job.status = "running";
    firstState.jobs[0]!.job.runtimeRevision = 1;
    firstState.jobs[0]!.job.recovery = {
      retryCount: 0, maxRetries: 3, generation: 1, leaseToken: "generation-1", leaseExpiresAt: 1,
    };
    const secondState = fixture(root, "terminal-generation-2");
    secondState.jobs[0]!.job.status = "cancelled";
    secondState.jobs[0]!.job.runtimeRevision = 2;
    secondState.jobs[0]!.job.recovery = { retryCount: 0, maxRetries: 3, generation: 2 };

    let releaseFirst!: () => void;
    const paused = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    let activeSections = 0;
    let maxActiveSections = 0;
    let secondEntered = false;
    type LockInternals = {
      lockPath: string;
      withLock<T>(operation: () => Promise<T>): Promise<T>;
      writeAtomic(state: DurableRuntimeState): Promise<void>;
      releaseLock(token: string): Promise<boolean>;
    };
    const firstInternals = first as unknown as LockInternals;
    const secondInternals = second as unknown as LockInternals;
    const firstWrite = firstInternals.withLock(async () => {
      activeSections += 1;
      maxActiveSections = Math.max(maxActiveSections, activeSections);
      firstEntered();
      await paused;
      await firstInternals.writeAtomic(firstState);
      activeSections -= 1;
    });
    await entered;
    // Reproduce an owner paused beyond the removed age-only stale threshold.
    const liveClaim = join(first.lockPath, (await readdir(first.lockPath)).find((name) => name.endsWith(".claim"))!);
    await lutimes(liveClaim, new Date(0), new Date(0));
    const ownerLink = await readlink(liveClaim);
    assert.equal(await firstInternals.releaseLock("not-the-owner-token"), false);
    assert.equal(await readlink(liveClaim), ownerLink, "token-mismatched cleanup cannot remove the live claim");

    const secondWrite = secondInternals.withLock(async () => {
      secondEntered = true;
      activeSections += 1;
      maxActiveSections = Math.max(maxActiveSections, activeSections);
      await secondInternals.writeAtomic(secondState);
      activeSections -= 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(secondEntered, false, "elapsed age alone cannot reclaim a delayed live owner");
    assert.equal(maxActiveSections, 1);

    releaseFirst();
    await Promise.all([firstWrite, secondWrite]);
    assert.equal(maxActiveSections, 1, "critical sections never overlap");
    const durable = (await second.load())!.jobs[0]!.job;
    assert.equal(durable.status, "cancelled");
    assert.equal(durable.recovery?.generation, 2);
    assert.equal(durable.title, "terminal-generation-2", "generation 1 cannot write after generation 2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a proven-dead lock owner is recovered without ambiguous token cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-lock-dead-"));
  try {
    const store = new RuntimeStateStore(root);
    await mkdir(store.lockPath, { recursive: true });
    const deadOwner: RuntimeLockOwner = {
      token: "abandoned-owner",
      pid: 2_147_483_647,
      hostname: hostname(),
      processIdentity: "proc:proven-dead-test-owner",
      createdAt: 1,
      ticket: 1,
    };
    await symlink(JSON.stringify(deadOwner), join(store.lockPath, `${deadOwner.token}.claim`));
    store.save(fixture(root, "recovered-after-dead-owner"));
    await store.flush();
    assert.equal((await store.load())?.jobs[0]?.job.title, "recovered-after-dead-owner");
    assert.deepEqual(await readdir(store.lockPath), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("three contenders cannot displace a live successor after stale dead-owner observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-lock-three-"));
  try {
    const seed = new RuntimeStateStore(root);
    const generation1 = fixture(root, "generation-1");
    generation1.jobs[0]!.job.status = "running";
    generation1.jobs[0]!.job.runtimeRevision = 1;
    generation1.jobs[0]!.job.recovery = {
      retryCount: 0, maxRetries: 3, generation: 1, leaseToken: "generation-1", leaseExpiresAt: 1,
    };
    seed.save(generation1);
    await seed.flush();
    const deadOwner: RuntimeLockOwner = {
      token: "shared-dead-owner", pid: 2_147_483_647, hostname: hostname(),
      processIdentity: "proc:dead-three-contender", createdAt: 1, ticket: 1,
    };
    await symlink(JSON.stringify(deadOwner), join(seed.lockPath, `${deadOwner.token}.claim`));

    type Entry = { path: string; serialized?: string; owner?: RuntimeLockOwner };
    type Internals = {
      lockPath: string;
      withLock<T>(operation: () => Promise<T>): Promise<T>;
      removeIfProvenDead(entry: Entry): Promise<boolean>;
      writeAtomic(state: DurableRuntimeState): Promise<void>;
      load(): Promise<DurableRuntimeState | undefined>;
    };
    const first = new RuntimeStateStore(root) as unknown as Internals;
    const delayed = new RuntimeStateStore(root) as unknown as Internals;
    const third = new RuntimeStateStore(root) as unknown as Internals;
    let observedFirst!: () => void, observedDelayed!: () => void;
    const firstObserved = new Promise<void>((resolve) => { observedFirst = resolve; });
    const delayedObserved = new Promise<void>((resolve) => { observedDelayed = resolve; });
    let releaseFirstReclaim!: () => void, releaseDelayedReclaim!: () => void;
    const firstReclaimGate = new Promise<void>((resolve) => { releaseFirstReclaim = resolve; });
    const delayedReclaimGate = new Promise<void>((resolve) => { releaseDelayedReclaim = resolve; });
    const originalFirstRemove = first.removeIfProvenDead.bind(first);
    const originalDelayedRemove = delayed.removeIfProvenDead.bind(delayed);
    first.removeIfProvenDead = async (entry) => {
      if (entry.owner?.token === deadOwner.token) { observedFirst(); await firstReclaimGate; }
      return originalFirstRemove(entry);
    };
    delayed.removeIfProvenDead = async (entry) => {
      if (entry.owner?.token === deadOwner.token) { observedDelayed(); await delayedReclaimGate; }
      return originalDelayedRemove(entry);
    };

    let active = 0, maxActive = 0;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    let releaseLiveOwner!: () => void;
    const liveOwnerGate = new Promise<void>((resolve) => { releaseLiveOwner = resolve; });
    const generation2 = fixture(root, "terminal-generation-2");
    generation2.jobs[0]!.job.status = "cancelled";
    generation2.jobs[0]!.job.runtimeRevision = 2;
    generation2.jobs[0]!.job.recovery = { retryCount: 0, maxRetries: 3, generation: 2 };
    const firstRun = first.withLock(async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await first.writeAtomic(generation2);
      firstEntered();
      await liveOwnerGate;
      active -= 1;
    });
    await firstObserved;

    let delayedEntered = false;
    const delayedRun = delayed.withLock(async () => {
      delayedEntered = true;
      active += 1; maxActive = Math.max(maxActive, active);
      const durable = await delayed.load();
      // This is the stale generation-1 CAS predicate: it must fail after A's terminal write.
      if (durable?.jobs[0]?.job.runtimeRevision === 1 && durable.jobs[0].job.recovery?.generation === 1) {
        await delayed.writeAtomic(generation1);
      }
      active -= 1;
    });
    await delayedObserved;
    releaseFirstReclaim();
    await entered;

    let thirdEntered = false;
    const thirdRun = third.withLock(async () => {
      thirdEntered = true;
      active += 1; maxActive = Math.max(maxActive, active);
      active -= 1;
    });
    releaseDelayedReclaim();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(delayedEntered, false, "stale reclaimer cannot displace the live successor claim");
    assert.equal(thirdEntered, false, "third contender cannot enter while successor is live");
    assert.equal(maxActive, 1);
    const claims = (await readdir(seed.lockPath)).filter((name) => name.endsWith(".claim"));
    const liveClaims = await Promise.all(claims.map((name) => readlink(join(seed.lockPath, name)).then((value) => JSON.parse(value) as RuntimeLockOwner)));
    assert.equal(liveClaims.some((owner) => owner.ticket === 2), true, "live owner token remains at its immutable claim path");

    releaseLiveOwner();
    await Promise.all([firstRun, delayedRun, thirdRun]);
    assert.equal(maxActive, 1);
    const durable = (await seed.load())!.jobs[0]!.job;
    assert.equal(durable.status, "cancelled");
    assert.equal(durable.recovery?.generation, 2);
    assert.equal(durable.title, "terminal-generation-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease renewal samples time after pre-lock flush and lock contention", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-renew-commit-time-"));
  try {
    let now = 20;
    const seed = new RuntimeStateStore(root, () => 31);
    const state = fixture(root, "short-generation-1");
    const live = state.jobs[0]!.job;
    live.status = "running";
    live.runtimeRevision = 1;
    live.recovery = {
      retryCount: 0, maxRetries: 3, generation: 1,
      leaseToken: "generation-1", leaseAcquiredAt: 10, leaseExpiresAt: 30,
    };
    seed.save(state);
    await seed.flush();

    type LockInternals = {
      withLock<T>(operation: () => Promise<T>): Promise<T>;
    };
    const holder = new RuntimeStateStore(root) as unknown as LockInternals;
    let releaseHolder!: () => void, holderEntered!: () => void;
    const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const entered = new Promise<void>((resolve) => { holderEntered = resolve; });
    const held = holder.withLock(async () => { holderEntered(); await holderGate; });
    await entered;

    const renewing = new RuntimeStateStore(root, () => now);
    const renewingInternals = renewing as unknown as LockInternals;
    const originalWithLock = renewingInternals.withLock.bind(renewingInternals);
    let flushAttempted!: () => void;
    const flushWaitingForLock = new Promise<void>((resolve) => { flushAttempted = resolve; });
    let attempts = 0;
    renewingInternals.withLock = async <T>(operation: () => Promise<T>) => {
      attempts += 1;
      if (attempts === 1) flushAttempted();
      return originalWithLock(operation);
    };
    // Force renewJobLease through an already-pending pre-lock persistence flush.
    renewing.save(structuredClone(state));
    await flushWaitingForLock;
    const renewal = renewing.renewJobLease(live.id, {
      revision: 1, generation: 1, token: "generation-1",
    }, 100);
    now = 31;
    releaseHolder();
    await held;
    assert.equal(await renewal, undefined, "an invocation begun before expiry cannot revive after entering late");
    const unchanged = (await seed.load())!.jobs[0]!.job;
    assert.equal(unchanged.runtimeRevision, 1);
    assert.equal(unchanged.recovery?.leaseExpiresAt, 30);

    const successor = structuredClone(unchanged);
    successor.recovery!.generation = 2;
    successor.recovery!.leaseToken = "generation-2";
    successor.recovery!.leaseExpiresAt = 999; // Deliberately stale caller proposal; the store must replace it.
    const generation2 = await seed.compareAndSwapJob(successor, {
      revision: 1, generation: 1, token: "generation-1", requireExpiredLease: true,
      establishLeaseMs: 100,
    });
    assert.equal(generation2?.runtimeRevision, 2);
    assert.equal(generation2?.recovery?.leaseExpiresAt, 131, "takeover lease also derives from in-lock time");
    const stale = structuredClone(unchanged);
    stale.messages.push({ id: "late", role: "assistant", text: "late generation-1 callback", timestamp: 32 });
    assert.equal(await renewing.compareAndSwapJob(stale, {
      revision: 1, generation: 1, token: "generation-1",
    }), undefined, "generation-1 callbacks remain fenced after takeover");

    // A renewal that enters before expiry succeeds, but its deadline derives
    // from the in-lock clock sample rather than invocation time.
    let successNow = 40;
    const successful = new RuntimeStateStore(root, () => successNow);
    const current = (await seed.load())!.jobs[0]!.job;
    current.recovery!.leaseExpiresAt = 200;
    current.runtimeRevision = 3;
    const currentState = (await seed.load())!;
    currentState.jobs[0]!.job = current;
    seed.save(currentState);
    await seed.flush();

    let releaseSecond!: () => void, secondEntered!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const secondHeld = new Promise<void>((resolve) => { secondEntered = resolve; });
    const holder2 = new RuntimeStateStore(root) as unknown as LockInternals;
    const holding2 = holder2.withLock(async () => { secondEntered(); await secondGate; });
    await secondHeld;
    const successInternals = successful as unknown as LockInternals;
    const successOriginal = successInternals.withLock.bind(successInternals);
    let acquisitionAttempted!: () => void;
    const waiting = new Promise<void>((resolve) => { acquisitionAttempted = resolve; });
    successInternals.withLock = async <T>(operation: () => Promise<T>) => {
      acquisitionAttempted();
      return successOriginal(operation);
    };
    successNow = 50;
    const successfulRenewal = successful.renewJobLease(live.id, {
      revision: 3, generation: 2, token: "generation-2",
    }, 100);
    await waiting;
    successNow = 70;
    releaseSecond();
    await holding2;
    const renewed = await successfulRenewal;
    assert.equal(renewed?.runtimeRevision, 4);
    assert.equal(renewed?.recovery?.leaseExpiresAt, 170, "deadline uses time sampled after lock acquisition");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
