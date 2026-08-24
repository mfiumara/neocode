import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../../scripts/check-git-state.mjs", import.meta.url));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): { root: string; base: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "neocode-git-check-"));
  git(root, ["init", "-b", "trunk"]);
  git(root, ["config", "user.name", "Neocode Test"]);
  git(root, ["config", "user.email", "test@neocode.local"]);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, ["add", "."]); git(root, ["commit", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/remotes/origin/trunk", base]);
  git(root, ["checkout", "-b", "feature"]);
  return { root, base, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function rawGit(cwd: string, args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }); }
function commitReviewEvidence(root: string, base: string, inconsistentCwd = false): string {
  const parent = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const at = "2026-08-24T12:00:00.000Z";
  const output = "verified fixture output\n";
  const capture = (command: string, cwd = root) => ({ command, cwd, startedAt: at, finishedAt: at, exit: 0, bytes: Buffer.byteLength(output), output, sha256: sha256(output) });
  const empty = (command: string) => ({ command, cwd: root, startedAt: at, finishedAt: at, exit: 0, bytes: 0, output: "", sha256: sha256("") });
  const names = rawGit(root, ["diff", "--name-status", `${base}...${parent}`]);
  const binary = rawGit(root, ["diff", "--binary", `${base}...${parent}`]);
  const evidence = {
    version: 1, testedParent: parent, testedTree: tree, base, mergeBase: base,
    repository: { topLevel: root, testedParent: parent, testedTree: tree }, testCwd: root,
    commands: [capture("npm test"), capture("npm run check", inconsistentCwd ? `${root}/other` : root), capture("npm run build")],
    candidatePorcelain: empty("git status --porcelain --untracked-files=all"), rootPorcelain: empty("git status --porcelain --untracked-files=all"),
    diffCheck: empty(`git diff --check ${base} ${parent}`), nameStatus: { output: names, sha256: sha256(names) },
    canonicalDiffSha256: sha256(binary), risks: ["fixture portability risk"],
  };
  git(root, ["commit", "--allow-empty", "-m", "neocode-review-evidence-v1", "-m", JSON.stringify(evidence)]);
  return git(root, ["rev-parse", "HEAD"]);
}

function check(cwd: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script], {
    cwd, encoding: "utf8",
    env: { ...process.env, NEOCODE_DIFF_BASE_SHA: "", GITHUB_BASE_REF: "", ...env },
  });
}

test("GitHub PR base discovery checks the complete feature range without main or HEAD^", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.root, "early.txt"), "trailing whitespace  \n");
    git(value.root, ["add", "."]); git(value.root, ["commit", "-m", "early feature commit"]);
    writeFileSync(join(value.root, "later.txt"), "later\n");
    git(value.root, ["add", "."]); git(value.root, ["commit", "-m", "later feature commit"]);

    const result = check(value.root, { GITHUB_BASE_REF: "trunk" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, new RegExp(`git diff --check ${value.base} HEAD`));
    assert.match(result.stdout, /early\.txt.*trailing whitespace/s);
  } finally { value.cleanup(); }
});

test("coordinator worktrees report literal main packet commands across the full feature range", () => {
  const value = fixture();
  try {
    git(value.root, ["update-ref", "refs/heads/main", value.base]);
    writeFileSync(join(value.root, "early.txt"), "early\n");
    git(value.root, ["add", "."]); git(value.root, ["commit", "-m", "early feature commit"]);
    writeFileSync(join(value.root, "later.txt"), "later\n");
    git(value.root, ["add", "."]); git(value.root, ["commit", "-m", "later feature commit"]);

    const result = check(value.root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\$ git merge-base main HEAD\nmain-merge-base output begin/);
    assert.match(result.stdout, new RegExp(`${value.base}\\nmain-merge-base output end\\nmain-merge-base exit: 0`));
    assert.match(result.stdout, /\$ git diff --name-status main\.\.\.HEAD\nmain-name-status output begin/);
    assert.match(result.stdout, /A\s+early\.txt.*A\s+later\.txt/s);
    assert.match(result.stdout, /main-name-status output end\nmain-name-status exit: 0/);
    assert.match(result.stdout, /\$ git show -s --format='author-name=%an%nauthor-email=%ae%ncommitter-name=%cn%ncommitter-email=%ce' HEAD\nhead-identity output begin/);
    assert.match(result.stdout, /author-name=Neocode Test\nauthor-email=test@neocode\.local\ncommitter-name=Neocode Test\ncommitter-email=test@neocode\.local\nhead-identity output end\nhead-identity exit: 0/);
    assert.match(result.stdout, /\$ git diff --check main\.\.\.HEAD\nmain-diff-check output begin\nmain-diff-check output end\nmain-diff-check exit: 0/);
    assert.match(result.stdout, new RegExp(`\\$ git diff --check ${value.base} HEAD`));
  } finally { value.cleanup(); }
});

test("recognized exact-tree evidence is portable across clones and rejects inconsistent historical cwd metadata", () => {
  const value = fixture();
  const cloneParent = mkdtempSync(join(tmpdir(), "neocode-evidence-clone-"));
  const clone = join(cloneParent, "moved-checkout");
  try {
    const evidenceHead = commitReviewEvidence(value.root, value.base);
    execFileSync("git", ["clone", "--quiet", value.root, clone]);
    assert.equal(git(clone, ["rev-parse", "HEAD"]), evidenceHead);
    value.cleanup(); // Verification must not depend on the recorded checkout still existing.
    const moved = check(clone, { NEOCODE_DIFF_BASE_SHA: value.base });
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, /verified review evidence/);

    commitReviewEvidence(clone, value.base, true);
    const tampered = check(clone, { NEOCODE_DIFF_BASE_SHA: value.base });
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /historical cwd is inconsistent/);
  } finally {
    value.cleanup();
    rmSync(cloneParent, { recursive: true, force: true });
  }
});

test("recognized exact-tree evidence fails closed when malformed", () => {
  const value = fixture();
  try {
    git(value.root, ["commit", "--allow-empty", "-m", "neocode-review-evidence-v1", "-m", "{\"version\":1}"]);
    const result = check(value.root, { NEOCODE_DIFF_BASE_SHA: value.base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Malformed recognized review evidence/);
  } finally { value.cleanup(); }
});

test("verified base checks report exact empty clean status and reject dirty candidates", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.root, "feature.txt"), "feature\n");
    git(value.root, ["add", "."]); git(value.root, ["commit", "-m", "feature"]);
    const clean = check(value.root, { NEOCODE_DIFF_BASE_SHA: value.base });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /clean-status output begin\nclean-status output end\nclean-status exit: 0/);

    writeFileSync(join(value.root, "dirty.txt"), "dirty\n");
    const dirty = check(value.root, { NEOCODE_DIFF_BASE_SHA: value.base });
    assert.equal(dirty.status, 1);
    assert.match(dirty.stdout, /\?\? dirty\.txt/);
    assert.match(dirty.stderr, /Working tree is not clean/);
  } finally { value.cleanup(); }
});
