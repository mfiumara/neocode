import type { AgentJob, ReviewStatus } from "@neocode/protocol";

export type PipelineTone = "waiting" | "active" | "complete" | "failed" | "blocked";
export interface ReviewPipelineStage {
  id: "handoff" | "preparation" | "ci" | "judge" | "repair" | "merge" | "verification";
  label: string;
  summary: string;
  tone: PipelineTone;
  at?: number;
}
export interface ReviewPipeline {
  headline: string;
  guidance: string;
  active: boolean;
  stages: ReviewPipelineStage[];
}

const rank: Record<ReviewStatus, number> = {
  handoff_received: 1, queued: 1, ci_running: 2, ci_failed: 2, judging: 3,
  rejected: 3, feedback_sent: 4, worker_resumed: 4, approved: 5,
  merge_queued: 5, merging: 5, conflict: 5, post_merge_ci: 6,
  post_ci_failed: 6, merged: 7, blocked: 0, failed: 0, needs_attention: 0,
};

function transitionAt(job: AgentJob, statuses: ReviewStatus[]): number | undefined {
  return job.review?.transitions.filter((item) => statuses.includes(item.status)).at(-1)?.at;
}

function checkSummary(job: AgentJob): string {
  const checks = job.review?.ci || [];
  if (!checks.length) return "Product checks have not started";
  const passed = checks.filter((check) => check.ok).length;
  return `${passed}/${checks.length} product checks passed`;
}

function judgeSummary(job: AgentJob): string {
  const judge = job.review?.judge;
  if (!judge) return "Independent judge has not started";
  return `${judge.approved ? "Approved" : "Rejected"}: ${judge.summary}`;
}

/** Derives presentation solely from durable job/review state. */
export function reviewPipeline(job: AgentJob, activityReady = true): ReviewPipeline {
  const review = job.review;
  const status = review?.status;
  const authoritativeTerminal = job.integration?.status === "merged" || job.integration?.status === "superseded" || status === "merged";
  const genuineWorker = activityReady && !authoritativeTerminal && job.status === "running";
  const reviewActive = activityReady && !authoritativeTerminal && job.status === "completed" &&
    ["ci_running", "judging", "merging", "post_merge_ci"].includes(status || "");
  const active = genuineWorker || reviewActive;

  let headline = "Awaiting worker handoff";
  let guidance = job.status === "running" ? "Worker is still preparing a handoff." : "No fresh handoff is available for coordinator review.";

  // Top-level terminal dispositions override stale review phases.
  if (["queued", "interrupted", "needs_attention", "failed", "cancelled"].includes(job.status)) {
    headline = job.status === "queued" ? "Awaiting worker" : "Review blocked";
    guidance = job.status === "interrupted" ? "Worker was interrupted; coordinator action is required."
      : job.status === "needs_attention" ? "Worker needs coordinator attention."
      : job.status === "failed" ? "Worker failed before review could continue."
      : job.status === "cancelled" ? "Worker was cancelled."
      : "Worker is queued and has not produced a fresh handoff.";
  } else if (job.integration?.status === "merged" || status === "merged") {
    headline = "Verified outcome";
    guidance = "Integration is complete and verified.";
  } else if (job.integration?.status === "superseded") {
    headline = "Verified outcome";
    guidance = "This work is durably marked as superseded; integration is not required.";
  } else if (genuineWorker) {
    headline = review ? "Repairing now" : "Worker active";
    guidance = review?.remediation?.actions.some((item) => item.state === "repairing") || status === "worker_resumed"
      ? "Worker is repairing feedback in the same worktree."
      : "Worker is running; awaiting a fresh handoff.";
  } else if (job.integration?.status === "conflicted" || status === "conflict") {
    headline = "Review blocked";
    guidance = "Worker is resolving a rebase conflict; merge remains blocked.";
  } else if (status === "ci_running") {
    headline = reviewActive ? "Reviewing now" : "Review status recorded";
    guidance = reviewActive ? "Coordinator product CI is running." : "Product CI was last recorded running; live activity is not confirmed.";
  } else if (status === "judging") {
    headline = reviewActive ? "Reviewing now" : "Review status recorded";
    guidance = reviewActive ? "Independent judge is reviewing the prepared candidate." : "Independent review was last recorded running; live activity is not confirmed.";
  } else if (status === "merging") {
    headline = reviewActive ? "Integrating now" : "Integration status recorded";
    guidance = reviewActive ? "Coordinator-authorized integration is running." : "Integration was last recorded running; live activity is not confirmed.";
  } else if (status === "post_merge_ci") {
    headline = reviewActive ? "Integrating now" : "Integration status recorded";
    guidance = reviewActive ? "Post-merge CI is verifying the integrated result." : "Post-merge CI was last recorded running; live activity is not confirmed.";
  } else if (status === "queued" || status === "handoff_received" || (!review && !!job.handoff)) {
    headline = "Ready for review"; guidance = "Awaiting coordinator review; no review is currently running.";
  } else if (status === "ci_failed") {
    headline = "Review blocked"; guidance = "CI failed; repair is required before judging.";
  } else if (status === "rejected") {
    headline = "Changes requested"; guidance = "Judge rejected the candidate; feedback repair is required.";
  } else if (status === "feedback_sent") {
    headline = "Repair requested"; guidance = "Feedback was sent; awaiting the worker repair attempt.";
  } else if (status === "worker_resumed") {
    headline = "Repairing feedback"; guidance = "Worker repair is recorded, but no live activity is currently confirmed.";
  } else if (status === "approved") {
    headline = "Approved — merge not started"; guidance = "Merge awaits explicit coordinator authorization.";
  } else if (status === "merge_queued") {
    headline = "Approved — integration queued"; guidance = "Awaiting coordinator integration; execution has not started.";
  } else if (status === "post_ci_failed") {
    headline = "Action required"; guidance = "Post-merge CI failed; coordinator repair and verification are required.";
  } else if (["blocked", "failed", "needs_attention"].includes(status || "")) {
    headline = "Action required";
    guidance = review?.error ? "Review is blocked; open technical evidence for the recorded reason." : "Coordinator action is required before review can continue.";
  }

  const phase = status ? rank[status] : 0;
  const terminal = job.integration?.status === "merged" || status === "merged";
  const handoffComplete = !!job.handoff;
  const ciFailed = status === "ci_failed" || !!review?.ci?.some((check) => !check.ok);
  const repairAction = review?.remediation?.actions.find((item) => item.id === review.remediation?.currentActionId)
    || review?.remediation?.actions.find((item) => item.state !== "resolved");
  const post = review?.postMergeCi || [];
  const postPassed = !!post.length && post.every((check) => check.ok);

  const stages: ReviewPipelineStage[] = [
    { id: "handoff", label: "Worker handoff", summary: handoffComplete ? `Received round ${job.handoff!.round}` : "Awaiting fresh handoff", tone: handoffComplete ? "complete" : genuineWorker ? "active" : "waiting", at: job.handoff?.createdAt },
    { id: "preparation", label: "Coordinator Git preparation", summary: review?.reviewBaseRef ? "Candidate prepared on target base" : phase >= 2 ? "Preparation recorded by later review stage" : "Awaiting coordinator", tone: phase >= 2 || !!review?.reviewBaseRef ? "complete" : status === "conflict" || job.integration?.status === "conflicted" ? "blocked" : "waiting", at: transitionAt(job, ["queued", "ci_running"]) },
    { id: "ci", label: "Product CI", summary: checkSummary(job), tone: ciFailed ? "failed" : status === "ci_running" && reviewActive ? "active" : phase > 2 ? "complete" : "waiting", at: transitionAt(job, ["ci_running", "ci_failed", "judging"]) },
    { id: "judge", label: "Independent judge", summary: judgeSummary(job), tone: status === "judging" && reviewActive ? "active" : status === "rejected" ? "failed" : review?.judge?.approved ? "complete" : "waiting", at: transitionAt(job, ["judging", "approved", "rejected"]) },
    { id: "repair", label: "Feedback and repair", summary: repairAction ? `${repairAction.failureClass.replaceAll("_", " ")} · ${repairAction.state} · ${repairAction.attempt}/${repairAction.maxAttempts}` : status === "feedback_sent" ? "Feedback sent; awaiting worker" : "No active repair", tone: genuineWorker && !!review ? "active" : repairAction?.state === "exhausted" ? "blocked" : repairAction?.state === "resolved" ? "complete" : repairAction ? "waiting" : "waiting", at: repairAction?.updatedAt },
    { id: "merge", label: "Authorized merge", summary: review?.mergeCommit ? "Merge recorded" : review?.coordinatorAuthorizedAt ? "Explicitly authorized" : status === "approved" || status === "merge_queued" ? "Awaiting explicit coordinator authorization" : "Not authorized", tone: status === "merging" && reviewActive ? "active" : review?.mergeCommit ? "complete" : status === "conflict" ? "blocked" : "waiting", at: review?.coordinatorAuthorizedAt || transitionAt(job, ["approved", "merge_queued", "merging"]) },
    { id: "verification", label: "Post-merge verification", summary: terminal ? "Verified terminal outcome" : post.length ? `${post.filter((item) => item.ok).length}/${post.length} post-merge checks passed` : "Not started", tone: terminal || postPassed ? "complete" : status === "post_ci_failed" ? "failed" : status === "post_merge_ci" && reviewActive ? "active" : "waiting", at: job.integration?.verifiedAt || transitionAt(job, ["post_merge_ci", "post_ci_failed", "merged"]) },
  ];
  return { headline, guidance, active, stages };
}
