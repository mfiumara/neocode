import type { TranscriptMessage, TranscriptPageInfo } from "@neocode/protocol";

export const DEFAULT_TRANSCRIPT_PAGE_SIZE = 100;
export const MAX_TRANSCRIPT_PAGE_SIZE = 250;

export interface TranscriptPage {
  messages: TranscriptMessage[];
  page: TranscriptPageInfo;
}

export function transcriptPage(
  source: readonly TranscriptMessage[],
  before?: string,
  requestedLimit = DEFAULT_TRANSCRIPT_PAGE_SIZE,
): TranscriptPage {
  const limit = Math.max(1, Math.min(MAX_TRANSCRIPT_PAGE_SIZE,
    Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_TRANSCRIPT_PAGE_SIZE));
  let end = source.length;
  if (before !== undefined) {
    end = source.findIndex((message) => message.id === before);
    // A stale/unknown cursor must not replay the tail and create an endless
    // pagination loop. The client can refresh to acquire a current cursor.
    if (end < 0) return { messages: [], page: { oldestCursor: before, hasOlder: false } };
  }
  const start = Math.max(0, end - limit);
  const messages = source.slice(start, end).map((message) => structuredClone(message));
  return {
    messages,
    page: {
      oldestCursor: messages[0]?.id ?? before,
      hasOlder: start > 0,
    },
  };
}
