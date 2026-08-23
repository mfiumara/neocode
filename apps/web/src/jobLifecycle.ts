import type { AgentJob } from "@neocode/protocol";

export function isDoneJob(job: AgentJob): boolean {
  if (job.integration?.status === "merged") return true;
  if (job.status === "failed" || job.status === "cancelled") return true;
  return job.status === "completed" && job.isolation.mode === "root";
}

export function jobLifecycleLabel(job: AgentJob): string {
  const integration = job.integration?.status;
  if (integration === "merged") return job.cleanup?.status === "removed" ? "Merged · cleaned" : "Merged · verified";
  if (integration === "reviewing") return "Review in progress";
  if (integration === "integrating") return "Integrating";
  if (integration === "conflicted") return "Conflict · needs attention";
  if (job.status === "completed" && job.isolation.mode === "worktree") return "Completed · unmerged";
  if (job.status === "interrupted") return "Interrupted · recoverable";
  return job.status.charAt(0).toUpperCase() + job.status.slice(1);
}
