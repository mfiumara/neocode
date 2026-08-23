import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptMessage } from "@neocode/protocol";
import { DEFAULT_TRANSCRIPT_PAGE_SIZE, transcriptPage } from "./transcript-pagination.js";

function history(count: number): TranscriptMessage[] {
  const largeEvidence = JSON.stringify({ judge: "x".repeat(16_000), diagnostics: Array(30).fill("failure evidence") });
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: "system" as const,
    timestamp: index,
    text: index % 100 === 0
      ? `[worker_status] ${JSON.stringify({ jobId: `j-${index}`, state: "action_required", detail: largeEvidence })}`
      : `message ${index}`,
  }));
}

test("10,000 durable messages produce a bounded initial snapshot window without data loss", () => {
  const durable = history(10_000);
  const fullBytes = Buffer.byteLength(JSON.stringify(durable));
  const initial = transcriptPage(durable);
  const initialBytes = Buffer.byteLength(JSON.stringify(initial));

  assert.equal(initial.messages.length, DEFAULT_TRANSCRIPT_PAGE_SIZE);
  assert.equal(initial.messages[0]?.id, "m-9900");
  assert.equal(initial.messages.at(-1)?.id, "m-9999");
  assert.equal(initial.page.hasOlder, true);
  assert.ok(initialBytes < fullBytes / 20, `${initialBytes} should be far smaller than ${fullBytes}`);
  assert.equal(durable.length, 10_000, "pagination never truncates durable source history");
  assert.match(durable[9900]!.text, /judge/, "large raw lifecycle evidence remains durable");
});

test("cursor pages reconstruct exact order with no overlap", () => {
  const durable = history(10_000);
  let page = transcriptPage(durable);
  let loaded = page.messages;
  while (page.page.hasOlder) {
    page = transcriptPage(durable, page.page.oldestCursor, 137);
    const ids = new Set(loaded.map((message) => message.id));
    assert.equal(page.messages.some((message) => ids.has(message.id)), false);
    loaded = [...page.messages, ...loaded];
  }
  assert.deepEqual(loaded.map((message) => message.id), durable.map((message) => message.id));
});
