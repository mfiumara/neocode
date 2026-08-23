import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CoordinatorContextState, ServerMessage, TranscriptMessage } from "@neocode/protocol";
import { Orchestrator } from "./orchestrator.js";

interface FakeSession {
  isIdle: boolean;
  autoCompactionEnabled: boolean;
  usage: { tokens: number | null; contextWindow: number; percent: number | null };
  listener?: (event: any) => void;
  compact: () => Promise<any>;
  prompt: (content: string) => Promise<void>;
  getContextUsage: () => FakeSession["usage"];
  subscribe: (listener: (event: any) => void) => void;
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
    usage: { tokens: 48_000, contextWindow: 128_000, percent: 37.5 },
    getContextUsage() { return this.usage; },
    subscribe(listener) { this.listener = listener; },
    compact: async () => undefined,
    prompt: async () => undefined,
  };
  session.compact = () => compact?.(session) ?? Promise.resolve(undefined);
  const internal = orchestrator as any;
  internal.coordinator = session;
  internal.bindCoordinator();
  return { cwd, events, orchestrator, internal, session };
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

    value.internal.publishCoordinatorContext();
    assert.deepEqual(latestContext(value.events).usage && {
      tokens: latestContext(value.events).usage!.tokens,
      contextWindow: latestContext(value.events).usage!.contextWindow,
      percent: latestContext(value.events).usage!.percent,
    }, { tokens: 48_000, contextWindow: 128_000, percent: 37.5 });
    assert.equal(latestContext(value.events).autoCompactionEnabled, true);
    assert.equal(latestContext(value.events).manualCompactionAvailable, true);

    value.session.autoCompactionEnabled = false;
    value.internal.publishCoordinatorContext(); // same path used by reconnect snapshots/live refreshes
    assert.equal(latestContext(value.events).autoCompactionEnabled, false);
  } finally { await rm(value.cwd, { recursive: true, force: true }); }
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
  } finally { await rm(value.cwd, { recursive: true, force: true }); }
});

test("manual compaction rejects queued work and reports SDK failures without a stale active state", async () => {
  const blocked = await fixture();
  try {
    blocked.internal.pendingCoordinatorPrompts.push({ messageId: "queued" });
    await assert.rejects(blocked.orchestrator.compactCoordinator(), /queued coordinator prompts/);
  } finally { await rm(blocked.cwd, { recursive: true, force: true }); }

  const failed = await fixture(async (session) => {
    session.listener?.({ type: "compaction_start", reason: "manual" });
    session.listener?.({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage: "provider unavailable" });
    throw new Error("provider unavailable");
  });
  try {
    await assert.rejects(failed.orchestrator.compactCoordinator(), /provider unavailable/);
    assert.equal(latestContext(failed.events).compaction?.state, "failed");
    assert.equal(latestContext(failed.events).compaction?.error, "provider unavailable");
    assert.equal(latestContext(failed.events).manualCompactionAvailable, true);
  } finally { await rm(failed.cwd, { recursive: true, force: true }); }
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
  } finally { await rm(value.cwd, { recursive: true, force: true }); }
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

    releasePrompt();
    await waitFor(() => value.internal.pendingCoordinatorPrompts.length === 0);
    assert.equal(value.internal.coordinatorTurnInFlight, false);
    assert.equal(calls.length, 1, "the durable FIFO prompt runs exactly once after every gate releases");
  } finally { await rm(value.cwd, { recursive: true, force: true }); }
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
  } finally { await rm(value.cwd, { recursive: true, force: true }); }
});
