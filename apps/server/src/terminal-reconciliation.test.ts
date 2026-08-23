import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import { cleanupCandidates, TerminalReconciler } from "./terminal-reconciliation.js";
const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> { return (await exec("git", args, { cwd })).stdout.trim(); }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "neocode-terminal-"));
  await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.email", "test@example.com"]); await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "base.txt"), "base\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]); const worktrees = join(root, ".worktrees"); await mkdir(worktrees);
  const make = async (name: string, content: string) => {
    const path = join(worktrees, name); await git(root, ["worktree", "add", "-b", `job/${name}`, path, base]);
    await writeFile(join(path, `${name}.txt`), `${content}\n`); await git(path, ["add", "."]); await git(path, ["commit", "-m", name]);
    return { path, head: await git(path, ["rev-parse", "HEAD"]), branch: `job/${name}` };
  };
  return { root, base, make, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function job(id: string, base: string, value: { path: string; head: string; branch: string }, status: AgentJob["status"] = "completed"): AgentJob {
  return { id, title: id, prompt: id, status, branch: value.branch, worktree: value.path,
    isolation: { requested: "worktree", mode: "worktree", path: value.path }, baseRef: base,
    createdAt: 1, updatedAt: 1, messages: [], completion: { head: value.head, finishedAt: 2 } };
}

test("backfills ancestry, patch equivalence, and reviewed manifest supersession but leaves unknown work actionable", async () => {
  const f = await fixture();
  try {
    const ancestor = await f.make("ancestor", "ancestor");
    await git(f.root, ["merge", "--no-ff", ancestor.branch, "-m", "merge ancestor"]);
    const equivalent = await f.make("equivalent", "equivalent");
    await git(f.root, ["cherry-pick", equivalent.head]);
    const superseded = await f.make("superseded", "old approach");
    await writeFile(join(f.root, "replacement.txt"), "replacement\n"); await git(f.root, ["add", "."]); await git(f.root, ["commit", "-m", "replacement"]);
    const replacement = await git(f.root, ["rev-parse", "HEAD"]);
    const unknown = await f.make("unknown", "valuable unique work");
    const manifestDir = join(f.root, ".neocode/runtime/worktree-salvage/one"); await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, "manifest.json"), JSON.stringify({ reviewed: true, entries: [{ jobId: "superseded", sourceCommit: superseded.head, integrationCommit: replacement, disposition: "superseded", supersededBy: "replacement-job" }] }));
    const unreviewed = join(f.root, ".neocode/runtime/worktree-salvage/two"); await mkdir(unreviewed, { recursive: true });
    await writeFile(join(unreviewed, "manifest.json"), JSON.stringify({ entries: [{ jobId: "unknown", sourceCommit: unknown.head, integrationCommit: replacement, disposition: "merged_verified" }] }));
    const jobs = [job("ancestor", f.base, ancestor), job("equivalent", f.base, equivalent), job("superseded", f.base, superseded, "needs_attention"), job("unknown", f.base, unknown)];
    assert.equal(await new TerminalReconciler(f.root, "main", () => 10).reconcile(jobs), 3);
    assert.equal(jobs[0]!.terminalDisposition?.evidence.method, "commit-ancestry");
    assert.equal(jobs[1]!.terminalDisposition?.evidence.method, "patch-equivalence");
    assert.equal(jobs[2]!.terminalDisposition?.kind, "superseded");
    assert.equal(jobs[2]!.terminalDisposition?.supersededBy, "replacement-job");
    assert.match(jobs[2]!.terminalDisposition?.evidence.manifestPath || "", /manifest\.json$/);
    assert.equal(jobs[3]!.terminalDisposition, undefined);
  } finally { await f.cleanup(); }
});

test("reviewed manifests explicitly resolve a stale shared-root needs-attention record as superseded", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, ".git/info/exclude"), ".neocode/\n");
    await writeFile(join(f.root, "resolved.txt"), "resolved\n"); await git(f.root, ["add", "."]); await git(f.root, ["commit", "-m", "resolution"]);
    const target = await git(f.root, ["rev-parse", "HEAD"]);
    const dir = join(f.root, ".neocode/runtime/worktree-salvage/current"); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ reviewedIntegrationCommit: target, entries: [{ jobId: "6044712e", sourceCommit: f.base, integrationCommit: target, disposition: "superseded", supersededBy: "ae65aed6" }] }));
    const stale: AgentJob = { id: "6044712e", title: "audit", prompt: "audit", status: "needs_attention", branch: "main", worktree: f.root,
      isolation: { requested: "root", mode: "root", path: f.root }, baseRef: f.base, createdAt: 1, updatedAt: 2, messages: [] };
    assert.equal(await new TerminalReconciler(f.root).reconcile([stale]), 1);
    assert.equal(stale.terminalDisposition?.kind, "superseded");
    assert.equal(stale.terminalDisposition?.supersededBy, "ae65aed6");
    assert.match(stale.recoveryIssue || "", /Resolved as superseded/);
  } finally { await f.cleanup(); }
});

test("dirty or uninspectable registered worktrees are never classified Done", async () => {
  const f = await fixture();
  try {
    const dirty = await f.make("dirty", "committed"); await git(f.root, ["merge", "--no-ff", dirty.branch, "-m", "merge dirty"]);
    await writeFile(join(dirty.path, "untracked.txt"), "not represented in git\n");
    const value = job("dirty", f.base, dirty);
    assert.equal(await new TerminalReconciler(f.root).reconcile([value]), 0);
    assert.equal(value.terminalDisposition, undefined);
  } finally { await f.cleanup(); }
});

test("newly reconciled and startup-migrated history is not fed directly into janitor cleanup", () => {
  const value = (id: string) => ({ id } as AgentJob);
  const jobs = [value("existing-history"), value("newly-reconciled"), value("startup-migrated"), value("actionable")];
  assert.deepEqual(cleanupCandidates(jobs, new Set(["newly-reconciled"]), new Set(["startup-migrated"]), true).map((job) => job.id),
    ["existing-history", "actionable"]);
  assert.deepEqual(cleanupCandidates(jobs, new Set(["newly-reconciled"]), new Set(["startup-migrated"]), false).map((job) => job.id),
    ["existing-history", "startup-migrated", "actionable"]);
});

test("cancelled and failed pre-integration records receive durable process-independent dispositions", async () => {
  const f = await fixture();
  try {
    const noWork = { path: join(f.root, "missing"), head: f.base, branch: "job/missing" };
    const cancelled = job("cancelled", f.base, noWork, "cancelled"); const failed = job("failed", f.base, noWork, "failed"); failed.error = "boom";
    await new TerminalReconciler(f.root).reconcile([cancelled, failed]);
    assert.equal(cancelled.terminalDisposition?.kind, "cancelled"); assert.equal(failed.terminalDisposition?.kind, "failed_terminal");
  } finally { await f.cleanup(); }
});
