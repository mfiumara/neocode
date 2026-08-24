import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppSnapshot,
  ClientMessage,
  CoordinatorContextState,
  ServerMessage,
} from "@neocode/protocol";

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function contextMessage(message: ServerMessage): CoordinatorContextState | undefined {
  return message.type === "coordinator_context" ? message.context : undefined;
}

function isCompact(message: ClientMessage): message is Extract<ClientMessage, { type: "compact_coordinator" }> {
  return message.type === "compact_coordinator";
}

const settings = {
  variant: "build" as const,
  thinkingLevel: "off" as const,
  availableVariants: ["build"] as const,
  availableThinkingLevels: ["off"] as const,
};

function snapshot(context: CoordinatorContextState): AppSnapshot {
  return {
    cwd: "/safe",
    coordinator: {
      status: "idle", activityHistory: [], messages: [], settings: {
        ...settings,
        availableVariants: [...settings.availableVariants],
        availableThinkingLevels: [...settings.availableThinkingLevels],
      },
      model: null, models: [], context,
    },
    jobs: [], maintenance: { state: "idle" },
  };
}

test("context protocol snapshot and live messages round-trip with nullable unknown usage", () => {
  const context: CoordinatorContextState = {
    usage: { tokens: null, contextWindow: 200_000, percent: null, updatedAt: 10 },
    autoCompactionEnabled: true,
    manualCompactionAvailable: false,
    compaction: {
      state: "completed", reason: "manual", startedAt: 1, completedAt: 2,
      tokensBefore: 80_000, estimatedTokensAfter: 20_000,
    },
  };
  const initial: ServerMessage = { type: "snapshot", snapshot: snapshot(context) };
  const live: ServerMessage = { type: "coordinator_context", context };
  const decodedInitial = roundTrip(initial);
  const decodedLive = roundTrip(live);

  assert.equal(decodedInitial.type, "snapshot");
  if (decodedInitial.type === "snapshot") {
    assert.equal(decodedInitial.snapshot.coordinator.context.usage?.tokens, null);
    assert.equal(decodedInitial.snapshot.coordinator.context.usage?.percent, null);
  }
  assert.deepEqual(contextMessage(decodedLive), context);
  assert.doesNotMatch(JSON.stringify([decodedInitial, decodedLive]), /summary|content|reasoning|prompt|firstKeptEntryId/);
});

test("context protocol narrows compact command and every terminal status including retry intent", () => {
  const command = roundTrip<ClientMessage>({ type: "compact_coordinator" });
  assert.equal(isCompact(command), true);
  if (isCompact(command)) assert.deepEqual(Object.keys(command), ["type"]);

  for (const state of ["completed", "failed", "aborted"] as const) {
    const context: CoordinatorContextState = {
      autoCompactionEnabled: false,
      manualCompactionAvailable: true,
      compaction: {
        state, reason: "overflow", startedAt: 1, completedAt: 2,
        willRetry: state === "failed" ? true : undefined,
        error: state === "failed" ? "safe provider diagnostic" : undefined,
      },
    };
    const decoded = contextMessage(roundTrip<ServerMessage>({ type: "coordinator_context", context }));
    assert.equal(decoded?.compaction?.state, state);
    assert.equal(decoded?.compaction?.willRetry, state === "failed" ? true : undefined);
  }
});
