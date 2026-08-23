import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentJob, ServerMessage } from "@neocode/protocol";
import { Orchestrator } from "./orchestrator.js";
import { canAutomaticallyResume } from "./recovery.js";
import { RUNTIME_STATE_VERSION, type DurableRuntimeState, type RuntimeStateStore } from "./runtime-state.js";

function runningJob(): AgentJob {
  return {
    id: "lease-loss",
    title: "lease loss",
    prompt: "work",
    status: "running",
    branch: "neocode/lease-loss",
    worktree: "/tmp/lease-loss",
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/lease-loss" },
    baseRef: "base",
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: "user", role: "user", text: "work", timestamp: 1 }],
    activityHistory: [],
    recovery: {
      retryCount: 0,
      maxRetries: 3,
      generation: 1,
      leaseToken: "generation-1",
      leaseExpiresAt: Date.now() + 1_000,
    },
    attempts: [{ number: 1, generation: 1, token: "generation-1", reason: "initial", startedAt: 1 }],
  };
}

function durableState(root: string, job: AgentJob): DurableRuntimeState {
  return {
    version: RUNTIME_STATE_VERSION,
    workspaceRoot: root,
    updatedAt: Date.now(),
    coordinator: { messages: [] },
    jobs: [{ job: structuredClone(job) }],
  };
}

function fakeSession() {
  return {
    isIdle: true,
    async abort() {},
    dispose() {},
  };
}

test("orchestrator rejects every callback from a generation after durable lease ownership transfers", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-orchestrator-lease-"));
  const emitted: ServerMessage[] = [];
  try {
    const orchestrator = new Orchestrator(root, (message) => emitted.push(message), { startup: false });
    let subscriber: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    let aborts = 0;
    const session = {
      subscribe(callback: (event: { type: string; [key: string]: unknown }) => void) { subscriber = callback; return () => undefined; },
      async abort() { aborts += 1; },
      dispose() {},
    };
    const internals = orchestrator as unknown as {
      jobs: Map<string, AgentJob>;
      workers: Map<string, { session: unknown; cancelled: boolean; generation: number; token: string }>;
      bindWorker(job: AgentJob, session: unknown, generation: number, token: string): void;
      loseWorkerLease(job: AgentJob, durable: AgentJob, generation: number, token: string): Promise<void>;
      isCurrentAttempt(job: AgentJob, generation: number, token: string): boolean;
    };
    const stale = runningJob();
    internals.jobs.set(stale.id, stale);
    internals.workers.set(stale.id, { session, cancelled: false, generation: 1, token: "generation-1" });
    internals.bindWorker(stale, session, 1, "generation-1");

    const successor = structuredClone(stale);
    successor.runtimeRevision = 10;
    successor.recovery!.generation = 2;
    successor.recovery!.leaseToken = "generation-2";
    successor.recovery!.leaseExpiresAt = Date.now() + 30_000;
    await internals.loseWorkerLease(stale, successor, 1, "generation-1");

    assert.equal(aborts, 1, "the former generation is aborted after ownership transfer");
    assert.equal(internals.jobs.get(stale.id)?.recovery?.leaseToken, "generation-2");
    assert.equal(stale.recovery?.leaseToken, undefined, "the exact captured callback object is invalidated");
    assert.equal(internals.isCurrentAttempt(stale, 1, "generation-1"), false);
    const emittedAtLoss = emitted.length;
    const staleMessages = stale.messages.length;

    subscriber?.({ type: "agent_start" });
    subscriber?.({ type: "message_start", message: { role: "assistant" } });
    subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stale output" } });
    subscriber?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stale output" }] } });

    assert.equal(stale.messages.length, staleMessages, "stale transcript callbacks are ignored");
    assert.equal(stale.activity, undefined, "stale activity callbacks are ignored");
    assert.equal(emitted.length, emittedAtLoss, "stale callbacks emit no job updates");
    assert.equal(internals.jobs.get(stale.id)?.status, "running", "stale terminal logic cannot mutate canonical ownership");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean shutdown durably relinquishes only the generation it owns", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-orchestrator-shutdown-"));
  try {
    const owner = new Orchestrator(root, () => undefined, { startup: false });
    const job = runningJob();
    job.runtimeRevision = 1;
    const ownerInternals = owner as unknown as {
      jobs: Map<string, AgentJob>;
      workers: Map<string, { session: ReturnType<typeof fakeSession>; cancelled: boolean; generation: number; token: string }>;
      coordinator: ReturnType<typeof fakeSession>;
      stateStore: RuntimeStateStore;
    };
    ownerInternals.jobs.set(job.id, job);
    ownerInternals.workers.set(job.id, { session: fakeSession(), cancelled: false, generation: 1, token: "generation-1" });
    ownerInternals.coordinator = fakeSession();
    ownerInternals.stateStore.save(durableState(root, job));
    await ownerInternals.stateStore.flush();

    const staleSnapshot = structuredClone(job);
    await owner.dispose();
    const relinquished = (await ownerInternals.stateStore.load())!.jobs[0]!.job;
    assert.equal(relinquished.status, "interrupted");
    assert.equal(relinquished.runtimeRevision, 2);
    assert.equal(relinquished.recovery?.leaseToken, undefined);
    assert.equal(relinquished.recovery?.leaseAcquiredAt, undefined);
    assert.equal(relinquished.recovery?.leaseExpiresAt, undefined);

    const successor = structuredClone(relinquished);
    successor.status = "running";
    successor.recovery!.generation = 2;
    successor.recovery!.leaseToken = "generation-2";
    successor.recovery!.leaseAcquiredAt = Date.now();
    successor.recovery!.leaseExpiresAt = Date.now() + 30_000;
    const generation2 = await ownerInternals.stateStore.compareAndSwapJob(successor, {
      revision: 2, generation: 1, token: null,
    });
    assert.equal(generation2?.runtimeRevision, 3);

    const staleServer = new Orchestrator(root, () => undefined, { startup: false });
    const staleInternals = staleServer as unknown as typeof ownerInternals;
    staleInternals.jobs.set(staleSnapshot.id, staleSnapshot);
    staleInternals.workers.set(staleSnapshot.id, {
      session: fakeSession(), cancelled: false, generation: 1, token: "generation-1",
    });
    staleInternals.coordinator = fakeSession();
    await staleServer.dispose();
    const durable = (await staleInternals.stateStore.load())!.jobs[0]!.job;
    assert.equal(durable.recovery?.generation, 2);
    assert.equal(durable.recovery?.leaseToken, "generation-2", "stale dispose cannot clear successor ownership");
    assert.equal(durable.runtimeRevision, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease expiry during initialization waits for recovery readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-orchestrator-readiness-"));
  try {
    const orchestrator = new Orchestrator(root, () => undefined, { startup: false });
    const job = runningJob();
    job.runtimeRevision = 1;
    job.recovery!.leaseExpiresAt = Date.now() + 10;
    let starts = 0;
    const internals = orchestrator as unknown as {
      jobs: Map<string, AgentJob>;
      workers: Map<string, unknown>;
      startupRecoveryIds: Set<string>;
      recoveryReady: boolean;
      recoveryConfig: { backoffMs: number; maxBackoffMs: number };
      stateStore: RuntimeStateStore;
      deferRecoveryLeaseTakeover(job: AgentJob): void;
      resumeRestoredJobs(): Promise<void>;
      validateRecoveryCheckout(job: AgentJob): Promise<void>;
      startRecoveryAttempt(job: AgentJob, reason: string): Promise<void>;
    };
    internals.jobs.set(job.id, job);
    internals.stateStore.save(durableState(root, job));
    await internals.stateStore.flush();
    internals.validateRecoveryCheckout = async (candidate) => {
      candidate.recoverable = true;
      delete candidate.recoveryIssue;
    };
    internals.startRecoveryAttempt = async () => { starts += 1; };
    internals.recoveryConfig.backoffMs = 0;
    internals.recoveryConfig.maxBackoffMs = 0;

    internals.deferRecoveryLeaseTakeover(job);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(starts, 0, "timer cannot start a worker before coordinator/model initialization completes");
    assert.equal(internals.workers.size, 0);
    assert.equal(internals.startupRecoveryIds.has(job.id), true, "expired recovery remains queued behind readiness");

    internals.recoveryReady = true;
    await internals.resumeRestoredJobs();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(starts, 1, "queued recovery launches exactly once after readiness opens");
    assert.equal(internals.startupRecoveryIds.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["completed", "cancelled", "shutdown"] as const) {
  test(`${mode} transition waits for the one authoritative durable lease renewal`, async () => {
    const root = await mkdtemp(join(tmpdir(), `neocode-renewal-${mode}-`));
    try {
      const orchestrator = new Orchestrator(root, () => undefined, { startup: false });
      const job = runningJob();
      job.runtimeRevision = 1;
      let releaseRenewal!: () => void;
      const renewalGate = new Promise<void>((resolve) => { releaseRenewal = resolve; });
      let renewalEntered!: () => void;
      const entered = new Promise<void>((resolve) => { renewalEntered = resolve; });
      type Internals = {
        jobs: Map<string, AgentJob>;
        stateStore: RuntimeStateStore & { renewJobLease: RuntimeStateStore["renewJobLease"] };
        workerLeaseRenewals: Map<string, Promise<void>>;
        renewWorkerLeaseOnce(job: AgentJob, generation: number, token: string): Promise<void>;
        commitOwnedTerminal(job: AgentJob, generation: number, token: string, mutate: () => void): Promise<boolean>;
        relinquishWorkerForShutdown(job: AgentJob, generation: number, token: string): Promise<boolean>;
      };
      const internals = orchestrator as unknown as Internals;
      internals.jobs.set(job.id, job);
      internals.stateStore.save(durableState(root, job));
      await internals.stateStore.flush();
      const durableRenew = internals.stateStore.renewJobLease.bind(internals.stateStore);
      internals.stateStore.renewJobLease = async (...args) => {
        renewalEntered();
        await renewalGate;
        return durableRenew(...args);
      };

      const renewal = internals.renewWorkerLeaseOnce(job, 1, "generation-1");
      await entered;
      const overlapOne = internals.renewWorkerLeaseOnce(job, 1, "generation-1");
      const overlapTwo = internals.renewWorkerLeaseOnce(job, 1, "generation-1");
      assert.equal(overlapOne, renewal);
      assert.equal(overlapTwo, renewal, "overlapping ticks retain the exact authoritative promise");
      assert.equal(internals.workerLeaseRenewals.get(job.id), renewal);

      let transitionSettled = false;
      const transition = (mode === "shutdown"
        ? internals.relinquishWorkerForShutdown(job, 1, "generation-1")
        : internals.commitOwnedTerminal(job, 1, "generation-1", () => {
          job.status = mode;
          job.recoverable = false;
          delete job.recovery!.leaseToken;
          delete job.recovery!.leaseAcquiredAt;
          delete job.recovery!.leaseExpiresAt;
        })).finally(() => { transitionSettled = true; });
      const tickAfterStop = internals.renewWorkerLeaseOnce(job, 1, "generation-1");
      await tickAfterStop;
      assert.notEqual(tickAfterStop, renewal, "stopping fences timer callbacks queued after scheduling is cleared");
      assert.equal(internals.workerLeaseRenewals.get(job.id), renewal);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(transitionSettled, false, "terminal transition waits for the paused renewal");
      assert.equal((await internals.stateStore.load())!.jobs[0]!.job.status, "running");

      releaseRenewal();
      await Promise.all([renewal, overlapOne, overlapTwo, transition]);
      const durable = (await internals.stateStore.load())!.jobs[0]!.job;
      assert.equal(durable.runtimeRevision, 3, "renewal revision is fenced before terminal CAS");
      assert.equal(durable.status, mode === "shutdown" ? "interrupted" : mode);
      assert.equal(durable.recovery?.leaseToken, undefined);
      assert.equal(durable.recovery?.leaseAcquiredAt, undefined);
      assert.equal(durable.recovery?.leaseExpiresAt, undefined);
      assert.equal(internals.workerLeaseRenewals.has(job.id), false);
      if (mode === "shutdown") {
        assert.equal(canAutomaticallyResume(durable), true, "owned shutdown remains intentionally recoverable");
      } else {
        assert.equal(canAutomaticallyResume(durable), false, "terminal work is never automatically recovered");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function pausedInitializationScenario(successorBeforeDispose: boolean): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `neocode-initializing-dispose-${successorBeforeDispose}-`));
  const emitted: ServerMessage[] = [];
  try {
    const orchestrator = new Orchestrator(root, (message) => emitted.push(message), { startup: false });
    const job = runningJob();
    job.runtimeRevision = 1;
    let creationEntered!: () => void;
    const entered = new Promise<void>((resolve) => { creationEntered = resolve; });
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    let subscribes = 0, prompts = 0, aborts = 0, disposals = 0;
    const workerSession = {
      subscribe() { subscribes += 1; return () => undefined; },
      async prompt() { prompts += 1; },
      async abort() { aborts += 1; },
      dispose() { disposals += 1; },
    };
    type InitRecord = { run?: Promise<void> };
    const internals = orchestrator as unknown as {
      jobs: Map<string, AgentJob>;
      workers: Map<string, unknown>;
      initializingWorkers: Map<string, InitRecord>;
      coordinator: ReturnType<typeof fakeSession>;
      stateStore: RuntimeStateStore;
      launchWorker(job: AgentJob, attachments: [], attempt: { generation: number; token: string; resume: boolean }): void;
      createWorkerAgentSession(options: unknown): Promise<{ session: typeof workerSession }>;
    };
    internals.jobs.set(job.id, job);
    internals.coordinator = fakeSession();
    internals.stateStore.save(durableState(root, job));
    await internals.stateStore.flush();
    internals.createWorkerAgentSession = async () => {
      creationEntered();
      await creationGate;
      return { session: workerSession };
    };
    internals.launchWorker(job, [], { generation: 1, token: "generation-1", resume: false });
    const run = internals.initializingWorkers.get(job.id)!.run!;
    await entered;

    if (successorBeforeDispose) {
      const successor = structuredClone(job);
      successor.recovery!.generation = 2;
      successor.recovery!.leaseToken = "generation-2";
      successor.recovery!.leaseAcquiredAt = Date.now();
      successor.recovery!.leaseExpiresAt = Date.now() + 30_000;
      assert.ok(await internals.stateStore.compareAndSwapJob(successor, {
        revision: 1, generation: 1, token: "generation-1",
      }));
    }

    await orchestrator.dispose();
    let durable = (await internals.stateStore.load())!.jobs[0]!.job;
    if (successorBeforeDispose) {
      assert.equal(durable.recovery?.generation, 2);
      assert.equal(durable.recovery?.leaseToken, "generation-2", "stale disposer preserves successor ownership");
    } else {
      assert.equal(durable.status, "interrupted", "owned initializing lease is durably relinquished");
      assert.equal(durable.recovery?.leaseToken, undefined);
      const successor = structuredClone(durable);
      successor.status = "running";
      successor.recovery!.generation = 2;
      successor.recovery!.leaseToken = "generation-2";
      successor.recovery!.leaseAcquiredAt = Date.now();
      successor.recovery!.leaseExpiresAt = Date.now() + 30_000;
      assert.ok(await internals.stateStore.compareAndSwapJob(successor, {
        revision: durable.runtimeRevision, generation: 1, token: null,
      }));
    }
    const emittedBeforeRelease = emitted.length;
    releaseCreation();
    await run;

    durable = (await internals.stateStore.load())!.jobs[0]!.job;
    assert.equal(durable.recovery?.generation, 2);
    assert.equal(durable.recovery?.leaseToken, "generation-2");
    assert.equal(internals.workers.size, 0);
    assert.equal(subscribes, 0);
    assert.equal(prompts, 0);
    assert.equal(aborts, 1, "a session created after shutdown is immediately aborted");
    assert.equal(disposals, 1);
    assert.equal(emitted.length, emittedBeforeRelease, "released initialization emits and persists nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("dispose fences a paused initializing owner and relinquishes it before successor takeover", async () => {
  await pausedInitializationScenario(false);
});

test("dispose of a paused stale initializer cannot clear ownership already transferred to a successor", async () => {
  await pausedInitializationScenario(true);
});

test("expired ownership self-fences callbacks and failed renewal before successor takeover", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-expired-self-fence-"));
  const emitted: ServerMessage[] = [];
  try {
    const orchestrator = new Orchestrator(root, (message) => emitted.push(message), { startup: false });
    let subscriber: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    let aborts = 0;
    const session = {
      subscribe(callback: typeof subscriber) { subscriber = callback; return () => undefined; },
      async abort() { aborts += 1; },
      dispose() {},
    };
    const job = runningJob();
    job.runtimeRevision = 1;
    job.recovery!.leaseExpiresAt = Date.now() - 1;
    const internals = orchestrator as unknown as {
      jobs: Map<string, AgentJob>;
      workers: Map<string, { session: typeof session; cancelled: boolean; generation: number; token: string }>;
      stateStore: RuntimeStateStore;
      bindWorker(job: AgentJob, session: unknown, generation: number, token: string): void;
      isCurrentAttempt(job: AgentJob, generation: number, token: string): boolean;
      renewWorkerLeaseOnce(job: AgentJob, generation: number, token: string): Promise<void>;
    };
    internals.jobs.set(job.id, job);
    internals.workers.set(job.id, { session, cancelled: false, generation: 1, token: "generation-1" });
    internals.stateStore.save(durableState(root, job));
    await internals.stateStore.flush();
    internals.bindWorker(job, session, 1, "generation-1");
    const before = emitted.length;
    subscriber?.({ type: "agent_start" });
    subscriber?.({ type: "message_start", message: { role: "assistant" } });
    subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "expired" } });
    assert.equal(internals.isCurrentAttempt(job, 1, "generation-1"), false);
    assert.equal(job.messages.length, 1);
    assert.equal(emitted.length, before);

    await internals.renewWorkerLeaseOnce(job, 1, "generation-1");
    assert.equal(aborts, 1, "expired owner is aborted when renewal cannot be durably confirmed");
    assert.equal(job.recovery?.leaseToken, undefined);
    const timers = orchestrator as unknown as {
      recoveryTimers: Map<string, NodeJS.Timeout>;
      workerLeaseTimers: Map<string, NodeJS.Timeout>;
      workerLeaseExpiryTimers: Map<string, NodeJS.Timeout>;
    };
    for (const timer of timers.recoveryTimers.values()) clearTimeout(timer);
    for (const timer of timers.workerLeaseTimers.values()) clearInterval(timer);
    for (const timer of timers.workerLeaseExpiryTimers.values()) clearTimeout(timer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful durable renewal extends callback authority and keeps 10,000-message transport bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-renewed-transport-"));
  const emitted: ServerMessage[] = [];
  try {
    const orchestrator = new Orchestrator(root, (message) => emitted.push(message), { startup: false });
    const job = runningJob();
    job.runtimeRevision = 1;
    job.recovery!.leaseExpiresAt = Date.now() + 5_000;
    job.messages = Array.from({ length: 10_000 }, (_, index) => ({
      id: `message-${index}`, role: "assistant" as const, text: `message ${index}`, timestamp: index,
    }));
    const internals = orchestrator as unknown as {
      jobs: Map<string, AgentJob>;
      stateStore: RuntimeStateStore;
      renewWorkerLeaseOnce(job: AgentJob, generation: number, token: string): Promise<void>;
      isCurrentAttempt(job: AgentJob, generation: number, token: string): boolean;
      acceptCommittedJob(job: AgentJob, committed: AgentJob): void;
      loseWorkerLease(job: AgentJob, durable: AgentJob, generation: number, token: string): Promise<void>;
    };
    internals.jobs.set(job.id, job);
    internals.stateStore.save(durableState(root, job));
    await internals.stateStore.flush();
    const oldExpiry = job.recovery!.leaseExpiresAt!;
    await internals.renewWorkerLeaseOnce(job, 1, "generation-1");
    assert.ok(job.recovery!.leaseExpiresAt! > oldExpiry);
    assert.equal(internals.isCurrentAttempt(job, 1, "generation-1"), true);
    internals.acceptCommittedJob(job, structuredClone(job));
    assert.equal((await internals.stateStore.load())!.jobs[0]!.job.messages.length, 10_000,
      "transport projection never truncates durable history");
    const successor = structuredClone(job);
    successor.recovery!.generation = 2;
    successor.recovery!.leaseToken = "generation-2";
    successor.recovery!.leaseExpiresAt = Date.now() + 30_000;
    await internals.loseWorkerLease(job, successor, 1, "generation-1");
    const updates = emitted.filter((message): message is Extract<ServerMessage, { type: "job_updated" }> => message.type === "job_updated");
    assert.ok(updates.length >= 1);
    for (const update of updates) {
      assert.ok(update.job.messages.length < 10_000);
      assert.equal(update.job.messages.at(-1)?.id, "message-9999");
      assert.equal(update.job.transcriptPage?.hasOlder, true);
    }
    assert.ok(updates.length >= 3, "renewal, guarded adoption, and lease-loss paths all emit bounded projections");
    const timers = orchestrator as unknown as {
      recoveryTimers: Map<string, NodeJS.Timeout>;
      workerLeaseTimers: Map<string, NodeJS.Timeout>;
      workerLeaseExpiryTimers: Map<string, NodeJS.Timeout>;
    };
    for (const timer of timers.recoveryTimers.values()) clearTimeout(timer);
    for (const timer of timers.workerLeaseTimers.values()) clearInterval(timer);
    for (const timer of timers.workerLeaseExpiryTimers.values()) clearTimeout(timer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const successorBeforeCancel of [false, true]) {
  test(`cancellation fences a paused initializer${successorBeforeCancel ? " and preserves successor ownership" : ""}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `neocode-initializing-cancel-${successorBeforeCancel}-`));
    const emitted: ServerMessage[] = [];
    try {
      const orchestrator = new Orchestrator(root, (message) => emitted.push(message), { startup: false });
      const job = runningJob();
      job.runtimeRevision = 1;
      let entered!: () => void, release!: () => void;
      const creationEntered = new Promise<void>((resolve) => { entered = resolve; });
      const creationGate = new Promise<void>((resolve) => { release = resolve; });
      let subscribes = 0, prompts = 0, aborts = 0, disposals = 0;
      const session = {
        subscribe() { subscribes += 1; return () => undefined; },
        async prompt() { prompts += 1; },
        async abort() { aborts += 1; },
        dispose() { disposals += 1; },
      };
      const internals = orchestrator as unknown as {
        jobs: Map<string, AgentJob>;
        initializingWorkers: Map<string, { run?: Promise<void> }>;
        stateStore: RuntimeStateStore;
        launchWorker(job: AgentJob, attachments: [], attempt: { generation: number; token: string; resume: boolean }): void;
        createWorkerAgentSession(options: unknown): Promise<{ session: typeof session }>;
      };
      internals.jobs.set(job.id, job);
      internals.stateStore.save(durableState(root, job));
      await internals.stateStore.flush();
      internals.createWorkerAgentSession = async () => { entered(); await creationGate; return { session }; };
      internals.launchWorker(job, [], { generation: 1, token: "generation-1", resume: false });
      const run = internals.initializingWorkers.get(job.id)!.run!;
      await creationEntered;
      if (successorBeforeCancel) {
        const successor = structuredClone(job);
        successor.recovery!.generation = 2;
        successor.recovery!.leaseToken = "generation-2";
        successor.recovery!.leaseExpiresAt = Date.now() + 30_000;
        assert.ok(await internals.stateStore.compareAndSwapJob(successor, {
          revision: 1, generation: 1, token: "generation-1",
        }));
      }
      if (successorBeforeCancel) await assert.rejects(() => orchestrator.cancelJob(job.id), /changed ownership/);
      else await orchestrator.cancelJob(job.id);
      const emittedBeforeRelease = emitted.length;
      release();
      await run;
      const durable = (await internals.stateStore.load())!.jobs[0]!.job;
      assert.equal(durable.status, successorBeforeCancel ? "running" : "cancelled");
      assert.equal(durable.recovery?.generation, successorBeforeCancel ? 2 : 1);
      assert.equal(durable.recovery?.leaseToken, successorBeforeCancel ? "generation-2" : undefined);
      assert.equal(subscribes, 0);
      assert.equal(prompts, 0);
      assert.equal(aborts, 1);
      assert.equal(disposals, 1);
      assert.equal(emitted.length, emittedBeforeRelease);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
