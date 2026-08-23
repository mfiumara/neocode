import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  AgentJob,
  CheckEvidence,
  JudgeEvidence,
  ReviewStatus,
} from "@neocode/protocol";

export class PipelineError extends Error {
  constructor(readonly code: "blocked" | "conflict" | "failed", message: string) {
    super(message);
  }
}

const execFileAsync = promisify(execFile);

export interface ReconcileResult { commit: string; alreadyMerged?: boolean }
export interface ReviewAdapter {
  runCi(cwd: string): Promise<CheckEvidence[]>;
  readDiff(job: AgentJob): Promise<string>;
  judge(job: AgentJob, diff: string, diffSha256: string): Promise<JudgeEvidence>;
  reconcile(job: AgentJob): Promise<ReconcileResult>;
}

type Publish = (job: AgentJob) => void;

/**
 * Event-driven completion pipeline. The durable hookToken is written before any
 * asynchronous work starts, so duplicate terminal events and process restarts
 * cannot create a second automatic review.
 */
export class CompletionPipeline {
  private readonly active = new Set<string>();
  private mergeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: ReviewAdapter,
    private readonly publish: Publish,
    private readonly targetBranch = process.env.NEOCODE_MERGE_BRANCH || "main",
    private readonly rootCwd?: string,
  ) {}

  enqueue(job: AgentJob): boolean {
    if (job.status !== "completed" || job.review) return false;
    const now = Date.now();
    job.review = {
      hookToken: randomUUID(), status: "queued", attempt: 1,
      targetBranch: this.targetBranch, updatedAt: now,
      transitions: [{ status: "queued", at: now, detail: "Worker completed; review hook fired" }],
    };
    this.publish(job);
    this.launch(job, "full");
    return true;
  }

  retry(job: AgentJob): void {
    if (job.status !== "completed") throw new Error("Only successfully completed workers can be reviewed.");
    if (!job.review) { this.enqueue(job); return; }
    if (this.active.has(job.id)) throw new Error("Review is already running.");
    if (job.review.status === "merged") throw new Error("This job is already merged.");
    job.review.attempt += 1;
    delete job.review.error;
    delete job.review.judge;
    delete job.review.ci;
    delete job.review.postMergeCi;
    delete job.review.mergeCommit;
    this.transition(job, "queued", "Manual retry requested");
    this.launch(job, "full");
  }

  requestMerge(job: AgentJob): void {
    if (!job.review?.judge?.approved) throw new Error("A structured independent judge approval is required before reconciliation.");
    if (this.active.has(job.id)) throw new Error("Review is already running.");
    if (job.review.status === "merged") return;
    this.transition(job, "merge_queued", "Manual reconciliation requested");
    this.launch(job, "merge");
  }

  /** Resume durable transient states, and fire missing hooks, during startup. */
  recover(jobs: AgentJob[]): void {
    for (const job of jobs) {
      if (job.status !== "completed") continue;
      if (!job.review) { this.enqueue(job); continue; }
      if (["queued", "ci_running", "judging"].includes(job.review.status)) {
        this.transition(job, "queued", "Resuming interrupted review");
        this.launch(job, "full");
      } else if (["approved", "merge_queued", "merging"].includes(job.review.status)) {
        this.transition(job, "merge_queued", "Resuming interrupted reconciliation");
        this.launch(job, "merge");
      } else if (job.review.status === "post_merge_ci") {
        this.launch(job, "post");
      }
    }
  }

  async idle(): Promise<void> {
    while (this.active.size) await new Promise((resolve) => setTimeout(resolve, 5));
    await this.mergeTail;
  }

  private launch(job: AgentJob, mode: "full" | "merge" | "post"): void {
    if (this.active.has(job.id)) return;
    this.active.add(job.id);
    void this.process(job, mode).finally(() => this.active.delete(job.id));
  }

  private async process(job: AgentJob, mode: "full" | "merge" | "post"): Promise<void> {
    try {
      if (mode === "full") {
        this.transition(job, "ci_running", "Running local CI in worker checkout");
        const ci = await this.adapter.runCi(job.isolation.path);
        job.review!.ci = ci;
        this.publish(job);
        if (!ci.length || ci.some((check) => !check.ok)) {
          this.transition(job, "ci_failed", !ci.length ? "No CI checks were configured or detected" : "Worker CI failed");
          return;
        }

        // CI is allowed to create files, so bind the verdict to a fresh diff
        // captured after CI rather than the worker-completion snapshot.
        const diff = await this.adapter.readDiff(job);
        job.diff = diff;
        const diffSha256 = createHash("sha256").update(diff).digest("hex");
        this.transition(job, "judging", "Launching fresh independent Pi judge session");
        const verdict = await this.adapter.judge(job, diff, diffSha256);
        if (verdict.diffSha256 !== diffSha256) throw new PipelineError("failed", "Judge verdict was not tied to the reviewed diff.");
        job.review!.judge = verdict;
        this.publish(job);
        if (!verdict.approved || !verdict.requirements.length || verdict.requirements.some((item) => !item.satisfied)) {
          this.transition(job, "rejected", verdict.summary || "Independent judge rejected the change");
          return;
        }
        this.transition(job, "approved", verdict.summary);
        this.transition(job, "merge_queued", "Waiting for serialized reconciliation");
      }

      if (mode !== "post") {
        await this.withMergeLock(async () => {
          this.transition(job, "merging", `Reconciling into ${job.review!.targetBranch}`);
          const currentDiff = await this.adapter.readDiff(job);
          const currentHash = createHash("sha256").update(currentDiff).digest("hex");
          if (currentHash !== job.review!.judge!.diffSha256) {
            throw new PipelineError("blocked", "Worker diff changed after independent review; retry review before integration.");
          }
          const result = await this.adapter.reconcile(job);
          job.review!.mergeCommit = result.commit;
          this.transition(job, "post_merge_ci", result.alreadyMerged ? "Merge already present; rerunning CI" : "Reconciled; rerunning CI");
          await this.runPostMergeCi(job);
        });
      } else {
        await this.withMergeLock(() => this.runPostMergeCi(job));
      }
    } catch (error) {
      const code = error instanceof PipelineError ? error.code : "failed";
      this.transition(job, code, error instanceof Error ? error.message : String(error));
    }
  }

  private async runPostMergeCi(job: AgentJob): Promise<void> {
    const checks = await this.adapter.runCi(this.rootCwd || job.isolation.path);
    job.review!.postMergeCi = checks;
    this.publish(job);
    if (!checks.length || checks.some((check) => !check.ok)) {
      this.transition(job, "post_ci_failed", !checks.length ? "No post-merge CI checks detected" : "Post-merge CI failed");
      return;
    }
    this.transition(job, "merged", `Merged as ${job.review!.mergeCommit}`);
  }

  private async withMergeLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mergeTail;
    let release!: () => void;
    this.mergeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private transition(job: AgentJob, status: ReviewStatus, detail?: string): void {
    const review = job.review!;
    review.status = status;
    review.updatedAt = Date.now();
    if (["blocked", "conflict", "failed", "ci_failed", "post_ci_failed"].includes(status)) review.error = detail;
    else delete review.error;
    review.transitions.push({ status, at: review.updatedAt, detail });
    this.publish(job);
  }
}

export interface LocalReviewAdapterOptions {
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  judge: ReviewAdapter["judge"];
  targetBranch?: string;
}

/** Git/CI implementation used by the server; kept injectable for pipeline tests. */
export class LocalReviewAdapter implements ReviewAdapter {
  readonly targetBranch: string;
  constructor(readonly root: string, private readonly options: LocalReviewAdapterOptions) {
    this.targetBranch = options.targetBranch || process.env.NEOCODE_MERGE_BRANCH || "main";
  }

  async runCi(cwd: string): Promise<CheckEvidence[]> {
    const commands = this.options.command || process.env.NEOCODE_CI_COMMAND
      ? [this.options.command || process.env.NEOCODE_CI_COMMAND!]
      : await detectedCommands(cwd);
    const evidence: CheckEvidence[] = [];
    for (const command of commands) {
      const check = await runBounded(command, cwd, this.options.timeoutMs, this.options.maxOutputBytes);
      evidence.push(check);
      if (!check.ok) break;
    }
    return evidence;
  }

  readDiff(job: AgentJob): Promise<string> {
    return readWorktreeDiff(job.isolation.path, job.baseRef);
  }

  judge(job: AgentJob, diff: string, diffSha256: string): Promise<JudgeEvidence> {
    return this.options.judge(job, diff, diffSha256);
  }

  async reconcile(job: AgentJob): Promise<ReconcileResult> {
    if (job.isolation.mode !== "worktree") throw new PipelineError("blocked", "Root-isolated jobs are never auto-merged; use a worktree worker.");
    const branch = (await git(this.root, ["branch", "--show-current"])).trim();
    if (branch !== this.targetBranch) throw new PipelineError("blocked", `Root checkout is on ${branch || "detached HEAD"}, expected ${this.targetBranch}.`);
    if ((await git(this.root, ["status", "--porcelain", "--untracked-files=normal"])).trim()) {
      throw new PipelineError("blocked", "Root checkout is dirty; refusing to merge or overwrite it.");
    }
    const workerBranch = (await git(job.isolation.path, ["branch", "--show-current"])).trim();
    if (workerBranch !== job.branch) throw new PipelineError("blocked", `Worker checkout is on ${workerBranch || "detached HEAD"}, expected ${job.branch}.`);

    if (!await gitSucceeds(this.root, ["merge-base", "--is-ancestor", job.baseRef, job.branch])) {
      throw new PipelineError("blocked", "Worker branch no longer descends from its recorded base.");
    }
    // Commit before checking whether the branch is already integrated. A new
    // worker branch initially points at its base while all useful work is still
    // uncommitted, so doing the ancestry check first would silently skip it.
    if ((await git(job.isolation.path, ["status", "--porcelain"])).trim()) {
      await git(job.isolation.path, ["add", "-A"]);
      await git(job.isolation.path, ["commit", "-m", `neocode: ${job.title}`]);
    }
    if (!await gitSucceeds(this.root, ["merge-base", "--is-ancestor", job.baseRef, job.branch])) {
      throw new PipelineError("blocked", "Worker branch no longer descends from its recorded base.");
    }
    if (await gitSucceeds(this.root, ["merge-base", "--is-ancestor", job.branch, this.targetBranch])) {
      return { commit: (await git(this.root, ["rev-parse", this.targetBranch])).trim(), alreadyMerged: true };
    }
    try {
      await git(this.root, ["merge", "--no-ff", "--no-edit", job.branch]);
    } catch (error) {
      await git(this.root, ["merge", "--abort"]).catch(() => undefined);
      throw new PipelineError("conflict", `Merge conflict; root was restored without forcing: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { commit: (await git(this.root, ["rev-parse", "HEAD"])).trim() };
  }
}

export async function readWorktreeDiff(cwd: string, baseRef: string): Promise<string> {
  const tracked = await execFileAsync("git", ["diff", "--binary", "--no-ext-diff", baseRef], {
    cwd, maxBuffer: 10 * 1024 * 1024,
  });
  const untracked = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd, encoding: "buffer", maxBuffer: 10 * 1024 * 1024,
  });
  const files = untracked.stdout.toString().split("\0").filter(Boolean);
  const patches: string[] = [tracked.stdout];
  for (const file of files) {
    try {
      const result = await execFileAsync("git", ["diff", "--binary", "--no-index", "--", "/dev/null", file], {
        cwd, maxBuffer: 10 * 1024 * 1024,
      });
      patches.push(result.stdout);
    } catch (error) {
      // git diff --no-index returns 1 when it successfully finds a difference.
      const result = error as { code?: number | string; stdout?: string };
      if (result.code !== 1 || typeof result.stdout !== "string") throw error;
      patches.push(result.stdout);
    }
  }
  return patches.join("");
}

async function detectedCommands(cwd: string): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(`${cwd}/package.json`, "utf8")) as { scripts?: Record<string, string> };
    return ["test", "check", "build"].filter((name) => value.scripts?.[name]).map((name) => `npm run ${name}`);
  } catch { return []; }
}

export async function runBounded(command: string, cwd: string, timeoutMs = Number(process.env.NEOCODE_CI_TIMEOUT_MS) || 300_000, maxBytes = 96 * 1024): Promise<CheckEvidence> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", command], { cwd, env: process.env, detached: process.platform !== "win32" });
    let output = "";
    let truncated = false;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      const value = chunk.toString();
      const remaining = maxBytes - Buffer.byteLength(output);
      if (remaining > 0) output += Buffer.from(value).subarray(0, remaining).toString();
      if (Buffer.byteLength(value) > remaining) truncated = true;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (error) => { output += `\n${error.message}`; });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ command, ok: exitCode === 0 && !timedOut, exitCode, durationMs: Date.now() - started, output, truncated: truncated || undefined, timedOut: timedOut || undefined });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runBounded(`git ${args.map(shellQuote).join(" ")}`, cwd, 120_000, 1024 * 1024);
  if (!result.ok) throw new Error(result.output.trim() || `git ${args[0]} failed (${result.exitCode})`);
  return result.output;
}
async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  return (await runBounded(`git ${args.map(shellQuote).join(" ")}`, cwd, 120_000, 64 * 1024)).ok;
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
