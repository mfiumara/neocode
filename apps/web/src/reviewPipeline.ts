import type { AgentJob, JudgeEvidence, RemediationFailureClass, ReviewStatus } from "@neocode/protocol";

export type PipelineTone = "waiting" | "active" | "complete" | "failed" | "blocked";
export interface ReviewPipelineStage {
  id: "handoff" | "preparation" | "ci" | "judge" | "repair" | "merge" | "verification";
  label: string;
  summary: string;
  tone: PipelineTone;
  at?: number;
  /** Only populated from bounded durable timestamps/evidence, never a client clock. */
  durationMs?: number;
}
export interface ReviewPipeline { headline: string; guidance: string; active: boolean; stages: ReviewPipelineStage[] }

const rank: Record<ReviewStatus, number> = {
  handoff_received: 1, queued: 1, ci_running: 2, ci_failed: 2, judging: 3,
  rejected: 3, feedback_sent: 4, worker_resumed: 4, approved: 5,
  merge_queued: 5, merging: 5, conflict: 5, post_merge_ci: 6,
  post_ci_failed: 6, merged: 7, blocked: 0, failed: 0, needs_attention: 0,
};

function transitionAt(job: AgentJob, statuses: ReviewStatus[]): number | undefined {
  return job.review?.transitions.filter((item) => statuses.includes(item.status)).at(-1)?.at;
}
function transitionDuration(job: AgentJob, start: ReviewStatus[], finish: ReviewStatus[]): number | undefined {
  const startedAt = transitionAt(job, start);
  if (startedAt === undefined) return undefined;
  const finishedAt = job.review?.transitions.find((item) => item.at >= startedAt && finish.includes(item.status))?.at;
  return finishedAt === undefined ? undefined : Math.max(0, finishedAt - startedAt);
}
function isProductCheck(command: string): boolean {
  return /^(?:npm test|npm run (?:test|check|build))$/.test(command);
}
function productChecks(job: AgentJob) {
  return (job.review?.ci || []).filter((check) => check.purpose === "product_ci" || (!check.purpose && isProductCheck(check.command)));
}
function checkSummary(checks: NonNullable<AgentJob["review"]>["ci"] = [], historical = false, queued = false): string {
  if (!checks.length) return queued ? "Product CI queued; no product command durably started" : "No product commands recorded";
  const summary = `${checks.filter((check) => check.ok).length}/${checks.length} product checks passed`;
  return historical ? `Historical prior-round evidence: ${summary}` : summary;
}

/** Current verdict authority is exact-round bound; remediation verdicts are audit history only. */
export function latestJudgeEvidence(job: AgentJob): JudgeEvidence | undefined {
  return job.review?.judge && job.handoff?.round !== undefined && job.review.judgeHandoffRound === job.handoff.round
    ? job.review.judge : undefined;
}
export function latestHistoricalJudgeEvidence(job: AgentJob): JudgeEvidence | undefined {
  const remediation = job.review?.remediation?.actions
    .filter((action) => !!action.evidence.judge)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.evidence.judge;
  return remediation || (job.review?.judge && !latestJudgeEvidence(job) ? job.review.judge : undefined);
}
function interruptedJudgeAction(job: AgentJob) {
  const action = job.review?.remediation?.actions.find((item) => item.id === job.review?.remediation?.currentActionId)
    || job.review?.remediation?.actions.find((item) => item.state !== "resolved");
  const judgingAt = transitionAt(job, ["judging"]);
  return action?.failureClass === "infrastructure" && judgingAt !== undefined && action.updatedAt >= judgingAt ? action : undefined;
}
function presentJudgeSummary(value: string): string {
  // Verdict summaries are human-authored conclusions, but providers may append
  // exact packets or diagnostics. Keep one bounded prose line and redact broad
  // technical identifier classes; the original remains in collapsed evidence.
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim() || "";
  const presented = firstLine
    .replace(/\b(?:BASE|HEAD|PARENT|TREE|DIFF|SHA(?:1|256)?)=[^\s,;]+/gi, "[technical reference]")
    .replace(/\b[0-9a-f]{40,64}\b/gi, "[reference]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[identifier]")
    .replace(/\b[a-z][a-z0-9_]*-[a-z0-9_-]{16,}\b/gi, "[identifier]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s,;:]+[\\/])*[^\s,;:]*/g, "[path]")
    .replace(/\b(?:npm|pnpm|yarn|npx|git|node|bash|sh)\s+(?:run\s+)?[^,;]+/gi, "[command]")
    .replace(/\s+/g, " ").trim();
  if (!presented) return "Conclusion recorded; open technical evidence for the exact summary";
  return presented.length <= 180 ? presented : `${presented.slice(0, 179).trimEnd()}…`;
}

function judgeSummary(job: AgentJob): string {
  const judge = latestJudgeEvidence(job);
  if (judge) return `Current ${judge.approved ? "approved" : "rejected"} conclusion — ${presentJudgeSummary(judge.summary)}`;
  if (interruptedJudgeAction(job)) return "Independent judge interrupted; coordinator recovery required";
  const historicalJudge = latestHistoricalJudgeEvidence(job);
  return historicalJudge
    ? `Latest prior-round verdict — ${historicalJudge.approved ? "approved" : "rejected"}: ${presentJudgeSummary(historicalJudge.summary)}`
    : "Independent judge has not started for this handoff round";
}

function actionSubject(failureClass: RemediationFailureClass): string {
  return ({ worker_ci: "Implementation checks", candidate_ci: "Candidate verification", judge_changes: "Independent review",
    conflict: "Integration conflict", post_merge_ci: "Post-merge verification", infrastructure: "Review infrastructure" } as Record<string, string>)[failureClass]
    || "Review";
}
function hasRebaseConflictEvidence(job: AgentJob): boolean {
  if (job.review?.status !== "conflict") return false;
  return !!job.review.remediation?.actions.some((action) => action.failureClass === "conflict")
    || /\b(?:rebase|merge)\b[^\n]*\bconflict/i.test(job.review.error || "")
    || job.review.transitions.some((item) => item.status === "conflict" && /\b(?:rebase|merge|conflict)/i.test(item.detail || ""));
}

/** Derives presentation solely from durable job/review state. */
export function reviewPipeline(job: AgentJob, activityReady = true): ReviewPipeline {
  const review = job.review;
  const status = review?.status;
  const superseded = job.integration?.status === "superseded";
  const merged = job.integration?.status === "merged" || status === "merged";
  const authoritativeTerminal = merged || superseded;
  const genuineWorker = activityReady && !authoritativeTerminal && job.status === "running";
  const action = review?.remediation?.actions.find((item) => item.id === review.remediation?.currentActionId)
    || review?.remediation?.actions.find((item) => item.state !== "resolved");
  const activeRetry = activityReady && !authoritativeTerminal && job.status === "completed" && status === "ci_running"
    && action?.state === "repairing" ? review?.activeRetry : undefined;
  const retryRound = action ? review?.remediation?.rounds[action.failureClass] : undefined;
  const scheduledRetry = !authoritativeTerminal && job.status === "completed" && action?.state === "repairing"
    && !review?.activeRetry && retryRound?.nextRetryAt !== undefined;
  const retryTarget = action?.evidence.mergeCommit ? "post_merge" : "review";
  const reviewActive = activityReady && !authoritativeTerminal && !scheduledRetry && job.status === "completed" &&
    ["ci_running", "judging", "merging", "post_merge_ci"].includes(status || "");
  const reviewRetry = activeRetry?.target === "review";
  const postMergeRetry = activeRetry?.target === "post_merge";
  const scheduledReviewRetry = scheduledRetry && retryTarget === "review";
  const scheduledPostMergeRetry = scheduledRetry && retryTarget === "post_merge";
  const handoffRound = job.handoff?.round;
  const currentRoundJudgeClaim = handoffRound !== undefined && review?.judgeHandoffRound === handoffRound
    && ["queued", "handoff_received"].includes(status || "");
  const preparedForCurrentRound = !!review?.reviewBaseRef && handoffRound !== undefined && review?.preparedHandoffRound === handoffRound;
  const allProductChecks = productChecks(job);
  const boundChecks = allProductChecks.filter((check) => handoffRound !== undefined
    && (check.handoffRound === handoffRound || (check.handoffRound === undefined && review?.ciHandoffRound === handoffRound)));
  const checks = reviewRetry || scheduledReviewRetry ? [] : boundChecks;
  const historicalChecks = allProductChecks.filter((check) => !checks.includes(check));
  const currentCiPublished = !reviewRetry && !scheduledReviewRetry && handoffRound !== undefined && review?.ciHandoffRound === handoffRound;
  const preparationRunning = status === "ci_running" && !postMergeRetry && (!preparedForCurrentRound || reviewRetry);
  const productCiRunning = reviewActive && status === "ci_running" && preparedForCurrentRound && !currentCiPublished && !activeRetry;
  const active = genuineWorker || reviewActive;
  const rebaseConflict = hasRebaseConflictEvidence(job);
  const conflictRepairing = rebaseConflict && genuineWorker;
  const conflictRepairClaimed = rebaseConflict && !genuineWorker
    && action?.failureClass === "conflict" && action.state === "repairing";
  const conflictActionRequired = rebaseConflict && action?.failureClass === "conflict" && ["pending", "exhausted"].includes(action.state);
  const freshHandoffAfterBase = !!review?.reviewBaseRef && !!job.handoff
    && ["handoff_received", "queued"].includes(status || "")
    && review?.preparedHandoffRound !== job.handoff.round;
  const targetAdvanced = !!review?.reviewBaseRef && ["handoff_received", "queued"].includes(status || "")
    && review?.transitions.some((item) => item.status === "handoff_received"
      && /main advanced|target advanced|prior approval invalidated/i.test(item.detail || ""));
  const preparationInvalidated = freshHandoffAfterBase || targetAdvanced;

  let headline = "Awaiting worker handoff";
  let guidance = job.status === "running" ? "Worker is still preparing a handoff." : "No fresh handoff is available for coordinator review.";
  // Top-level worker and verified terminal dispositions override stale review phases.
  if (["queued", "interrupted", "needs_attention", "failed", "cancelled"].includes(job.status)) {
    headline = job.status === "queued" ? "Awaiting worker" : "Review blocked";
    guidance = job.status === "interrupted" ? action?.state === "repairing"
      ? `${actionSubject(action.failureClass)} repair is claimed but the worker is interrupted; awaiting coordinator recovery.`
      : "Worker was interrupted; coordinator action is required."
      : job.status === "needs_attention" ? action
        ? `${actionSubject(action.failureClass)} requires coordinator attention; open technical evidence for exact diagnostics.`
        : "Worker needs coordinator attention."
      : job.status === "failed" ? "Worker failed before review could continue."
      : job.status === "cancelled" ? "Worker was cancelled."
      : "Worker is queued and has not produced a fresh handoff.";
  } else if (merged) {
    headline = "Verified outcome"; guidance = "Integration is complete and verified.";
  } else if (superseded) {
    headline = "Verified outcome"; guidance = "This work is durably marked as superseded; integration is not required.";
  } else if (genuineWorker) {
    headline = review ? "Repairing now" : "Worker active";
    guidance = conflictRepairing ? "Worker is resolving a rebase conflict in the same worktree."
      : action?.state === "repairing" || status === "worker_resumed"
        ? "Worker is repairing feedback in the same worktree." : "Worker is running; awaiting a fresh handoff.";
  } else if (scheduledRetry) {
    headline = "Coordinator retry scheduled";
    guidance = scheduledPostMergeRetry
      ? "Post-merge verification retry is in backoff and awaiting serialized coordinator execution."
      : "Review prerequisite retry is in backoff; the independent judge remains queued behind coordinator execution.";
  } else if (status === "ci_running") {
    headline = activeRetry ? "Retrying now" : currentCiPublished ? "CI result recorded" : reviewActive ? "Reviewing now" : "Review status recorded";
    guidance = reviewRetry ? "Coordinator is retrying review prerequisites; independent judge is queued behind the checks."
      : postMergeRetry ? "Coordinator is retrying post-merge verification."
      : preparationRunning
      ? reviewActive ? "Coordinator Git preparation is running; product CI is queued." : "Coordinator Git preparation was recorded; live activity is unsynchronized and product CI has not durably started."
      : currentCiPublished ? checks.some((check) => !check.ok)
        ? "Product CI completed with failures; awaiting durable remediation state."
        : "Product CI completed; coordinator is preparing the next review stage."
      : reviewActive ? "Coordinator product CI is running." : "Product CI was recorded after preparation; live activity is unsynchronized.";
  } else if (status === "judging") {
    const currentJudge = latestJudgeEvidence(job);
    headline = currentJudge ? "Judge verdict recorded" : reviewActive ? "Reviewing now" : "Review status recorded";
    guidance = currentJudge ? `Independent judge ${currentJudge.approved ? "approved" : "rejected"} the current round; awaiting durable coordinator transition.`
      : reviewActive ? "Independent judge is reviewing the prepared candidate." : "Independent review was last recorded running; live activity is not confirmed.";
  } else if (status === "merging") {
    headline = reviewActive ? "Integrating now" : "Integration status recorded";
    guidance = reviewActive ? "Coordinator-authorized integration is running." : "Integration was last recorded running; live activity is not confirmed.";
  } else if (status === "post_merge_ci") {
    const postPublished = !!review?.postMergeCi?.length;
    headline = postPublished ? "Verification result recorded" : reviewActive ? "Integrating now" : "Integration status recorded";
    guidance = postPublished ? review!.postMergeCi!.some((check) => !check.ok)
      ? "Post-merge verification completed with failures; awaiting durable remediation state."
      : "Post-merge verification completed; awaiting verified terminal transition."
      : reviewActive ? "Post-merge CI is verifying the integrated result." : "Post-merge CI was last recorded running; live activity is not confirmed.";
  } else if (currentRoundJudgeClaim) {
    headline = "Independent review claimed";
    guidance = activityReady
      ? "Current handoff is claimed and awaiting judge launch or serialized coordinator execution."
      : "Current handoff remains claimed and awaits coordinator recovery after reconnect; execution is not confirmed.";
  } else if (preparationInvalidated) {
    headline = "Fresh review required"; guidance = "Target or handoff advanced; coordinator rebase and preparation plus fresh approval are required.";
  } else if (status === "queued" || status === "handoff_received" || (!review && !!job.handoff)) {
    headline = "Ready for review"; guidance = "Awaiting coordinator review; no review is currently running.";
  } else if (status === "ci_failed") {
    headline = "Review blocked"; guidance = "CI failed; repair is required before judging.";
  } else if (status === "rejected") {
    headline = "Changes requested"; guidance = "Judge rejected the candidate; feedback repair is required.";
  } else if (status === "post_ci_failed") {
    headline = "Action required"; guidance = "Post-merge CI failed; coordinator repair and verification are required.";
  } else if (status === "feedback_sent") {
    headline = "Repair requested"; guidance = "Feedback was sent; awaiting the worker repair attempt.";
  } else if (status === "worker_resumed") {
    headline = "Repairing feedback"; guidance = "Worker repair is recorded, but no live activity is currently confirmed.";
  } else if (status === "approved") {
    headline = "Approved — merge not started"; guidance = "Merge awaits explicit coordinator authorization.";
  } else if (status === "merge_queued") {
    headline = "Approved — integration queued"; guidance = "Awaiting coordinator integration; execution has not started.";
  } else if (conflictActionRequired) {
    headline = "Action required"; guidance = action!.state === "exhausted"
      ? "Rebase conflict repair attempts are exhausted; coordinator action is required."
      : "Rebase conflict repair is required; awaiting coordinator action.";
  } else if (conflictRepairing) {
    headline = "Review blocked"; guidance = "Worker is resolving an integration conflict; merge remains blocked.";
  } else if (conflictRepairClaimed) {
    headline = "Repair claimed"; guidance = "Integration conflict repair is claimed; awaiting worker resume or coordinator recovery.";
  } else if (rebaseConflict) {
    headline = "Action required"; guidance = "A rebase conflict is recorded; coordinator action is required before repair can continue.";
  } else if (["blocked", "failed", "needs_attention", "conflict"].includes(status || "")) {
    headline = action?.state === "repairing" ? "Repair claimed" : "Action required";
    guidance = action?.state === "repairing"
      ? `${actionSubject(action.failureClass)} repair is claimed; awaiting worker resume or coordinator recovery.`
      : action ? `${actionSubject(action.failureClass)} requires coordinator action before review can continue; exact diagnostics are in technical evidence.`
      : "Coordinator action is required before review can continue; exact diagnostics are in technical evidence.";
  }

  const phase = status ? rank[status] : 0;
  const post = review?.postMergeCi || [];
  const judge = latestJudgeEvidence(job);
  const preparationComplete = preparedForCurrentRound && !preparationInvalidated;
  const ciActionBlocked = ["worker_ci", "candidate_ci"].includes(action?.failureClass || "") && action?.state !== "resolved";
  const ciTone: PipelineTone = scheduledReviewRetry ? "waiting"
    : currentCiPublished ? checks.some((check) => !check.ok) ? "failed" : checks.length ? "complete" : "blocked"
    : productCiRunning ? "active"
    : status === "ci_failed" ? "failed"
    : ciActionBlocked ? "blocked"
    : phase > 2 ? "complete"
    : checks.some((check) => !check.ok) ? "failed" : "waiting";
  const reachedMerge = !!review?.coordinatorAuthorizedAt || review?.transitions.some((item) => ["approved", "merge_queued", "merging"].includes(item.status));
  const mergeBlocked = !authoritativeTerminal && (rebaseConflict
    || (["blocked", "failed", "needs_attention"].includes(status || "") && reachedMerge));

  const stages: ReviewPipelineStage[] = [
    { id: "handoff", label: "Worker handoff", summary: job.handoff ? `Received round ${job.handoff.round}` : "Awaiting fresh handoff", tone: job.handoff ? "complete" : genuineWorker ? "active" : "waiting", at: job.handoff?.createdAt },
    { id: "preparation", label: "Coordinator Git preparation", summary: reviewRetry ? "Retrying preparation and prerequisite checks" : scheduledReviewRetry ? "Review prerequisite retry scheduled after backoff" : preparationInvalidated ? "Target or handoff advanced; rebase, preparation, and fresh approval required" : preparationComplete ? "Candidate prepared on target base" : rebaseConflict ? "Rebase conflict recorded" : status === "ci_running" ? reviewActive ? "Preparing candidate on target base" : "Preparation recorded; live activity unsynchronized" : "Awaiting coordinator", tone: reviewRetry ? "active" : preparationComplete ? "complete" : rebaseConflict ? "blocked" : preparationRunning && reviewActive ? "active" : "waiting" },
    { id: "ci", label: "Product CI", summary: checks.length ? checkSummary(checks) : historicalChecks.length ? checkSummary(historicalChecks, true, preparationRunning) : productCiRunning ? "Product CI running; no completed product commands recorded" : checkSummary([], false, preparationRunning), tone: ciTone, at: preparationRunning ? undefined : transitionAt(job, ["ci_running", "ci_failed", "judging"]), durationMs: checks.length ? checks.reduce((sum, check) => sum + check.durationMs, 0) : status === "ci_running" ? undefined : transitionDuration(job, ["ci_running"], ["ci_failed", "judging"]) },
    { id: "judge", label: "Independent judge", summary: reviewRetry ? "Independent judge queued behind retry prerequisite checks" : scheduledReviewRetry ? "Independent judge queued behind scheduled retry backoff" : currentRoundJudgeClaim ? "Current handoff claimed; awaiting judge launch or serialized coordinator execution" : status === "judging" && !reviewActive && !judge && !interruptedJudgeAction(job) ? "Independent judging recorded; live activity unsynchronized" : judgeSummary(job), tone: reviewRetry || scheduledReviewRetry || currentRoundJudgeClaim ? "waiting" : status === "judging" ? judge ? judge.approved ? "complete" : "failed" : reviewActive ? "active" : "waiting" : interruptedJudgeAction(job) ? "blocked" : status === "rejected" || judge?.approved === false ? "failed" : judge?.approved ? "complete" : "waiting", at: transitionAt(job, ["judging", "approved", "rejected"]), durationMs: status === "judging" ? undefined : transitionDuration(job, ["judging"], ["approved", "rejected"]) },
    { id: "repair", label: "Feedback and repair", summary: scheduledRetry ? `Coordinator retry backoff · ${action!.attempt}/${action!.maxAttempts}` : action ? `${action.failureClass.replaceAll("_", " ")} · ${action.state} · ${action.attempt}/${action.maxAttempts}` : status === "feedback_sent" ? "Feedback sent; awaiting worker" : "No active repair", tone: genuineWorker && !!review ? "active" : action?.state === "pending" || action?.state === "exhausted" ? "blocked" : action?.state === "resolved" ? "complete" : "waiting", at: action?.updatedAt, durationMs: action ? Math.max(0, action.updatedAt - action.createdAt) : undefined },
    { id: "merge", label: "Authorized merge", summary: superseded ? "Integration not required" : review?.mergeCommit ? "Merge recorded" : review?.coordinatorAuthorizedAt ? "Explicitly authorized" : status === "approved" || status === "merge_queued" ? "Awaiting explicit coordinator authorization" : "Not authorized", tone: superseded || review?.mergeCommit ? "complete" : status === "merging" && reviewActive ? "active" : mergeBlocked ? "blocked" : "waiting", at: review?.coordinatorAuthorizedAt || transitionAt(job, ["approved", "merge_queued", "merging"]), durationMs: transitionDuration(job, ["merging"], ["post_merge_ci", "merged", "blocked", "failed"]) },
    { id: "verification", label: "Post-merge verification", summary: merged ? "Verified terminal outcome" : superseded ? "Superseded terminal outcome" : postMergeRetry ? "Retrying post-merge verification; prior evidence retained as historical" : scheduledPostMergeRetry ? "Post-merge verification retry scheduled after backoff; prior evidence retained as historical" : post.length ? `${post.filter((item) => item.ok).length}/${post.length} post-merge checks passed` : "Not started", tone: authoritativeTerminal ? "complete" : postMergeRetry ? "active" : scheduledPostMergeRetry ? "waiting" : status === "post_merge_ci" ? post.length ? post.some((check) => !check.ok) ? "failed" : "complete" : reviewActive ? "active" : "waiting" : (!!post.length && post.every((check) => check.ok)) ? "complete" : status === "post_ci_failed" ? "failed" : action?.failureClass === "post_merge_ci" && action.state !== "resolved" ? "blocked" : "waiting", at: job.integration?.verifiedAt || transitionAt(job, ["post_merge_ci", "post_ci_failed", "merged"]), durationMs: post.length ? post.reduce((sum, check) => sum + check.durationMs, 0) : transitionDuration(job, ["post_merge_ci"], ["post_ci_failed", "merged"]) },
  ];
  return { headline, guidance, active, stages };
}
