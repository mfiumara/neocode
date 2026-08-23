import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptMessage } from "@neocode/protocol";
import { appendUnique, reconcileWindow } from "./transcript";
import { promptStateLabel, reconcilePromptSettlement } from "./transcriptMessages";

const message = (id: string, timestamp: number, promptState?: TranscriptMessage["promptState"]): TranscriptMessage =>
  ({ id, role: "user", text: id, timestamp, promptState });

test("durable queued acknowledgement deduplicates an optimistic row in place", () => {
  const optimistic = message("request-1", 10, "sending");
  const acknowledged = message("request-1", 11, "queued");
  const rows = appendUnique([message("earlier", 1), optimistic], acknowledged);
  assert.deepEqual(rows.map((entry) => entry.id), ["earlier", "request-1"]);
  assert.equal(rows[1]?.promptState, "queued");
});

test("multiple queued prompts retain server ordering and settled updates do not duplicate", () => {
  let rows = appendUnique([], message("first", 10, "queued"));
  rows = appendUnique(rows, message("second", 20, "queued"));
  rows = appendUnique(rows, message("first", 10));
  assert.deepEqual(rows.map((entry) => entry.id), ["first", "second"]);
  assert.equal(rows[0]?.promptState, undefined);
});

test("disjoint reconnect clears paged-out pending state without dropping cached ranges", () => {
  const cached = [message("old", 1), message("paged-out", 2, "queued"), message("cached-tail", 3)];
  const server = [message("server-tail", 6), message("newer-active", 7, "queued")];
  const window = reconcileWindow(
    { messages: cached, page: { oldestCursor: "old", hasOlder: true } },
    { messages: server, page: { oldestCursor: "server-tail", hasOlder: true } },
  );
  const reconciled = reconcilePromptSettlement(window.messages, { throughTimestamp: 2, failures: [] });
  assert.deepEqual(reconciled.map((entry) => entry.id), ["old", "paged-out", "cached-tail", "server-tail", "newer-active"]);
  assert.equal(reconciled[1]?.promptState, undefined);
  assert.equal(reconciled[4]?.promptState, "queued");
  assert.equal(window.page?.oldestCursor, "server-tail", "the disjoint gap cursor remains authoritative");
});

test("bounded settlement authority preserves recent correlated failures", () => {
  const reconciled = reconcilePromptSettlement([message("failed", 2, "processing")], {
    throughTimestamp: 2,
    failures: [{ messageId: "failed", error: "backend failed" }],
  });
  assert.equal(reconciled[0]?.promptState, "failed");
  assert.equal(reconciled[0]?.promptError, "backend failed");
});

test("prompt lifecycle labels distinguish pending, processing, and failure", () => {
  assert.equal(promptStateLabel(message("a", 1, "sending")), "sending…");
  assert.equal(promptStateLabel(message("b", 2, "queued")), "queued");
  assert.equal(promptStateLabel(message("c", 3, "processing")), "processing");
  assert.equal(promptStateLabel(message("d", 4, "failed")), "send failed");
  assert.equal(promptStateLabel(message("e", 5)), undefined);
});
