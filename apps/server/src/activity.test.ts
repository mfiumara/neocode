import assert from "node:assert/strict";
import test from "node:test";
import { activity, ActivityTimeline, summarizeToolArgs, toolActivity, type ActivityClock } from "./activity.js";

test("summarizeToolArgs prioritizes useful arguments and stays concise", () => {
  const summary = summarizeToolArgs({
    path: "/workspace/src/orchestrator.ts",
    pattern: "coordinator activity",
    offset: 120,
    ignored: "fourth value is not included",
  });
  assert.equal(summary, "path: /workspace/src/orchestrator.ts · pattern: coordinator activity · offset: 120");
  assert.ok(summary!.length <= 110);
});

test("summarizeToolArgs omits credentials and nested or huge output", () => {
  const summary = summarizeToolArgs({
    command: "npm test",
    apiToken: "do-not-display",
    result: { output: "x".repeat(50_000) },
    text: "x".repeat(5_000),
  });
  assert.ok(summary?.includes("command: npm test"));
  assert.ok(!summary?.includes("do-not-display"));
  assert.ok(!summary?.includes("50000"));
  assert.ok(summary!.length <= 110);
});

test("tool activities expose transitions without results", () => {
  const running = toolActivity("tool_running", "read", { path: "src/App.tsx" });
  const complete = toolActivity("tool_complete", "read");
  assert.equal(running.description, "Running read — path: src/App.tsx");
  assert.equal(complete.description, "Finished read");
  assert.equal(complete.phase, "tool_complete");
});

test("activity descriptions are normalized and capped", () => {
  const value = activity("thinking", `  Thinking\n${"x".repeat(300)}  `, undefined, 123);
  assert.equal(value.description.includes("\n"), false);
  assert.ok(value.description.length <= 140);
  assert.equal(value.startedAt, 123);
});

test("timeline keeps a stable start across deltas and uses monotonic duration", () => {
  let wall = 1_000;
  let monotonic = 10;
  const clock: ActivityClock = { wallNow: () => wall, monotonicNow: () => monotonic };
  const history: ReturnType<typeof activity>[] = [];
  const timeline = new ActivityTimeline(undefined, history, clock);

  assert.equal(timeline.set(activity("thinking", "Thinking", undefined, wall)), true);
  wall = 50_000; // A wall-clock correction must not inflate an in-process step.
  monotonic = 260;
  assert.equal(timeline.set(activity("thinking", "Thinking", undefined, wall)), false);
  assert.equal(timeline.current?.startedAt, 1_000);
  timeline.set(activity("responding", "Writing response", undefined, wall));

  assert.equal(history[0]?.startedAt, 1_000);
  assert.equal(history[0]?.completedAt, 50_000);
  assert.equal(history[0]?.durationMs, 250);
});

test("restored activity falls back to truthful wall-clock duration", () => {
  const clock: ActivityClock = { wallNow: () => 2_500, monotonicNow: () => 100 };
  const timeline = new ActivityTimeline(undefined, [], clock);
  // Simulate adopting persisted state without an in-process monotonic anchor.
  timeline.current = activity("tool_running", "Running tests", "test", 1_000);
  const completed = timeline.completeCurrent();
  assert.equal(completed?.durationMs, 1_500);
});
