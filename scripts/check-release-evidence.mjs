import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const COMMANDS = ["npm test", "npm run check", "npm run build"];
const SHA = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function fail(message) { throw new Error(`release evidence: ${message}`); }
function validUtc(value) { return typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value)); }

export function validateEvidenceRecord(record, facts) {
  if (!record || record.version !== 1) fail("missing or unsupported record");
  for (const key of ["testedParent", "testedTree", "base", "mergeBase", "cwd"]) if (typeof record[key] !== "string" || !record[key]) fail(`missing ${key}`);
  if (facts.subject !== "Record trusted literal validation evidence") fail("final commit subject is not recognized");
  if (facts.parent !== record.testedParent) fail("tested parent does not match final parent");
  if (facts.headTree !== facts.parentTree || facts.headTree !== record.testedTree) fail("final commit is non-empty or tree does not match tested parent");
  if (facts.base !== record.base || facts.mergeBase !== record.mergeBase) fail("base or merge-base mismatch");
  if (facts.cwd !== record.cwd) fail("tested cwd mismatch");
  if (!Array.isArray(record.commands) || record.commands.length !== COMMANDS.length) fail("literal command records are incomplete");
  for (let index = 0; index < COMMANDS.length; index += 1) {
    const command = record.commands[index];
    if (!command || command.command !== COMMANDS[index]) fail(`command ${index + 1} spelling/order mismatch`);
    if (command.cwd !== record.cwd) fail(`${command.command} cwd mismatch`);
    if (!validUtc(command.startedUtc) || !validUtc(command.finishedUtc) || Date.parse(command.finishedUtc) < Date.parse(command.startedUtc)) fail(`${command.command} timestamps malformed`);
    if (command.exit !== 0) fail(`${command.command} exit is nonzero`);
    for (const stream of ["stdout", "stderr"]) {
      const checksum = command[`${stream}Sha256`];
      const bytes = command[`${stream}Bytes`];
      if (!SHA.test(checksum || "") || !Number.isSafeInteger(bytes) || bytes < 0) fail(`${command.command} ${stream} checksum metadata malformed`);
    }
  }
  for (const name of ["candidatePorcelain", "rootPorcelain"]) {
    const evidence = record[name];
    if (!evidence || evidence.beforeSha256 !== EMPTY_SHA256 || evidence.afterSha256 !== EMPTY_SHA256
      || evidence.beforeBytes !== 0 || evidence.afterBytes !== 0) fail(`${name} does not prove separate clean before/after state`);
  }
  if (facts.candidatePorcelain !== "" || facts.rootPorcelain !== "") fail("current candidate or root porcelain is not clean");
  if (!Array.isArray(record.risks) || !record.risks.some((risk) => /dirty manifest fingerprint/i.test(risk))
    || !record.risks.some((risk) => /vite.*chunk/i.test(risk))) fail("required migration and Vite risks are missing");
  return true;
}

function git(args, cwd = process.cwd()) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd(); }
export function parseEvidenceMessage(message) {
  const lines = message.split("\n").filter((line) => line.startsWith("Neocode-Evidence-JSON: "));
  if (lines.length !== 1) fail("expected exactly one evidence trailer");
  try { return JSON.parse(Buffer.from(lines[0].slice("Neocode-Evidence-JSON: ".length), "base64url").toString("utf8")); }
  catch { fail("evidence trailer is malformed"); }
}

export function verifyHead(cwd = process.cwd()) {
  if (process.env.NEOCODE_EVIDENCE_RECORDING === "1") {
    process.stdout.write("release evidence: recording mode; final empty commit verification deferred\n");
    return true;
  }
  const message = git(["show", "-s", "--format=%B", "HEAD"], cwd);
  const record = parseEvidenceMessage(message);
  const worktrees = git(["worktree", "list", "--porcelain"], cwd);
  const root = worktrees.split("\n").find((line) => line.startsWith("worktree "))?.slice(9);
  if (!root) fail("root worktree is unavailable");
  return validateEvidenceRecord(record, {
    subject: git(["show", "-s", "--format=%s", "HEAD"], cwd),
    parent: git(["rev-parse", "HEAD^"], cwd), headTree: git(["rev-parse", "HEAD^{tree}"], cwd),
    parentTree: git(["rev-parse", "HEAD^^{tree}"], cwd), base: git(["rev-parse", "main"], cwd),
    mergeBase: git(["merge-base", "main", "HEAD"], cwd), cwd: git(["rev-parse", "--show-toplevel"], cwd),
    candidatePorcelain: git(["status", "--porcelain=v1", "--untracked-files=all"], cwd),
    rootPorcelain: git(["status", "--porcelain=v1", "--untracked-files=all"], root),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { verifyHead(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}

export { EMPTY_SHA256 };
