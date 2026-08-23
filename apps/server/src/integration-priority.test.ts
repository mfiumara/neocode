import assert from "node:assert/strict";
import test from "node:test";
import { integrationComplexityScore } from "./integration-priority.js";

test("small non-overlapping changes are prioritized before broad conflicting changes", () => {
  const easy = integrationComplexityScore({ files: 1, additions: 8, deletions: 2, overlappingFiles: 0, ageMs: 0 });
  const complex = integrationComplexityScore({ files: 8, additions: 200, deletions: 80, overlappingFiles: 2, ageMs: 0 });
  assert.ok(easy < complex);
});

test("aging lowers complexity priority without producing negative scores", () => {
  const fresh = integrationComplexityScore({ files: 2, additions: 30, deletions: 10, overlappingFiles: 0, ageMs: 0 });
  const old = integrationComplexityScore({ files: 2, additions: 30, deletions: 10, overlappingFiles: 0, ageMs: 24 * 3_600_000 });
  assert.ok(old < fresh);
  assert.equal(integrationComplexityScore({ files: 0, additions: 0, deletions: 0, overlappingFiles: 0, ageMs: 999 * 3_600_000 }), 0);
});
