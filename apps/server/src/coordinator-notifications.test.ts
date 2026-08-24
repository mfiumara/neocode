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
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("Timed out waiting for notification race checkpoint");
}

function pendingActionJob(): AgentJob {
  const value = job();
  value.review!.status = "ci_failed";
  value.review!.remediation = {
    maxAttempts: 3, rounds: {}, currentActionId: "race-action",
    actions: [{ id: "race-action", failureClass: "worker_ci", fingerprint: "race", state: "pending", attempt: 0,
      maxAttempts: 3, createdAt: 3, updatedAt: 3, evidence: { detail: "immutable race evidence" } }],
  };
  return value;
}

test("a meaningful transition appends once and duplicate broadcasts do not wake twice", async () => {
  const durable = state();
  const appended: CoordinatorWorkerEvent[] = [];
  const wakes: string[] = [];
  const queue = new CoordinatorNotificationQueue(durable, {
    append: (event) => appended.push(event), persist: () => undefined, isIdle: () => true,
    wake: async (event, started) => { started(); wakes.push(event.id); },
  });
  const value = job();
  assert.equal(queue.observe(value), true);
  assert.equal(queue.observe(value), false);
  await tick();
  assert.equal(appended.length, 1);
  assert.deepEqual(wakes, [durable.events[0]!.id]);
  assert.match(durable.events[0]!.text, /branch=neocode\/ship/);
  assert.match(durable.events[0]!.text, /worktree=\/tmp\/ship/);
  assert.match(durable.events[0]!.text, /requirements=ship/);
  assert.match(durable.events[0]!.text, /tests=tests pass/);
  assert.match(durable.events[0]!.text, /risks=none reported/);
  assert.ok(durable.events[0]!.wakeDeliveredAt);
});

test("busy coordinator queues durably and restart delivers the pending id exactly once", async () => {
  const durable = state();
  const appended: string[] = [];
  const wakes: string[] = [];
  let idle = false;
  const hooks = {
    append: (event: CoordinatorWorkerEvent) => appended.push(event.id), persist: () => undefined,
    isIdle: () => idle, wake: async (event: CoordinatorWorkerEvent, started: () => void) => { started(); wakes.push(event.id); },
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

test("agent settlement completes a claimed wake even when prompt promise remains unresolved", async () => {
  const durable = state();
  let finishWake!: () => void;
  const wakePending = new Promise<void>((resolve) => { finishWake = resolve; });
  const queue = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, isIdle: () => true,
    wake: async (_event, started) => { started(); return wakePending; },
  });
  queue.observe(job());
  await tick();
  assert.equal(durable.events[0]?.wakeState, "claimed");
  queue.agentSettled();
  assert.equal(durable.events[0]?.wakeState, "delivered");
  assert.ok(durable.events[0]?.wakeDeliveredAt);
  finishWake(); await tick();
  assert.equal(durable.events[0]?.wakeState, "delivered", "late prompt resolution cannot reopen the event");
});

test("restart redelivers the same event id after a crash between persisted claim and wake", async () => {
  const durable = state();
  let idle = false;
  const first = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, isIdle: () => idle,
    wake: async () => { throw new Error("the crashed process must not wake"); },
  });
  first.observe(job());
  await tick(); // let the enqueue checkpoint finish before taking a crash image
  const eventId = durable.events[0]!.id;
  // Exact durable snapshot after drain persisted its claim but before invoking
  // the external wake side effect.
  durable.events[0]!.wakeState = "claimed";
  durable.events[0]!.wakeClaimedAt = 10;
  assert.equal(durable.events[0]!.wakeDeliveredAt, undefined);

  const wakes: string[] = [];
  idle = true;
  const restarted = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, isIdle: () => idle,
    wake: async (event, started) => { started(); wakes.push(event.id); },
  });
  restarted.settled(); await tick();
  assert.deepEqual(wakes, [eventId]);
  assert.equal(durable.events[0]!.wakeState, "delivered");
  assert.ok(durable.events[0]!.wakeDeliveredAt);
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
    wake: async (event: CoordinatorWorkerEvent, started: () => void) => { started(); wakes.push(event.id); },
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

test("backlog sweeps wake once per stable job state and survive a busy coordinator", async () => {
  const durable = state();
  const wakes: string[] = [];
  let idle = false;
  const queue = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, isIdle: () => idle,
    wake: async (event, started) => { started(); wakes.push(event.id); },
  });
  const value = job();
  assert.equal(queue.requestBacklogSweep(value), true);
  assert.equal(queue.requestBacklogSweep(value), false);
  assert.equal(queue.hasPendingWake(), true);
  await tick();
  assert.equal(wakes.length, 0);
  idle = true;
  queue.settled(); await tick();
  assert.equal(wakes.length, 1);
  assert.equal(queue.hasPendingWake(), false);
  value.updatedAt += 1;
  assert.equal(queue.requestBacklogSweep(value), true, "a lifecycle change makes the job eligible again");
  await tick();
  assert.equal(wakes.length, 2);
});

test("stale pending action snapshots reconcile against repairing and resolved durable state", async () => {
  const stale = job();
  stale.review!.remediation = {
    maxAttempts: 3, rounds: {}, currentActionId: "action-stale",
    actions: [{ id: "action-stale", failureClass: "worker_ci", fingerprint: "f", state: "pending", attempt: 0,
      maxAttempts: 3, createdAt: 3, updatedAt: 3, evidence: { detail: "original exact evidence" } }],
  };
  const current = structuredClone(stale);
  const wakes: string[] = [];
  const durable = state();
  let idle = false;
  const queue = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, isIdle: () => idle,
    currentJob: () => current,
    wake: async (event, started) => { started(); wakes.push(event.id); },
  });
  assert.equal(queue.observe(stale), true);
  const original = durable.events[0]!.text;
  current.review!.remediation!.actions[0]!.state = "repairing";
  current.review!.transitions.push({ status: "worker_resumed", at: 4, owner: "server", detail: "claimed exact action" });
  current.updatedAt += 1;
  assert.equal(queue.observe(stale), true, "authoritative repairing state may append its newer lifecycle transition");
  idle = true;
  queue.settled(); await tick();
  assert.equal(wakes.length, 0, "obsolete pending action must not invoke the model");
  assert.equal(durable.events[0]!.text, original, "audit evidence is never rewritten during reconciliation");
  assert.equal(durable.events[0]!.wakeState, "delivered");

  current.review!.remediation!.actions[0]!.state = "resolved";
  current.updatedAt += 1;
  assert.equal(queue.observe(stale), false, "resolved durable state, not stale payload, controls observation");
  await tick();
  assert.equal(wakes.length, 0);
});

test("durable settlement survives reconnect/restart and duplicate stable-id rows", async () => {
  const durable = state();
  const wakes: string[] = [];
  const hooks = {
    append: () => undefined, persist: () => undefined, isIdle: () => true,
    wake: async (event: CoordinatorWorkerEvent, started: () => void) => { started(); wakes.push(event.id); },
  };
  const first = new CoordinatorNotificationQueue(durable, hooks);
  first.observe(job()); await tick();
  const settled = durable.events[0]!;
  assert.equal(settled.wakeState, "delivered");
  durable.events.push({ ...structuredClone(settled), wakeState: "pending", wakeDeliveredAt: undefined, messageId: "duplicate-row" });
  const reconnect = new CoordinatorNotificationQueue(durable, hooks);
  reconnect.observe(job());
  reconnect.settled(); await tick();
  assert.deepEqual(wakes, [settled.id], "stable event id remains exactly once across reconnect and duplicate rows");
});

test("failed acknowledgement never loops live, while its uncommitted crash image redelivers", async () => {
  const live = state();
  let committed = structuredClone(live);
  let persistCalls = 0;
  const wakes: string[] = [];
  const queue = new CoordinatorNotificationQueue(live, {
    append: () => undefined,
    persist: () => {
      persistCalls += 1;
      if (persistCalls === 3) throw new Error("disk unavailable at settlement");
      committed = structuredClone(live);
    },
    isIdle: () => true,
    wake: async (event, started) => { started(); wakes.push(event.id); },
  });
  queue.observe(job()); await tick(); queue.settled(); await tick();
  assert.equal(wakes.length, 1, "failed durable acknowledgement must not re-prompt in the live process");
  assert.equal(committed.events[0]!.wakeState, "claimed", "crash image does not falsely claim settlement");

  const recoveredWakes: string[] = [];
  const restarted = new CoordinatorNotificationQueue(committed, {
    append: () => undefined, persist: () => undefined, isIdle: () => true,
    wake: async (event, started) => { started(); recoveredWakes.push(event.id); },
  });
  restarted.settled(); await tick();
  assert.deepEqual(recoveredWakes, [committed.events[0]!.id], "uncommitted crash checkpoint legitimately redelivers");
});

test("claim persistence failure invokes no model and creates no extra transcript entry", async () => {
  const durable = state();
  let persists = 0;
  let appended = 0;
  let wakes = 0;
  const queue = new CoordinatorNotificationQueue(durable, {
    append: () => { appended += 1; },
    persist: () => { if (++persists === 2) throw new Error("claim write failed"); },
    isIdle: () => true,
    wake: async (_event, started) => { started(); wakes += 1; },
  });
  queue.observe(job()); await tick(); queue.settled(); await tick();
  assert.equal(wakes, 0);
  assert.equal(appended, 1);
  assert.equal(durable.events.length, 1);
});

test("legacy wake rows reconcile every kind against advanced durable state", async () => {
  const current = job();
  current.review!.status = "judging";
  current.review!.transitions.push({ status: "judging", at: 9, owner: "coordinator", detail: "already advanced" });
  const kinds: CoordinatorWorkerEvent["kind"][] = ["handoff", "failed", "needs_attention", "backlog_sweep"];
  const events = kinds.map((kind, index): CoordinatorWorkerEvent => ({
    id: `legacy-${kind}`, jobId: current.id, kind,
    text: `[worker_status] original-${kind}-evidence`, messageId: `legacy-message-${index}`,
    createdAt: index + 1, wakeRequested: true, wakeState: "pending",
  }));
  const originalTexts = events.map((event) => event.text);
  const durable: CoordinatorNotificationState = { events, lastSignals: {} };
  const wakes: string[] = [];
  const queue = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, isIdle: () => true,
    currentJob: () => current,
    wake: async (event, started) => { started(); wakes.push(event.id); },
  });
  queue.settled(); await tick();
  assert.deepEqual(wakes, []);
  assert.deepEqual(events.map((event) => event.text), originalTexts, "legacy raw audit evidence remains exact");
  assert.ok(events.every((event) => event.wakeState === "delivered"));
});

test("legacy failed and needs-attention rows still wake when current durable state matches", async () => {
  for (const [kind, status] of [["failed", "failed"], ["needs_attention", "needs_attention"]] as const) {
    const current = job();
    current.review = undefined;
    current.status = status;
    const event: CoordinatorWorkerEvent = {
      id: `current-${kind}`, jobId: current.id, kind, text: "original evidence", messageId: `message-${kind}`,
      createdAt: 1, wakeRequested: true, wakeState: "pending",
    };
    const wakes: string[] = [];
    const queue = new CoordinatorNotificationQueue({ events: [event], lastSignals: {} }, {
      append: () => undefined, persist: () => undefined, isIdle: () => true, currentJob: () => current,
      wake: async (entry, started) => { started(); wakes.push(entry.id); },
    });
    queue.settled(); await tick();
    assert.deepEqual(wakes, [event.id]);
  }
});

test("claim flush revalidation settles an action that advanced without waking", async () => {
  const current = pendingActionJob();
  const durable = state();
  let persistCount = 0;
  let releaseClaim!: () => void;
  let claimBlocked = false;
  let reservations = 0;
  let releases = 0;
  let wakes = 0;
  const queue = new CoordinatorNotificationQueue(durable, {
    append: () => undefined,
    persist: async () => {
      persistCount += 1;
      if (persistCount === 2) {
        claimBlocked = true;
        await new Promise<void>((resolve) => { releaseClaim = resolve; });
      }
    },
    currentJob: () => current, isIdle: () => true,
    reserveTurn: () => { reservations += 1; return () => { releases += 1; }; },
    wake: async (_event, started) => { started(); wakes += 1; },
  });
  queue.observe(structuredClone(current));
  await waitUntil(() => claimBlocked);
  const originalEvidence = durable.events[0]!.text;
  current.review!.remediation!.actions[0]!.state = "repairing";
  releaseClaim();
  await waitUntil(() => durable.events[0]?.wakeState === "delivered");
  assert.equal(wakes, 0);
  assert.equal(durable.events[0]!.text, originalEvidence);
  assert.equal(reservations, 1);
  assert.equal(releases, 1);
});

test("rejected-before-start wake ignores unrelated settlement and releases every reservation path", async () => {
  const current = pendingActionJob();
  const durable = state();
  let releases = 0;
  let queue!: CoordinatorNotificationQueue;
  queue = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, currentJob: () => current, isIdle: () => true,
    reserveTurn: () => () => { releases += 1; },
    wake: async () => { queue.agentSettled(); throw new Error("rejected before lifecycle prompt acceptance"); },
  });
  queue.observe(current);
  await waitUntil(() => releases === 1);
  assert.equal(durable.events[0]!.wakeState, "pending");
  assert.equal(durable.events[0]!.wakeDeliveredAt, undefined);
  assert.equal(durable.settledEventIds?.[durable.events[0]!.id], undefined);

  const claimFailureState = state();
  let claimReleases = 0;
  let persist = 0;
  const claimFailure = new CoordinatorNotificationQueue(claimFailureState, {
    append: () => undefined, currentJob: () => current, isIdle: () => true,
    reserveTurn: () => () => { claimReleases += 1; },
    persist: () => { if (++persist === 2) throw new Error("claim persistence failed"); },
    wake: async (_event, started) => { started(); assert.fail("must not wake"); },
  });
  claimFailure.observe(current);
  await waitUntil(() => claimReleases === 1);
  assert.equal(claimFailureState.events[0]!.wakeState, "claimed", "uncommitted claim remains restart-redeliverable");

  const refusedState = state();
  let refusedWakes = 0;
  const refused = new CoordinatorNotificationQueue(refusedState, {
    append: () => undefined, persist: () => undefined, currentJob: () => current, isIdle: () => true,
    reserveTurn: () => undefined,
    wake: async (_event, started) => { started(); refusedWakes += 1; },
  });
  refused.observe(current); await tick();
  assert.equal(refusedWakes, 0);
  assert.equal(refusedState.events[0]!.wakeState, "pending");

  const shutdownState = state();
  let shutdownBlocked = false;
  let finishShutdownClaim!: () => void;
  let shutdownReleases = 0;
  let shutdownWakes = 0;
  let shutdownPersists = 0;
  const shutdownQueue = new CoordinatorNotificationQueue(shutdownState, {
    append: () => undefined, currentJob: () => current, isIdle: () => true,
    reserveTurn: () => () => { shutdownReleases += 1; },
    persist: async () => {
      if (++shutdownPersists === 2) {
        shutdownBlocked = true;
        await new Promise<void>((resolve) => { finishShutdownClaim = resolve; });
      }
    },
    wake: async (_event, started) => { started(); shutdownWakes += 1; },
  });
  shutdownQueue.observe(current);
  await waitUntil(() => shutdownBlocked);
  shutdownQueue.shutdown();
  assert.equal(shutdownReleases, 1);
  finishShutdownClaim(); await tick();
  assert.equal(shutdownWakes, 0);
  assert.equal(shutdownState.events[0]!.wakeState, "claimed");
});

test("every lifecycle transition is appended without extra model chatter", async () => {
  const durable = state();
  let wakes = 0;
  const queue = new CoordinatorNotificationQueue(durable, {
    append: () => undefined, persist: () => undefined, isIdle: () => true,
    wake: async (_event, started) => { started(); wakes += 1; },
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
