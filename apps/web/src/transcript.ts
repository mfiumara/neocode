import type { TranscriptMessage, TranscriptPageInfo } from "@neocode/protocol";

export interface TranscriptWindow {
  messages: TranscriptMessage[];
  page?: TranscriptPageInfo;
}

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

/**
 * Reconcile messages and their cursor as one unit. Cached pages are retained
 * only when the authoritative server tail overlaps them, proving continuity.
 * A disjoint reconnect tail replaces the cache and adopts its cursor so the
 * omitted middle remains reachable through pagination.
 */
export function reconcileWindow(cached: TranscriptWindow, server: TranscriptWindow): TranscriptWindow {
  if (!cached.messages.length) return server;
  if (!server.messages.length) return server;
  const cachedIndex = new Map(cached.messages.map((message, index) => [message.id, index]));
  const overlap = server.messages.findIndex((message) => cachedIndex.has(message.id));
  if (overlap < 0) return server;
  const oldIndex = cachedIndex.get(server.messages[overlap]!.id)!;
  return {
    messages: [...cached.messages.slice(0, oldIndex), ...server.messages],
    page: cached.page,
  };
}
