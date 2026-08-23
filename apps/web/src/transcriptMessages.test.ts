import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptMessage } from "@neocode/protocol";
import { appendUnique } from "./transcript";
import { promptStateLabel } from "./transcriptMessages";

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

test("prompt lifecycle labels distinguish pending, processing, and failure", () => {
  assert.equal(promptStateLabel(message("a", 1, "sending")), "sending…");
  assert.equal(promptStateLabel(message("b", 2, "queued")), "queued");
  assert.equal(promptStateLabel(message("c", 3, "processing")), "processing");
  assert.equal(promptStateLabel(message("d", 4, "failed")), "send failed");
  assert.equal(promptStateLabel(message("e", 5)), undefined);
});
