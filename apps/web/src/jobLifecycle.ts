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
  if (!activityReady) return undefined;
  if (["interrupted", "needs_attention", "failed", "cancelled"].includes(job.status)) {
    // Terminal worker dispositions override stale review data. Completed is
    // deliberately excluded because review/integration work follows it.
    return undefined;
  }

  if (["merged", "superseded", "conflicted"].includes(job.integration?.status || "")) return undefined;

  const review = job.review?.status;
  if (review === "worker_resumed") return { kind: "worker", label: "Worker repairing" };
  if (review === "ci_running" || review === "post_merge_ci") return { kind: "checks", label: "Running checks" };
  if (review === "judging") return { kind: "review", label: "Under review" };
  if (review === "merge_queued" || review === "merging") return { kind: "integration", label: "Integrating" };

  // Any other current review status is settled or awaiting a decision. This
  // guard also prevents a mismatched stale worker status from winning. An
  // integration flag without its review action is not enough evidence of a
  // live process after restart.
  if (job.review) return undefined;
  if (job.status === "running") return { kind: "worker", label: "Worker working" };
  return undefined;
}

export function isDoneJob(job: AgentJob): boolean {
  if (job.integration?.status === "merged" || job.integration?.status === "superseded") return true;
  if (job.status === "failed" || job.status === "cancelled") return true;
  return job.status === "completed" && job.isolation.mode === "root";
}

export function jobLifecycleLabel(job: AgentJob): string {
  const integration = job.integration?.status;
  const review = job.review?.status;
  if (integration === "merged") {
    const prefix = job.integration?.disposition === "already_integrated" ? "Already integrated" : "Integrated";
    return job.cleanup?.status === "removed" ? `${prefix} · cleaned` : `${prefix} · verified`;
  }
  if (integration === "superseded") return job.cleanup?.status === "removed" ? "Not required · cleaned" : "Not required · superseded";
  if (review === "approved") return "Approved · awaiting merge";
  if (review === "blocked") return "Blocked · needs attention";
  if (review === "failed") return "Review failed";
  if (review === "rejected") return "Changes requested";
  if (["queued", "handoff_received"].includes(review || "")) return "Awaiting review";
  if (review === "feedback_sent") return "Repair requested";
  if (integration === "reviewing") return "Review in progress";
  if (integration === "integrating") return "Integrating";
  if (integration === "conflicted") return "Conflict · needs attention";
  if (job.status === "completed" && job.isolation.mode === "worktree") return "Completed · unmerged";
  if (job.status === "interrupted") return "Interrupted · recoverable";
  return job.status.charAt(0).toUpperCase() + job.status.slice(1);
}
