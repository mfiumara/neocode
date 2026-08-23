import assert from "node:assert/strict";
import test from "node:test";
import {
  isNearTranscriptBottom,
  nearestTranscriptScrollTop,
} from "./transcriptScroll";

test("follows output only inside the bottom threshold", () => {
  assert.equal(isNearTranscriptBottom({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 510 }), true);
  assert.equal(isNearTranscriptBottom({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 503 }), false);
  assert.equal(isNearTranscriptBottom({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 }), true);
});

test("scrolls a row below the transcript viewport above its bottom margin", () => {
  assert.equal(nearestTranscriptScrollTop({
    scrollTop: 300,
    viewportTop: 100,
    viewportBottom: 600,
    itemTop: 560,
    itemBottom: 650,
  }), 366);
});

test("scrolls upward and leaves an already visible row alone", () => {
  assert.equal(nearestTranscriptScrollTop({
    scrollTop: 300,
    viewportTop: 100,
    viewportBottom: 600,
    itemTop: 70,
    itemBottom: 140,
  }), 254);
  assert.equal(nearestTranscriptScrollTop({
    scrollTop: 300,
    viewportTop: 100,
    viewportBottom: 600,
    itemTop: 150,
    itemBottom: 550,
  }), 300);
});
