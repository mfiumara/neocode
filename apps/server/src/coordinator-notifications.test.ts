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
    handoff: { report: "Implemented and tested.", requirements: ["ship"], diffSha256: "abc", branch: "neocode/ship", worktree: "/tmp/ship", tests: ["tests pass"], risks: [], round: 1, createdAt: 2 },
    review: { hookToken: "hook", status: "queued", attempt: 1, targetBranch: "main", updatedAt: 2, transitions: [{ status: "queued", at: 2, owner: "worker", detail: "handoff" }] },
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

test("action-required diagnostics stay exact while a user prompt is busy and wake once afterward", async () => {
  const durable = state();
  const wakes: string[] = [];
  let userPromptRunning = true;
  const value = job();
  const output = "FAIL src/example.test.ts:42\nexpected 2, received 1\n  exact stack line";
  value.review!.status = "ci_failed";
  value.review!.updatedAt = 3;
  value.review!.transitions.push({ status: "ci_failed", at: 3, owner: "server", detail: "Worker CI failed" });
  value.review!.remediation = {
    maxAttempts: 3,
    rounds: { worker_ci: { failureClass: "worker_ci", fingerprint: "same", attempts: 0, maxAttempts: 3, updatedAt: 3 } },
    actions: [{ id: "action-1", failureClass: "worker_ci", fingerprint: "same", state: "pending", attempt: 0, maxAttempts: 3, createdAt: 3, updatedAt: 3,
      evidence: { detail: "Worker CI failed", checks: [{ command: "npm test", ok: false, exitCode: 1, durationMs: 2, output }] } }],
    currentActionId: "action-1",
  };
  const hooks = {
    append: () => undefined, persist: () => undefined, isIdle: () => !userPromptRunning,
    wake: async (event: CoordinatorWorkerEvent) => { wakes.push(event.id); },
  };
  const queue = new CoordinatorNotificationQueue(durable, hooks);
  assert.equal(queue.observe(value), true);
  await tick();
  assert.equal(wakes.length, 0, "normal user prompt remains serviceable and is not interrupted");
  assert.match(durable.events[0]?.text || "", /exact stack line/);
  assert.equal(queue.observe(value), false, "duplicate broadcasts do not duplicate the repair attempt wake");
  userPromptRunning = false;
  queue.settled(); await tick(); queue.settled(); await tick();
  assert.equal(wakes.length, 1);
});

test("every lifecycle transition is appended without extra model chatter", async () => {
  const durable = state();
  let wakes = 0;
  const queue = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, isIdle: () => true,
    wake: async () => { wakes += 1; },
  });
  const value = job();
  assert.equal(queue.observe(value), true);
  await tick();
  value.review!.status = "judging";
  value.review!.updatedAt = 4;
  value.review!.transitions.push({ status: "judging", at: 4, owner: "coordinator", detail: "fresh judge" });
  assert.equal(queue.observe(value), true);
  await tick();
  assert.equal(durable.events[1]?.kind, "lifecycle_transition");
  assert.match(durable.events[1]?.text || "", /judging/);
  assert.equal(wakes, 1, "only the handoff wakes the coordinator");
});
