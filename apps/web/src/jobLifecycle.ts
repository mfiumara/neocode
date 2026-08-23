import type { AgentJob } from "@neocode/protocol";

export interface JobActiveState {
  kind: "worker" | "checks" | "review" | "integration";
  label: string;
}

/**
 * Current execution, rather than the durable top-level disposition. Review
 * transitions are coordinator state, so only the current status is relevant;
 * transition history must never make a settled job look live again.
 */
export function jobActiveState(job: AgentJob, activityReady = true): JobActiveState | undefined {
  if (!activityReady || job.terminalDisposition) return undefined;
  if (["queued", "interrupted", "needs_attention", "failed", "cancelled"].includes(job.status)) {
    // Queued and terminal worker dispositions override stale review data.
    // Completed is deliberately excluded because review/integration work
    // follows it.
    return undefined;
  }

  if (["merged", "superseded"].includes(job.integration?.status || "")) return undefined;

  const review = job.review?.status;
  // startRecoveryAttempt is the live execution authority: it sets running but
  // intentionally preserves the prior review diagnosis and conflicted
  // integration evidence. A fresh connected snapshot therefore lets current
  // worker execution win over that settled metadata.
  if (job.status === "running") {
    return { kind: "worker", label: job.review ? "Worker repairing" : "Worker working" };
  }
  if (review === "ci_running") {
    const action = job.review?.remediation?.actions.find((item) => item.id === job.review?.remediation?.currentActionId);
    if (action?.state === "repairing" && job.review?.activeRetry) {
      return job.review.activeRetry.target === "post_merge"
        ? { kind: "checks", label: "Retrying verification" }
        : { kind: "review", label: "Retrying review prerequisites" };
    }
    const round = job.handoff?.round;
    if (round !== undefined && job.review?.ciHandoffRound === round) return undefined;
    return job.review?.reviewBaseRef && round !== undefined && job.review.preparedHandoffRound === round
      ? { kind: "checks", label: "Running product checks" }
      : { kind: "review", label: "Preparing review" };
  }
  if (review === "post_merge_ci") return job.review?.postMergeCi?.length
    ? undefined : { kind: "checks", label: "Running checks" };
  if (review === "judging") return job.review?.judge && job.handoff?.round !== undefined
    && job.review.judgeHandoffRound === job.handoff.round ? undefined : { kind: "review", label: "Under review" };
  if (review === "merging") return { kind: "integration", label: "Integrating" };

  // Other current review statuses are settled or awaiting a decision. An
  // integration flag alone is likewise not evidence of a live process.
  return undefined;
}

export function isDoneJob(job: AgentJob): boolean {
  return job.terminalDisposition !== undefined;
}

export function isActionableJob(job: AgentJob): boolean {
  return !isDoneJob(job);
}

export function splitJobs(jobs: AgentJob[]): { actionable: AgentJob[]; done: AgentJob[] } {
  return { actionable: jobs.filter(isActionableJob), done: jobs.filter(isDoneJob) };
}

export function jobLifecycleLabel(job: AgentJob): string {
  const terminal = job.terminalDisposition;
  if (terminal?.kind === "merged_verified") {
    const prefix = job.integration?.disposition === "already_integrated" ? "Already integrated" : "Integrated";
    return job.cleanup?.status === "removed" ? `${prefix} · verified · cleaned` : `${prefix} · verified`;
  }
  if (terminal?.kind === "superseded") {
    const replacement = terminal.supersededBy ? ` by ${terminal.supersededBy}` : "";
    return job.cleanup?.status === "removed" ? "Not required · cleaned" : `Not required · superseded${replacement}`;
  }
  if (terminal?.kind === "cancelled") return "Cancelled";
  if (terminal?.kind === "failed_terminal") return "Failed · terminal";
  if (terminal?.kind === "archived") return "Archived";

  const integration = job.integration?.status;
  const review = job.review?.status;
  // Otherwise the current worker disposition overrides transient review data.
  if (job.status === "queued") return "Queued";
  if (job.status === "interrupted") return job.recoverable === false ? "Interrupted" : "Interrupted · recoverable";
  if (job.status === "needs_attention") return "Needs attention";
  if (job.status === "failed") return "Failed";
  if (job.status === "cancelled") return "Cancelled";
  if (integration === "merged") return "Integrated · verification pending";
  if (integration === "superseded") return "Not required · verification pending";

  const currentRoundJudgeClaim = job.handoff?.round !== undefined
    && job.review?.judgeHandoffRound === job.handoff.round
    && ["queued", "handoff_received"].includes(review || "");
  if (currentRoundJudgeClaim) return "Review claimed · awaiting launch";
  const action = job.review?.remediation?.actions.find((item) => item.id === job.review?.remediation?.currentActionId);
  const retryRound = action ? job.review?.remediation?.rounds[action.failureClass] : undefined;
  if (action?.state === "repairing" && !job.review?.activeRetry && retryRound?.nextRetryAt !== undefined) {
    return action.evidence.mergeCommit ? "Verification retry scheduled" : "Review retry scheduled";
  }
  if (review === "approved") return "Approved · awaiting merge";
  if (review === "merge_queued") return "Approved · awaiting integration";
  if (review === "blocked") return "Blocked · needs attention";
  if (review === "failed") return "Review failed";
  if (review === "rejected") return "Changes requested";
  if (["queued", "handoff_received"].includes(review || "")) return "Awaiting review";
  if (review === "feedback_sent") return "Repair requested";
  if (integration === "reviewing") return "Review in progress";
  if (integration === "integrating") return "Integrating";
  if (integration === "conflicted") return "Conflict · needs attention";
  if (job.status === "completed") return job.isolation.mode === "worktree" ? "Completed · unmerged" : "Completed · unverified";
  return job.status.charAt(0).toUpperCase() + job.status.slice(1);
}
