import assert from "node:assert/strict";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import type { CoordinatorNotificationState, CoordinatorWorkerEvent } from "./runtime-state.js";
import { CoordinatorNotificationQueue } from "./coordinator-notifications.js";

function job(): AgentJob {
  return {
    id: "worker-1", title: "Ship feature", prompt: "ship", status: "completed",
    branch: "neocode/ship", worktree: "/tmp/ship",
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/ship" },
    baseRef: "base", createdAt: 1, updatedAt: 2, messages: [], summary: "Implemented and tested.",
  };
}

function state(): CoordinatorNotificationState { return { events: [], lastSignals: {} }; }

async function tick(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 5)); }

test("a meaningful transition appends once and duplicate broadcasts do not wake twice", async () => {
  const durable = state();
  const appended: CoordinatorWorkerEvent[] = [];
  const wakes: string[] = [];
  const queue = new CoordinatorNotificationQueue(durable, {
    append: (event) => appended.push(event), persist: () => undefined, isIdle: () => true,
    wake: async (event) => { wakes.push(event.id); },
  });
  const value = job();
  assert.equal(queue.observe(value), true);
  assert.equal(queue.observe(value), false);
  await tick();
  assert.equal(appended.length, 1);
  assert.deepEqual(wakes, [durable.events[0]!.id]);
  assert.ok(durable.events[0]!.wakeDeliveredAt);
});

test("busy coordinator queues durably and restart delivers the pending id exactly once", async () => {
  const durable = state();
  const appended: string[] = [];
  const wakes: string[] = [];
  let idle = false;
  const hooks = {
    append: (event: CoordinatorWorkerEvent) => appended.push(event.id), persist: () => undefined,
    isIdle: () => idle, wake: async (event: CoordinatorWorkerEvent) => { wakes.push(event.id); },
  };
  const firstProcess = new CoordinatorNotificationQueue(durable, hooks);
  firstProcess.observe(job());
  await tick();
  assert.equal(wakes.length, 0);
  assert.equal(durable.events[0]!.wakeDeliveredAt, undefined);

  idle = true;
  const restarted = new CoordinatorNotificationQueue(durable, hooks);
  restarted.settled();
  await tick();
  restarted.settled();
  await tick();
  assert.equal(appended.length, 1, "restart must not append a duplicate transcript event");
  assert.deepEqual(wakes, [durable.events[0]!.id]);
});

test("low-level review progress is silent but rejection is appended without model chatter", async () => {
  const durable = state();
  let wakes = 0;
  const queue = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, isIdle: () => true,
    wake: async () => { wakes += 1; },
  });
  const value = job();
  value.review = { hookToken: "hook", status: "judging", attempt: 1, targetBranch: "main", updatedAt: 3, transitions: [] };
  assert.equal(queue.observe(value), false);
  value.review.status = "rejected";
  value.review.updatedAt = 4;
  value.review.error = "requirements not met";
  assert.equal(queue.observe(value), true);
  await tick();
  assert.equal(durable.events[0]?.kind, "review_rejected");
  assert.equal(wakes, 0);
});
