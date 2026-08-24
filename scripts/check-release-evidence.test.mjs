import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { commandRecordSha256, EMPTY_SHA256, parseEvidenceMessage, validateEvidenceRecord } from "./check-release-evidence.mjs";

function fixture() {
  const cwd = "/repo/.worktrees/candidate";
  const record = {
    version: 1, testedParent: "parent", testedTree: "tree", base: "base", mergeBase: "base", cwd, rootCwd: "/repo",
    commands: ["npm test", "npm run check", "npm run build"].map((command, index) => {
      const stdout = Buffer.from(`output ${index}\n`); const stderr = Buffer.alloc(0);
      const evidence = { command, cwd, startedUtc: `2026-08-24T08:0${index}:00Z`, finishedUtc: `2026-08-24T08:0${index}:01Z`, exit: 0,
        stdoutSha256: "", stdoutBytes: stdout.length, stdoutBase64: stdout.toString("base64"),
        stderrSha256: EMPTY_SHA256, stderrBytes: 0, stderrBase64: "", recordSha256: "" };
      evidence.stdoutSha256 = createHash("sha256").update(stdout).digest("hex");
      evidence.recordSha256 = commandRecordSha256(evidence);
      return evidence;
    }),
    candidatePorcelain: { beforeSha256: EMPTY_SHA256, beforeBytes: 0, afterSha256: EMPTY_SHA256, afterBytes: 0 },
    rootPorcelain: { beforeSha256: EMPTY_SHA256, beforeBytes: 0, afterSha256: EMPTY_SHA256, afterBytes: 0 },
    risks: ["Dirty manifest fingerprint omissions remain durably ambiguous.", "Existing Vite chunk-size warning remains."],
  };
  const facts = { subject: "Record trusted literal validation evidence", parent: "parent", headTree: "tree", parentTree: "tree", base: "base", mergeBase: "base", cwd, rootCwd: "/repo", candidatePorcelain: "", rootPorcelain: "" };
  return { record, facts };
}

test("rejects missing, duplicate, and malformed evidence trailers", () => {
  assert.throws(() => parseEvidenceMessage("ordinary commit"), /exactly one/);
  assert.throws(() => parseEvidenceMessage("Neocode-Evidence-JSON: !!!"), /malformed/);
  const encoded = Buffer.from("{}").toString("base64url");
  assert.throws(() => parseEvidenceMessage(`Neocode-Evidence-JSON: ${encoded}\nNeocode-Evidence-JSON: ${encoded}`), /exactly one/);
});

test("accepts complete byte-identical exact-tree evidence", () => {
  const { record, facts } = fixture();
  assert.equal(validateEvidenceRecord(record, facts), true);
});

test("fails closed for missing records, non-empty final commit, wrong parent/tree, and dirty porcelain", () => {
  const { record, facts } = fixture();
  for (const mutate of [
    (r, f) => { r.commands.pop(); },
    (r, f) => { f.headTree = "changed"; },
    (r, f) => { f.parent = "wrong"; },
    (r, f) => { f.candidatePorcelain = " M file"; },
    (r, f) => { r.rootPorcelain.afterSha256 = "c".repeat(64); },
  ]) {
    const candidate = structuredClone(record); const observed = structuredClone(facts); mutate(candidate, observed);
    assert.throws(() => validateEvidenceRecord(candidate, observed), /release evidence:/);
  }
});

test("rejects command spelling, cwd, exits, timestamps, checksums, and missing risks", () => {
  const { record, facts } = fixture();
  for (const mutate of [
    (r) => { r.commands[0].command = "npm run test"; },
    (r) => { r.commands[1].cwd = "/other"; },
    (r) => { r.commands[2].exit = 1; },
    (r) => { r.commands[0].startedUtc = "yesterday"; },
    (r) => { r.commands[0].startedUtc = "2026-08-24T07:59:59Z"; },
    (r) => { r.commands[1].finishedUtc = "2026-08-24T07:00:00Z"; },
    (r) => { r.commands[2].stdoutSha256 = "c".repeat(64); },
    (r) => { r.commands[2].stdoutBase64 = Buffer.from("tampered\n").toString("base64"); },
    (r) => { r.commands[2].stderrBytes = -1; },
    (r) => { r.risks = []; },
  ]) {
    const candidate = structuredClone(record); mutate(candidate);
    assert.throws(() => validateEvidenceRecord(candidate, facts), /release evidence:/);
  }
});
