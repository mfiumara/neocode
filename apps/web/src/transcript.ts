import type { TranscriptMessage, TranscriptPageInfo } from "@neocode/protocol";

export function messageContextText(message: TranscriptMessage): string {
  const event = message.workerEvent;
  if (!event?.rawEvidence) return message.text;
  return `${event.title} — ${event.state.replaceAll("_", " ")}: ${event.summary}\n\nRaw lifecycle evidence:\n${event.rawEvidence}`;
}

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

/** Insert a chronological page immediately before its requested cursor. */
export function insertPageBefore(messages: TranscriptMessage[], page: TranscriptMessage[], before?: string): TranscriptMessage[] {
  const result = [...messages];
  const known = new Set(result.map((message) => message.id));
  for (let start = 0; start < page.length;) {
    if (known.has(page[start]!.id)) { start += 1; continue; }
    let end = start + 1;
    while (end < page.length && !known.has(page[end]!.id)) end += 1;
    const run = page.slice(start, end);
    const previousId = page[start - 1]?.id;
    const nextId = page[end]?.id;
    const previousIndex = previousId ? result.findIndex((message) => message.id === previousId) : -1;
    const nextIndex = nextId ? result.findIndex((message) => message.id === nextId) : -1;
    const cursorIndex = before ? result.findIndex((message) => message.id === before) : -1;
    const insertion = previousIndex >= 0 ? previousIndex + 1 : nextIndex >= 0 ? nextIndex : cursorIndex >= 0 ? cursorIndex : 0;
    result.splice(insertion, 0, ...run);
    run.forEach((message) => known.add(message.id));
    start = end;
  }
  return result;
}

/** Backward-compatible initial prepend when no explicit cursor is available. */
export function prependPage(messages: TranscriptMessage[], page: TranscriptMessage[]): TranscriptMessage[] {
  return insertPageBefore(messages, page, messages[0]?.id);
}

/**
 * Reconcile messages and their cursor as one unit. Cached pages are retained
 * only when the authoritative server tail overlaps them, proving continuity.
 * A disjoint reconnect preserves the reader's cached historical range and
 * appends the fresh authoritative tail. Its cursor becomes the active gap-fill
 * boundary, so repeated pages insert before that tail without losing the view.
 */
export function reconcileWindow(cached: TranscriptWindow, server: TranscriptWindow): TranscriptWindow {
  if (!cached.messages.length) return server;
  if (!server.messages.length) return server;
  const cachedIndex = new Map(cached.messages.map((message, index) => [message.id, index]));
  const overlap = server.messages.findIndex((message) => cachedIndex.has(message.id));
  if (overlap < 0) {
    const serverIds = new Set(server.messages.map((message) => message.id));
    return {
      messages: [...cached.messages.filter((message) => !serverIds.has(message.id)), ...server.messages],
      page: server.page,
    };
  }
  const oldIndex = cachedIndex.get(server.messages[overlap]!.id)!;
  return {
    messages: [...cached.messages.slice(0, oldIndex), ...server.messages],
    page: cached.page,
  };
}
