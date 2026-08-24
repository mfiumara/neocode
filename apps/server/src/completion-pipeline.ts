import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  ActionRequired,
  AgentJob,
  CheckEvidence,
  JudgeEvidence,
  RemediationFailureClass,
  ReviewStatus,
} from "@neocode/protocol";

export class PipelineError extends Error {
  constructor(
    readonly code: "blocked" | "conflict" | "failed",
    message: string,
    readonly failureClass?: RemediationFailureClass,
    readonly checks?: CheckEvidence[],
  ) { super(message); }
}

const execFileAsync = promisify(execFile);

export interface ReconcileResult {
  commit: string;
  completionCommit?: string;
  alreadyMerged?: boolean;
  /** CI evidence for the exact prospective merge tree, before main changes. */
  candidateCi?: CheckEvidence[];
}
export interface ReviewAdapter {
  /** Rebase the worker onto the current target before CI and exact-diff judgment. */
  prepareForReview?(job: AgentJob): Promise<void>;
  runCi(cwd: string): Promise<CheckEvidence[]>;
  /** Separate required product validation from informational Git packet checks. */
  productCiEvidence?(checks: CheckEvidence[]): CheckEvidence[];
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
  private readonly scheduled = new Set<string>();
  private readonly operationLock: OperationLock;
  readonly #coordinatorMergeCapability: symbol;

  constructor(
    private readonly adapter: ReviewAdapter,
    private readonly publish: Publish,
    private readonly targetBranch = process.env.NEOCODE_MERGE_BRANCH || "main",
    private readonly rootCwd?: string,
    operationLock?: OperationLock,
    coordinatorMergeCapability: symbol = Symbol("unbound coordinator merge capability"),
  ) {
    this.operationLock = operationLock ?? new SerialOperationLock();
    this.#coordinatorMergeCapability = coordinatorMergeCapability;
  }

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
      remediation: { maxAttempts: remediationLimit(), rounds: {}, actions: [] },
    };
    job.integration = { status: "reviewing", targetRef: this.targetBranch };
    this.publish(job);
    return true;
  }

  /** Upgrade pre-handoff queued records after the orchestrator refreshes their exact diff. */
  migrateLegacyHandoff(job: AgentJob): boolean {
    if (job.status !== "completed" || !job.review || job.handoff || job.review.status !== "queued") return false;
    const now = Date.now();
    const diff = job.diff || "";
    job.handoff = {
      report: job.summary || "Legacy worker completed without a written report.",
      requirements: requirementsFrom(job.prompt),
      diffSha256: createHash("sha256").update(diff).digest("hex"),
      branch: job.branch,
      worktree: job.isolation.path,
      tests: evidenceLines(job.summary, /test|check|build/i),
      risks: evidenceLines(job.summary, /risk|unresolved|remaining/i),
      round: 1,
      createdAt: now,
    };
    job.review.updatedAt = now;
    job.review.transitions.push({
      status: "queued", at: now, owner: "server",
      detail: "Legacy completed record upgraded to a structured exact-diff handoff",
    });
    job.updatedAt = now;
    this.publish(job);
    return true;
  }

  startJudge(job: AgentJob): void {
    if (job.status !== "completed" || !job.review || !job.handoff) throw new Error("A completed worker handoff is required.");
    if (this.active.has(job.id)) throw new Error("A lifecycle action is already running.");
    if (!["queued", "handoff_received"].includes(job.review.status)) {
      throw new Error(`Cannot judge from ${job.review.status}; claim the pending repair, resume the same worker, and await its new handoff.`);
    }
    if ((job.review.judgeHandoffRound || 0) >= job.handoff.round) {
      throw new Error("This handoff has already been judged; a genuinely new worker handoff is required.");
    }
    job.review.attempt += job.review.judgeHandoffRound ? 1 : 0;
    job.review.judgeHandoffRound = job.handoff.round;
    delete job.review.error;
    delete job.review.judge;
    delete job.review.coordinatorAuthorizedAt;
    this.publish(job); // persist the handoff claim before CI or judge side effects
    this.launch(job, "judge");
  }

  /** Compatibility for the UI: retry means the coordinator explicitly starts a fresh judge. */
  retry(job: AgentJob): void { this.startJudge(job); }

  retryInfrastructure(job: AgentJob, reason: string): void {
    const action = this.currentAction(job);
    const transientChecks = action?.evidence.checks?.some((check) => check.timedOut || check.exitCode === null);
    if (!action || action.state !== "pending" || (action.failureClass !== "infrastructure" && !transientChecks)) {
      throw new Error("The current action is not diagnosed as a transient infrastructure failure.");
    }
    this.claimRepair(job, action, reason, true);
    this.transition(job, "feedback_sent", `Coordinator authorized safe infrastructure retry: ${reason}`, "coordinator");
    this.scheduleInfrastructureRetry(job);
  }

  requestChanges(job: AgentJob, feedback: string): void {
    if (!job.review) throw new Error("No handoff exists for this job.");
    if (!feedback.trim()) throw new Error("Specific feedback quoting the failing command/output is required.");
    const action = this.currentAction(job);
    if (!action || action.state !== "pending") throw new Error("No pending action-required failure exists.");
    const round = this.claimRepair(job, action, feedback.trim());
    job.review.feedback ??= [];
    job.review.feedback.push(feedback.trim());
    delete job.review.judge;
    delete job.review.coordinatorAuthorizedAt;
    this.transition(job, "feedback_sent", `Repair ${round.attempts}/${round.maxAttempts} feedback: ${feedback.trim()}`, "coordinator");
  }

  workerResumed(job: AgentJob): void {
    if (!job.review) throw new Error("No review exists for this job.");
    const action = this.currentAction(job);
    if (!action || action.state !== "repairing") throw new Error("A bounded repair attempt must be claimed before resuming the worker.");
    this.transition(job, "worker_resumed", `Same implementation worktree resumed: ${job.isolation.path}`, "coordinator");
  }

  nextHandoff(job: AgentJob): void {
    if (!job.review) { this.enqueue(job); return; }
    const action = this.currentAction(job);
    const lastTransition = job.review.transitions.at(-1);
    if (!action || action.state !== "repairing" || lastTransition?.status !== "worker_resumed") {
      throw new Error("A new handoff is accepted only after a bounded repair claim resumes the same worker.");
    }
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
    if (action.state === "repairing") {
      action.state = "resolved";
      action.updatedAt = now;
      delete job.review.remediation!.currentActionId;
    }
    this.transition(job, "handoff_received", `New handoff ${job.handoff.diffSha256} delivered from the same worktree for review round ${job.handoff.round}`, "worker");
  }

  invalidateApprovalForTargetAdvance(job: AgentJob, targetHead: string): boolean {
    if (job.review?.status !== "approved" || job.review.reviewBaseRef === targetHead || !job.handoff) return false;
    delete job.review.judge;
    delete job.review.coordinatorAuthorizedAt;
    job.review.judgeHandoffRound = Math.max(0, job.handoff.round - 1);
    this.transition(job, "handoff_received", `Main advanced to ${targetHead}; prior approval invalidated before integration and the candidate requires rebase plus fresh judgment`, "server");
    return true;
  }

  requestMerge(job: AgentJob, capability: symbol): void {
    if (capability !== this.#coordinatorMergeCapability) throw new Error("Only the bound main coordinator tool can authorize guarded merge.");
    if (!job.review?.judge?.approved) throw new Error("A fresh independent judge approval is required before guarded merge.");
    if (this.active.has(job.id)) throw new Error("A lifecycle action is already running.");
    if (job.review.status !== "approved") {
      throw new Error(`Guarded merge is unavailable from ${job.review.status}; conflicts and failures require a new worker handoff and fresh judge.`);
    }
    job.review.coordinatorAuthorizedAt = Date.now();
    this.transition(job, "merge_queued", "Coordinator approved the exact reviewed rebased diff and authorized guarded fast-forward integration", "coordinator");
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
      const action = this.currentAction(job);
      if (job.review.status === "merged" || job.integration?.status === "merged") {
        if (action?.state === "repairing") this.resolveAction(job, action);
        continue;
      }
      const transientRetry = action?.evidence.checks?.some((check) => check.timedOut || check.exitCode === null);
      if (action?.state === "repairing" && (action.failureClass === "infrastructure" || transientRetry)) {
        if (job.review.activeRetry) {
          delete job.review.activeRetry; // A pre-restart operation lease is never live authority.
          this.publish(job);
        }
        this.scheduleInfrastructureRetry(job);
      } else if (["ci_running", "judging"].includes(job.review.status)) {
        this.requireAction(job, "infrastructure", "failed", "Interrupted judge action requires a bounded recovery decision");
      } else if (["merge_queued", "merging", "post_merge_ci"].includes(job.review.status)) {
        delete job.review.coordinatorAuthorizedAt;
        this.requireAction(job, "judge_changes", "blocked", "Interrupted merge recovered safely; return to the same worker before a fresh review");
      }
    }
  }

  async idle(): Promise<void> { while (this.active.size) await new Promise((resolve) => setTimeout(resolve, 5)); }

  private launch(job: AgentJob, mode: "judge" | "merge" | "post"): void {
    this.active.add(job.id);
    void this.process(job, mode).finally(() => this.active.delete(job.id));
  }

  private async process(job: AgentJob, mode: "judge" | "merge" | "post"): Promise<void> {
    try {
      if (mode === "post") {
        const checks = await this.adapter.runCi(this.rootCwd || job.isolation.path);
        const productChecks = this.productCiEvidence(checks);
        job.review!.postMergeCi = this.classifyChecks(checks, productChecks, job.handoff?.round);
        delete job.review!.activeRetry;
        this.publish(job);
        if (!productChecks.length || checks.some((check) => !check.ok)) {
          this.requireAction(job, "post_merge_ci", "post_ci_failed",
            !productChecks.length ? "No post-merge product CI checks detected" : "Post-merge CI failed", job.review!.postMergeCi);
          return;
        }
        this.resolveInfrastructureRetry(job);
        this.transition(job, "merged", `Post-merge verification passed for ${job.review!.mergeCommit}: ${checks.map((check) => check.command).join(", ")}`, "server");
        return;
      }
      if (mode === "judge") {
        this.transition(job, "ci_running", "Coordinator started guarded rebase and CI for independent review", "coordinator");
        await this.adapter.prepareForReview?.(job);
        job.review!.preparedHandoffRound = job.handoff?.round;
        this.publish(job);
        const ci = await this.adapter.runCi(job.isolation.path);
        const productChecks = this.productCiEvidence(ci);
        job.review!.ci = this.classifyChecks(ci, productChecks, job.handoff?.round);
        job.review!.ciHandoffRound = job.handoff?.round;
        delete job.review!.activeRetry;
        this.publish(job);
        if (!productChecks.length || ci.some((check) => !check.ok)) {
          const transient = productChecks.some((check) => check.timedOut || check.exitCode === null);
          this.requireAction(job, transient ? "infrastructure" : "worker_ci", "ci_failed",
            !productChecks.length ? "No product CI checks configured; Git metadata alone cannot authorize review" : "Worker CI failed", job.review!.ci);
          return;
        }
        this.transition(job, "ci_running", `CI passed: ${ci.map((check) => check.command).join(", ")}`, "server");
        const diff = await this.adapter.readDiff(job);
        job.diff = diff;
        const hash = createHash("sha256").update(diff).digest("hex");
        const packetHash = ci.find((check) => check.command === CANONICAL_DIFF_COMMAND)?.output.trim().split(/\s+/)[0];
        if (packetHash && packetHash !== hash) {
          throw new PipelineError("failed", `Candidate Git packet hash ${packetHash} does not match reviewed diff ${hash}.`, "candidate_ci", ci);
        }
        if (job.handoff) job.handoff.diffSha256 = hash;
        this.publish(job);
        this.transition(job, "judging", `Coordinator launched a fresh independent judge session for exact diff ${hash}${packetHash ? ` with matching Git packet ${packetHash}` : ""}`, "coordinator");
        const verdict = await this.adapter.judge(job, diff, hash);
        if (verdict.diffSha256 !== hash) throw new PipelineError("failed", "Judge verdict was not tied to the reviewed diff.");
        job.review!.judge = verdict; this.publish(job);
        if (!verdict.approved || !verdict.requirements.length || verdict.requirements.some((item) => !item.satisfied)) {
          this.requireAction(job, "judge_changes", "rejected", verdict.summary || "Judge requested changes", undefined, verdict);
          return;
        }
        this.resolveInfrastructureRetry(job);
        this.transition(job, "approved", verdict.summary, "judge");
        return;
      }

      if (!job.review!.coordinatorAuthorizedAt) throw new PipelineError("blocked", "Only a coordinator tool call can authorize merge.");
      await this.operationLock.run(async () => {
        this.transition(job, "merging", `Coordinator-owned guarded fast-forward into ${job.review!.targetBranch}`, "coordinator");
        const current = await this.adapter.readDiff(job);
        const hash = createHash("sha256").update(current).digest("hex");
        if (hash !== job.review!.judge!.diffSha256) throw new PipelineError("blocked", "Worker diff changed after judge approval; return it to the same worker and start a fresh judge.", "judge_changes");
        const result = await this.adapter.reconcile(job);
        job.review!.mergeCommit = result.commit;
        if (result.completionCommit && job.completion) job.completion.head = result.completionCommit;
        if (result.candidateCi) {
          const productChecks = this.productCiEvidence(result.candidateCi);
          job.review!.postMergeCi = this.classifyChecks(result.candidateCi, productChecks, job.handoff?.round);
          this.publish(job);
          this.resolveInfrastructureRetry(job);
          this.transition(job, "merged", `Guarded rebased fast-forward verified as ${result.commit}; exact candidate checks passed before main changed`, "server");
          return;
        }
        this.transition(job, "post_merge_ci", "Merge completed; running serialized post-merge checks", "server");
        const checks = await this.adapter.runCi(this.rootCwd || job.isolation.path);
        const productChecks = this.productCiEvidence(checks);
        job.review!.postMergeCi = this.classifyChecks(checks, productChecks, job.handoff?.round);
        delete job.review!.activeRetry;
        this.publish(job);
        if (!productChecks.length || checks.some((check) => !check.ok)) {
          this.requireAction(job, "post_merge_ci", "post_ci_failed",
            !productChecks.length ? "No post-merge product CI checks detected" : "Post-merge CI failed", job.review!.postMergeCi);
          return;
        }
        this.resolveInfrastructureRetry(job);
        this.transition(job, "merged", `Guarded merge verified as ${result.commit}; post-merge checks passed: ${checks.map((check) => check.command).join(", ")}`, "server");
      });
    } catch (error) {
      delete job.review!.activeRetry;
      const code = error instanceof PipelineError ? error.code : "failed";
      const failureClass = error instanceof PipelineError && error.failureClass
        ? error.failureClass : code === "conflict" ? "conflict" : "infrastructure";
      this.requireAction(job, failureClass, code, error instanceof Error ? error.message : String(error),
        error instanceof PipelineError ? error.checks : undefined);
    }
  }

  private currentAction(job: AgentJob): ActionRequired | undefined {
    const remediation = job.review?.remediation;
    return remediation?.actions.find((action) => action.id === remediation.currentActionId);
  }

  private requireAction(
    job: AgentJob,
    failureClass: RemediationFailureClass,
    status: ReviewStatus,
    detail: string,
    checks?: CheckEvidence[],
    judge?: JudgeEvidence,
  ): void {
    const review = job.review!;
    review.remediation ??= { maxAttempts: remediationLimit(), rounds: {}, actions: [] };
    const diffHash = createHash("sha256").update(job.diff || "").digest("hex");
    // The implementation patch is the material identity. Completion commits,
    // merge commits, timestamps, and command output can change without changing
    // the implementation and therefore must never replenish the failure budget.
    const fingerprint = `${failureClass}:${diffHash}`;
    let round = review.remediation.rounds[failureClass];
    if (!round || round.fingerprint !== fingerprint) {
      round = { failureClass, fingerprint, attempts: 0, maxAttempts: review.remediation.maxAttempts, updatedAt: Date.now() };
      review.remediation.rounds[failureClass] = round;
    }
    const previous = this.currentAction(job);
    if (previous && previous.state !== "exhausted") { previous.state = "resolved"; previous.updatedAt = Date.now(); }
    const action = {
      id: randomUUID(), failureClass, fingerprint,
      state: "pending" as const, attempt: round.attempts, maxAttempts: round.maxAttempts,
      createdAt: Date.now(), updatedAt: Date.now(),
      evidence: { detail, checks, judge, mergeCommit: review.mergeCommit },
    };
    review.remediation.actions.push(action);
    review.remediation.currentActionId = action.id;
    this.transition(job, status, detail, failureClass === "judge_changes" ? "judge" : "server");
    if (round.attempts >= round.maxAttempts) this.exhaust(job, action, round.attempts);
  }

  private claimRepair(job: AgentJob, action: ActionRequired, feedback: string, withBackoff = false) {
    const round = job.review!.remediation!.rounds[action.failureClass]!;
    if (round.attempts >= round.maxAttempts) {
      this.exhaust(job, action, round.attempts);
      throw new Error(`Repair limit reached for ${action.failureClass}; complete evidence is preserved.`);
    }
    round.attempts += 1;
    round.updatedAt = Date.now();
    if (withBackoff) round.nextRetryAt = Date.now() + remediationBackoff(round.attempts);
    else delete round.nextRetryAt;
    action.attempt = round.attempts;
    action.feedback = feedback;
    action.state = "repairing";
    action.updatedAt = Date.now();
    this.publish(job); // persist the claim before worker/CI side effects
    return round;
  }

  private resolveAction(job: AgentJob, action: ActionRequired): void {
    action.state = "resolved";
    action.updatedAt = Date.now();
    if (job.review?.remediation?.currentActionId === action.id) delete job.review.remediation.currentActionId;
    this.publish(job);
  }

  private resolveInfrastructureRetry(job: AgentJob): void {
    const action = this.currentAction(job);
    if (action?.state === "repairing" && action.failureClass === "infrastructure") {
      // The following lifecycle transition persists this mutation atomically
      // with the successful status, so avoid an intermediate publish here.
      action.state = "resolved";
      action.updatedAt = Date.now();
      delete job.review!.remediation!.currentActionId;
    }
  }

  private scheduleInfrastructureRetry(job: AgentJob): void {
    const action = this.currentAction(job);
    const round = action && job.review?.remediation?.rounds[action.failureClass];
    if (!action || !round || this.scheduled.has(action.id)
      || job.review?.status === "merged" || job.integration?.status === "merged") return;
    this.scheduled.add(action.id);
    const delay = Math.max(0, (round.nextRetryAt || Date.now()) - Date.now());
    const timer = setTimeout(() => {
      this.scheduled.delete(action.id);
      if (this.currentAction(job)?.id !== action.id || action.state !== "repairing"
        || job.review?.status === "merged" || job.integration?.status === "merged") return;
      const target = action.evidence.mergeCommit ? "post_merge" : "review";
      job.review!.activeRetry = { target, startedAt: Date.now() };
      this.transition(job, "ci_running", `Infrastructure retry ${round.attempts}/${round.maxAttempts} after ${delay}ms backoff`, "coordinator");
      this.launch(job, target === "post_merge" ? "post" : "judge");
    }, delay);
    timer.unref?.();
  }

  private exhaust(job: AgentJob, action: ActionRequired, attempts: number): void {
    action.state = "exhausted";
    action.updatedAt = Date.now();
    job.status = "needs_attention";
    job.recoverable = true;
    job.recoveryIssue = `Repair limit reached for ${action.failureClass} after ${attempts} unchanged rounds. Exact diagnostics remain in review.remediation.actions.`;
    this.transition(job, "needs_attention", job.recoveryIssue, "server");
  }

  private productCiEvidence(checks: CheckEvidence[]): CheckEvidence[] {
    return this.adapter.productCiEvidence?.(checks) ?? checks;
  }

  private classifyChecks(checks: CheckEvidence[], productChecks: CheckEvidence[], handoffRound?: number): CheckEvidence[] {
    const product = new Set(productChecks);
    return checks.map((check) => ({ ...check, purpose: product.has(check) ? "product_ci" : "preparation", handoffRound }));
  }

  private transition(job: AgentJob, status: ReviewStatus, detail?: string, owner: "worker" | "coordinator" | "judge" | "server" = "server"): void {
    const review = job.review!; review.status = status; review.updatedAt = Date.now();
    if (["queued", "ci_running", "judging", "approved", "feedback_sent", "worker_resumed", "handoff_received"].includes(status)) job.integration = { ...job.integration, status: "reviewing", targetRef: review.targetBranch };
    else if (["merge_queued", "merging", "post_merge_ci"].includes(status)) job.integration = { ...job.integration, status: "integrating", targetRef: review.targetBranch };
    else if (["rejected", "blocked", "conflict", "ci_failed", "post_ci_failed", "failed"].includes(status)) job.integration = { ...job.integration, status: "conflicted", targetRef: review.targetBranch };
    else if (status === "merged") job.integration = {
      status: "merged", targetRef: review.targetBranch, verifiedAt: Date.now(),
      targetHead: review.mergeCommit, completionHead: job.completion?.head,
      disposition: job.integration?.disposition || "integrated",
    };
    if (["blocked", "conflict", "failed", "ci_failed", "post_ci_failed"].includes(status)) review.error = detail; else delete review.error;
    review.transitions.push({ status, at: review.updatedAt, detail, owner }); this.publish(job);
  }
}

function remediationLimit(): number {
  const value = Number(process.env.NEOCODE_REMEDIATION_MAX_ROUNDS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 3;
}
function remediationBackoff(attempt: number): number {
  const base = Number(process.env.NEOCODE_REMEDIATION_BACKOFF_MS);
  return (Number.isFinite(base) && base >= 0 ? base : 1_000) * 2 ** Math.max(0, attempt - 1);
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

  async prepareForReview(job: AgentJob): Promise<void> {
    if (job.isolation.mode !== "worktree") throw new PipelineError("blocked", "Root-isolated jobs cannot be rebased for guarded integration.");
    const workerBranch = (await git(job.isolation.path, ["branch", "--show-current"])).trim();
    if (workerBranch !== job.branch) throw new PipelineError("blocked", `Worker checkout is on ${workerBranch || "detached HEAD"}, expected ${job.branch}.`);
    if ((await git(job.isolation.path, ["status", "--porcelain"])).trim()) {
      await git(job.isolation.path, ["add", "-A"]);
      await git(job.isolation.path, ["commit", "-m", `neocode: ${job.title}`]);
    }
    const targetHead = (await git(this.root, ["rev-parse", this.targetBranch])).trim();
    if (!await gitSucceeds(this.root, ["merge-base", "--is-ancestor", targetHead, job.branch])) {
      try {
        await git(job.isolation.path, ["rebase", targetHead]);
      } catch (error) {
        throw new PipelineError("conflict", `Worker rebase onto ${this.targetBranch} conflicts; main was not changed and the same worktree must resolve it: ${error instanceof Error ? error.message : String(error)}`, "conflict");
      }
    }
    // A worker may have merged main into its own branch. Even when current main
    // is already an ancestor, flatten candidate-local merge commits before
    // review so --ff-only can never import non-linear history.
    const mergeCommits = (await git(job.isolation.path, ["rev-list", "--min-parents=2", `${targetHead}..HEAD`])).trim();
    if (mergeCommits) {
      await git(job.isolation.path, ["reset", "--soft", targetHead]);
      if (await gitSucceeds(job.isolation.path, ["diff", "--cached", "--quiet"])) {
        await git(job.isolation.path, ["reset", "--hard", targetHead]);
      } else {
        await git(job.isolation.path, ["commit", "-m", `neocode: ${job.title}`]);
      }
    }
    const completionHead = (await git(job.isolation.path, ["rev-parse", "HEAD"])).trim();
    // Keep job.baseRef/worktreeIdentity.baseRef as immutable creation
    // provenance. The mutable target used for exact review is separate.
    job.review!.reviewBaseRef = targetHead;
    job.completion = { head: completionHead, finishedAt: job.completion?.finishedAt || Date.now() };
    job.updatedAt = Date.now();
  }

  async runCi(cwd: string): Promise<CheckEvidence[]> {
    const commands = this.options.command || process.env.NEOCODE_CI_COMMAND
      ? [this.options.command || process.env.NEOCODE_CI_COMMAND!]
      : await detectedCommands(cwd);
    const targetHead = (await git(this.root, ["rev-parse", this.targetBranch])).trim();
    // These are standard candidate checks, not worker-report prose. Keep the
    // exact base, clean identity, tree, changed paths, and whitespace gate in
    // durable CheckEvidence consumed by the independent judge.
    commands.push(
      `git diff --check ${targetHead} HEAD`,
      `test -z "$(git status --porcelain)" && printf 'BASE=${targetHead}\\nHEAD=' && git rev-parse HEAD && printf 'PARENT=' && git rev-parse HEAD^ && printf 'TREE=' && git rev-parse 'HEAD^{tree}' && git diff --name-status ${shellQuote(targetHead)} HEAD`,
    );
    const evidence: CheckEvidence[] = [];
    for (const command of [...candidateGitPacketCommands(this.targetBranch), ...commands]) {
      const check = await runBounded(command, cwd, this.options.timeoutMs, this.options.maxOutputBytes);
      evidence.push(check);
      if (!check.ok) break;
    }
    return evidence;
  }

  productCiEvidence(checks: CheckEvidence[]): CheckEvidence[] {
    return classifyProductCiEvidence(checks, this.options.command || process.env.NEOCODE_CI_COMMAND);
  }

  readDiff(job: AgentJob): Promise<string> {
    return readWorktreeDiff(job.isolation.path, job.review?.reviewBaseRef || job.baseRef);
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

    if ((await git(job.isolation.path, ["status", "--porcelain"])).trim()) {
      throw new PipelineError("blocked", "Worker changed after exact-diff approval; a fresh rebase, CI, and judge are required.");
    }
    const completionCommit = (await git(job.isolation.path, ["rev-parse", "HEAD"])).trim();
    const targetHead = (await git(this.root, ["rev-parse", this.targetBranch])).trim();
    const alreadyMerged = await gitSucceeds(this.root, ["merge-base", "--is-ancestor", job.branch, this.targetBranch]);
    if (!alreadyMerged && (job.review?.reviewBaseRef !== targetHead
      || !await gitSucceeds(this.root, ["merge-base", "--is-ancestor", targetHead, job.branch]))) {
      throw new PipelineError("blocked", "Main advanced after review or the worker is not rebased onto it; a fresh rebase, CI, and judge are required.", "judge_changes");
    }
    // Keep the temporary worktree outside the repository so it cannot make a
    // fixture or checkout dirty, but on the same filesystem so node_modules can
    // be atomically activated with rename(2).
    const temporaryRoot = await mkdtemp(join(dirname(this.root), ".neocode-integration-"));
    const candidate = join(temporaryRoot, "candidate");
    const dependencyBackup = join(temporaryRoot, "previous-node-modules");
    let candidateAdded = false;
    let dependenciesActivated = false;
    let hadRootDependencies = false;
    let integrationSucceeded = false;

    try {
      // Main must not change until the exact prospective merge tree has passed
      // CI in a clean checkout with its own dependency installation.
      // The judge reviewed this exact rebased head. Validate that commit in an
      // isolated checkout, then advance main only with --ff-only: no merge
      // commits and no integration-time content changes are possible.
      await git(this.root, ["worktree", "add", "--detach", candidate, alreadyMerged ? targetHead : completionCommit]);
      candidateAdded = true;

      const candidateCi = await this.runCi(candidate);
      const productChecks = this.productCiEvidence(candidateCi);
      if (!productChecks.length || candidateCi.some((check) => !check.ok)) {
        const failed = candidateCi.find((check) => !check.ok);
        throw new PipelineError("failed", failed
          ? `Candidate CI failed before main changed: ${failed.command}`
          : "No candidate product CI checks were configured; Git metadata alone cannot change main.",
          candidateCi.some((check) => check.timedOut || check.exitCode === null) ? "infrastructure" : "candidate_ci", candidateCi);
      }
      const candidateTree = (await git(candidate, ["rev-parse", "HEAD^{tree}"])).trim();

      // Refuse races with humans or other processes after candidate validation.
      const currentHead = (await git(this.root, ["rev-parse", "HEAD"])).trim();
      if (currentHead !== targetHead || (await git(this.root, ["branch", "--show-current"])).trim() !== this.targetBranch) {
        throw new PipelineError("blocked", "Main changed while candidate CI was running; review must be retried.");
      }
      if ((await git(this.root, ["status", "--porcelain", "--untracked-files=normal"])).trim()) {
        throw new PipelineError("blocked", "Root became dirty while candidate CI was running; main was not changed.");
      }

      // Candidate CI proves a clean dependency graph, but a long-running dev
      // checkout may still have node_modules from the previous lockfile. When
      // dependencies changed, atomically activate the tested candidate graph
      // before the source fast-forward so Vite can never observe new imports
      // with old installed packages.
      const candidateLock = await readFile(join(candidate, "package-lock.json"), "utf8").catch(() => undefined);
      const rootLock = await readFile(join(this.root, "package-lock.json"), "utf8").catch(() => undefined);
      if (candidateLock !== undefined && candidateLock !== rootLock) {
        const candidateModules = join(candidate, "node_modules");
        const rootModules = join(this.root, "node_modules");
        try {
          await rename(rootModules, dependencyBackup);
          hadRootDependencies = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          await rename(candidateModules, rootModules);
          dependenciesActivated = true;
        } catch (error) {
          if (hadRootDependencies) await rename(dependencyBackup, rootModules).catch(() => undefined);
          throw new PipelineError("failed", `Tested candidate dependencies could not be activated; main was not changed: ${error instanceof Error ? error.message : String(error)}`, "infrastructure", candidateCi);
        }
      }

      if (!alreadyMerged) {
        try {
          await git(this.root, ["merge", "--ff-only", job.branch]);
        } catch (error) {
          throw new PipelineError("blocked", `Fast-forward integration refused; main was not changed: ${error instanceof Error ? error.message : String(error)}`, "judge_changes");
        }
      }
      const commit = (await git(this.root, ["rev-parse", "HEAD"])).trim();
      const integratedTree = (await git(this.root, ["rev-parse", "HEAD^{tree}"])).trim();
      if (integratedTree !== candidateTree) {
        // Root was proven clean and targetHead was captured immediately above,
        // so this rollback cannot discard user work.
        await git(this.root, ["reset", "--hard", targetHead]);
        throw new PipelineError("failed", "Integrated tree differed from the CI-validated candidate; main was rolled back.");
      }
      integrationSucceeded = true;
      return { commit, completionCommit, alreadyMerged: alreadyMerged || undefined, candidateCi };
    } finally {
      if (dependenciesActivated && !integrationSucceeded) {
        await rm(join(this.root, "node_modules"), { recursive: true, force: true });
        if (hadRootDependencies) await rename(dependencyBackup, join(this.root, "node_modules")).catch(() => undefined);
      }
      if (candidateAdded) await git(this.root, ["worktree", "remove", "--force", candidate]).catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
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

export const CANONICAL_DIFF_COMMAND = "git diff --binary main...HEAD | shasum -a 256";

/** Recognized required commands remain product evidence if configuration changes after execution. */
export function classifyProductCiEvidence(checks: CheckEvidence[], configuredCommand?: string): CheckEvidence[] {
  return checks.filter((check) => check.command === configuredCommand
    || /^(?:npm test|npm run (?:check|build))$/.test(check.command));
}

export function candidateGitPacketCommands(targetBranch = "main"): string[] {
  const target = targetBranch === "main" ? "main" : shellQuote(targetBranch);
  const canonicalDiff = targetBranch === "main"
    ? CANONICAL_DIFF_COMMAND
    : `git diff --binary ${target}...HEAD | shasum -a 256`;
  return [
    `git rev-parse ${target} HEAD HEAD^`,
    "git rev-parse HEAD^{tree}",
    `git merge-base ${target} HEAD`,
    `git diff --name-status ${target}...HEAD`,
    canonicalDiff,
    "git status --porcelain",
    `git diff --check ${target}...HEAD`,
  ];
}

export async function detectedCommands(cwd: string): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const commands: string[] = [];
    try {
      await readFile(join(cwd, "package-lock.json"));
      commands.push("npm ci");
    } catch {
      // Without a lockfile we cannot prove a reproducible dependency graph.
    }
    if (value.scripts?.test) commands.push("npm test");
    commands.push(...["check", "build"]
      .filter((name) => value.scripts?.[name])
      .map((name) => `npm run ${name}`));
    return commands;
  } catch { return []; }
}

export async function runBounded(command: string, cwd: string, timeoutMs = Number(process.env.NEOCODE_CI_TIMEOUT_MS) || 300_000, maxBytes = 96 * 1024): Promise<CheckEvidence> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", command], { cwd, env: process.env, detached: process.platform !== "win32" });
    let output = "";
    let truncated = false;
    let timedOut = false;
    let closed = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      const value = chunk.toString();
      const remaining = maxBytes - Buffer.byteLength(output);
      if (remaining > 0) output += Buffer.from(value).subarray(0, remaining).toString();
      if (Buffer.byteLength(value) > remaining) truncated = true;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const signalChild = (signal: NodeJS.Signals) => {
      if (closed) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        // The process group can disappear between timeout and signal delivery,
        // or macOS can reject a group signal with EPERM. Never let a cleanup
        // race crash the server; fall back to the direct child and retain the
        // diagnostic as CI evidence.
        const detail = error instanceof Error ? error.message : String(error);
        output += `\nFailed to signal command process group (${signal}): ${detail}`;
        try { child.kill(signal); } catch (childError) {
          output += `\nFailed to signal command process (${signal}): ${childError instanceof Error ? childError.message : String(childError)}`;
        }
      }
    };
    const timer = setTimeout(() => {
      if (closed) return;
      timedOut = true;
      signalChild("SIGTERM");
      forceTimer = setTimeout(() => signalChild("SIGKILL"), 5_000);
      forceTimer.unref();
    }, timeoutMs);
    child.on("error", (error) => { output += `\n${error.message}`; });
    child.on("close", (exitCode) => {
      closed = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
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
