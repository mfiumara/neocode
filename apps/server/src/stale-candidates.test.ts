import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import { decideStaleCandidate, migrateStaleManifest, nominateStaleCandidate } from "./stale-candidates.js";
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

test("dirty diff and untracked evidence are archived before explicit final supersession", async () => {
  const { root, path, job } = await fixture();
  await nominateStaleCandidate(job, nomination, { workspaceRoot: root, now: () => 10 });
  await decideStaleCandidate(job, "confirm_superseded", { workspaceRoot: root, now: () => 20 });
  assert.equal(job.integration?.status, "superseded");
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

  const mismatched = new Map(jobs);
  mismatched.get("12345678")!.isolation.path = join(root, ".worktrees", "other");
  const closed = await migrateStaleManifest(manifestPath, mismatched, { workspaceRoot: root });
  assert.equal(closed.nominated, 0);
  assert.match(closed.ambiguous[0] || "", /mismatch/);
});
