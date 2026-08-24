#!/usr/bin/env node
import { createHash } from "node:crypto";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const EVIDENCE_MARKER = "neocode-review-evidence-v1";
const COMMANDS = ["npm test", "npm run check", "npm run build"];
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;
const checksum = (value) => createHash("sha256").update(value).digest("hex");
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`evidence git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}
function commit(reference, cwd) { return git(["rev-parse", `${reference}^{commit}`], cwd).trim(); }
function tree(reference, cwd) { return git(["rev-parse", `${reference}^{tree}`], cwd).trim(); }
function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed recognized review evidence: ${label} must be an object.`);
  return value;
}
function verifyCapture(capture, command, label) {
  const value = requireObject(capture, label);
  if (value.command !== command || value.exit !== 0 || typeof value.output !== "string" || typeof value.cwd !== "string"
    || value.cwd.length === 0 || !Number.isSafeInteger(value.bytes) || value.bytes !== Buffer.byteLength(value.output)
    || !hex64.test(value.sha256 || "")) {
    throw new Error(`Malformed recognized review evidence: invalid ${label} command, cwd, exit, bytes, output, or checksum.`);
  }
  if (checksum(value.output) !== value.sha256) throw new Error(`Malformed recognized review evidence: ${label} checksum mismatch.`);
  for (const field of ["startedAt", "finishedAt"]) {
    if (typeof value[field] !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value[field]) || Number.isNaN(Date.parse(value[field]))) {
      throw new Error(`Malformed recognized review evidence: ${label}.${field} must be an exact UTC timestamp.`);
    }
  }
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) throw new Error(`Malformed recognized review evidence: ${label} timestamps are reversed.`);
}

/** Verify a recognized final empty evidence commit. Non-evidence HEADs are ignored. */
export function verifyReviewEvidence(cwd = process.cwd()) {
  const body = git(["show", "-s", "--format=%B", "HEAD"], cwd).trim();
  if (!body.startsWith(EVIDENCE_MARKER)) return false;
  const source = body.slice(EVIDENCE_MARKER.length).trim();
  let evidence;
  try { evidence = requireObject(JSON.parse(source), "root"); }
  catch (error) { throw new Error(`Malformed recognized review evidence: ${error instanceof Error ? error.message : String(error)}`); }
  if (evidence.version !== 1 || !hex40.test(evidence.testedParent || "") || !hex40.test(evidence.testedTree || "") || !hex40.test(evidence.base || "") || !hex40.test(evidence.mergeBase || "")) {
    throw new Error("Malformed recognized review evidence: invalid version or Git identities.");
  }
  const parent = commit("HEAD^", cwd);
  if (evidence.testedParent !== parent || evidence.testedTree !== tree(parent, cwd) || tree("HEAD", cwd) !== evidence.testedTree) {
    throw new Error("Malformed recognized review evidence: HEAD must be an empty commit over the exact tested parent/tree.");
  }
  if (commit(evidence.base, cwd) !== evidence.base || git(["merge-base", evidence.base, "HEAD"], cwd).trim() !== evidence.mergeBase || evidence.mergeBase !== evidence.base) {
    throw new Error("Malformed recognized review evidence: base/merge-base mismatch.");
  }
  const repository = requireObject(evidence.repository, "repository");
  const recordedTop = normalize(repository.topLevel || "");
  const recordedCwd = normalize(evidence.testCwd || "");
  const outside = relative(recordedTop, recordedCwd);
  if (!isAbsolute(recordedTop) || !isAbsolute(recordedCwd) || (outside && (outside === ".." || outside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)))
    || repository.testedParent !== evidence.testedParent || repository.testedTree !== evidence.testedTree) {
    throw new Error("Malformed recognized review evidence: invalid or unbound historical repository/cwd identity.");
  }
  if (!Array.isArray(evidence.commands) || evidence.commands.length !== COMMANDS.length) throw new Error("Malformed recognized review evidence: exact command captures are required.");
  evidence.commands.forEach((capture, index) => {
    verifyCapture(capture, COMMANDS[index], `commands[${index}]`);
    if (normalize(capture.cwd) !== recordedCwd) throw new Error(`Malformed recognized review evidence: commands[${index}] historical cwd is inconsistent.`);
  });
  if (!Array.isArray(evidence.risks) || !evidence.risks.length || evidence.risks.some((risk) => typeof risk !== "string" || !risk.trim())) {
    throw new Error("Malformed recognized review evidence: non-empty risks are required.");
  }
  const nameStatus = git(["diff", "--name-status", `${evidence.base}...${evidence.testedParent}`], cwd);
  const nameEvidence = requireObject(evidence.nameStatus, "nameStatus");
  if (typeof nameEvidence.output !== "string" || !hex64.test(nameEvidence.sha256 || "") || nameEvidence.output !== nameStatus || checksum(nameStatus) !== nameEvidence.sha256) {
    throw new Error("Malformed recognized review evidence: name-status packet mismatch.");
  }
  const binaryDiff = git(["diff", "--binary", `${evidence.base}...${evidence.testedParent}`], cwd);
  if (!hex64.test(evidence.canonicalDiffSha256 || "") || checksum(binaryDiff) !== evidence.canonicalDiffSha256) {
    throw new Error("Malformed recognized review evidence: canonical diff checksum mismatch.");
  }

  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).trim();
  const root = resolve(dirname(commonDir));
  const live = [
    [evidence.candidatePorcelain, "git status --porcelain --untracked-files=all", "candidatePorcelain", git(["status", "--porcelain", "--untracked-files=all"], cwd), recordedCwd],
    [evidence.rootPorcelain, "git status --porcelain --untracked-files=all", "rootPorcelain", git(["status", "--porcelain", "--untracked-files=all"], root), recordedTop],
    [evidence.diffCheck, `git diff --check ${evidence.base} ${evidence.testedParent}`, "diffCheck", git(["diff", "--check", evidence.base, evidence.testedParent], cwd), recordedCwd],
  ];
  for (const [capture, command, label, output, expectedCwd] of live) {
    verifyCapture(capture, command, label);
    if (normalize(capture.cwd) !== expectedCwd) throw new Error(`Malformed recognized review evidence: ${label} historical cwd is inconsistent.`);
    if (capture.output !== output) throw new Error(`Malformed recognized review evidence: live ${label} output mismatch.`);
  }
  process.stdout.write(`verified review evidence: tested parent ${parent}, tree ${evidence.testedTree}\n`);
  return true;
}
