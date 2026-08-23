import type { ImageAttachment, TranscriptMessage } from "@neocode/protocol";
import type { DurableCoordinatorPrompt } from "./runtime-state.js";

export function queuedCoordinatorPrompt(input: {
  id: string;
  text: string;
  context: string[];
  attachments: ImageAttachment[];
  mode: "build" | "plan";
  now: number;
  previousTimestamp?: number;
}): { message: TranscriptMessage; pending: DurableCoordinatorPrompt } {
  const timestamp = Math.max(input.now, (input.previousTimestamp ?? 0) + 1);
  return {
    message: {
      id: input.id, role: "user", text: input.text, timestamp,
      attachments: input.attachments.length ? input.attachments : undefined,
      promptState: "queued",
    },
    pending: { messageId: input.id, context: [...input.context], mode: input.mode, createdAt: timestamp, state: "queued" },
  };
}

/**
 * Recover only turns without a durable completed-response checkpoint. A
 * responded entry is atomically persisted with its assistant turn, so replaying
 * it would duplicate already completed model/tool work.
 */
export function reconcileRestoredPromptStates(messages: TranscriptMessage[], pending: DurableCoordinatorPrompt[]): void {
  const respondedIds = new Set(pending.filter((entry) => entry.state === "responded").map((entry) => entry.messageId));
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index]!.state === "responded") pending.splice(index, 1);
    else pending[index]!.state = "queued";
  }
  const pendingIds = new Set(pending.map((entry) => entry.messageId));
  for (const message of messages) {
    if (pendingIds.has(message.id)) message.promptState = "queued";
    else if (respondedIds.has(message.id) || message.promptState === "queued" || message.promptState === "processing") {
      delete message.promptState;
      delete message.promptError;
    }
  }
}

export function setPromptProcessing(message: TranscriptMessage, pending: DurableCoordinatorPrompt): void {
  pending.state = "processing";
  message.promptState = "processing";
  delete message.promptError;
}

export function checkpointPromptResponse(pending: DurableCoordinatorPrompt, responseMessageId?: string, completedAt = Date.now()): void {
  pending.state = "responded";
  pending.responseMessageId = responseMessageId;
  pending.responseCompletedAt = completedAt;
}

export function settlePrompt(message: TranscriptMessage, error?: string): void {
  if (error === undefined) {
    delete message.promptState;
    delete message.promptError;
  } else {
    message.promptState = "failed";
    message.promptError = error;
  }
}
