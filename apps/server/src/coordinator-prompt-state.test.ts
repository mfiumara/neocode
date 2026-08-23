import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptMessage } from "@neocode/protocol";
import type { DurableCoordinatorPrompt } from "./runtime-state.js";
import {
  queuedCoordinatorPrompt,
  reconcileRestoredPromptStates,
  setPromptProcessing,
  settlePrompt,
} from "./coordinator-prompt-state.js";

const image = { id: "image-1", mimeType: "image/png" as const, data: "AA==", size: 1 };

test("accepted prompts render queued immediately with stable ordering and attachments", () => {
  const first = queuedCoordinatorPrompt({ id: "one", text: "first", context: [], attachments: [], mode: "build", now: 10 });
  const second = queuedCoordinatorPrompt({ id: "two", text: "second", context: ["context"], attachments: [image], mode: "plan", now: 10, previousTimestamp: first.message.timestamp });
  assert.equal(first.message.promptState, "queued");
  assert.equal(second.message.timestamp, 11);
  assert.deepEqual(second.message.attachments, [image]);
  assert.deepEqual(second.pending.context, ["context"]);
});

test("acknowledgement replaces queued state and settled or failed prompts are never shown queued", () => {
  const value = queuedCoordinatorPrompt({ id: "one", text: "hello", context: [], attachments: [], mode: "build", now: 1 });
  setPromptProcessing(value.message, value.pending);
  assert.equal(value.message.promptState, "processing");
  settlePrompt(value.message);
  assert.equal(value.message.promptState, undefined);

  const failed = queuedCoordinatorPrompt({ id: "two", text: "bad", context: [], attachments: [], mode: "build", now: 2 });
  settlePrompt(failed.message, "backend rejected prompt");
  assert.equal(failed.message.promptState, "failed");
  assert.equal(failed.message.promptError, "backend rejected prompt");
});

test("restart requeues only durable prompts and clears stale lifecycle badges", () => {
  const messages: TranscriptMessage[] = [
    { id: "durable", role: "user", text: "again", timestamp: 1, promptState: "processing" },
    { id: "settled", role: "user", text: "done", timestamp: 2, promptState: "queued" },
  ];
  const pending: DurableCoordinatorPrompt[] = [{ messageId: "durable", context: [], mode: "build", createdAt: 1, state: "processing" }];
  reconcileRestoredPromptStates(messages, pending);
  assert.equal(pending[0]?.state, "queued");
  assert.equal(messages[0]?.promptState, "queued");
  assert.equal(messages[1]?.promptState, undefined);
});
