import type { AgentJob } from "@neocode/protocol";

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
  if (terminal?.kind === "merged_verified") return job.cleanup?.status === "removed" ? "Merged · verified · cleaned" : "Merged · verified";
  if (terminal?.kind === "superseded") return `Superseded${terminal.supersededBy ? ` by ${terminal.supersededBy}` : ""}`;
  if (terminal?.kind === "cancelled") return "Cancelled";
  if (terminal?.kind === "failed_terminal") return "Failed · terminal";
  if (terminal?.kind === "archived") return "Archived";
  const integration = job.integration?.status;
  if (integration === "merged") return "Merged · verification pending";
  if (integration === "reviewing") return "Review in progress";
  if (integration === "integrating") return "Integrating";
  if (integration === "conflicted") return "Blocked · needs attention";
  if (job.status === "completed") return job.isolation.mode === "worktree" ? "Completed · unmerged" : "Completed · unverified";
  if (job.status === "needs_attention") return "Blocked · needs attention";
  if (job.status === "interrupted") return "Interrupted · recoverable";
  return job.status.charAt(0).toUpperCase() + job.status.slice(1);
}
