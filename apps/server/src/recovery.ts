import type { AgentJob } from "@neocode/protocol";

export interface RecoveryConfig {
  maxRetries: number;
  backoffMs: number;
  maxBackoffMs: number;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function recoveryConfig(env: NodeJS.ProcessEnv = process.env): RecoveryConfig {
  return {
    maxRetries: nonNegativeInteger(env.NEOCODE_WORKER_RESTART_MAX_RETRIES, 3),
    backoffMs: nonNegativeInteger(env.NEOCODE_WORKER_RESTART_BACKOFF_MS, 1_000),
    maxBackoffMs: nonNegativeInteger(env.NEOCODE_WORKER_RESTART_MAX_BACKOFF_MS, 30_000),
  };
}

export function retryDelay(config: RecoveryConfig, retryCount: number): number {
  return Math.min(config.maxBackoffMs, config.backoffMs * 2 ** Math.max(0, retryCount - 1));
}

export function isClearlyReadOnlyRoot(job: AgentJob): boolean {
  // Auto only selects root for tasks accepted by the conservative read-only
  // classifier. Explicit root is shared/mutating unless a human resumes it.
  return job.isolation.mode === "root" && job.isolation.requested === "auto";
}

export function canAutomaticallyResume(job: AgentJob): boolean {
  if (job.status !== "interrupted" || !job.recoverable || job.recoveryIssue) return false;
  return job.isolation.mode === "worktree" || isClearlyReadOnlyRoot(job);
}

export interface RecoverySessionChoice<T> {
  manager: T;
  mode: "opened" | "fresh_fallback";
  reopened: boolean;
}

export function openRecoverySession<T>(
  previousSessionSupported: boolean,
  openPrevious: () => T,
  createFresh: () => T,
): RecoverySessionChoice<T> {
  if (previousSessionSupported) {
    try {
      return { manager: openPrevious(), mode: "opened", reopened: true };
    } catch {
      // A missing, corrupt, or incompatible Pi append-only log must not make a
      // verified checkout permanently unrecoverable.
    }
  }
  return { manager: createFresh(), mode: "fresh_fallback", reopened: false };
}

export function isDurableAttemptCurrent(job: AgentJob, generation: number, token: string): boolean {
  return job.recovery?.generation === generation && job.recovery.leaseToken === token;
}

export function durableProgressSummary(job: AgentJob, limit = 6_000): string {
  const entries = job.messages
    .filter((message, index) => index > 0 || message.role !== "user")
    .slice(-10)
    .filter((message) => message.text.trim().length > 0)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`);
  const summary = [
    job.summary ? `LAST WORKER REPORT:\n${job.summary}` : "",
    entries.length ? `DURABLE TRANSCRIPT TAIL:\n${entries.join("\n\n")}` : "No durable progress messages were recorded.",
    job.diff ? `A durable diff was recorded (${job.diff.length} characters). Inspect the checkout for the current source of truth.` : "",
  ].filter(Boolean).join("\n\n");
  return summary.length > limit ? `${summary.slice(0, limit)}\n… summary truncated` : summary;
}

export function continuationPrompt(job: AgentJob, reopened: boolean): string {
  const feedback = job.review?.feedback?.at(-1);
  const common = `${feedback ? `COORDINATOR REVIEW FEEDBACK:\n${feedback}\n\n` : ""}Inspect the existing checkout, git status, diff, and prior work before acting. Preserve useful local changes; never reset, overwrite, or repeat work blindly. Continue toward the original task and run relevant checks.`;
  if (reopened) return `The Neocode backend restarted and this is a new worker attempt. The prior Pi session was reopened for context. ${common}`;
  return `The Neocode backend restarted and the prior Pi session could not be safely reopened, so this is a fresh worker session.\n\nORIGINAL TASK:\n${job.prompt}\n\nDURABLE PROGRESS SUMMARY:\n${durableProgressSummary(job)}\n\n${common}`;
}
