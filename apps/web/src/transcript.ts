import type { TranscriptMessage } from "@neocode/protocol";

/** Append live updates without duplicating replayed messages after reconnect. */
export function appendUnique(messages: TranscriptMessage[], incoming: TranscriptMessage): TranscriptMessage[] {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index < 0) return [...messages, incoming];
  const next = [...messages];
  next[index] = incoming;
  return next;
}

/** Pages are chronological and precede the cursor. Preserve server order. */
export function prependPage(messages: TranscriptMessage[], page: TranscriptMessage[]): TranscriptMessage[] {
  const known = new Set(messages.map((message) => message.id));
  return [...page.filter((message) => !known.has(message.id)), ...messages];
}

/** Reconcile a bounded reconnect tail while retaining pages already loaded. */
export function reconcileTail(messages: TranscriptMessage[], tail: TranscriptMessage[]): TranscriptMessage[] {
  if (!messages.length) return tail;
  const firstOverlap = tail.findIndex((message) => messages.some((old) => old.id === message.id));
  // If more than one server window arrived during downtime there is a gap.
  // Keep the server tail/cursor truthful; discarded client cache is pageable.
  if (firstOverlap < 0) return tail;
  const overlapId = tail[firstOverlap]!.id;
  const oldIndex = messages.findIndex((message) => message.id === overlapId);
  return [...messages.slice(0, oldIndex), ...tail];
}
