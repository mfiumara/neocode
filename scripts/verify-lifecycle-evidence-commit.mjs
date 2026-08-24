#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

const cwd = process.cwd();
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
const message = git("show", "-s", "--format=%B", "HEAD");
if (!/^Lifecycle-Evidence-Type:/m.test(message)) {
  console.log("lifecycle_evidence_state=pre-evidence-no-op");
  process.exit(0);
}
const trailers = new Map(message.split("\n").flatMap((line) => {
  const match = line.match(/^([A-Za-z0-9-]+): (.+)$/);
  return match ? [[match[1], match[2].trim()]] : [];
}));
const need = (key, pattern) => {
  const value = trailers.get(key);
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Missing or malformed ${key}`);
  return value;
};
const same = (label, actual, expected) => {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  console.log(`${label}=${actual}`);
};
same("evidence_type", need("Lifecycle-Evidence-Type"), "coordinator-lifecycle-exactly-once-v3");
const parent = git("rev-parse", "HEAD^1");
const tree = git("rev-parse", "HEAD^{tree}");
same("tested_parent", need("Tested-Parent", /^[0-9a-f]{40}$/), parent);
same("tested_tree", need("Tested-Tree", /^[0-9a-f]{40}$/), git("rev-parse", "HEAD^1^{tree}"));
same("empty_final_tree", tree, need("Tested-Tree"));
const evidenceCommit = need("Evidence-Commit", /^[0-9a-f]{40}$/);
same("evidence_parent", git("rev-parse", "HEAD^2"), evidenceCommit);

const requestedBase = process.env.NEOCODE_DIFF_BASE_SHA?.trim();
const candidates = [requestedBase, "main", "origin/main", need("Base", /^[0-9a-f]{40}$/)].filter(Boolean);
let base;
for (const candidate of candidates) {
  try {
    const resolved = git("rev-parse", "--verify", `${candidate}^{commit}`);
    execFileSync("git", ["merge-base", "--is-ancestor", resolved, "HEAD^1"], { cwd, stdio: "ignore" });
    base = resolved; break;
  } catch { /* try the next portable identity */ }
}
if (!base) throw new Error("No validated evidence base is available");
same("base", need("Base"), base);
same("merge_base", need("Merge-Base", /^[0-9a-f]{40}$/), git("merge-base", base, "HEAD^1"));
same("candidate_porcelain", git("status", "--porcelain", "--untracked-files=normal"), "");
execFileSync("git", ["diff", "--check", `${base}...HEAD^1`], { cwd, stdio: "ignore" });

const evidenceNames = git("ls-tree", "--name-only", evidenceCommit).split("\n").sort();
same("evidence_files", evidenceNames.join(","), "git-state.txt,npm-run-build.log,npm-run-check.log,npm-test.log");
const manifest = git("show", `${evidenceCommit}:git-state.txt`);
const field = (name) => {
  const match = manifest.match(new RegExp(`^${name}: (.*)$`, "m"));
  if (!match) throw new Error(`Missing evidence manifest field ${name}`);
  return match[1];
};
same("manifest_base", field("Base"), base);
same("manifest_merge_base", field("Merge-Base"), git("merge-base", base, "HEAD^1"));
same("manifest_tested_parent", field("Tested-Parent"), parent);
same("manifest_tested_tree", field("Tested-Tree"), tree);
same("manifest_candidate_porcelain", field("Candidate-Porcelain"), "clean");
same("manifest_root_porcelain", field("Root-Porcelain"), "clean");
same("manifest_root_head", field("Root-Head"), base);
same("manifest_diff_check_exit", field("Diff-Check-Exit"), "0");
const risks = field("Residual-Risks");
if (risks.length < 20) throw new Error("Explicit residual risks are required");
same("residual_risks", need("Residual-Risks"), risks);
const worktrees = git("worktree", "list", "--porcelain").split("\n\n");
const mainEntry = worktrees.find((entry) => entry.includes("branch refs/heads/main"));
if (mainEntry) {
  const root = mainEntry.match(/^worktree (.+)$/m)?.[1];
  if (!root) throw new Error("Malformed main worktree identity");
  same("root_porcelain", execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trimEnd(), "");
  same("root_head", execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), base);
} else console.log("root_worktree=not-checked-out; captured root identity validated against base");

const expected = [
  ["npm-test.log", "npm test", "Npm-Test", ["> neocode@0.1.0 test", "# fail 0", "1 passed"]],
  ["npm-run-check.log", "npm run check", "Npm-Run-Check", ["> neocode@0.1.0 check", "lifecycle_evidence_state=pre-evidence-no-op", "> @neocode/server@0.1.0 check", "> @neocode/web@0.1.0 check"]],
  ["npm-run-build.log", "npm run build", "Npm-Run-Build", ["> neocode@0.1.0 build", "> @neocode/server@0.1.0 build", "> @neocode/web@0.1.0 build", "✓ built in"]],
];
for (const [file, invocation, prefix, needles] of expected) {
  const raw = execFileSync("git", ["show", `${evidenceCommit}:${file}`], { cwd });
  const text = raw.toString("utf8");
  const escaped = invocation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^Invocation: ${escaped}\\nStarted-UTC: (\\S+)\\nCwd: (.+)\\n--- stdout\\+stderr ---\\n[\\s\\S]*\\n--- end stdout\\+stderr ---\\nFinished-UTC: (\\S+)\\nExit: (\\d+)\\n$`);
  const match = text.match(pattern);
  if (!match || Number.isNaN(Date.parse(match[1])) || Number.isNaN(Date.parse(match[3])) || Date.parse(match[3]) < Date.parse(match[1])) {
    throw new Error(`Malformed complete raw capture ${file}`);
  }
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`${file} lacks required raw output: ${needle}`);
  same(`${prefix}_cwd`, match[2], need("Working-Directory"));
  same(`${prefix}_exit`, match[4], "0");
  same(`${prefix}_bytes`, String(raw.length), need(`${prefix}-Capture-Bytes`, /^\d+$/));
  same(`${prefix}_sha256`, createHash("sha256").update(raw).digest("hex"), need(`${prefix}-Capture-SHA256`, /^[0-9a-f]{64}$/));
}
if (!manifest.includes(`Working-Directory: ${need("Working-Directory")}`)) throw new Error("Manifest cwd mismatch");
if (realpathSync(cwd) !== realpathSync(need("Working-Directory"))) console.log("cwd_portability=validated-captured-cwd; detached/current path may differ");
console.log(`lifecycle_evidence_verified_head=${git("rev-parse", "HEAD")}`);
