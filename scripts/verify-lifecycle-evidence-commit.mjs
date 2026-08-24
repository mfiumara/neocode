#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const cwd = process.cwd();
const run = (args, options = {}) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trimEnd();
const message = run(["show", "-s", "--format=%B", "HEAD"]);
if (!/^Lifecycle-Evidence-Type:/m.test(message)) {
  console.log("lifecycle_evidence_state=pre-evidence-no-op");
  process.exit(0);
}
const values = new Map(message.split("\n").flatMap((line) => {
  const match = line.match(/^([A-Za-z0-9-]+): (.+)$/);
  return match ? [[match[1], match[2].trim()]] : [];
}));
const need = (key, pattern) => {
  const value = values.get(key);
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Missing or malformed ${key}`);
  return value;
};
const same = (name, actual, expected) => {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
  console.log(`${name}=${actual}`);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

same("evidence_type", need("Lifecycle-Evidence-Type"), "coordinator-lifecycle-exactly-once-linear-v1");
const ancestry = run(["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/);
if (ancestry.length !== 2) throw new Error("Evidence HEAD must have exactly one parent");
const parent = ancestry[1];
const tree = run(["rev-parse", "HEAD^{tree}"]);
same("tested_parent", need("Tested-Parent", /^[0-9a-f]{40}$/), parent);
same("tested_tree", need("Tested-Tree", /^[0-9a-f]{40}$/), run(["rev-parse", "HEAD^1^{tree}"]));
same("empty_final_tree", tree, need("Tested-Tree"));
same("empty_final_diff", run(["diff-tree", "--no-commit-id", "--name-only", "HEAD^", "HEAD"]), "");

const requested = process.env.NEOCODE_DIFF_BASE_SHA?.trim();
let base;
for (const candidate of [requested, "main", "origin/main", need("Base", /^[0-9a-f]{40}$/)].filter(Boolean)) {
  try {
    const resolved = run(["rev-parse", "--verify", `${candidate}^{commit}`]);
    execFileSync("git", ["merge-base", "--is-ancestor", resolved, "HEAD^"], { cwd, stdio: "ignore" });
    base = resolved; break;
  } catch { /* detached CI may lack local branch names */ }
}
if (!base) throw new Error("No validated evidence base is available");
same("base", need("Base"), base);
same("merge_base", need("Merge-Base", /^[0-9a-f]{40}$/), run(["merge-base", base, "HEAD^"]));
same("candidate_porcelain", run(["status", "--porcelain", "--untracked-files=normal"]), "");
execFileSync("git", ["diff", "--check", `${base}...HEAD^`], { cwd, stdio: "ignore" });
same("diff_check_exit", need("Diff-Check-Exit"), "0");
const names = run(["diff", "--name-status", `${base}...HEAD^`]);
const namePacket = message.match(/--- BEGIN CHANGED-NAME-STATUS ---\n([\s\S]*?)\n--- END CHANGED-NAME-STATUS ---/)?.[1];
if (namePacket === undefined) throw new Error("Missing changed-file packet");
same("changed_name_status", namePacket, names);
same("changed_name_status_sha256", sha256(Buffer.from(namePacket)), need("Changed-Name-Status-SHA256", /^[0-9a-f]{64}$/));

const identity = run(["show", "-s", "--format=%an <%ae>", "HEAD"]);
same("author_identity", need("Author-Identity"), identity);
same("committer_identity", need("Committer-Identity"), run(["show", "-s", "--format=%cn <%ce>", "HEAD"]));
same("candidate_porcelain_capture", need("Candidate-Porcelain"), "clean");
same("root_porcelain_capture", need("Root-Porcelain"), "clean");
same("root_head_capture", need("Root-Head", /^[0-9a-f]{40}$/), base);
const root = run(["worktree", "list", "--porcelain"]).split("\n\n").find((entry) => entry.includes("branch refs/heads/main"))?.match(/^worktree (.+)$/m)?.[1];
if (root) {
  same("root_porcelain", execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trimEnd(), "");
  same("root_head", execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), base);
} else console.log("root_worktree=not-checked-out; captured identity validated against base");

const rootCause = need("Root-Cause");
for (const phrase of ["compactable rows", "stale snapshots", "production serialization", "currentness", "turn correlation"]) {
  if (!rootCause.includes(phrase)) throw new Error(`Root cause omits ${phrase}`);
}
const risks = need("Residual-Risks");
for (const phrase of ["unbounded permanent settled-ID growth", "conservative unsigned legacy reconciliation", "at-least-once before committed settlement"]) {
  if (!risks.includes(phrase)) throw new Error(`Residual risks omit ${phrase}`);
}

const captures = [
  ["NPM-TEST", "npm test", "Npm-Test", ["> neocode@0.1.0 test", "# fail 0", "1 passed"]],
  ["NPM-RUN-CHECK", "npm run check", "Npm-Run-Check", ["> neocode@0.1.0 check", "lifecycle_evidence_state=pre-evidence-no-op", "> @neocode/server@0.1.0 check", "> @neocode/web@0.1.0 check"]],
  ["NPM-RUN-BUILD", "npm run build", "Npm-Run-Build", ["> neocode@0.1.0 build", "> @neocode/server@0.1.0 build", "> @neocode/web@0.1.0 build", "✓ built in"]],
];
for (const [marker, invocation, prefix, needles] of captures) {
  const encoded = message.match(new RegExp(`--- BEGIN ${marker} GZIP-BASE64 ---\\n([A-Za-z0-9+/=\\n]+?)\\n--- END ${marker} GZIP-BASE64 ---`))?.[1];
  if (!encoded) throw new Error(`Missing embedded ${invocation} capture`);
  let raw;
  try { raw = gunzipSync(Buffer.from(encoded.replace(/\s/g, ""), "base64")); } catch { throw new Error(`Corrupt embedded ${invocation} capture`); }
  const text = raw.toString("utf8");
  const escaped = invocation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parsed = text.match(new RegExp(`^Invocation: ${escaped}\\nStarted-UTC: (\\S+)\\nCwd: (.+)\\n--- stdout\\+stderr ---\\n[\\s\\S]*\\n--- end stdout\\+stderr ---\\nFinished-UTC: (\\S+)\\nExit: (\\d+)\\n$`));
  if (!parsed || !Date.parse(parsed[1]) || !Date.parse(parsed[3]) || Date.parse(parsed[3]) < Date.parse(parsed[1])) throw new Error(`Malformed ${invocation} capture`);
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`${invocation} capture lacks ${needle}`);
  same(`${prefix}_cwd`, parsed[2], need("Working-Directory"));
  same(`${prefix}_exit`, parsed[4], "0");
  same(`${prefix}_bytes`, String(raw.length), need(`${prefix}-Capture-Bytes`, /^\d+$/));
  same(`${prefix}_sha256`, sha256(raw), need(`${prefix}-Capture-SHA256`, /^[0-9a-f]{64}$/));
}
console.log(`root_cause=${rootCause}`);
console.log(`residual_risks=${risks}`);
console.log(`lifecycle_evidence_verified_head=${run(["rev-parse", "HEAD"])}`);
