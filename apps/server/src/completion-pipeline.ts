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

export interface ReconcileResult { commit: string; completionCommit?: string; alreadyMerged?: boolean }
export interface ReviewAdapter {
  runCi(cwd: string): Promise<CheckEvidence[]>;
  readDiff(job: AgentJob): Promise<string>;
  judge(job: AgentJob, diff: string, diffSha256: string): Promise<JudgeEvidence>;
  reconcile(job: AgentJob): Promise<ReconcileResult>;
}

type Publish = (job: AgentJob) => void;
export interface OperationLock { run<T>(operation: () => Promise<T>): Promise<T> }

class SerialOperationLock implements OperationLock {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

/**
 * Durable coordinator-owned lifecycle. Worker completion only records a
 * handoff and wakes the coordinator; judge and merge side effects require
 * separate explicit coordinator tool calls.
 */
export class CompletionPipeline {
  private readonly active = new Set<string>();
  private readonly operationLock: OperationLock;

  constructor(
    private readonly adapter: ReviewAdapter,
    private readonly publish: Publish,
    private readonly targetBranch = process.env.NEOCODE_MERGE_BRANCH || "main",
    private readonly rootCwd?: string,
    operationLock?: OperationLock,
  ) { this.operationLock = operationLock ?? new SerialOperationLock(); }

  enqueue(job: AgentJob): boolean {
    if (job.status !== "completed" || job.review) return false;
    const now = Date.now();
    const diff = job.diff || "";
    job.handoff = {
      report: job.summary || "Worker completed without a written report.",
      requirements: requirementsFrom(job.prompt),
      diffSha256: createHash("sha256").update(diff).digest("hex"),
      branch: job.branch, worktree: job.isolation.path,
      tests: evidenceLines(job.summary, /test|check|build/i),
      risks: evidenceLines(job.summary, /risk|unresolved|remaining/i),
      round: 1, createdAt: now,
    };
    job.review = {
      hookToken: randomUUID(), status: "queued", attempt: 1,
      targetBranch: this.targetBranch, updatedAt: now,
      transitions: [{ status: "queued", at: now, owner: "worker", detail: "Structured handoff delivered; awaiting coordinator review" }],
    };
    job.integration = { status: "reviewing", targetRef: this.targetBranch };
    this.publish(job);
    return true;
  }

  startJudge(job: AgentJob): void {
    if (job.status !== "completed" || !job.review) throw new Error("A completed worker handoff is required.");
    if (this.active.has(job.id)) throw new Error("A lifecycle action is already running.");
    if (["merging", "post_merge_ci", "merged"].includes(job.review.status)) throw new Error("Cannot judge while integration is active or complete.");
    job.review.attempt += job.review.judge ? 1 : 0;
    delete job.review.error;
    delete job.review.judge;
    delete job.review.coordinatorAuthorizedAt;
    this.launch(job, "judge");
  }

  /** Compatibility for the UI: retry means the coordinator explicitly starts a fresh judge. */
  retry(job: AgentJob): void { this.startJudge(job); }

  requestChanges(job: AgentJob, feedback: string): void {
    if (!job.review) throw new Error("No handoff exists for this job.");
    if (!feedback.trim()) throw new Error("Specific review feedback is required.");
    job.review.feedback ??= [];
    job.review.feedback.push(feedback.trim());
    delete job.review.judge;
    delete job.review.coordinatorAuthorizedAt;
    this.transition(job, "rejected", `Coordinator feedback sent: ${feedback.trim()}`, "coordinator");
  }

  workerResumed(job: AgentJob): void {
    if (!job.review) throw new Error("No review exists for this job.");
    this.transition(job, "queued", "Worker resumed in the same worktree for the next review round", "coordinator");
  }

  nextHandoff(job: AgentJob): void {
    if (!job.review) { this.enqueue(job); return; }
    const now = Date.now();
    const diff = job.diff || "";
    job.handoff = {
      report: job.summary || "Worker completed without a written report.",
      requirements: requirementsFrom(job.prompt),
      diffSha256: createHash("sha256").update(diff).digest("hex"),
      branch: job.branch, worktree: job.isolation.path,
      tests: evidenceLines(job.summary, /test|check|build/i), risks: evidenceLines(job.summary, /risk|unresolved|remaining/i),
      round: (job.handoff?.round || 1) + 1, createdAt: now,
    };
    delete job.review.judge;
    delete job.review.coordinatorAuthorizedAt;
    this.transition(job, "queued", `Updated handoff delivered for review round ${job.handoff.round}`, "worker");
  }

  requestMerge(job: AgentJob): void {
    if (!job.review?.judge?.approved) throw new Error("A fresh independent judge approval is required before guarded merge.");
    if (this.active.has(job.id)) throw new Error("A lifecycle action is already running.");
    if (job.review.status !== "approved" && job.review.status !== "blocked" && job.review.status !== "conflict") {
      throw new Error(`Guarded merge is unavailable from ${job.review.status}.`);
    }
    job.review.coordinatorAuthorizedAt = Date.now();
    this.transition(job, "merge_queued", "Coordinator approved the exact reviewed diff and authorized guarded merge", "coordinator");
    this.launch(job, "merge");
  }

  /** Recovery persists intent but never replays judge or merge product decisions. */
  recover(jobs: AgentJob[]): void {
    for (const job of jobs) {
      if (job.status !== "completed") continue;
      if (!job.review) { this.enqueue(job); continue; }
      const coordinatorStartedJudge = job.review.transitions.some((entry) => entry.status === "judging" && entry.owner === "coordinator");
      if (job.review.judge && !coordinatorStartedJudge) {
        delete job.review.judge;
        delete job.review.coordinatorAuthorizedAt;
        this.transition(job, "queued", "Legacy server-owned verdict invalidated; coordinator must start a fresh judge", "server");
        continue;
      }
      if (["ci_running", "judging"].includes(job.review.status)) {
        this.transition(job, "queued", "Interrupted judge action recovered; awaiting coordinator restart", "server");
      } else if (["merge_queued", "merging", "post_merge_ci"].includes(job.review.status)) {
        delete job.review.coordinatorAuthorizedAt;
        this.transition(job, "blocked", "Interrupted merge recovered safely; coordinator must re-authorize guarded merge", "server");
      }
    }
  }

  async idle(): Promise<void> { while (this.active.size) await new Promise((resolve) => setTimeout(resolve, 5)); }

  private launch(job: AgentJob, mode: "judge" | "merge"): void {
    this.active.add(job.id);
    void this.process(job, mode).finally(() => this.active.delete(job.id));
  }

  private async process(job: AgentJob, mode: "judge" | "merge"): Promise<void> {
    try {
      if (mode === "judge") {
        this.transition(job, "ci_running", "Coordinator started CI for independent review", "coordinator");
        const ci = await this.adapter.runCi(job.isolation.path);
        job.review!.ci = ci; this.publish(job);
        if (!ci.length || ci.some((check) => !check.ok)) {
          this.transition(job, "ci_failed", !ci.length ? "No CI checks configured" : "Worker CI failed", "server"); return;
        }
        this.transition(job, "ci_running", `CI passed: ${ci.map((check) => check.command).join(", ")}`, "server");
        const diff = await this.adapter.readDiff(job);
        job.diff = diff;
        const hash = createHash("sha256").update(diff).digest("hex");
        this.transition(job, "judging", "Coordinator launched a fresh independent judge session", "coordinator");
        const verdict = await this.adapter.judge(job, diff, hash);
        if (verdict.diffSha256 !== hash) throw new PipelineError("failed", "Judge verdict was not tied to the reviewed diff.");
        job.review!.judge = verdict; this.publish(job);
        if (!verdict.approved || !verdict.requirements.length || verdict.requirements.some((item) => !item.satisfied)) {
          this.transition(job, "rejected", verdict.summary || "Judge requested changes", "judge"); return;
        }
        this.transition(job, "approved", verdict.summary, "judge");
        return;
      }

      if (!job.review!.coordinatorAuthorizedAt) throw new PipelineError("blocked", "Only a coordinator tool call can authorize merge.");
      await this.operationLock.run(async () => {
        this.transition(job, "merging", `Coordinator-owned guarded merge into ${job.review!.targetBranch}`, "coordinator");
        const current = await this.adapter.readDiff(job);
        const hash = createHash("sha256").update(current).digest("hex");
        if (hash !== job.review!.judge!.diffSha256) throw new PipelineError("blocked", "Worker diff changed after judge approval; start a fresh judge.");
        const result = await this.adapter.reconcile(job);
        job.review!.mergeCommit = result.commit;
        if (result.completionCommit && job.completion) job.completion.head = result.completionCommit;
        this.transition(job, "post_merge_ci", "Merge completed; running serialized post-merge checks", "server");
        const checks = await this.adapter.runCi(this.rootCwd || job.isolation.path);
        job.review!.postMergeCi = checks; this.publish(job);
        if (!checks.length || checks.some((check) => !check.ok)) {
          this.transition(job, "post_ci_failed", !checks.length ? "No post-merge CI checks detected" : "Post-merge CI failed", "server"); return;
        }
        this.transition(job, "merged", `Guarded merge verified as ${result.commit}; post-merge checks passed: ${checks.map((check) => check.command).join(", ")}`, "server");
      });
    } catch (error) {
      const code = error instanceof PipelineError ? error.code : "failed";
      this.transition(job, code, error instanceof Error ? error.message : String(error), "server");
    }
  }

  private transition(job: AgentJob, status: ReviewStatus, detail?: string, owner: "worker" | "coordinator" | "judge" | "server" = "server"): void {
    const review = job.review!; review.status = status; review.updatedAt = Date.now();
    if (["queued", "ci_running", "judging", "approved"].includes(status)) job.integration = { ...job.integration, status: "reviewing", targetRef: review.targetBranch };
    else if (["merge_queued", "merging", "post_merge_ci"].includes(status)) job.integration = { ...job.integration, status: "integrating", targetRef: review.targetBranch };
    else if (["rejected", "blocked", "conflict", "ci_failed", "post_ci_failed", "failed"].includes(status)) job.integration = { ...job.integration, status: "conflicted", targetRef: review.targetBranch };
    else if (status === "merged") job.integration = { status: "merged", targetRef: review.targetBranch, verifiedAt: Date.now(), targetHead: review.mergeCommit, completionHead: job.completion?.head };
    if (["blocked", "conflict", "failed", "ci_failed", "post_ci_failed"].includes(status)) review.error = detail; else delete review.error;
    review.transitions.push({ status, at: review.updatedAt, detail, owner }); this.publish(job);
  }
}

function requirementsFrom(prompt: string): string[] {
  const lines = prompt.split("\n").map((line) => line.trim()).filter(Boolean);
  const listed = lines.filter((line) => /^(?:[-*]|\d+[.)])\s/.test(line)).slice(0, 20).map((line) => line.replace(/^(?:[-*]|\d+[.)])\s*/, ""));
  return listed.length ? listed : lines.slice(0, 1);
}
function evidenceLines(summary: string | undefined, pattern: RegExp): string[] {
  return (summary || "").split("\n").map((line) => line.trim()).filter((line) => pattern.test(line)).slice(0, 10);
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
    if (job.isolation.mode !== "worktree") throw new PipelineError("blocked", "Root-isolated jobs cannot be guarded-merged; use a worktree worker.");
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
    const completionCommit = (await git(job.isolation.path, ["rev-parse", "HEAD"])).trim();
    if (await gitSucceeds(this.root, ["merge-base", "--is-ancestor", job.branch, this.targetBranch])) {
      return { commit: (await git(this.root, ["rev-parse", this.targetBranch])).trim(), completionCommit, alreadyMerged: true };
    }
    try {
      await git(this.root, ["merge", "--no-ff", "--no-edit", job.branch]);
    } catch (error) {
      await git(this.root, ["merge", "--abort"]).catch(() => undefined);
      throw new PipelineError("conflict", `Merge conflict; root was restored without forcing: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { commit: (await git(this.root, ["rev-parse", "HEAD"])).trim(), completionCommit };
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
