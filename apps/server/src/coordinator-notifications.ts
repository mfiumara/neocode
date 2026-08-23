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

function signalFor(job: AgentJob): { kind: CoordinatorWorkerEventKind; detail?: string; wake: boolean; signature?: string } | undefined {
  const remediation = job.review?.remediation;
  const action = remediation?.actions.find((entry) => entry.id === remediation.currentActionId);
  if (action && (action.state === "pending" || action.state === "exhausted")) {
    return {
      kind: "action_required",
      detail: JSON.stringify({
        actionId: action.id, failureClass: action.failureClass, fingerprint: action.fingerprint,
        state: action.state, attempt: action.attempt, maxAttempts: action.maxAttempts,
        evidence: action.evidence, worktree: job.isolation.path, branch: job.branch,
      }),
      wake: action.state === "pending",
      signature: `action_required:${action.id}:${action.state}`,
    };
  }
  const transition = job.review?.transitions.at(-1);
  if (transition) {
    const handoff = transition.owner === "worker" && (transition.status === "queued" || transition.status === "handoff_received");
    const evidence = handoff && job.handoff
      ? `round=${job.handoff.round} branch=${job.handoff.branch} diff=${job.handoff.diffSha256} tests=${job.handoff.tests.join("; ") || "not reported"} risks=${job.handoff.risks.join("; ") || "none reported"} report=${job.handoff.report}`
      : `${transition.owner || "server"}:${transition.status} ${transition.detail || ""}`;
    return { kind: handoff ? "handoff" : "lifecycle_transition", detail: evidence, wake: handoff };
  }
  if (job.status === "failed") return { kind: "failed", detail: job.error, wake: true };
  if (job.status === "needs_attention") return { kind: "needs_attention", detail: job.recoveryIssue || job.error, wake: true };
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
    const lastTransition = job.review?.transitions.at(-1);
    const signature = signal.signature || (lastTransition
      ? `${signal.kind}:${lastTransition.status}:${lastTransition.at}:${lastTransition.owner || "server"}`
      : `${signal.kind}:${job.updatedAt}`);
    if (this.state.lastSignals[job.id] === signature) return false;
    this.state.lastSignals[job.id] = signature;
    const eventId = randomUUID();
    const payload = {
      eventId,
      jobId: job.id,
      title: job.title,
      state: signal.kind,
      ...(signal.detail ? { detail: signal.kind === "action_required" ? signal.detail : concise(signal.detail) } : {}),
    };
    const event: CoordinatorWorkerEvent = {
      id: eventId,
      jobId: job.id,
      kind: signal.kind,
      text: `[worker_status] ${JSON.stringify(payload)}`,
      createdAt: Date.now(),
      messageId: randomUUID(),
      wakeRequested: signal.wake,
      wakeState: signal.wake ? "pending" : undefined,
    };
    this.state.events.push(event);
    // Bound delivered history only. An action-required wake may never be
    // discarded merely because the coordinator stayed busy for a long time.
    while (this.state.events.length > 500) {
      const removable = this.state.events.findIndex((entry) => !entry.wakeRequested || entry.wakeState === "delivered" || entry.wakeDeliveredAt !== undefined);
      if (removable < 0) break;
      this.state.events.splice(removable, 1);
    }
    this.hooks.append(event);
    this.hooks.persist();
    void this.drain();
    return true;
  }

  settled(): void { void this.drain(); }

  private async drain(): Promise<void> {
    if (this.draining || !this.hooks.isIdle()) return;
    const event = this.state.events.find((entry) => entry.wakeRequested
      && entry.wakeState !== "delivered" && entry.wakeDeliveredAt === undefined);
    if (!event) return;
    this.draining = true;
    // Persist only a claim before the external side effect. If the process
    // crashes here, restart redelivers the same stable event id; completion is
    // persisted only after wake resolves.
    event.wakeState = "claimed";
    event.wakeClaimedAt = Date.now();
    this.hooks.persist();
    let delivered = false;
    try {
      await this.hooks.wake(event);
      event.wakeState = "delivered";
      event.wakeDeliveredAt = Date.now();
      this.hooks.persist();
      delivered = true;
    } catch {
      event.wakeState = "pending";
      delete event.wakeClaimedAt;
      this.hooks.persist();
    } finally {
      this.draining = false;
      if (delivered && this.hooks.isIdle()) void this.drain();
    }
  }
}
