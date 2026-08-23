import type { TranscriptMessage } from "@neocode/protocol";

export function promptStateLabel(message: TranscriptMessage): string | undefined {
  if (message.promptState === "sending") return "sending…";
  if (message.promptState === "queued") return "queued";
  if (message.promptState === "processing") return "processing";
  if (message.promptState === "failed") return "send failed";
  return undefined;
}
