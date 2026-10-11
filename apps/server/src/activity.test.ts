import assert from "node:assert/strict";
import test from "node:test";
import { activity, summarizeToolArgs, toolActivity } from "./activity.js";

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
  const value = activity("thinking", `  Thinking\n${"x".repeat(300)}  `);
  assert.equal(value.description.includes("\n"), false);
  assert.ok(value.description.length <= 140);
});
