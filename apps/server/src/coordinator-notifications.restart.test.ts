import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentJob, TranscriptMessage } from "@neocode/protocol";
import type { CoordinatorNotificationQueue } from "./coordinator-notifications.js";
import { Orchestrator } from "./orchestrator.js";
import { RuntimeStateStore, type CoordinatorNotificationState } from "./runtime-state.js";

function failedJob(id: string): AgentJob {
  return {
    id, title: `Restart ${id}`, prompt: "proof", status: "failed",
    branch: `neocode/${id}`, worktree: `/tmp/${id}`,
    isolation: { requested: "worktree", mode: "worktree", path: `/tmp/${id}` },
    baseRef: "base", createdAt: 1, updatedAt: 2, messages: [], error: `exact ${id} failure`,
  };
}

type ProductionHarness = {
  notificationState: CoordinatorNotificationState;
  coordinatorMessages: TranscriptMessage[];
  coordinatorNotifications?: CoordinatorNotificationQueue;
  coordinator: {
    isIdle: boolean;
    prompt(content: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
  };
  dispose(): Promise<void>;
  jobs: Map<string, AgentJob>;
  stateStore: RuntimeStateStore;
  initializeCoordinatorNotifications(): void;
  restoreCoordinatorNotificationState(state: CoordinatorNotificationState): void;
  persist(): void;
};

function productionHarness(root: string, wakes: string[]): ProductionHarness {
  const orchestrator = new Orchestrator(root, () => undefined, { startup: false, intervalMs: 0, sweepIntervalMs: 0 });
  const harness = orchestrator as unknown as ProductionHarness;
  harness.coordinator = {
    isIdle: true,
    async prompt(content: string) { wakes.push(content); },
    async abort() { /* test session has no provider work */ },
    dispose() { /* test session owns no external resources */ },
  };
  return harness;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for production notification persistence");
}

test("production persistence preserves compacted settlements and redelivers only an uncommitted claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-production-notification-restart-"));
  let first: ProductionHarness | undefined;
  let restarted: ProductionHarness | undefined;
  try {
    const firstWakes: string[] = [];
    first = productionHarness(root, firstWakes);
    const settledJob = failedJob("settled-job");
    const claimJob = failedJob("claim-job");
    first.jobs.set(settledJob.id, settledJob);
    first.jobs.set(claimJob.id, claimJob);
    first.initializeCoordinatorNotifications();

    // Observe and settle through the same queue, append, wake, persistence, and
    // RuntimeStateStore hooks used by Orchestrator.initialize().
    first.coordinatorNotifications!.observe(settledJob);
    await waitUntil(() => first!.notificationState.events[0]?.wakeState === "delivered");
    await first.stateStore.flush();
    assert.equal(firstWakes.length, 1);
    const settled = structuredClone(first.notificationState.events[0]!);
    assert.ok(first.notificationState.settledEventIds?.[settled.id]);
    const transcriptBeforeRestart = first.coordinatorMessages.map((message) => structuredClone(message));

    // Compact the delivered row while retaining a surviving stale duplicate.
    // Also persist a real crash image: claimed, but lacking any settlement.
    first.notificationState.events.splice(0, first.notificationState.events.length,
      { ...settled, wakeState: "pending", wakeDeliveredAt: undefined, wakeClaimedAt: undefined },
      { id: "uncommitted-claim", jobId: claimJob.id, kind: "failed", text: "exact uncommitted failure",
        messageId: "uncommitted-message", createdAt: 3, wakeRequested: true, wakeState: "claimed", wakeClaimedAt: 4 });
    first.persist();
    await first.stateStore.flush();

    // Reload the actual durable envelope, then restore and reconstruct the
    // production notification queue on a new Orchestrator instance.
    const loaded = await new RuntimeStateStore(root).load();
    assert.ok(loaded?.coordinatorNotifications);
    assert.ok(loaded.coordinatorNotifications.settledEventIds?.[settled.id],
      "actual Orchestrator.persist envelope must carry permanent settlement authority");

    const restartWakes: string[] = [];
    // The first process must quiesce before the replacement process owns the
    // same runtime directory, exactly as backend restart sequencing requires.
    await first.dispose();
    first = undefined;
    restarted = productionHarness(root, restartWakes);
    restarted.coordinatorMessages.push(...loaded.coordinator.messages);
    for (const entry of loaded.jobs) restarted.jobs.set(entry.job.id, entry.job);
    restarted.restoreCoordinatorNotificationState(loaded.coordinatorNotifications);
    restarted.initializeCoordinatorNotifications();
    restarted.coordinatorNotifications!.settled();
    await waitUntil(() => restarted!.notificationState.events[1]?.wakeState === "delivered");
    await restarted.stateStore.flush();

    assert.equal(restartWakes.length, 1, "only the genuinely uncommitted claim redelivers");
    assert.match(restartWakes[0]!, /uncommitted-claim/);
    assert.equal(restarted.notificationState.events[0]!.wakeState, "pending",
      "compacted settled duplicate needs no mutable row rewrite to remain suppressed");
    assert.deepEqual(restarted.coordinatorMessages, transcriptBeforeRestart,
      "settled duplicate adds neither a wake nor duplicate transcript append after restart");
  } finally {
    await restarted?.dispose();
    await first?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
