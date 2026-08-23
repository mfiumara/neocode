import { randomUUID } from "node:crypto";
import type { AgentJob } from "@neocode/protocol";
import type {
  CoordinatorNotificationState,
  CoordinatorWorkerEvent,
  CoordinatorWorkerEventKind,
} from "./runtime-state.js";

export interface CoordinatorNotificationHooks {
  append(event: CoordinatorWorkerEvent): void;
  persist(): void;
  isIdle(): boolean;
  wake(event: CoordinatorWorkerEvent): Promise<void>;
}

function signalFor(job: AgentJob): { kind: CoordinatorWorkerEventKind; detail?: string; wake: boolean } | undefined {
  const review = job.review;
  if (review?.status === "merged") return { kind: "merged", detail: review.mergeCommit, wake: true };
  if (review?.status === "rejected") return { kind: "review_rejected", detail: review.error || review.judge?.summary, wake: false };
  if (review?.status === "blocked") return { kind: "review_blocked", detail: review.error, wake: false };
  if (review?.status === "conflict") return { kind: "review_conflict", detail: review.error, wake: false };
  if (["failed", "ci_failed", "post_ci_failed"].includes(review?.status || "")) {
    return { kind: "review_failed", detail: review?.error, wake: false };
  }
  // Once review exists, its low-level progress must not repeatedly look like a
  // fresh completion transition.
  if (review) return undefined;
  if (job.status === "completed") return { kind: "completed", detail: job.summary, wake: true };
  if (job.status === "failed") return { kind: "failed", detail: job.error, wake: false };
  if (job.status === "needs_attention") return { kind: "needs_attention", detail: job.recoveryIssue || job.error, wake: false };
  return undefined;
}

function concise(value: string | undefined, limit = 240): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export class CoordinatorNotificationQueue {
  private draining = false;

  constructor(
    readonly state: CoordinatorNotificationState,
    private readonly hooks: CoordinatorNotificationHooks,
  ) {}

  observe(job: AgentJob): boolean {
    const signal = signalFor(job);
    if (!signal) return false;
    const signature = `${signal.kind}:${job.review?.updatedAt || job.updatedAt}`;
    if (this.state.lastSignals[job.id] === signature) return false;
    this.state.lastSignals[job.id] = signature;
    const eventId = randomUUID();
    const payload = {
      eventId,
      jobId: job.id,
      title: job.title,
      state: signal.kind,
      ...(concise(signal.detail) ? { detail: concise(signal.detail) } : {}),
    };
    const event: CoordinatorWorkerEvent = {
      id: eventId,
      jobId: job.id,
      kind: signal.kind,
      text: `[worker_status] ${JSON.stringify(payload)}`,
      createdAt: Date.now(),
      messageId: randomUUID(),
      wakeRequested: signal.wake,
    };
    this.state.events.push(event);
    // Keep exactly-once identities bounded while retaining ample restart history.
    if (this.state.events.length > 500) this.state.events.splice(0, this.state.events.length - 500);
    this.hooks.append(event);
    this.hooks.persist();
    void this.drain();
    return true;
  }

  settled(): void { void this.drain(); }

  private async drain(): Promise<void> {
    if (this.draining || !this.hooks.isIdle()) return;
    const event = this.state.events.find((entry) => entry.wakeRequested && !entry.wakeDeliveredAt);
    if (!event) return;
    this.draining = true;
    // Persist the delivery claim before the external model side effect. A
    // restart can therefore never issue the same wake twice.
    event.wakeDeliveredAt = Date.now();
    this.hooks.persist();
    try {
      await this.hooks.wake(event);
    } catch {
      // The structured transcript event is already delivered. Keep the durable
      // claim to avoid duplicate model chatter if the process restarts.
    } finally {
      this.draining = false;
      if (this.hooks.isIdle()) void this.drain();
    }
  }
}
