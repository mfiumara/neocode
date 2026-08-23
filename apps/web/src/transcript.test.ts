import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptMessage } from "@neocode/protocol";
import { anchoredScrollTop } from "./transcriptScroll";
import { appendUnique, prependPage, reconcileTail } from "./transcript";

const message = (id: string): TranscriptMessage => ({ id, role: "assistant", text: id, timestamp: Number(id.slice(1)) });

test("pages prepend in server order and deduplicate replayed boundaries", () => {
  const loaded = [message("m3"), message("m4"), message("m5")];
  const result = prependPage(loaded, [message("m1"), message("m2"), message("m3")]);
  assert.deepEqual(result.map(({ id }) => id), ["m1", "m2", "m3", "m4", "m5"]);
});

test("reconnect tail preserves loaded pages, replaces overlaps, and appends downtime output", () => {
  const loaded = [message("m1"), message("m2"), message("m3"), message("m4")];
  const result = reconcileTail(loaded, [{ ...message("m3"), text: "updated" }, message("m4"), message("m5")]);
  assert.deepEqual(result.map(({ id }) => id), ["m1", "m2", "m3", "m4", "m5"]);
  assert.equal(result[2]?.text, "updated");
  assert.equal(appendUnique(result, message("m5")).length, 5);
  assert.deepEqual(reconcileTail([message("m1")], [message("m9")]).map(({ id }) => id), ["m9"],
    "a reconnect gap keeps the server cursor/order truthful and reloadable");
});

test("prepending preserves the exact visual scroll anchor for dynamic-height rows", () => {
  assert.equal(anchoredScrollTop(420, 2_000, 3_375), 1_795);
  assert.equal(anchoredScrollTop(0, 100, 50), 0);
});
