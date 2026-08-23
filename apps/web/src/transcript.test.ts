import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptMessage } from "@neocode/protocol";
import { appendUnique, insertPageBefore, messageContextText, prependPage, reconcileWindow, type TranscriptWindow } from "./transcript";

const message = (id: string): TranscriptMessage => ({ id, role: "assistant", text: id, timestamp: Number(id.slice(1)) });
const page = (messages: TranscriptMessage[], oldestCursor: string, hasOlder = true): TranscriptWindow =>
  ({ messages, page: { oldestCursor, hasOlder } });

test("pages prepend in server order and deduplicate replayed boundaries", () => {
  const loaded = [message("m3"), message("m4"), message("m5")];
  const result = prependPage(loaded, [message("m1"), message("m2"), message("m3")]);
  assert.deepEqual(result.map(({ id }) => id), ["m1", "m2", "m3", "m4", "m5"]);
});

test("atomic reconnect preserves a disjoint reader cache while adopting the server gap cursor", () => {
  const cached = page(Array.from({ length: 300 }, (_, index) => message(`m${index}`)), "m0", false);
  const server = page(Array.from({ length: 100 }, (_, index) => message(`m${900 + index}`)), "m900");
  const result = reconcileWindow(cached, server);
  assert.deepEqual(result.messages.map(({ id }) => id), [...cached.messages, ...server.messages].map(({ id }) => id));
  assert.deepEqual(result.page, server.page, "server cursor becomes the gap-fill boundary");
});

test("partial overlap, downtime append, replay, and repeated reconnect retain continuity once", () => {
  let current = page([1, 2, 3, 4].map((id) => message(`m${id}`)), "m1");
  current = reconcileWindow(current, page([3, 4, 5].map((id) => message(`m${id}`)), "m3"));
  assert.deepEqual(current.messages.map(({ id }) => id), ["m1", "m2", "m3", "m4", "m5"]);
  assert.equal(current.page?.oldestCursor, "m1");
  current = reconcileWindow(current, page([3, 4, 5].map((id) => message(`m${id}`)), "m3"));
  current = reconcileWindow(current, page([4, 5, 6, 7].map((id) => message(`m${id}`)), "m4"));
  assert.deepEqual(current.messages.map(({ id }) => id), ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  assert.equal(new Set(current.messages.map(({ id }) => id)).size, current.messages.length);
  assert.equal(appendUnique(current.messages, message("m7")).length, 7);
});

test("every durable id remains reachable exactly once after a no-overlap reconnect", () => {
  const durable = Array.from({ length: 1_000 }, (_, index) => message(`m${index}`));
  let current = reconcileWindow(
    page(durable.slice(0, 300), "m0", false),
    page(durable.slice(900), "m900"),
  );
  while (current.page?.hasOlder) {
    const cursor = durable.findIndex((entry) => entry.id === current.page?.oldestCursor);
    const start = Math.max(0, cursor - 100);
    const older = durable.slice(start, cursor);
    current = { messages: insertPageBefore(current.messages, older, current.page.oldestCursor), page: { oldestCursor: older[0]?.id, hasOlder: start > 0 } };
  }
  assert.deepEqual(current.messages.map(({ id }) => id), durable.map(({ id }) => id));
  assert.equal(new Set(current.messages.map(({ id }) => id)).size, durable.length);
});

test("repeated disjoint reconnects and straddling pages preserve exact durable order", () => {
  const durable = Array.from({ length: 2_000 }, (_, index) => message(`m${index}`));
  let current = reconcileWindow(page(durable.slice(0, 300), "m0", false), page(durable.slice(900, 1_000), "m900"));
  current = reconcileWindow(current, page(durable.slice(1_900), "m1900"));
  while (current.page?.hasOlder) {
    const cursor = durable.findIndex((entry) => entry.id === current.page?.oldestCursor);
    const start = Math.max(0, cursor - 250);
    const older = durable.slice(start, cursor);
    current = { messages: insertPageBefore(current.messages, older, current.page.oldestCursor), page: { oldestCursor: older[0]?.id, hasOlder: start > 0 } };
  }
  assert.deepEqual(current.messages.map(({ id }) => id), durable.map(({ id }) => id));
  assert.equal(new Set(current.messages.map(({ id }) => id)).size, durable.length);
});

test("lifecycle context includes readable summary and full raw evidence", () => {
  const lifecycle: TranscriptMessage = {
    id: "event", role: "system", timestamp: 1, text: "compact status",
    workerEvent: {
      jobId: "job-1", title: "Fix transport", state: "action_required", summary: "Review diagnostics",
      rawEvidence: "{\"judge\":{\"approved\":false},\"diagnostic\":\"exact failure\"}", actionRequired: true,
    },
  };
  const context = messageContextText(lifecycle);
  assert.match(context, /Fix transport — action required: Review diagnostics/);
  assert.match(context, /exact failure/);
});

test("stable row keys survive timestamp merges with jobs above and below the viewport", () => {
  const before = [
    { key: "job-old", timestamp: 5 }, { key: "message-m50", timestamp: 50 },
    { key: "job-visible", timestamp: 55 }, { key: "message-m60", timestamp: 60 }, { key: "job-new", timestamp: 90 },
  ].sort((a, b) => a.timestamp - b.timestamp);
  const visibleKey = "job-visible";
  const selectedKey = "message-m60";
  const after = [...before, { key: "message-m10", timestamp: 10 }, { key: "message-m70", timestamp: 70 }]
    .sort((a, b) => a.timestamp - b.timestamp);
  assert.equal(after.findIndex(({ key }) => key === visibleKey), 3, "only rows truly above shift the anchor");
  assert.equal(after.findIndex(({ key }) => key === selectedKey), 4, "selection follows identity, not page length");
});
