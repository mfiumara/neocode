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

/** Processing never survives a process, so only durable queue membership restores a badge. */
export function reconcileRestoredPromptStates(messages: TranscriptMessage[], pending: DurableCoordinatorPrompt[]): void {
  const pendingIds = new Set(pending.map((entry) => entry.messageId));
  for (const entry of pending) entry.state = "queued";
  for (const message of messages) {
    if (pendingIds.has(message.id)) message.promptState = "queued";
    else if (message.promptState === "queued" || message.promptState === "processing") delete message.promptState;
  }
}

export function setPromptProcessing(message: TranscriptMessage, pending: DurableCoordinatorPrompt): void {
  pending.state = "processing";
  message.promptState = "processing";
  delete message.promptError;
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
