import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, TranscriptMessage } from "@neocode/protocol";
import { Orchestrator, workerSystemPrompt } from "./orchestrator.js";
import { RuntimeStateStore, type DurableCoordinatorPrompt } from "./runtime-state.js";

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
