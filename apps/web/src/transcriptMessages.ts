import type { PromptSettlementSnapshot, TranscriptMessage } from "@neocode/protocol";

/** Apply bounded FIFO settlement authority to cached rows outside the server tail. */
export function reconcilePromptSettlement(
  messages: TranscriptMessage[],
  settlement?: PromptSettlementSnapshot,
): TranscriptMessage[] {
  if (!settlement) return messages;
  const failures = new Map(settlement.failures.map((entry) => [entry.messageId, entry.error]));
  return messages.map((message) => {
    if ((message.promptState !== "queued" && message.promptState !== "processing")
      || message.timestamp > settlement.throughTimestamp) return message;
    const error = failures.get(message.id);
    if (error) return { ...message, promptState: "failed", promptError: error };
    const settled = { ...message };
    delete settled.promptState;
    delete settled.promptError;
    return settled;
  });
}

export function promptStateLabel(message: TranscriptMessage): string | undefined {
  if (message.promptState === "sending") return "sending…";
  if (message.promptState === "queued") return "queued";
  if (message.promptState === "processing") return "processing";
  if (message.promptState === "failed") return "send failed";
  return undefined;
}
