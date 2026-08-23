import assert from "node:assert/strict";
import test from "node:test";
import { workerSystemPrompt } from "./orchestrator.js";

test("worktree worker prompt reserves judging and integration authority for the main coordinator", () => {
  const prompt = workerSystemPrompt("base", {
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/worker" },
  });

  assert.match(prompt, /never mutate root\/main/i);
  assert.match(prompt, /never merge or advance the main ref, launch a judge, judge the work yourself, or directly start integration/i);
  assert.match(prompt, /only the MAIN coordinator owns those decisions and tool calls/);
  assert.match(prompt, /structured, concise handoff covering requirements, changes, tests, and unresolved risks/);
  assert.match(prompt, /inside this assigned checkout/);
});

test("root isolation stays explicit but every shared-root background worker is read-only", () => {
  const automaticJob = { isolation: { requested: "auto" as const, mode: "root" as const, path: "/repo" } };
  const explicitJob = { isolation: { requested: "root" as const, mode: "root" as const, path: "/repo" } };
  const automatic = workerSystemPrompt(undefined, automaticJob);
  const explicit = workerSystemPrompt(undefined, explicitJob);

  assert.equal(explicitJob.isolation.requested, "root", "prompt policy never rewrites explicit isolation metadata");
  for (const prompt of [automatic, explicit]) {
    assert.match(prompt, /read-only there: inspect and report only; do not edit or mutate the shared checkout/i);
    assert.doesNotMatch(prompt, /edits there are permitted/i);
  }
  assert.match(explicit, /explicitly selected shared root checkout/);
});
