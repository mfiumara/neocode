#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { verifyReviewEvidence } from "./review-evidence.mjs";

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function resolveCommit(reference) {
  if (!reference) return undefined;
  const result = git(["rev-parse", "--verify", `${reference}^{commit}`], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function requireAncestor(commit, label) {
  if (git(["merge-base", "--is-ancestor", commit, "HEAD"], { allowFailure: true }).status !== 0) {
    throw new Error(`${label} ${commit} is not an ancestor of HEAD; reconcile the complete feature branch first.`);
  }
  return commit;
}

export function discoverDiffBase(env = process.env) {
  const requested = env.NEOCODE_DIFF_BASE_SHA?.trim();
  if (requested) {
    const commit = resolveCommit(requested);
    if (!commit) throw new Error(`NEOCODE_DIFF_BASE_SHA ${requested} is unavailable; fetch the complete base history.`);
    return requireAncestor(commit, "NEOCODE_DIFF_BASE_SHA");
  }

  const pullRequestBase = env.GITHUB_BASE_REF?.trim();
  if (pullRequestBase) {
    const commit = resolveCommit(`origin/${pullRequestBase}`) || resolveCommit(pullRequestBase);
    if (!commit) throw new Error(`GitHub PR base ${pullRequestBase} is unavailable; checkout with fetch-depth: 0.`);
    return requireAncestor(commit, "GitHub PR base");
  }

  const localMain = resolveCommit("main");
  if (localMain) return requireAncestor(localMain, "Local main");
  const remoteMain = resolveCommit("origin/main");
  if (remoteMain) return requireAncestor(remoteMain, "Remote main");
  throw new Error("Cannot discover a verified base commit. Fetch main or set NEOCODE_DIFF_BASE_SHA.");
}

function reportCommand(command, result, label) {
  process.stdout.write(`$ ${command}\n${label} output begin\n`);
  process.stdout.write(result.stdout);
  process.stdout.write(result.stderr);
  if ((result.stdout || result.stderr) && !(result.stdout + result.stderr).endsWith("\n")) process.stdout.write("\n");
  process.stdout.write(`${label} output end\n${label} exit: ${result.status ?? 1}\n`);
}

export function checkGitState(env = process.env) {
  verifyReviewEvidence();
  const base = discoverDiffBase(env);
  process.stdout.write(`verified diff base: ${base}\n`);

  // A coordinator worktree has a local main ref. Keep these literal commands
  // in captured CI evidence so a reviewer can verify the exact candidate
  // range without translating an opaque SHA-only packet.
  if (resolveCommit("main")) {
    const identityFormat = "author-name=%an%nauthor-email=%ae%ncommitter-name=%cn%ncommitter-email=%ce";
    const mainChecks = [
      { args: ["merge-base", "main", "HEAD"], command: "git merge-base main HEAD", label: "main-merge-base" },
      { args: ["diff", "--name-status", "main...HEAD"], command: "git diff --name-status main...HEAD", label: "main-name-status" },
      { args: ["show", "-s", `--format=${identityFormat}`, "HEAD"], command: `git show -s --format='${identityFormat}' HEAD`, label: "head-identity" },
      { args: ["diff", "--check", "main...HEAD"], command: "git diff --check main...HEAD", label: "main-diff-check" },
    ];
    let mainFailure = 0;
    for (const check of mainChecks) {
      const result = git(check.args, { allowFailure: true });
      reportCommand(check.command, result, check.label);
      if (result.status !== 0 && mainFailure === 0) mainFailure = result.status ?? 1;
    }
    if (mainFailure) return mainFailure;
  }

  // This verified-base check remains authoritative in PR, shallow, and
  // non-main environments. It deliberately checks the complete feature range
  // and never falls back to HEAD^.
  const diff = git(["diff", "--check", base, "HEAD"], { allowFailure: true });
  reportCommand(`git diff --check ${base} HEAD`, diff, "diff-check");
  if (diff.status !== 0) return diff.status ?? 1;

  const status = git(["status", "--porcelain", "--untracked-files=normal"], { allowFailure: true });
  reportCommand("git status --porcelain --untracked-files=normal", status, "clean-status");
  if (status.status !== 0) return status.status ?? 1;
  if (status.stdout.length > 0) {
    process.stderr.write("Working tree is not clean.\n");
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    process.exitCode = checkGitState();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
