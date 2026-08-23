import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptMessage } from "@neocode/protocol";
import type { DurableCoordinatorPrompt } from "./runtime-state.js";
import {
  checkpointPromptResponse,
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

test("restart recovery distinguishes every crash checkpoint without replaying completed responses", () => {
  const before = queuedCoordinatorPrompt({ id: "before", text: "before", context: [], attachments: [], mode: "build", now: 1 });
  const during = queuedCoordinatorPrompt({ id: "during", text: "during", context: [], attachments: [], mode: "build", now: 2 });
  setPromptProcessing(during.message, during.pending);
  const responded = queuedCoordinatorPrompt({ id: "responded", text: "responded", context: [], attachments: [], mode: "build", now: 3 });
  setPromptProcessing(responded.message, responded.pending);
  checkpointPromptResponse(responded.pending, "assistant-1", 4);
  const settled = queuedCoordinatorPrompt({ id: "settled", text: "settled", context: [], attachments: [], mode: "build", now: 5 });
  settlePrompt(settled.message);

  const messages = [before.message, during.message, responded.message, settled.message];
  const pending: DurableCoordinatorPrompt[] = [before.pending, during.pending, responded.pending];
  reconcileRestoredPromptStates(messages, pending);

  assert.deepEqual(pending.map((entry) => [entry.messageId, entry.state]), [["before", "queued"], ["during", "queued"]]);
  assert.equal(messages[0]?.promptState, "queued", "crash before processing remains queued");
  assert.equal(messages[1]?.promptState, "queued", "incomplete processing is retried");
  assert.equal(messages[2]?.promptState, undefined, "durably responded work is settled, not replayed");
  assert.equal(messages[3]?.promptState, undefined, "already settled work remains settled");
});
