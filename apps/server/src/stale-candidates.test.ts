import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import { auditWorktree, decideStaleCandidate, migrateStaleManifest, nominateStaleCandidate } from "./stale-candidates.js";
import { WorktreeJanitor } from "./worktree-janitor.js";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) { return (await exec("git", args, { cwd })).stdout.trim(); }

async function fixture(dirty = true) {
  const root = await mkdtemp(join(tmpdir(), "neocode-stale-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  const path = join(root, ".worktrees", "historical-12345678");
  await mkdir(join(root, ".worktrees"), { recursive: true });
  await git(root, ["worktree", "add", "-b", "neocode/historical-12345678", path, base]);
  if (dirty) {
    await writeFile(join(path, "base.txt"), "changed\n");
    await writeFile(join(path, "untracked.bin"), Buffer.from([0, 1, 2, 255]));
  }
  const job: AgentJob = {
    id: "12345678", title: "Historical", prompt: "work", status: "interrupted",
    branch: "neocode/historical-12345678", worktree: path,
    isolation: { requested: "worktree", mode: "worktree", path }, baseRef: base,
    createdAt: 1, updatedAt: 2, messages: [], recoverable: true,
  };
  return { root, path, base, job };
}

const nomination = {
  reason: "Semantic audit found this historical implementation was replaced.",
  evidenceSource: "docs/audit.json", suspectedReplacementCommit: "deadbeef",
} as const;

test("inactive dirty nomination is provisional, durable-shaped, suppresses recovery, and deletes no files", async () => {
  const { root, path, job } = await fixture();
  await nominateStaleCandidate(job, nomination, { workspaceRoot: root, now: () => 10 });
  assert.equal(job.status, "interrupted");
  assert.equal(job.staleCandidate?.state, "pending");
  assert.equal(job.staleCandidate?.audit.dirty, true);
  assert.match(job.staleCandidate?.audit.porcelain || "", /base\.txt/);
  assert.equal(job.recoverable, false);
  assert.equal(await readFile(join(path, "base.txt"), "utf8"), "changed\n");
  assert.equal((await stat(join(path, "untracked.bin"))).isFile(), true);
  assert.equal(await new WorktreeJanitor(root, { graceMs: 0, targetRef: "main" }).review(job), false);
  assert.match(job.cleanup?.status === "refused" ? job.cleanup.detail : "", /awaits explicit confirmation/);

  const active = await fixture();
  active.job.status = "running";
  await assert.rejects(nominateStaleCandidate(active.job, nomination, { workspaceRoot: active.root }), /Active jobs/);

  for (const configure of [
    (value: AgentJob) => { value.integration = { status: "reviewing" }; },
    (value: AgentJob) => { value.integration = { status: "integrating" }; },
    (value: AgentJob) => { value.integration = { status: "conflicted" }; },
    (value: AgentJob) => { value.review = { hookToken: "h", status: "ci_running", attempt: 1, targetBranch: "main", updatedAt: 1, transitions: [] }; },
    (value: AgentJob) => { value.review = { hookToken: "h", status: "judging", attempt: 1, targetBranch: "main", updatedAt: 1, transitions: [] }; },
    (value: AgentJob) => { value.review = { hookToken: "h", status: "post_merge_ci", attempt: 1, targetBranch: "main", updatedAt: 1, transitions: [] }; },
    (value: AgentJob) => { value.review = { hookToken: "h", status: "post_ci_failed", attempt: 1, targetBranch: "main", updatedAt: 1, transitions: [] }; },
    (value: AgentJob) => { value.review = { hookToken: "h", status: "approved", attempt: 1, targetBranch: "main", updatedAt: 1, transitions: [] }; },
    (value: AgentJob) => { value.review = { hookToken: "h", status: "blocked", attempt: 1, targetBranch: "main", updatedAt: 1, transitions: [], remediation: { maxAttempts: 3, rounds: {}, currentActionId: "a", actions: [{ id: "a", failureClass: "worker_ci", fingerprint: "f", state: "repairing", attempt: 1, maxAttempts: 3, createdAt: 1, updatedAt: 1, evidence: { detail: "active" } }] } }; },
  ]) {
    const owned = await fixture(); configure(owned.job);
    await assert.rejects(nominateStaleCandidate(owned.job, nomination, { workspaceRoot: owned.root }), /Active jobs/);
    assert.equal(owned.job.staleCandidate, undefined);
  }
});

test("still wanted explicitly resolves nomination and restores safe prior lifecycle without altering files", async () => {
  const { root, path, job } = await fixture();
  await nominateStaleCandidate(job, nomination, { workspaceRoot: root });
  await decideStaleCandidate(job, "still_wanted", { workspaceRoot: root, now: () => 20 });
  assert.equal(job.staleCandidate?.confirmation, "still_wanted");
  assert.equal(job.staleCandidate?.state, "kept");
  assert.equal(job.status, "interrupted");
  assert.equal(job.recoverable, true);
  assert.equal(await readFile(join(path, "base.txt"), "utf8"), "changed\n");
  assert.notEqual(job.integration?.status, "superseded");
});

test("dirty diff is archived before supersession without rewriting immutable completion history", async () => {
  const { root, path, job } = await fixture();
  job.completion = { head: "immutable-completion", finishedAt: 7 };
  const completion = structuredClone(job.completion);
  await nominateStaleCandidate(job, nomination, { workspaceRoot: root, now: () => 10 });
  await decideStaleCandidate(job, "confirm_superseded", { workspaceRoot: root, now: () => 20 });
  assert.equal(job.integration?.status, "superseded");
  assert.deepEqual(job.completion, completion);
  assert.equal(job.status, "interrupted", "the decision does not rewrite worker execution status");
  assert.equal(job.staleCandidate?.confirmation, "confirmed_superseded");
  assert.equal(job.staleCandidate?.archive?.dirty, true);
  assert.equal(job.staleCandidate?.archive?.diffSha256.length, 64);
  assert.deepEqual(job.staleCandidate?.archive?.untrackedFiles.map((item) => item.path), ["untracked.bin"]);
  const archive = job.staleCandidate!.archive!;
  assert.equal((await stat(join(root, archive.patchPath))).isFile(), true);
  assert.equal((await stat(join(root, archive.evidencePath))).isFile(), true);
  assert.equal(await readFile(join(path, "base.txt"), "utf8"), "changed\n", "confirmation never cleans files");
  assert.equal(await new WorktreeJanitor(root, { graceMs: 0, targetRef: "main" }).review(job), false, "dirty checkout remains cleanup-ineligible");
  assert.equal(job.cleanup?.status, "refused");
});

test("confirmation rejects same-porcelain dirty content changes", async () => {
  const { root, path, job } = await fixture();
  await nominateStaleCandidate(job, nomination, { workspaceRoot: root });
  const original = job.staleCandidate?.audit.contentFingerprint;
  await writeFile(join(path, "base.txt"), "different content with the same porcelain row\n");
  await writeFile(join(path, "untracked.bin"), Buffer.from([9, 8, 7]));
  await assert.rejects(decideStaleCandidate(job, "confirm_superseded", { workspaceRoot: root }), /changed after nomination/);
  assert.notEqual((await auditWorktree(job, { workspaceRoot: root })).contentFingerprint, original);
  assert.equal(job.integration, undefined);
});

test("archive creation rejects traversal-shaped durable job ids", async () => {
  const { root, job } = await fixture();
  await nominateStaleCandidate(job, nomination, { workspaceRoot: root });
  job.id = "../escape";
  await assert.rejects(decideStaleCandidate(job, "confirm_superseded", { workspaceRoot: root }), /Unsafe job id/);
  assert.equal(job.integration, undefined);
});

test("confirmation fails closed if checkout changed after nomination", async () => {
  const { root, path, job } = await fixture();
  await nominateStaleCandidate(job, nomination, { workspaceRoot: root });
  await writeFile(join(path, "later.txt"), "later\n");
  await assert.rejects(decideStaleCandidate(job, "confirm_superseded", { workspaceRoot: root }), /changed after nomination/);
  assert.notEqual(job.integration?.status, "superseded");
  assert.equal(job.staleCandidate?.archive, undefined);
});

test("manifest migration creates orphan inventory, nominates idempotently, and rejects path mismatch", async () => {
  const { root, path, base } = await fixture();
  const manifestPath = join(root, "audit.json");
  const manifest = {
    schemaVersion: 1, generatedAt: "2026-08-23T00:00:00Z", baseline: { ref: "main", commit: base },
    worktrees: [{ path, branch: "neocode/historical-12345678", head: base, valid: true, dirty: true,
      disposition: "superseded duplicate", evidence: "Later replacement commit abcdef12 contains equivalent behavior and requires user confirmation." }],
    jobs: [{ id: "12345678", title: "Historical", branch: "neocode/historical-12345678", path,
      disposition: "superseded duplicate", evidence: "replacement" }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const jobs = new Map<string, AgentJob>();
  const first = await migrateStaleManifest(manifestPath, jobs, { workspaceRoot: root });
  assert.deepEqual({ synthetic: first.synthetic, nominated: first.nominated, ambiguous: first.ambiguous.length }, { synthetic: 1, nominated: 1, ambiguous: 0 });
  assert.equal(jobs.get("12345678")?.staleCandidate?.state, "pending");
  const second = await migrateStaleManifest(manifestPath, jobs, { workspaceRoot: root });
  assert.equal(second.unchanged, 1);
  assert.equal(jobs.size, 1);
  const originalEvidence = manifest.worktrees[0]!.evidence;
  manifest.worktrees[0]!.evidence = "Different pending evidence commit 11111111 must fail closed.";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const pendingChanged = await migrateStaleManifest(manifestPath, jobs, { workspaceRoot: root });
  assert.equal(pendingChanged.unchanged, 0);
  assert.match(pendingChanged.ambiguous[0] || "", /different pending stale nomination/);
  manifest.worktrees[0]!.evidence = originalEvidence;
  await writeFile(manifestPath, JSON.stringify(manifest));

  await decideStaleCandidate(jobs.get("12345678")!, "still_wanted", { workspaceRoot: root });
  const kept = await migrateStaleManifest(manifestPath, jobs, { workspaceRoot: root });
  assert.equal(kept.unchanged, 1);
  assert.equal(jobs.get("12345678")?.staleCandidate?.state, "kept", "automatic migration never reopens an explicit kept decision");
  manifest.worktrees[0]!.evidence = "Changed replacement evidence commit fedcba98 must not override the user.";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const changed = await migrateStaleManifest(manifestPath, jobs, { workspaceRoot: root });
  assert.equal(changed.unchanged, 0);
  assert.match(changed.ambiguous[0] || "", /changed manifest evidence/);
  assert.equal(jobs.get("12345678")?.staleCandidate?.state, "kept");

  const mismatched = new Map(jobs);
  mismatched.get("12345678")!.isolation.path = join(root, ".worktrees", "other");
  const closed = await migrateStaleManifest(manifestPath, mismatched, { workspaceRoot: root });
  assert.equal(closed.nominated, 0);
  assert.match(closed.ambiguous[0] || "", /mismatch/);
});

test("manifest imports content-equivalent classifications provisionally and leaves classification conflicts inert", async () => {
  const { root, path, base } = await fixture(false);
  const manifestPath = join(root, "audit.json");
  const manifest = {
    schemaVersion: 1, generatedAt: "2026-08-23T00:00:00Z", baseline: { ref: "main", commit: base },
    worktrees: [{ path, branch: "neocode/historical-12345678", head: base, valid: true, dirty: false,
      disposition: "already merged/content-equivalent", evidence: "Content appears in replacement commit abcdef12; user confirmation remains required." }],
    jobs: [{ id: "12345678", title: "Historical", branch: "neocode/historical-12345678", path,
      disposition: "already merged/content-equivalent", evidence: "Patch-equivalent evidence remains provisional." }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const jobs = new Map<string, AgentJob>();
  const imported = await migrateStaleManifest(manifestPath, jobs, { workspaceRoot: root });
  assert.equal(imported.nominated, 1);
  assert.equal(jobs.get("12345678")?.integration, undefined);
  assert.equal(jobs.get("12345678")?.staleCandidate?.state, "pending");

  manifest.jobs[0]!.disposition = "actionable unique work";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const conflicted = await migrateStaleManifest(manifestPath, new Map(), { workspaceRoot: root });
  assert.equal(conflicted.synthetic, 0);
  assert.equal(conflicted.nominated, 0);
  assert.match(conflicted.ambiguous[0] || "", /classification mismatch/);
});
