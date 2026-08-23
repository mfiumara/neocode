import assert from "node:assert/strict";
import test from "node:test";
import { resolveIsolationMode } from "./isolation.js";

test("explicit isolation always wins", () => {
  assert.equal(resolveIsolationMode("implement a feature", "root"), "root");
  assert.equal(resolveIsolationMode("inspect the API", "worktree"), "worktree");
});

test("auto prefers worktrees for mutating or ambiguous work", () => {
  assert.equal(resolveIsolationMode("implement configurable isolation", "auto"), "worktree");
  assert.equal(resolveIsolationMode("look into this task", "auto"), "worktree");
  assert.equal(resolveIsolationMode("review and fix the parser", "auto"), "worktree");
});

test("auto permits root for clearly non-mutating work", () => {
  assert.equal(resolveIsolationMode("explain how delegation works", "auto"), "root");
  assert.equal(resolveIsolationMode("inspect the protocol for isolation metadata", "auto"), "root");
});
