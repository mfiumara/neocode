import assert from "node:assert/strict";
import test from "node:test";
import { createLiveTimeAnchor, formatDuration, liveElapsedMs } from "./activityTiming";

test("live elapsed time is monotonic after anchoring", () => {
  const anchor = createLiveTimeAnchor(8_000, 10_000, 50);
  assert.equal(liveElapsedMs(anchor, 300), 2_250);
  // Wall time is deliberately absent from subsequent calculations.
  assert.equal(liveElapsedMs(anchor, 1_050), 3_000);
});

test("duration formatting is concise and deterministic", () => {
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(61_900), "1m 01s");
  assert.equal(formatDuration(3_720_000), "1h 02m");
});
