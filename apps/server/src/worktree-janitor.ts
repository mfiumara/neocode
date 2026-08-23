import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentJob, CleanupEvidence, CleanupRefusalReason } from "@neocode/protocol";

const execFileAsync = promisify(execFile);

export interface JanitorOptions {
  graceMs: number;
  targetRef: string;
  now?: () => number;
}

export interface JanitorRunResult {
  checked: number;
  removed: number;
  refused: number;
}

export class OperationLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function refusal(job: AgentJob, reason: CleanupRefusalReason, detail: string, checkedAt: number): false {
  job.cleanup = { status: "refused", checkedAt, reason, detail };
  return false;
}

/**
 * Removes only worktrees whose immutable completion head is demonstrably in the
 * configured target. Agent reports and integration labels are never evidence.
 */
export class WorktreeJanitor {
  private readonly now: () => number;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: JanitorOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async run(jobs: AgentJob[], onUpdate?: (job: AgentJob) => void): Promise<JanitorRunResult> {
    const result: JanitorRunResult = { checked: 0, removed: 0, refused: 0 };
    for (const job of jobs) {
      if (job.isolation.mode !== "worktree" || job.cleanup?.status === "removed"
        || job.status === "queued" || job.status === "running") continue;
      result.checked += 1;
      const removed = await this.review(job).catch((error: unknown) =>
        refusal(job, "git_error", error instanceof Error ? error.message : String(error), this.now()));
      if (removed) result.removed += 1;
      else result.refused += 1;
      onUpdate?.(job);
    }
    return result;
  }

  async review(job: AgentJob): Promise<boolean> {
    const checkedAt = this.now();
    if (job.status !== "completed") return refusal(job, "not_completed", `Job status is ${job.status}.`, checkedAt);
    if (!job.completion?.head || !job.completion.finishedAt || !job.worktreeIdentity) {
      return refusal(job, "missing_durable_identity", "Completion head or worktree identity is missing.", checkedAt);
    }
    if (checkedAt - job.completion.finishedAt < this.options.graceMs) {
      return refusal(job, "grace_period", "The cleanup grace period has not elapsed.", checkedAt);
    }
    const integration = job.integration?.status;
    if (integration === "reviewing" || integration === "integrating") {
      return refusal(job, "integration_active", `Integration is ${integration}.`, checkedAt);
    }
    if (integration === "conflicted") return refusal(job, "conflicted", "Integration has unresolved conflicts.", checkedAt);

    const identity = job.worktreeIdentity;
    if (await this.normalizedPath(identity.path) !== await this.normalizedPath(job.isolation.path)
      || identity.branch !== job.branch || identity.baseRef !== job.baseRef) {
      return refusal(job, "identity_mismatch", "Current branch/path/base does not match durable creation metadata.", checkedAt);
    }

    const registered = await this.registeredWorktrees();
    const normalizedIdentityPath = await this.normalizedPath(identity.path);
    const registeredBranch = registered.get(normalizedIdentityPath);
    if (registeredBranch === undefined) return refusal(job, "not_registered", "The durable path is not a registered worktree.", checkedAt);
    if (registeredBranch !== identity.branch) {
      return refusal(job, "branch_mismatch", `Registered branch is ${registeredBranch || "detached"}.`, checkedAt);
    }

    const actualHead = await this.git(["rev-parse", "HEAD"], identity.path);
    if (actualHead !== job.completion.head) {
      return refusal(job, "head_mismatch", "The worktree moved after its completion head was recorded.", checkedAt);
    }
    const porcelain = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], identity.path);
    if (porcelain) return refusal(job, "dirty", "Tracked or untracked local changes remain.", checkedAt);

    const commits = (await this.git(["rev-list", `${identity.baseRef}..${job.completion.head}`], this.workspaceRoot))
      .split("\n").filter(Boolean);

    const targetHead = await this.git(["rev-parse", this.options.targetRef], this.workspaceRoot);
    const superseded = integration === "superseded";
    let mergeMethod: CleanupEvidence["mergeMethod"] = superseded
      ? "superseded-branch-retained" : commits.length ? "commit-ancestry" : "no-changes";
    // Superseded work remains committed on its retained branch, so removing the
    // clean checkout cannot lose it. Other jobs still require Git integration.
    let merged = superseded || commits.length === 0;
    for (const commit of superseded ? [] : commits) {
      if (!(await this.gitSuccess(["merge-base", "--is-ancestor", commit, targetHead], this.workspaceRoot))) {
        merged = false;
        break;
      }
      merged = true;
    }
    if (!merged) {
      const cherry = await this.git(["cherry", this.options.targetRef, job.completion.head], this.workspaceRoot).catch(() => "");
      const equivalent = new Set(cherry.split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim()));
      let allIntegrated = true;
      for (const commit of commits) {
        if (equivalent.has(commit)) continue;
        if (!await this.gitSuccess(["merge-base", "--is-ancestor", commit, targetHead], this.workspaceRoot)) {
          allIntegrated = false;
          break;
        }
      }
      if (allIntegrated) {
        merged = true;
        mergeMethod = "patch-equivalent";
      }
    }
    if (!merged && await this.gitSuccess(["diff", "--quiet", job.completion.head, targetHead, "--"], this.workspaceRoot)) {
      merged = true;
      mergeMethod = "identical-content";
    }
    if (!merged) return refusal(job, "not_merged", `Completion head is not contained in ${this.options.targetRef}.`, checkedAt);

    const evidence: CleanupEvidence = {
      checkedAt,
      targetRef: this.options.targetRef,
      targetHead,
      completionHead: job.completion.head,
      intendedCommits: commits,
      mergeMethod,
      cleanPorcelain: true,
      registeredPath: identity.path,
      registeredBranch: identity.branch,
    };
    if (!superseded) job.integration = {
      ...job.integration,
      status: "merged",
      targetRef: this.options.targetRef,
      verifiedAt: checkedAt,
      targetHead,
      completionHead: job.completion.head,
      disposition: job.integration?.disposition || "already_integrated",
    };

    await this.git(["worktree", "remove", "--", identity.path], this.workspaceRoot);
    const after = await this.registeredWorktrees();
    const stillExists = await stat(identity.path).then(() => true, () => false);
    if (after.has(await this.normalizedPath(identity.path)) || stillExists) {
      return refusal(job, "removal_unverified", "Git removal completed but path/registration verification failed.", checkedAt);
    }
    job.cleanup = { status: "removed", checkedAt, removedAt: this.now(), evidence };
    return true;
  }

  private async registeredWorktrees(): Promise<Map<string, string>> {
    const output = await this.git(["worktree", "list", "--porcelain"], this.workspaceRoot);
    const result = new Map<string, string>();
    let path: string | undefined;
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = await this.normalizedPath(line.slice(9));
        result.set(path, "");
      } else if (path && line.startsWith("branch refs/heads/")) {
        result.set(path, line.slice("branch refs/heads/".length));
      }
    }
    return result;
  }

  private async normalizedPath(path: string): Promise<string> {
    return realpath(path).catch(() => resolve(path));
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  }

  private async gitSuccess(args: string[], cwd: string): Promise<boolean> {
    return execFileAsync("git", args, { cwd }).then(() => true, () => false);
  }
}
