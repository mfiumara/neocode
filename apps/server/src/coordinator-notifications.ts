import { randomUUID } from "node:crypto";
import type { AgentJob } from "@neocode/protocol";
import type {
  CoordinatorNotificationState,
  CoordinatorWorkerEvent,
  CoordinatorWorkerEventKind,
} from "./runtime-state.js";

export interface CoordinatorNotificationHooks {
  append(event: CoordinatorWorkerEvent): void;
  /** Resolve only when the notification checkpoint is durably committed. */
  persist(): void | Promise<void>;
  isIdle(): boolean;
  /** Synchronously reserve the shared coordinator turn; undefined means busy/capacity-limited. */
  reserveTurn?(event: CoordinatorWorkerEvent): (() => void) | undefined;
  turnReleased?(): void;
  /** Invoke started only after the lifecycle prompt was accepted by the session. */
  wake(event: CoordinatorWorkerEvent, started: () => void): Promise<void>;
  /** Return the authoritative durable job, rather than a broadcast snapshot. */
  currentJob?(jobId: string): AgentJob | undefined;
}

interface WorkerSignal {
  kind: CoordinatorWorkerEventKind;
  detail?: string;
  wake: boolean;
  signature?: string;
  actionId?: string;
  actionState?: "pending" | "repairing" | "resolved" | "exhausted";
}

function signalFor(job: AgentJob): WorkerSignal | undefined {
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
      actionId: action.id,
      actionState: action.state,
    };
  }
  const transition = job.review?.transitions.at(-1);
  if (transition) {
    const handoff = transition.owner === "worker" && (transition.status === "queued" || transition.status === "handoff_received");
    const evidence = handoff && job.handoff
      ? `round=${job.handoff.round} branch=${job.handoff.branch} worktree=${job.handoff.worktree} diff=${job.handoff.diffSha256} requirements=${job.handoff.requirements.join("; ") || "not extracted"} tests=${job.handoff.tests.join("; ") || "not reported"} risks=${job.handoff.risks.join("; ") || "none reported"} report=${job.handoff.report}`
      : `${transition.owner || "server"}:${transition.status} ${transition.detail || ""}`;
    return { kind: handoff ? "handoff" : "lifecycle_transition", detail: evidence, wake: handoff };
  }
  if (job.status === "failed") return { kind: "failed", detail: job.error, wake: true };
  if (job.status === "needs_attention") return { kind: "needs_attention", detail: job.recoveryIssue || job.error, wake: true };
  return undefined;
}

function signatureFor(job: AgentJob, signal: WorkerSignal): string {
  const lastTransition = job.review?.transitions.at(-1);
  return signal.signature || (lastTransition
    ? `${signal.kind}:${lastTransition.status}:${lastTransition.at}:${lastTransition.owner || "server"}`
    : `${signal.kind}:${job.updatedAt}`);
}

function backlogSignature(job: AgentJob): string {
  const action = job.review?.remediation?.actions.find((entry) => entry.id === job.review?.remediation?.currentActionId);
  return ["priority-v2", job.status, job.updatedAt, job.completion?.head, job.review?.status,
    job.review?.transitions.at(-1)?.at, action?.id, action?.state, job.integration?.status].join(":");
}

function backlogWakeCurrent(job: AgentJob): boolean {
  if (job.isolation.mode !== "worktree" || job.integration?.status === "merged" || job.integration?.status === "superseded") return false;
  if (job.status === "interrupted") return job.recoverable === true;
  if (job.status === "needs_attention") return true;
  if (job.status !== "completed" || job.review?.status === "merged") return false;
  return !new Set(["ci_running", "judging", "merge_queued", "merging", "post_merge_ci"]).has(job.review?.status || "");
}

function concise(value: string | undefined, limit = 240): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function legacyActionId(event: CoordinatorWorkerEvent): string | undefined {
  if (event.actionId) return event.actionId;
  try {
    const outer = JSON.parse(event.text.slice(event.text.indexOf("{"))) as { detail?: string };
    if (!outer.detail) return undefined;
    return (JSON.parse(outer.detail) as { actionId?: string }).actionId;
  } catch { return undefined; }
}

export class CoordinatorNotificationQueue {
  private draining = false;
  private persistenceBlocked = false;
  private activeEventId?: string;
  private settlement?: Promise<void>;
  private releaseTurn?: () => void;
  private stopped = false;
  private drainRun?: Promise<void>;
  private suppressNextDrain = false;
  private readonly persistenceRuns = new Set<Promise<void>>();

  constructor(
    readonly state: CoordinatorNotificationState,
    private readonly hooks: CoordinatorNotificationHooks,
  ) {
    this.state.settledEventIds ??= {};
    // Upgrade old durable rows into the permanent idempotency checkpoint.
    for (const event of state.events) {
      if (event.wakeState === "delivered" || event.wakeDeliveredAt !== undefined) {
        this.state.settledEventIds[event.id] ??= event.wakeDeliveredAt || event.createdAt;
      }
    }
  }

  observe(snapshot: AgentJob): boolean {
    // Broadcasts and reconnect snapshots are hints only. Classification always
    // uses the current durable aggregate, so an old pending action cannot undo
    // a repairing/resolved action.
    const job = this.hooks.currentJob?.(snapshot.id) || snapshot;
    const signal = signalFor(job);
    if (!signal) return false;
    const signature = signatureFor(job, signal);
    if (this.state.lastSignals[job.id] === signature) return false;
    this.state.lastSignals[job.id] = signature;
    const eventId = randomUUID();
    const payload = {
      eventId,
      jobId: job.id,
      title: job.title,
      state: signal.kind,
      ...(signal.detail ? { detail: signal.detail } : {}),
    };
    const event: CoordinatorWorkerEvent = {
      id: eventId,
      jobId: job.id,
      kind: signal.kind,
      text: `[worker_status] ${JSON.stringify(payload)}`,
      summary: signal.kind === "action_required"
        ? "Action required — review diagnostics and evidence"
        : concise(signal.detail) || signal.kind.replaceAll("_", " "),
      title: job.title,
      createdAt: Date.now(),
      messageId: randomUUID(),
      wakeRequested: signal.wake,
      wakeState: signal.wake ? "pending" : undefined,
      signalSignature: signature,
      actionId: signal.actionId,
      actionState: signal.actionState,
    };
    this.enqueue(event);
    return true;
  }

  /** Queue one durable autonomous review for a stable backlog state. */
  requestBacklogSweep(snapshot: AgentJob): boolean {
    const job = this.hooks.currentJob?.(snapshot.id) || snapshot;
    const signature = backlogSignature(job);
    const key = `backlog:${job.id}`;
    if (this.state.lastSignals[key] === signature) return false;
    this.state.lastSignals[key] = signature;
    const eventId = randomUUID();
    const payload = {
      eventId,
      jobId: job.id,
      title: job.title,
      state: "backlog_sweep",
      detail: `status=${job.status} review=${job.review?.status || "none"} integration=${job.integration?.status || "none"} branch=${job.branch} worktree=${job.isolation.path}`,
    };
    this.enqueue({
      id: eventId,
      jobId: job.id,
      kind: "backlog_sweep",
      text: `[worker_status] ${JSON.stringify(payload)}`,
      summary: concise(payload.detail) || "backlog sweep",
      title: job.title,
      createdAt: Date.now(),
      messageId: randomUUID(),
      wakeRequested: true,
      wakeState: "pending",
      signalSignature: signature,
    });
    return true;
  }

  private enqueue(event: CoordinatorWorkerEvent): void {
    // A restored/corrupt duplicate row with the same stable id never creates a
    // second transcript entry or model turn.
    if (this.state.events.some((entry) => entry.id === event.id) || this.state.settledEventIds?.[event.id]) return;
    this.state.events.push(event);
    while (this.state.events.length > 500) {
      const removable = this.state.events.findIndex((entry) => !entry.wakeRequested || this.isSettled(entry));
      if (removable < 0) break;
      this.state.events.splice(removable, 1);
    }
    this.hooks.append(event);
    const persistence = this.persistThenDrain();
    this.persistenceRuns.add(persistence);
    void persistence.finally(() => this.persistenceRuns.delete(persistence));
  }

  private async persistThenDrain(): Promise<void> {
    try {
      await this.hooks.persist();
    } catch {
      this.persistenceBlocked = true;
      return;
    }
    this.requestDrain();
  }

  private requestDrain(): void {
    if (this.stopped || this.drainRun) return;
    const run = this.drain();
    this.drainRun = run;
    void run.finally(() => {
      if (this.drainRun === run) this.drainRun = undefined;
      const suppressed = this.suppressNextDrain;
      this.suppressNextDrain = false;
      if (!this.stopped && !suppressed && !this.persistenceBlocked && this.hasPendingWake() && this.hooks.isIdle()) this.requestDrain();
    });
  }

  hasPendingWake(): boolean {
    return this.state.events.some((entry) => entry.wakeRequested && !this.isSettled(entry));
  }

  /** Called only from Pi's agent_settled event, never as a startup poll. */
  agentSettled(): void {
    const event = this.activeEventId && this.state.events.find((entry) => entry.id === this.activeEventId);
    if (event && !this.isSettled(event)) {
      this.settlement ??= this.commitSettlement(event);
      void this.settlement.then(() => this.requestDrain(), () => undefined);
    } else this.requestDrain();
  }

  settled(): void { this.requestDrain(); }

  /** Stop new work and resolve only after every already-owned continuation settles. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.releaseReservation(false);
    while (this.drainRun || this.settlement || this.persistenceRuns.size) {
      await Promise.allSettled([
        ...this.persistenceRuns,
        ...(this.drainRun ? [this.drainRun] : []),
        ...(this.settlement ? [this.settlement] : []),
      ]);
    }
  }

  private releaseReservation(notify = true): void {
    const release = this.releaseTurn;
    this.releaseTurn = undefined;
    if (!release) return;
    release();
    if (notify) this.hooks.turnReleased?.();
  }

  private isSettled(event: CoordinatorWorkerEvent): boolean {
    return this.state.settledEventIds?.[event.id] !== undefined
      || event.wakeState === "delivered" || event.wakeDeliveredAt !== undefined;
  }

  private isCurrent(event: CoordinatorWorkerEvent): boolean {
    if (!this.hooks.currentJob) return true;
    const job = this.hooks.currentJob(event.jobId);
    if (!job) return false;
    if (event.kind === "action_required") {
      const actionId = legacyActionId(event);
      const current = job.review?.remediation?.actions.find((entry) => entry.id === job.review?.remediation?.currentActionId);
      return !!actionId && current?.id === actionId && current.state === "pending";
    }
    if (event.kind === "backlog_sweep") {
      return event.signalSignature ? backlogSignature(job) === event.signalSignature : backlogWakeCurrent(job);
    }
    if (event.signalSignature) {
      const signal = signalFor(job);
      return !!signal && signatureFor(job, signal) === event.signalSignature;
    }
    // Legacy rows predate source signatures. Reclassify their wake kind from
    // current durable state instead of trusting historical payload metadata.
    if (event.kind === "failed") return job.status === "failed";
    if (event.kind === "needs_attention") return job.status === "needs_attention";
    if (event.kind === "handoff") return signalFor(job)?.kind === "handoff";
    return false;
  }

  private async commitSettlement(event: CoordinatorWorkerEvent): Promise<void> {
    const deliveredAt = Date.now();
    event.wakeState = "delivered";
    event.wakeDeliveredAt = deliveredAt;
    this.state.settledEventIds ??= {};
    this.state.settledEventIds[event.id] = deliveredAt;
    try {
      await this.hooks.persist();
    } catch (error) {
      // Never spin another model turn in this process after an acknowledgement
      // failure. The old durable claim remains eligible after a true restart.
      this.persistenceBlocked = true;
      throw error;
    }
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining || this.persistenceBlocked || !this.hooks.isIdle()) return;
    const event = this.state.events.find((entry) => entry.wakeRequested && !this.isSettled(entry));
    if (!event) return;
    this.draining = true;
    let wakeFailed = false;
    let reservationBlocked = false;
    try {
      if (!this.isCurrent(event)) {
        // Keep text/raw evidence byte-for-byte intact; only settle its obsolete
        // wake after comparing with the authoritative job/action aggregate.
        await this.commitSettlement(event);
        return;
      }

      // Turn ownership is synchronous and precedes the first asynchronous claim
      // write, so a queued user prompt cannot enter Pi during this TOCTOU window.
      const reservation = this.hooks.reserveTurn?.(event);
      if (this.hooks.reserveTurn && !reservation) {
        reservationBlocked = true;
        return;
      }
      this.releaseTurn = reservation || (() => undefined);
      if (!this.isCurrent(event)) {
        await this.commitSettlement(event);
        return;
      }
      event.wakeState = "claimed";
      event.wakeClaimedAt = Date.now();
      try {
        await this.hooks.persist();
      } catch {
        this.persistenceBlocked = true;
        return;
      }
      if (this.stopped) return;

      // The action may advance while the durable claim flush is blocked. The
      // authoritative re-read immediately before prompt() closes that gap.
      if (!this.isCurrent(event)) {
        await this.commitSettlement(event);
        return;
      }

      try {
        await this.hooks.wake(event, () => { this.activeEventId = event.id; });
        if (this.activeEventId !== event.id) throw new Error("Lifecycle wake was rejected before it started");
        this.settlement ??= this.commitSettlement(event);
        await this.settlement;
      } catch {
        wakeFailed = true;
        if (this.settlement) await this.settlement;
        else {
          // A rejected-before-start wake cannot be acknowledged by an unrelated
          // agent_settled event. Restore redelivery eligibility durably.
          event.wakeState = "pending";
          delete event.wakeClaimedAt;
          try { await this.hooks.persist(); } catch { this.persistenceBlocked = true; }
        }
      } finally {
        this.activeEventId = undefined;
        this.settlement = undefined;
      }
    } catch {
      // Settlement persistence failures deliberately stop live retries. A
      // restart from the last committed checkpoint remains redeliverable.
      this.persistenceBlocked = true;
    } finally {
      this.releaseReservation();
      this.draining = false;
      // The tracked drain wrapper starts the next pending event only after this
      // run has fully released its reservation and cleared drainRun. A failed
      // wake remains pending for a later external settled()/restart trigger.
      this.suppressNextDrain = wakeFailed || reservationBlocked;
    }
  }
}
