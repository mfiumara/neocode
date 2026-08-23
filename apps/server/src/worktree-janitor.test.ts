import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentJob, CleanupRefusalReason } from "@neocode/protocol";
import { WorktreeJanitor } from "./worktree-janitor.js";

const exec = promisify(execFile);
const NOW = 2_000_000_000_000;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

interface Fixture { root: string; worktree: string; job: AgentJob; cleanup(): Promise<void> }
async function fixture(options: { commit?: boolean; merge?: boolean } = {}): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "neocode-janitor-"));
  const root = join(parent, "repo");
  await git(parent, ["init", "-b", "main", root]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
  const baseRef = await git(root, ["rev-parse", "HEAD"]);
  const worktree = join(parent, "worker");
  await git(root, ["worktree", "add", "-b", "neocode/test-job", worktree, baseRef]);
  if (options.commit !== false) {
    await writeFile(join(worktree, "work.txt"), "intended\n");
    await git(worktree, ["add", "."]); await git(worktree, ["commit", "-m", "work"]);
  }
  const head = await git(worktree, ["rev-parse", "HEAD"]);
  if (options.merge) await git(root, ["merge", "--no-ff", "neocode/test-job", "-m", "merge work"]);
  const job: AgentJob = {
    id: "job", title: "job", prompt: "work", status: "completed", branch: "neocode/test-job",
    worktree, isolation: { requested: "worktree", mode: "worktree", path: worktree }, baseRef,
    createdAt: NOW - 20_000, updatedAt: NOW - 20_000, messages: [],
    worktreeIdentity: { path: worktree, branch: "neocode/test-job", baseRef, createdAt: NOW - 20_000 },
    completion: { head, finishedAt: NOW - 10_000 }, integration: { status: "unmerged" },
  };
  return { root, worktree, job, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

function janitor(root: string, graceMs = 1000): WorktreeJanitor {
  return new WorktreeJanitor(root, { graceMs, targetRef: "main", now: () => NOW });
}
function reason(job: AgentJob): CleanupRefusalReason | undefined {
  return job.cleanup?.status === "refused" ? job.cleanup.reason : undefined;
}

async function withFixture(options: { commit?: boolean; merge?: boolean }, run: (value: Fixture) => Promise<void>) {
  const value = await fixture(options);
  try { await run(value); } finally { await value.cleanup(); }
}

test("removes a merged clean registered worktree and retains its branch", async () => {
  await withFixture({ merge: true }, async ({ root, worktree, job }) => {
    assert.equal(await janitor(root).review(job), true);
    assert.equal(job.cleanup?.status, "removed");
    assert.equal(job.integration?.status, "merged");
    assert.equal(await readFile(join(root, "work.txt"), "utf8"), "intended\n");
    await assert.rejects(readFile(join(worktree, "work.txt"), "utf8"));
    assert.equal(await git(root, ["show-ref", "--verify", "refs/heads/neocode/test-job"]).then(() => true), true);
  });
});

test("removes a clean worktree whose commits were integrated with rewritten hashes", async () => {
  await withFixture({ commit: true }, async ({ root, worktree, job }) => {
    await writeFile(join(root, "main-only.txt"), "advance main\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "advance main"]);
    await git(root, ["cherry-pick", job.completion!.head]);
    assert.equal(await janitor(root).review(job), true);
    assert.equal(job.cleanup?.status, "removed");
    if (job.cleanup?.status === "removed") assert.equal(job.cleanup.evidence.mergeMethod, "patch-equivalent");
    assert.equal(await stat(worktree).then(() => true, () => false), false);
  });
});

test("refuses completed but unmerged work", async () => {
  await withFixture({}, async ({ root, job }) => {
    assert.equal(await janitor(root).review(job), false);
    assert.equal(reason(job), "not_merged");
  });
});

for (const [name, mutate, expected] of [
  ["tracked changes", async (f: Fixture) => writeFile(join(f.worktree, "work.txt"), "dirty\n"), "dirty"],
  ["untracked changes", async (f: Fixture) => writeFile(join(f.worktree, "untracked.txt"), "dirty\n"), "dirty"],
  ["interrupted jobs", async (f: Fixture) => { f.job.status = "interrupted"; }, "not_completed"],
  ["failed jobs", async (f: Fixture) => { f.job.status = "failed"; }, "not_completed"],
  ["conflicts", async (f: Fixture) => { f.job.integration = { status: "conflicted" }; }, "conflicted"],
  ["active review", async (f: Fixture) => { f.job.integration = { status: "reviewing" }; }, "integration_active"],
  ["active integration", async (f: Fixture) => { f.job.integration = { status: "integrating" }; }, "integration_active"],
  ["changed durable path", async (f: Fixture) => { f.job.isolation.path = `${f.worktree}-other`; }, "identity_mismatch"],
  ["changed durable branch", async (f: Fixture) => { f.job.branch = "other"; }, "identity_mismatch"],
  ["moved completion head", async (f: Fixture) => {
    await writeFile(join(f.worktree, "later.txt"), "later\n"); await git(f.worktree, ["add", "."]); await git(f.worktree, ["commit", "-m", "later"]);
  }, "head_mismatch"],
] as Array<[string, (fixture: Fixture) => Promise<void>, CleanupRefusalReason]>) {
  test(`refuses ${name}`, async () => withFixture({ merge: true }, async (value) => {
    await mutate(value);
    assert.equal(await janitor(value.root).review(value.job), false);
    assert.equal(reason(value.job), expected);
  }));
}

test("refuses a worktree on a branch other than durable metadata", async () => {
  await withFixture({ merge: true }, async ({ root, job }) => {
    job.branch = "main";
    job.worktreeIdentity!.branch = "main";
    assert.equal(await janitor(root).review(job), false);
    assert.equal(reason(job), "branch_mismatch");
  });
});

test("refuses unregistered and unknown worktree paths", async () => {
  await withFixture({ merge: true }, async ({ root, worktree, job }) => {
    await git(root, ["worktree", "remove", "--force", worktree]);
    assert.equal(await janitor(root).review(job), false);
    assert.equal(reason(job), "not_registered");
  });
});

test("refuses jobs before grace and jobs missing durable completion metadata", async () => {
  await withFixture({ merge: true }, async ({ root, job }) => {
    assert.equal(await janitor(root, 20_000).review(job), false);
    assert.equal(reason(job), "grace_period");
    delete job.completion;
    assert.equal(await janitor(root).review(job), false);
    assert.equal(reason(job), "missing_durable_identity");
  });
});

test("removes a clean completed no-op wrapper without risking unique work", async () => {
  await withFixture({ commit: false }, async ({ root, worktree, job }) => {
    assert.equal(await janitor(root).review(job), true);
    assert.equal(job.cleanup?.status, "removed");
    if (job.cleanup?.status === "removed") assert.equal(job.cleanup.evidence.mergeMethod, "no-changes");
    assert.equal(await stat(worktree).then(() => true, () => false), false);
  });
});
