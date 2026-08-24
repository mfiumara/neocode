import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentJob, ServerMessage, TranscriptMessage } from "@neocode/protocol";
import { CoordinatorNotificationQueue } from "./coordinator-notifications.js";
import { Orchestrator, workerSystemPrompt } from "./orchestrator.js";
import { RuntimeStateStore, type CoordinatorNotificationState, type DurableCoordinatorPrompt } from "./runtime-state.js";

test("worktree worker prompt reserves judging and integration authority for the main coordinator", () => {
  const prompt = workerSystemPrompt("base", {
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/worker" },
  });

  assert.match(prompt, /never mutate root\/main/i);
  assert.match(prompt, /never merge or advance the main ref, launch a judge, judge the work yourself, or directly start integration/i);
  assert.match(prompt, /only the MAIN coordinator owns those decisions and tool calls/);
  assert.match(prompt, /structured, concise handoff covering requirements, changes, tests, and unresolved risks/);
  assert.match(prompt, /inside this assigned checkout/);
});

test("root isolation stays explicit but every shared-root background worker is read-only", () => {
  const automaticJob = { isolation: { requested: "auto" as const, mode: "root" as const, path: "/repo" } };
  const explicitJob = { isolation: { requested: "root" as const, mode: "root" as const, path: "/repo" } };
  const automatic = workerSystemPrompt(undefined, automaticJob);
  const explicit = workerSystemPrompt(undefined, explicitJob);

  assert.equal(explicitJob.isolation.requested, "root", "prompt policy never rewrites explicit isolation metadata");
  for (const prompt of [automatic, explicit]) {
    assert.match(prompt, /read-only there: inspect and report only; do not edit or mutate the shared checkout/i);
    assert.doesNotMatch(prompt, /edits there are permitted/i);
  }
  assert.match(explicit, /explicitly selected shared root checkout/);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for coordinator queue state");
}

test("concurrent prompt acceptances share failed durability and acknowledge none before a later retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-orchestrator-acceptance-failure-"));
  const events: ServerMessage[] = [];
  const coordinator = { isIdle: false, async prompt() { throw new Error("must remain busy"); } };
  type Harness = {
    coordinator: typeof coordinator;
    stateStore: RuntimeStateStore;
    pendingCoordinatorPrompts: DurableCoordinatorPrompt[];
  };
  try {
    const orchestrator = new Orchestrator(root, (event) => events.push(event), { startup: false, intervalMs: 0, sweepIntervalMs: 0 });
    const harness = orchestrator as unknown as Harness;
    harness.coordinator = coordinator;
    const stateStore = harness.stateStore as unknown as {
      writeAtomic(state: import("./runtime-state.js").DurableRuntimeState): Promise<void>;
    };
    const writeAtomic = stateStore.writeAtomic.bind(stateStore);
    const injected = new Error("coalesced acceptance write failed");
    let fail = true;
    stateStore.writeAtomic = async (state) => {
      if (fail) { fail = false; throw injected; }
      await writeAtomic(state);
    };

    const outcomes = await Promise.allSettled([
      orchestrator.prompt("first", [], [], "accept-1"),
      orchestrator.prompt("second", [], [], "accept-2"),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected"]);
    for (const outcome of outcomes) if (outcome.status === "rejected") assert.equal(outcome.reason, injected);
    assert.equal(events.some((event) => event.type === "coordinator_message"), false);
    assert.equal(harness.pendingCoordinatorPrompts.length, 0);
    await harness.stateStore.flush();

    await orchestrator.prompt("retry", [], [], "accept-retry");
    assert.equal(events.filter((event) => event.type === "coordinator_message").length, 1);
    assert.equal(harness.pendingCoordinatorPrompts[0]?.messageId, "accept-retry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backend failure is durably terminal before broadcast and later FIFO work continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-orchestrator-failure-"));
  const events: ServerMessage[] = [];
  const calls: string[] = [];
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  let terminalWriteStarted!: () => void;
  const terminalStarted = new Promise<void>((resolve) => { terminalWriteStarted = resolve; });
  let paused = false;
  const coordinator = {
    isIdle: true,
    async prompt(content: string): Promise<void> {
      const text = content.split("\n", 1)[0]!;
      calls.push(text);
      if (text === "fails") throw new Error("backend execution failed");
    },
  };
  type Harness = {
    coordinator: typeof coordinator;
    stateStore: RuntimeStateStore;
    pendingCoordinatorPrompts: DurableCoordinatorPrompt[];
  };

  try {
    const orchestrator = new Orchestrator(root, (event) => events.push(event), { startup: false, intervalMs: 0, sweepIntervalMs: 0 });
    const harness = orchestrator as unknown as Harness;
    harness.coordinator = coordinator;
    const stateStore = harness.stateStore as unknown as {
      writeAtomic(state: import("./runtime-state.js").DurableRuntimeState): Promise<void>;
    };
    const writeAtomic = stateStore.writeAtomic.bind(stateStore);
    stateStore.writeAtomic = async (state) => {
      const terminal = state.coordinator.messages.some((message) => message.id === "failure-1" && message.promptState === "failed");
      if (terminal && !paused) {
        paused = true;
        terminalWriteStarted();
        await terminalGate;
      }
      await writeAtomic(state);
    };

    await orchestrator.prompt("fails", [], [], "failure-1");
    await terminalStarted;
    assert.equal(events.some((event) => event.type === "coordinator_prompt_failed"), false, "failure is not broadcast before commit");
    const beforeCommit = await new RuntimeStateStore(root).load();
    assert.equal(beforeCommit?.coordinator.messages.find((message) => message.id === "failure-1")?.promptState, "queued");
    assert.equal(beforeCommit?.coordinator.pendingPrompts?.[0]?.messageId, "failure-1", "a crash before failure commit requeues instead of fabricating failure");

    const laterAcceptance = orchestrator.prompt("later", [], [], "failure-2");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls, ["fails"], "an accepting FIFO item cannot run before its own durable acknowledgement");
    releaseTerminal();
    await laterAcceptance;
    await waitFor(() => harness.pendingCoordinatorPrompts.length === 0);
    await harness.stateStore.flush();

    const failureEvents = events.filter((event) => event.type === "coordinator_prompt_failed");
    assert.equal(failureEvents.length, 1);
    assert.deepEqual(calls, ["fails", "later"], "durably failed head does not strand the next FIFO item");
    const restored = await new RuntimeStateStore(root).load();
    assert.equal(restored?.coordinator.messages.find((message) => message.id === "failure-1")?.promptState, "failed");
    assert.equal(restored?.coordinator.pendingPrompts?.some((entry) => entry.messageId === "failure-1"), false, "restart cannot replay durable failure");
  } finally {
    releaseTerminal();
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal persistence failure fails closed without claiming a durable prompt failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-orchestrator-failure-closed-"));
  const events: ServerMessage[] = [];
  const coordinator = { isIdle: true, async prompt() { throw new Error("backend failed"); } };
  type Harness = { coordinator: typeof coordinator; stateStore: RuntimeStateStore; coordinatorPromptDrainBlocked: boolean };
  try {
    const orchestrator = new Orchestrator(root, (event) => events.push(event), { startup: false, intervalMs: 0, sweepIntervalMs: 0 });
    const harness = orchestrator as unknown as Harness;
    harness.coordinator = coordinator;
    const stateStore = harness.stateStore as unknown as {
      writeAtomic(state: import("./runtime-state.js").DurableRuntimeState): Promise<void>;
    };
    const writeAtomic = stateStore.writeAtomic.bind(stateStore);
    stateStore.writeAtomic = async (state) => {
      if (state.coordinator.messages.some((message) => message.id === "failure-closed" && message.promptState === "failed")) {
        throw new Error("terminal write failed");
      }
      await writeAtomic(state);
    };

    await orchestrator.prompt("fails closed", [], [], "failure-closed");
    await waitFor(() => events.some((event) => event.type === "error"));
    assert.equal(events.some((event) => event.type === "coordinator_prompt_failed"), false);
    assert.equal(events.some((event) => event.type === "coordinator_message_updated" && event.message.promptState === "failed"), false);
    assert.equal(harness.coordinatorPromptDrainBlocked, true, "later FIFO progress remains blocked until restart");
    const restored = await new RuntimeStateStore(root).load();
    assert.equal(restored?.coordinator.messages.find((message) => message.id === "failure-closed")?.promptState, "queued");
    assert.equal(restored?.coordinator.pendingPrompts?.[0]?.messageId, "failure-closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notification claim reservation serializes a real queued user prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-notification-user-race-"));
  const calls: string[] = [];
  const coordinator = { isIdle: true, async prompt(content: string) { calls.push(content); } };
  type Harness = {
    coordinator: typeof coordinator;
    coordinatorTurnInFlight: boolean;
    coordinatorNotifications?: CoordinatorNotificationQueue;
    pendingCoordinatorPrompts: DurableCoordinatorPrompt[];
    schedulePromptDrain(): void;
    stateStore: RuntimeStateStore;
  };
  try {
    const orchestrator = new Orchestrator(root, () => undefined, { startup: false, intervalMs: 0, sweepIntervalMs: 0 });
    const harness = orchestrator as unknown as Harness;
    harness.coordinator = coordinator;
    const current: AgentJob = {
      id: "race-job", title: "Race", prompt: "race", status: "completed", branch: "race", worktree: "/tmp/race",
      isolation: { requested: "worktree", mode: "worktree", path: "/tmp/race" }, baseRef: "base",
      createdAt: 1, updatedAt: 2, messages: [],
      review: { hookToken: "hook", status: "ci_failed", attempt: 1, targetBranch: "main", updatedAt: 2, transitions: [],
        remediation: { maxAttempts: 3, rounds: {}, currentActionId: "action",
          actions: [{ id: "action", failureClass: "worker_ci", fingerprint: "race", state: "pending", attempt: 0,
            maxAttempts: 3, createdAt: 2, updatedAt: 2, evidence: { detail: "exact" } }] } },
    };
    const notificationState: CoordinatorNotificationState = { events: [], lastSignals: {} };
    let persistCount = 0;
    let claimBlocked = false;
    let releaseClaim!: () => void;
    const queue = new CoordinatorNotificationQueue(notificationState, {
      append: () => undefined, currentJob: () => current,
      isIdle: () => coordinator.isIdle,
      reserveTurn: () => {
        if (harness.coordinatorTurnInFlight) return undefined;
        harness.coordinatorTurnInFlight = true;
        return () => { harness.coordinatorTurnInFlight = false; };
      },
      turnReleased: () => harness.schedulePromptDrain(),
      persist: async () => {
        if (++persistCount === 2) {
          claimBlocked = true;
          await new Promise<void>((resolve) => { releaseClaim = resolve; });
        }
      },
      wake: async (event, started) => { const prompt = coordinator.prompt(event.text); started(); await prompt; },
    });
    harness.coordinatorNotifications = queue;
    queue.observe(current);
    await waitFor(() => claimBlocked);

    await orchestrator.prompt("user FIFO", [], [], "user-race");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls, [], "accepted user prompt cannot enter the reserved lifecycle turn");
    queue.agentSettled();
    assert.equal(notificationState.events[0]!.wakeState, "claimed", "unrelated settlement cannot acknowledge a not-started wake");

    current.review!.remediation!.actions[0]!.state = "repairing";
    releaseClaim();
    await waitFor(() => harness.pendingCoordinatorPrompts.length === 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /^user FIFO/);
    assert.equal(notificationState.events[0]!.wakeState, "delivered", "stale wake settles without a model turn");
    await harness.stateStore.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator queues genuinely busy prompts durably and drains FIFO exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-orchestrator-prompts-"));
  const events: ServerMessage[] = [];
  const calls: string[] = [];
  let savedGeneration = 0;
  let flushedGeneration = 0;
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let notify: ((event: unknown) => void) | undefined;
  const coordinator = {
    isIdle: true,
    subscribe(listener: (event: unknown) => void) { notify = listener; return () => undefined; },
    async prompt(content: string): Promise<void> {
      calls.push(content.split("\n", 1)[0]!);
      active += 1;
      maxActive = Math.max(maxActive, active);
      coordinator.isIdle = false;
      await new Promise<void>((resolve) => releases.push(() => {
        active -= 1;
        coordinator.isIdle = true;
        resolve();
      }));
    },
  };

  type Harness = {
    coordinator: typeof coordinator;
    coordinatorMessages: TranscriptMessage[];
    pendingCoordinatorPrompts: DurableCoordinatorPrompt[];
    stateStore: RuntimeStateStore;
    bindCoordinator(): void;
  };

  try {
    const orchestrator = new Orchestrator(root, (event) => {
      if (event.type === "coordinator_message" && event.message.role === "user") {
        assert.equal(flushedGeneration, savedGeneration, "durable queue flush precedes accepted transcript acknowledgement");
      }
      events.push(event);
    }, { startup: false, intervalMs: 0, sweepIntervalMs: 0 });
    const harness = orchestrator as unknown as Harness;
    harness.coordinator = coordinator;
    const durableSave = harness.stateStore.save.bind(harness.stateStore);
    harness.stateStore.save = (state) => { savedGeneration += 1; durableSave(state); };
    const durableFlush = harness.stateStore.flush.bind(harness.stateStore);
    harness.stateStore.flush = async () => { await durableFlush(); flushedGeneration = savedGeneration; };
    harness.bindCoordinator();

    await orchestrator.prompt("first", [], [], "prompt-1");
    await orchestrator.prompt("second", [], [], "prompt-2");
    await orchestrator.prompt("third", [], [], "prompt-3");
    await orchestrator.prompt("duplicate must be ignored", [], [], "prompt-2");

    assert.deepEqual(harness.coordinatorMessages.map((entry) => [entry.id, entry.promptState]), [
      ["prompt-1", "processing"], ["prompt-2", "queued"], ["prompt-3", "queued"],
    ]);
    assert.deepEqual(harness.pendingCoordinatorPrompts.map((entry) => entry.messageId), ["prompt-1", "prompt-2", "prompt-3"]);
    assert.equal(calls.length, 1, "busy coordinator starts only the queue head");
    assert.equal(events.filter((event) => event.type === "coordinator_message").length, 3, "each accepted prompt is immediately visible once");

    notify?.({ type: "message_start", message: { role: "assistant", content: [] } });
    notify?.({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] } });
    notify?.({ type: "tool_execution_start", toolName: "read", args: {} });
    assert.equal(harness.pendingCoordinatorPrompts[0]?.state, "processing", "intermediate assistant/tool work is not completed");
    notify?.({ type: "tool_execution_end", toolName: "read", isError: false });
    notify?.({ type: "message_start", message: { role: "assistant", content: [] } });
    notify?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }] } });
    assert.equal(harness.pendingCoordinatorPrompts[0]?.state, "processing", "even a message end awaits authoritative agent settlement");
    coordinator.isIdle = true;
    notify?.({ type: "agent_settled" });
    assert.equal(harness.pendingCoordinatorPrompts[0]?.state, "responded");

    releases.shift()?.();
    await waitFor(() => calls.length === 2);
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(harness.coordinatorMessages[0]?.promptState, undefined);
    assert.equal(harness.coordinatorMessages[1]?.promptState, "processing");

    releases.shift()?.();
    await waitFor(() => calls.length === 3);
    releases.shift()?.();
    await waitFor(() => harness.pendingCoordinatorPrompts.length === 0);
    await harness.stateStore.flush();

    assert.deepEqual(calls, ["first", "second", "third"]);
    assert.equal(maxActive, 1);
    assert.ok(harness.coordinatorMessages.every((entry) => entry.promptState === undefined));
    const restored = await new RuntimeStateStore(root).load();
    assert.deepEqual(restored?.coordinator.pendingPrompts, []);
    assert.deepEqual(restored?.coordinator.messages.filter((entry) => entry.role === "user").map((entry) => entry.id), ["prompt-1", "prompt-2", "prompt-3"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
