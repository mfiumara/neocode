import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentJob, CoordinatorContextState, ServerMessage, TranscriptMessage } from "@neocode/protocol";
import { Orchestrator } from "./orchestrator.js";

interface FakeSession {
  isIdle: boolean;
  autoCompactionEnabled: boolean;
  model?: { provider: string; id: string };
  setModel: (model: { provider: string; id: string; contextWindow?: number }) => Promise<void>;
  usage: { tokens: number | null; contextWindow: number; percent: number | null };
  listener?: (event: any) => void;
  compact: () => Promise<any>;
  prompt: (content: string) => Promise<void>;
  getContextUsage: () => FakeSession["usage"];
  subscribe: (listener: (event: any) => void) => void;
  abort: () => Promise<void>;
  abortCompaction: () => void;
  dispose: () => void;
}

async function fixture(compact?: (session: FakeSession) => Promise<any>) {
  const cwd = await mkdtemp(join(tmpdir(), "neocode-context-"));
  const events: ServerMessage[] = [];
  const orchestrator = new Orchestrator(cwd, (event) => events.push(event), {
    startup: false, intervalMs: 0, sweepIntervalMs: 0,
  });
  const session: FakeSession = {
    isIdle: true,
    autoCompactionEnabled: true,
    model: { provider: "test", id: "old-model" },
    setModel: async (model) => {
      session.model = model;
      session.usage = { tokens: 48_000, contextWindow: model.contextWindow || 128_000, percent: 48_000 / (model.contextWindow || 128_000) * 100 };
    },
    usage: { tokens: 48_000, contextWindow: 128_000, percent: 37.5 },
    getContextUsage() { return this.usage; },
    subscribe(listener) { this.listener = listener; },
    compact: async () => undefined,
    prompt: async () => undefined,
    abort: async () => undefined,
    abortCompaction: () => undefined,
    dispose: () => undefined,
  };
  session.compact = () => compact?.(session) ?? Promise.resolve(undefined);
  const internal = orchestrator as any;
  internal.coordinator = session;
  internal.bindCoordinator();
  return { cwd, events, orchestrator, internal, session };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cleanupFixture(value: Fixture): Promise<void> {
  // Orchestrator.dispose owns shutdown ordering: stop timers/notification turns,
  // abort the SDK session, enqueue the final durable state, and await its flush.
  await value.orchestrator.dispose();
  const store = value.internal.stateStore;
  let writesAfterRemovalBegan = 0;
  const save = store.save.bind(store);
  store.save = (...args: unknown[]) => {
    writesAfterRemovalBegan += 1;
    return save(...args);
  };
  await rm(value.cwd, { recursive: true, force: true });
  assert.equal(writesAfterRemovalBegan, 0, "no orchestrator-owned writer starts after disposal and removal begin");
  await assert.rejects(access(value.cwd));
}

async function waitFor(check: () => boolean, timeout = 1_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for coordinator state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function latestContext(events: ServerMessage[]): CoordinatorContextState {
  const event = events.filter((entry) => entry.type === "coordinator_context").at(-1);
  assert.equal(event?.type, "coordinator_context");
  return event.context;
}

test("context state carries safe initial usage, capacity, auto-compaction, and reconnect refreshes", async () => {
  const value = await fixture();
  try {
    value.internal.settings = () => ({ variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: [] });
    value.internal.currentModel = () => ({ provider: "test", id: "model" });
    value.internal.modelChoices = () => [];
    const initialSnapshot = value.orchestrator.snapshot();
    assert.equal(initialSnapshot.coordinator.context.usage?.tokens, 48_000);
    assert.equal(initialSnapshot.coordinator.context.autoCompactionEnabled, true);

    assert.deepEqual({
      tokens: initialSnapshot.coordinator.context.usage!.tokens,
      contextWindow: initialSnapshot.coordinator.context.usage!.contextWindow,
      percent: initialSnapshot.coordinator.context.usage!.percent,
    }, { tokens: 48_000, contextWindow: 128_000, percent: 37.5 });
    assert.equal(initialSnapshot.coordinator.context.manualCompactionAvailable, true);

    // A reconnect asks snapshot() again; no test-only live publish helper is
    // involved, and current SDK state must win over the prior snapshot.
    value.session.autoCompactionEnabled = false;
    value.session.usage = { tokens: 49_000, contextWindow: 128_000, percent: 38.28125 };
    const reconnectSnapshot = value.orchestrator.snapshot();
    assert.equal(reconnectSnapshot.coordinator.context.usage?.tokens, 49_000);
    assert.equal(reconnectSnapshot.coordinator.context.autoCompactionEnabled, false);
  } finally { await cleanupFixture(value); }
});

test("setModel refreshes context capacity and publishes truthful gate transitions", async () => {
  const value = await fixture();
  try {
    value.internal.modelRuntime = {
      getAvailableSnapshot: () => [{ provider: "test", id: "new-model", contextWindow: 200_000 }],
    };
    value.internal.publishSettings = () => undefined;
    value.internal.persist = () => undefined;
    await value.orchestrator.setModel({ provider: "test", id: "new-model" });
    const contextEvents = value.events.filter((event): event is Extract<ServerMessage, { type: "coordinator_context" }> => event.type === "coordinator_context");
    assert.ok(contextEvents.some((event) => event.context.manualCompactionAvailable === false), "model transition closes the manual gate");
    assert.equal(contextEvents.at(-1)?.context.manualCompactionAvailable, true, "model release republishes the open gate");
    assert.equal(contextEvents.at(-1)?.context.usage?.contextWindow, 200_000);
    assert.ok(value.events.some((event) => event.type === "coordinator_model_updated" && event.model.id === "new-model"));
  } finally { await cleanupFixture(value); }
});

test("manual compaction is idle-only, reports completion, makes usage unknown, and preserves durable transcript", async () => {
  const value = await fixture(async (session) => {
    session.listener?.({ type: "compaction_start", reason: "manual" });
    session.usage = { tokens: null, contextWindow: 128_000, percent: null };
    const result = { summary: "private generated summary", firstKeptEntryId: "private-id", tokensBefore: 48_000, estimatedTokensAfter: 19_000 };
    session.listener?.({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
    return result;
  });
  try {
    const durable: TranscriptMessage = { id: "durable", role: "user", text: "must remain", timestamp: 1 };
    value.internal.coordinatorMessages.push(durable);
    await value.orchestrator.compactCoordinator();
    const state = latestContext(value.events);
    assert.equal(state.compaction?.state, "completed");
    assert.equal(state.compaction?.tokensBefore, 48_000);
    assert.equal(state.compaction?.estimatedTokensAfter, 19_000);
    assert.equal(state.usage?.tokens, null);
    assert.equal(state.usage?.percent, null);
    assert.equal(state.manualCompactionAvailable, true);
    assert.deepEqual(value.internal.coordinatorMessages, [durable]);
    assert.doesNotMatch(JSON.stringify(value.events), /private generated summary|private-id/);
  } finally { await cleanupFixture(value); }
});

test("manual compaction rejects queued work and reports SDK failures without a stale active state", async () => {
  const blocked = await fixture();
  try {
    blocked.internal.coordinatorTurnInFlight = true;
    await blocked.orchestrator.prompt("queued", [], [], "queued-for-compaction");
    blocked.internal.coordinatorTurnInFlight = false;
    await assert.rejects(blocked.orchestrator.compactCoordinator(), /queued coordinator prompts/);
  } finally { await cleanupFixture(blocked); }

  const failed = await fixture(async (session) => {
    session.listener?.({ type: "compaction_start", reason: "manual" });
    session.listener?.({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: true, errorMessage: "provider unavailable" });
    throw new Error("provider unavailable");
  });
  try {
    await assert.rejects(failed.orchestrator.compactCoordinator(), /provider unavailable/);
    assert.equal(latestContext(failed.events).compaction?.state, "failed");
    assert.equal(latestContext(failed.events).compaction?.error, "provider unavailable");
    assert.equal(latestContext(failed.events).compaction?.willRetry, true);
    assert.equal(latestContext(failed.events).manualCompactionAvailable, true);
    failed.internal.settings = () => ({ variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: [] });
    failed.internal.currentModel = () => ({ provider: "test", id: "old-model" });
    failed.internal.modelChoices = () => [];
    assert.equal(failed.orchestrator.snapshot().coordinator.context.compaction?.willRetry, true, "reconnect snapshot retains retry intent");
  } finally { await cleanupFixture(failed); }
});

test("production lifecycle wake reservation shares compaction, model, disposal, and turn gates", async () => {
  const value = await fixture();
  try {
    value.internal.activeReviewLaneIds = () => new Set<string>();
    value.internal.initializeCoordinatorNotifications();
    const hooks = value.internal.coordinatorNotifications.hooks;
    const event = { jobId: "worker-1" };

    value.internal.coordinatorCompacting = true;
    assert.equal(hooks.isIdle(), false);
    assert.equal(hooks.reserveTurn(event), undefined);
    value.internal.coordinatorCompacting = false;
    value.internal.modelChangeInProgress = true;
    assert.equal(hooks.reserveTurn(event), undefined);
    value.internal.modelChangeInProgress = false;
    value.internal.disposing = true;
    assert.equal(hooks.reserveTurn(event), undefined);
    value.internal.disposing = false;

    const release = hooks.reserveTurn(event);
    assert.equal(typeof release, "function");
    assert.equal(value.internal.coordinatorTurnInFlight, true);
    assert.equal(hooks.reserveTurn(event), undefined, "a user or second system wake cannot race the reservation");
    release();
    assert.equal(value.internal.coordinatorTurnInFlight, false);
    hooks.turnReleased();
    assert.equal(latestContext(value.events).manualCompactionAvailable, true, "system-wake release publishes open availability");
  } finally { await cleanupFixture(value); }
});

test("dispose awaits real notification persistence and invalidates delayed release callbacks", async () => {
  const value = await fixture();
  let disposed = false;
  try {
    value.internal.activeReviewLaneIds = () => new Set<string>();
    const job: AgentJob = {
      id: "dispose-race", title: "Dispose race", prompt: "", status: "failed",
      branch: "worker", worktree: "/tmp/worker",
      isolation: { requested: "worktree", mode: "worktree", path: "/tmp/worker" },
      baseRef: "base", createdAt: 1, updatedAt: 2, messages: [], error: "failure",
    };
    value.internal.jobs.set(job.id, job);
    value.internal.initializeCoordinatorNotifications();
    const queue = value.internal.coordinatorNotifications;
    const hooks = queue.hooks;
    const store = value.internal.stateStore;
    const durableFlush = store.flush.bind(store);
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
    let flushCalls = 0;
    store.flush = () => {
      flushCalls += 1;
      return flushCalls === 1 ? persistenceGate.then(() => durableFlush()) : durableFlush();
    };

    queue.observe(job); // starts the real append -> persistThenDrain continuation
    let disposalReturned = false;
    const disposal = value.orchestrator.dispose().then(() => { disposalReturned = true; disposed = true; });
    await Promise.resolve();
    assert.equal(disposalReturned, false, "dispose remains owned by the blocked notification persistence");
    releasePersistence();
    await disposal;

    let savesAfterDispose = 0;
    const durableSave = store.save.bind(store);
    store.save = (...args: unknown[]) => { savesAfterDispose += 1; return durableSave(...args); };
    hooks.turnReleased();
    queue.settled();
    assert.equal(savesAfterDispose, 0, "stopped queue and delayed turn release cannot persist after dispose returns");
    await rm(value.cwd, { recursive: true, force: true });
    await assert.rejects(access(value.cwd));
  } finally {
    if (!disposed) await cleanupFixture(value);
  }
});

test("reserved system turns and compaction jointly gate FIFO prompts until authoritative settlement", async () => {
  const value = await fixture();
  try {
    const calls: string[] = [];
    let releasePrompt!: () => void;
    const promptPending = new Promise<void>((resolve) => { releasePrompt = resolve; });
    value.session.prompt = async (content) => {
      calls.push(content);
      value.session.isIdle = false;
      await promptPending;
    };
    let notificationSettlements = 0;
    value.internal.coordinatorNotifications = {
      agentSettled: () => { notificationSettlements += 1; },
      settled: () => undefined,
      hasPendingWake: () => false,
      requestBacklogSweep: () => false,
      shutdown: () => undefined,
    };

    // Model a lifecycle/system wake that synchronously owns the shared Pi turn.
    value.internal.coordinatorTurnInFlight = true;
    await assert.rejects(value.orchestrator.compactCoordinator(), /current coordinator turn/);
    await value.orchestrator.prompt("queued behind system wake", [], [], "combined-gate");
    assert.equal(calls.length, 0);
    assert.deepEqual(value.internal.pendingCoordinatorPrompts.map((entry: any) => entry.messageId), ["combined-gate"]);

    // Even after the wake releases, an overlapping SDK compaction keeps FIFO
    // work queued rather than dropping or racing it.
    value.session.listener?.({ type: "compaction_start", reason: "threshold" });
    value.internal.coordinatorTurnInFlight = false;
    value.internal.schedulePromptDrain();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 0);

    value.session.listener?.({ type: "compaction_end", reason: "threshold", result: undefined, aborted: true, willRetry: false });
    await waitFor(() => calls.length === 1);
    assert.equal(value.internal.coordinatorTurnInFlight, true);
    value.session.usage = { tokens: 24_000, contextWindow: 128_000, percent: 18.75 };
    value.session.isIdle = true;
    value.session.listener?.({ type: "agent_settled" });
    assert.equal(notificationSettlements, 1, "Pi settlement remains authoritative for a claimed system wake");
    assert.equal(latestContext(value.events).usage?.tokens, 24_000, "the same settlement publishes trustworthy context");
    assert.equal(latestContext(value.events).manualCompactionAvailable, false, "settlement does not advertise idle before turn release");

    releasePrompt();
    await waitFor(() => value.internal.pendingCoordinatorPrompts.length === 0);
    assert.equal(value.internal.coordinatorTurnInFlight, false);
    assert.equal(latestContext(value.events).manualCompactionAvailable, true, "prompt finally republishes availability after atomic release");
    assert.equal(calls.length, 1, "the durable FIFO prompt runs exactly once after every gate releases");
  } finally { await cleanupFixture(value); }
});

test("fixture cleanup drains concurrent durable writers before removing runtime directories", async () => {
  await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const value = await fixture();
    try {
      await value.orchestrator.prompt(`stress ${index}`, [], [], `stress-${index}`);
      await value.internal.promptDrain;
      assert.equal(value.internal.pendingCoordinatorPrompts.length, 0);
    } finally {
      await cleanupFixture(value);
    }
  }));
});

test("aborted compaction is terminal and later trustworthy settled usage clears unknown state", async () => {
  const value = await fixture();
  try {
    value.session.listener?.({ type: "compaction_start", reason: "threshold" });
    value.session.listener?.({ type: "compaction_end", reason: "threshold", result: undefined, aborted: true, willRetry: false });
    assert.equal(latestContext(value.events).compaction?.state, "aborted");

    value.internal.coordinatorContextUnknownAfterCompaction = true;
    value.session.usage = { tokens: 22_000, contextWindow: 200_000, percent: 11 };
    value.session.listener?.({ type: "agent_settled" });
    assert.equal(latestContext(value.events).usage?.tokens, 22_000);
    assert.equal(latestContext(value.events).usage?.contextWindow, 200_000);
  } finally { await cleanupFixture(value); }
});
