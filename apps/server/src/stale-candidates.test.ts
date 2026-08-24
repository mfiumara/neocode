import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import { auditWorktree, decideStaleCandidate, migrateStaleManifest, nominateStaleCandidate, validateStaleArchive } from "./stale-candidates.js";
import { WorktreeJanitor } from "./worktree-janitor.js";
import { canAutomaticallyResume } from "./recovery.js";

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

async function confirmedArchive(dirty = false) {
  const value = await fixture(dirty);
  await nominateStaleCandidate(value.job, { ...nomination, suspectedReplacementCommit: value.base }, { workspaceRoot: value.root, now: () => 10 });
  await decideStaleCandidate(value.job, "confirm_superseded", { workspaceRoot: value.root, now: () => 20 });
  return value;
}

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
  const { root, path, base, job } = await fixture();
  job.completion = { head: "immutable-completion", finishedAt: 7 };
  const completion = structuredClone(job.completion);
  await nominateStaleCandidate(job, { ...nomination, suspectedReplacementCommit: base }, { workspaceRoot: root, now: () => 10 });
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

test("published archives validate completely and authorize cleanup only after payload verification", async () => {
  const { root, base, job } = await confirmedArchive(false);
  const archive = job.staleCandidate!.archive!;
  assert.equal(archive.patchBytes, 0);
  assert.equal(archive.evidenceSha256.length, 64);
  await validateStaleArchive(job, root);
  job.status = "completed";
  job.completion = { head: base, finishedAt: 1 };
  job.worktreeIdentity = { path: job.isolation.path, branch: job.branch, baseRef: job.baseRef, createdAt: job.createdAt };
  assert.equal(await new WorktreeJanitor(root, { graceMs: 0, targetRef: "main", now: () => 30 }).review(job), true);
});

test("archive validation rejects missing, partial, tampered, mismatched, and symlinked payloads", async () => {
  for (const [name, mutate] of [
    ["missing patch", async (root: string, job: AgentJob) => rm(join(root, job.staleCandidate!.archive!.patchPath))],
    ["missing evidence / partial publication", async (root: string, job: AgentJob) => rm(join(root, job.staleCandidate!.archive!.evidencePath))],
    ["tampered payload", async (root: string, job: AgentJob) => writeFile(join(root, job.staleCandidate!.archive!.evidencePath), "tampered")],
    ["size/hash mismatch", async (_root: string, job: AgentJob) => { job.staleCandidate!.archive!.patchBytes += 1; job.staleCandidate!.archive!.diffSha256 = "0".repeat(64); }],
    ["metadata path escape", async (_root: string, job: AgentJob) => { job.staleCandidate!.archive!.patchPath = "../outside.patch"; }],
    ["symlink payload", async (root: string, job: AgentJob) => {
      const path = join(root, job.staleCandidate!.archive!.patchPath); await rm(path); const outside = join(root, "outside.patch"); await writeFile(outside, "outside"); await symlink(outside, path);
    }],
  ] as Array<[string, (root: string, job: AgentJob) => Promise<void>]>) {
    const { root, job } = await confirmedArchive(false);
    await mutate(root, job);
    await assert.rejects(validateStaleArchive(job, root), `${name} must fail closed`);
    job.status = "completed";
    job.completion = { head: job.staleCandidate!.audit.head, finishedAt: 1 };
    job.worktreeIdentity = { path: job.isolation.path, branch: job.branch, baseRef: job.baseRef, createdAt: job.createdAt };
    assert.equal(await new WorktreeJanitor(root, { graceMs: 0, targetRef: "main", now: () => 30 }).review(job), false, name);
    assert.match(job.cleanup?.status === "refused" ? job.cleanup.detail : "", /archive failed integrity validation/i);
  }
});

test("publication crash boundaries never record archive authority or final supersession", async () => {
  for (const boundary of ["file_fsync", "temp_directory_fsync", "publish_rename", "parent_fsync"] as const) {
    const { root, base, job } = await fixture(true);
    await nominateStaleCandidate(job, { ...nomination, suspectedReplacementCommit: base }, { workspaceRoot: root, now: () => 10 });
    await assert.rejects(decideStaleCandidate(job, "confirm_superseded", {
      workspaceRoot: root, now: () => 20,
      archivePublicationHook: (step) => { if (step === boundary) throw new Error(`injected ${boundary}`); },
    }), /injected/);
    assert.equal(job.staleCandidate?.state, "pending", boundary);
    assert.equal(job.staleCandidate?.archive, undefined, boundary);
    assert.notEqual(job.integration?.status, "superseded", boundary);
    await decideStaleCandidate(job, "confirm_superseded", { workspaceRoot: root, now: () => 30 });
    assert.equal(job.staleCandidate?.state, "superseded", `restart-safe retry after ${boundary}`);
    await validateStaleArchive(job, root);
  }
});

test("confirmation rejects same-porcelain dirty content changes", async () => {
  const { root, path, base, job } = await fixture();
  await nominateStaleCandidate(job, { ...nomination, suspectedReplacementCommit: base }, { workspaceRoot: root });
  const original = job.staleCandidate?.audit.contentFingerprint;
  await writeFile(join(path, "base.txt"), "different content with the same porcelain row\n");
  await writeFile(join(path, "untracked.bin"), Buffer.from([9, 8, 7]));
  await assert.rejects(decideStaleCandidate(job, "confirm_superseded", { workspaceRoot: root }), /changed after nomination/);
  assert.notEqual((await auditWorktree(job, { workspaceRoot: root })).contentFingerprint, original);
  assert.equal(job.integration, undefined);
});

test("archive creation rejects traversal-shaped durable job ids", async () => {
  const { root, base, job } = await fixture();
  await nominateStaleCandidate(job, { ...nomination, suspectedReplacementCommit: base }, { workspaceRoot: root });
  job.id = "../escape";
  await assert.rejects(decideStaleCandidate(job, "confirm_superseded", { workspaceRoot: root }), /Unsafe job id/);
  assert.equal(job.integration, undefined);
});

test("confirmation fails closed if checkout changed after nomination", async () => {
  const { root, path, base, job } = await fixture();
  await nominateStaleCandidate(job, { ...nomination, suspectedReplacementCommit: base }, { workspaceRoot: root });
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
  assert.equal(jobs.get("12345678")?.inventorySynthetic, true);
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

test("supersession requires replacement authority and accepts verified commit or merged job evidence", async () => {
  const absent = await fixture(false);
  await nominateStaleCandidate(absent.job, { reason: nomination.reason, evidenceSource: nomination.evidenceSource }, { workspaceRoot: absent.root });
  await assert.rejects(decideStaleCandidate(absent.job, "confirm_superseded", { workspaceRoot: absent.root }), /Specific replacement/);
  assert.equal(absent.job.integration, undefined);

  const unverified = await fixture(false);
  await nominateStaleCandidate(unverified.job, { ...nomination, suspectedReplacementCommit: "deadbeef" }, { workspaceRoot: unverified.root });
  await assert.rejects(decideStaleCandidate(unverified.job, "confirm_superseded", { workspaceRoot: unverified.root }), /unknown revision|Needed a single revision|ambiguous argument/i);
  assert.equal(unverified.job.integration, undefined);

  const clean = await fixture(false);
  await nominateStaleCandidate(clean.job, { ...nomination, suspectedReplacementCommit: clean.base }, { workspaceRoot: clean.root });
  await decideStaleCandidate(clean.job, "confirm_superseded", { workspaceRoot: clean.root });
  assert.equal(clean.job.staleCandidate?.replacementAuthority?.kind, "commit");
  assert.equal(clean.job.staleCandidate?.replacementAuthority?.replacementCommit, clean.base);
  assert.equal(clean.job.staleCandidate?.archive?.dirty, false);
  assert.equal(clean.job.staleCandidate?.archive?.diffSha256.length, 64, "clean decisions still receive an explicit empty archive packet");

  const byJob = await fixture(false);
  const replacement: AgentJob = {
    ...structuredClone(byJob.job), id: "replacement", branch: "neocode/replacement", worktree: byJob.path,
    integration: { status: "merged", verifiedAt: 99, targetRef: "main", targetHead: byJob.base, completionHead: byJob.base },
  };
  await nominateStaleCandidate(byJob.job, { reason: nomination.reason, evidenceSource: nomination.evidenceSource, suspectedReplacementJobId: replacement.id }, { workspaceRoot: byJob.root });
  await decideStaleCandidate(byJob.job, "confirm_superseded", { workspaceRoot: byJob.root, jobs: new Map([[replacement.id, replacement]]) });
  assert.equal(byJob.job.staleCandidate?.replacementAuthority?.kind, "job");
  assert.equal(byJob.job.integration?.supersededByJobId, replacement.id);

  const badJob = await fixture(false);
  const unmerged = { ...replacement, integration: { status: "unmerged" as const } };
  await nominateStaleCandidate(badJob.job, { reason: nomination.reason, evidenceSource: nomination.evidenceSource, suspectedReplacementJobId: unmerged.id }, { workspaceRoot: badJob.root });
  await assert.rejects(decideStaleCandidate(badJob.job, "confirm_superseded", { workspaceRoot: badJob.root, jobs: new Map([[unmerged.id, unmerged]]) }), /merged_verified/);
});

test("still wanted routes failed and cancelled execution history through a manual needs-attention gate", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const value = await fixture();
    value.job.status = status;
    value.job.completion = { head: value.base, finishedAt: 4 };
    const completion = structuredClone(value.job.completion);
    await nominateStaleCandidate(value.job, nomination, { workspaceRoot: value.root });
    await decideStaleCandidate(value.job, "still_wanted", { workspaceRoot: value.root });
    assert.equal(value.job.status, "needs_attention");
    assert.equal(value.job.recoverable, false);
    assert.match(value.job.recoveryIssue || "", /coordinator path\/branch\/recovery validation/);
    assert.deepEqual(value.job.completion, completion);
  }
});

test("existing-job migration rejects manifest HEAD, dirty, and exact-content drift and reports missing rows", async () => {
  const value = await fixture();
  const initial = await auditWorktree(value.job, { workspaceRoot: value.root });
  const manifestPath = join(value.root, "audit-existing.json");
  const row = {
    path: value.path, branch: value.job.branch, head: value.base, valid: true, dirty: true, statusLines: 2,
    disposition: "superseded duplicate", evidence: "Replacement commit abcdef12 contains equivalent behavior.",
    trackedDiffSha256: initial.trackedDiffSha256, contentFingerprint: initial.contentFingerprint, untrackedFiles: initial.untrackedFiles,
  };
  const source = { id: value.job.id, title: value.job.title, branch: value.job.branch, path: value.path, disposition: "superseded duplicate", evidence: "Job evidence." };
  const write = async (worktrees: unknown[]) => writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-23T00:00:00Z", baseline: { ref: "main", commit: value.base }, worktrees, jobs: [source] }));

  await write([{ ...row, head: "0000000000000000000000000000000000000000" }]);
  let result = await migrateStaleManifest(manifestPath, new Map([[value.job.id, structuredClone(value.job)]]), { workspaceRoot: value.root });
  assert.match(result.ambiguous[0] || "", /live HEAD\/dirty\/content audit/);
  await write([{ ...row, dirty: false }]);
  result = await migrateStaleManifest(manifestPath, new Map([[value.job.id, structuredClone(value.job)]]), { workspaceRoot: value.root });
  assert.match(result.ambiguous[0] || "", /live HEAD\/dirty\/content audit/);
  await writeFile(join(value.path, "base.txt"), "same porcelain, changed bytes\n");
  await write([row]);
  result = await migrateStaleManifest(manifestPath, new Map([[value.job.id, structuredClone(value.job)]]), { workspaceRoot: value.root });
  assert.match(result.ambiguous[0] || "", /live HEAD\/dirty\/content audit/);
  assert.equal(result.nominated, 0);

  await write([]);
  result = await migrateStaleManifest(manifestPath, new Map([[value.job.id, structuredClone(value.job)]]), { workspaceRoot: value.root });
  assert.match(result.ambiguous[0] || "", /missing matching manifest worktree/);
});

test("intentionally-cancelled synthetic inventory never becomes autonomously recoverable", async () => {
  const value = await fixture(false);
  const manifestPath = join(value.root, "audit-cancelled.json");
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1, generatedAt: "2026-08-23T00:00:00Z", baseline: { ref: "main", commit: value.base },
    worktrees: [{ path: value.path, branch: value.job.branch, head: value.base, valid: true, dirty: false, statusLines: 0,
      disposition: "intentionally cancelled", evidence: "Legacy Lua target was deliberately removed and replacement commit abcdef12 exists." }], jobs: [],
  }));
  const jobs = new Map<string, AgentJob>();
  const result = await migrateStaleManifest(manifestPath, jobs, { workspaceRoot: value.root });
  assert.equal(result.synthetic, 1);
  const synthetic = jobs.get(value.job.id)!;
  assert.equal(synthetic.recoverable, false);
  await decideStaleCandidate(synthetic, "still_wanted", { workspaceRoot: value.root });
  assert.equal(synthetic.recoverable, false);
  assert.equal(canAutomaticallyResume(synthetic), false);
  assert.match(synthetic.recoveryIssue || "", /never automatically recoverable|validation/);
});

test("janitor refuses confirmed stale state without archive and replacement authority", async () => {
  const value = await fixture(false);
  value.job.status = "completed";
  value.job.completion = { head: value.base, finishedAt: 1 };
  value.job.worktreeIdentity = { path: value.path, branch: value.job.branch, baseRef: value.base, createdAt: 1 };
  value.job.integration = { status: "superseded", disposition: "superseded" };
  value.job.staleCandidate = {
    state: "superseded", nominatedAt: 1, nominatedBy: "coordinator", reason: nomination.reason, evidenceSource: nomination.evidenceSource,
    suspectedReplacementCommit: value.base, confirmation: "confirmed_superseded", resolvedAt: 2, resumeState: { status: "completed" },
    audit: await auditWorktree(value.job, { workspaceRoot: value.root }),
  };
  assert.equal(await new WorktreeJanitor(value.root, { graceMs: 0, targetRef: "main" }).review(value.job), false);
  assert.match(value.job.cleanup?.status === "refused" ? value.job.cleanup.detail : "", /lacks archive or authoritative replacement/);
});

test("exact checked-in manifest normalizes clean authority and leaves unproven dirty durable rows inert", async () => {
  const checkedPath = resolve(import.meta.dirname, "../../../docs/worktree-backlog-manifest-20260823.json");
  const checked = JSON.parse(await readFile(checkedPath, "utf8")) as {
    schemaVersion: number; generatedAt: string; baseline: { ref: string; commit: string };
    auditFieldPolicy: Record<string, string>; worktrees: Array<Record<string, any>>; jobs: Array<Record<string, any>>;
  };
  assert.equal(checked.schemaVersion, 1);
  assert.match(checked.auditFieldPolicy.dirtyExactEvidence, /unproven.*ambiguous/i);
  const dirtyRows = checked.worktrees.filter((row) => row.dirty === true);
  assert.ok(dirtyRows.length > 0);
  assert.ok(dirtyRows.every((row) => row.auditAuthority?.state === "unproven"));

  const cleanSourceRow = checked.worktrees.find((row) => row.branch.endsWith("-011964e9"))!;
  const cleanSourceJob = checked.jobs.find((row) => row.id === "011964e9")!;
  const clean = await fixture(false);
  const cleanManifest = join(clean.root, "checked-clean.json");
  await writeFile(cleanManifest, JSON.stringify({
    schemaVersion: checked.schemaVersion, generatedAt: checked.generatedAt, baseline: { ref: "main", commit: clean.base },
    auditFieldPolicy: checked.auditFieldPolicy,
    worktrees: [{ ...cleanSourceRow, path: clean.path, branch: clean.job.branch, head: clean.base, dirty: false, statusLines: 0 }],
    jobs: [{ ...cleanSourceJob, id: clean.job.id, path: clean.path, branch: clean.job.branch }],
  }));
  const cleanJobs = new Map([[clean.job.id, clean.job]]);
  const nominated = await migrateStaleManifest(cleanManifest, cleanJobs, { workspaceRoot: clean.root });
  assert.equal(nominated.nominated, 1);
  assert.equal(clean.job.staleCandidate?.state, "pending");
  assert.equal(clean.job.integration, undefined);

  const dirtySourceRow = checked.worktrees.find((row) => row.branch.endsWith("-ee87c4d3"))!;
  const dirtySourceJob = checked.jobs.find((row) => row.id === "ee87c4d3")!;
  const dirty = await fixture(true);
  const dirtyManifest = join(dirty.root, "checked-dirty.json");
  await writeFile(dirtyManifest, JSON.stringify({
    schemaVersion: checked.schemaVersion, generatedAt: checked.generatedAt, baseline: { ref: "main", commit: dirty.base },
    auditFieldPolicy: checked.auditFieldPolicy,
    worktrees: [{ ...dirtySourceRow, path: dirty.path, branch: dirty.job.branch, head: dirty.base, dirty: true, statusLines: 2 }],
    jobs: [{ ...dirtySourceJob, id: dirty.job.id, path: dirty.path, branch: dirty.job.branch }],
  }));
  const inert = await migrateStaleManifest(dirtyManifest, new Map([[dirty.job.id, dirty.job]]), { workspaceRoot: dirty.root });
  assert.equal(inert.nominated, 0);
  assert.equal(dirty.job.staleCandidate, undefined);
  assert.match(inert.ambiguous[0] || "", /lacks exact manifest content fingerprints/);
});

test("orphan migration rejects status drift and optional exact-content drift even when dirty boolean is unchanged", async () => {
  const statusDrift = await fixture(true);
  const statusManifest = join(statusDrift.root, "orphan-status.json");
  const row = { path: statusDrift.path, branch: statusDrift.job.branch, head: statusDrift.base, valid: true, dirty: true, statusLines: 2,
    disposition: "superseded duplicate", evidence: "Replacement commit abcdef12 contains equivalent behavior." };
  await writeFile(join(statusDrift.path, "another.txt"), "new status row\n");
  await writeFile(statusManifest, JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-23T00:00:00Z", baseline: { ref: "main", commit: statusDrift.base }, worktrees: [row], jobs: [] }));
  let result = await migrateStaleManifest(statusManifest, new Map(), { workspaceRoot: statusDrift.root });
  assert.equal(result.synthetic, 0);
  assert.match(result.ambiguous[0] || "", /status\/content audit differs/);

  const contentDrift = await fixture(true);
  const initial = await auditWorktree(contentDrift.job, { workspaceRoot: contentDrift.root });
  const contentManifest = join(contentDrift.root, "orphan-content.json");
  await writeFile(join(contentDrift.path, "base.txt"), "same status and dirty boolean, different bytes\n");
  const exactRow = { path: contentDrift.path, branch: contentDrift.job.branch, head: contentDrift.base, valid: true, dirty: true, statusLines: 2,
    disposition: "superseded duplicate", evidence: "Replacement commit abcdef12 contains equivalent behavior.",
    trackedDiffSha256: initial.trackedDiffSha256, contentFingerprint: initial.contentFingerprint, untrackedFiles: initial.untrackedFiles };
  await writeFile(contentManifest, JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-23T00:00:00Z", baseline: { ref: "main", commit: contentDrift.base }, worktrees: [exactRow], jobs: [] }));
  result = await migrateStaleManifest(contentManifest, new Map(), { workspaceRoot: contentDrift.root });
  assert.equal(result.synthetic, 0);
  assert.match(result.ambiguous[0] || "", /status\/content audit differs/);
});
