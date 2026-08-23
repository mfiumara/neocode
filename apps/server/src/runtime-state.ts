import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentActivity, AgentJob, MaintenanceStatus, PromptSettlementSnapshot, TranscriptMessage } from "@neocode/protocol";


export const RUNTIME_STATE_VERSION = 2;

export interface DurableJob {
  job: AgentJob;
  piSessionFile?: string;
}

export type CoordinatorWorkerEventKind =
  | "handoff" | "lifecycle_transition" | "action_required" | "failed" | "needs_attention" | "backlog_sweep";

export interface CoordinatorWorkerEvent {
  id: string;
  jobId: string;
  kind: CoordinatorWorkerEventKind;
  text: string;
  /** Concise UI text stored alongside, never instead of, raw event evidence. */
  summary?: string;
  title?: string;
  createdAt: number;
  messageId: string;
  wakeRequested: boolean;
  /** Durable at-least-once delivery state; claimed events are redelivered after restart. */
  wakeState?: "pending" | "claimed" | "delivered";
  wakeClaimedAt?: number;
  wakeDeliveredAt?: number;
  /** Durable source-state correlation used to reject stale broadcasts at wake time. */
  signalSignature?: string;
  /** Original remediation classification; raw text remains immutable audit evidence. */
  actionId?: string;
  actionState?: "pending" | "repairing" | "resolved" | "exhausted";
}

export interface CoordinatorNotificationState {
  events: CoordinatorWorkerEvent[];
  lastSignals: Record<string, string>;
  /** Permanent exactly-once settlement checkpoint keyed by stable event id. */
  settledEventIds?: Record<string, number>;
}

export interface DurableCoordinatorPrompt {
  messageId: string;
  context: string[];
  mode: "build" | "plan";
  createdAt: number;
  state: "queued" | "processing" | "responded";
  /** Durable correlation checkpoint written with the completed assistant turn. */
  responseMessageId?: string;
  responseCompletedAt?: number;
}

export interface DurableRuntimeState {
  version: typeof RUNTIME_STATE_VERSION;
  workspaceRoot: string;
  updatedAt: number;
  coordinator: {
    messages: TranscriptMessage[];
    activity?: AgentActivity;
    activityHistory?: AgentActivity[];
    piSessionFile?: string;
    /** Prompts accepted by the server but not yet settled by the coordinator. */
    pendingPrompts?: DurableCoordinatorPrompt[];
    promptSettlement?: PromptSettlementSnapshot;
  };
  maintenance?: MaintenanceStatus;
  coordinatorNotifications?: CoordinatorNotificationState;
  jobs: DurableJob[];
}

/** Runtime data is versioned so future schema migrations remain isolated. */
export function runtimeRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".neocode", "runtime", "server-v1");
}

export function runtimeStatePath(workspaceRoot: string): string {
  return join(runtimeRoot(workspaceRoot), "state.json");
}

function isRuntimeState(value: unknown, workspaceRoot: string): value is DurableRuntimeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DurableRuntimeState>;
  return ((candidate as { version?: number }).version === 1 || candidate.version === RUNTIME_STATE_VERSION)
    && candidate.workspaceRoot === workspaceRoot
    && !!candidate.coordinator
    && Array.isArray(candidate.coordinator.messages)
    && candidate.coordinator.messages.every((message) => !!message && typeof message.id === "string" && typeof message.text === "string")
    && (candidate.coordinator.promptSettlement === undefined || (typeof candidate.coordinator.promptSettlement.throughTimestamp === "number"
      && Array.isArray(candidate.coordinator.promptSettlement.failures)
      && candidate.coordinator.promptSettlement.failures.every((failure) => !!failure
        && typeof failure.messageId === "string" && typeof failure.error === "string")))
    && (candidate.coordinator.pendingPrompts === undefined || (Array.isArray(candidate.coordinator.pendingPrompts)
      && candidate.coordinator.pendingPrompts.every((prompt) => !!prompt
        && typeof prompt.messageId === "string"
        && Array.isArray(prompt.context) && prompt.context.every((entry) => typeof entry === "string")
        && (prompt.mode === "build" || prompt.mode === "plan")
        && (prompt.state === "queued" || prompt.state === "processing" || prompt.state === "responded")
        && (prompt.responseMessageId === undefined || typeof prompt.responseMessageId === "string")
        && (prompt.responseCompletedAt === undefined || typeof prompt.responseCompletedAt === "number")
        && (prompt.state !== "responded" || typeof prompt.responseCompletedAt === "number"))))
    && Array.isArray(candidate.jobs)
    && candidate.jobs.every((entry) => {
      if (!entry || typeof entry !== "object" || !entry.job || typeof entry.job !== "object") return false;
      const job = entry.job as Partial<AgentJob>;
      return typeof job.id === "string"
        && typeof job.title === "string"
        && typeof job.createdAt === "number"
        && Array.isArray(job.messages)
        && !!job.isolation
        && (job.isolation.mode === "root" || job.isolation.mode === "worktree")
        && typeof job.isolation.path === "string"
        && typeof job.branch === "string";
    });
}

/** Conservative persisted-schema migration; live Git-derived outcomes remain TerminalReconciler-owned. */
export async function migrateRuntimeState(state: DurableRuntimeState): Promise<DurableRuntimeState> {
  const migrated = structuredClone(state);
  const legacyVersion = (state as { version: number }).version === 1;
  migrated.version = RUNTIME_STATE_VERSION;
  for (const { job } of migrated.jobs) {
    if (job.terminalDisposition) continue;
    const integration = job.integration;
    const cleanup = job.cleanup;
    const identity = job.worktreeIdentity;
    const completion = job.completion;
    const removedCleanup = cleanup?.status === "removed" ? cleanup : undefined;
    const cleanedEvidence = removedCleanup?.evidence;
    const completeCleanedMerge = legacyVersion && job.status === "completed" && integration?.status === "merged"
      && Number.isFinite(integration.verifiedAt) && !!integration.targetRef && !!integration.targetHead && !!integration.completionHead
      && !!completion && completion.head === integration.completionHead && Number.isFinite(completion.finishedAt)
      && !!identity && identity.path === job.isolation.path && identity.branch === job.branch && identity.baseRef === job.baseRef
      && !!cleanedEvidence && cleanedEvidence.mergeMethod !== "superseded-branch-retained"
      && cleanedEvidence.targetRef === integration.targetRef
      && cleanedEvidence.targetHead === integration.targetHead && cleanedEvidence.completionHead === integration.completionHead
      && cleanedEvidence.registeredPath === identity.path && cleanedEvidence.registeredBranch === identity.branch
      && cleanedEvidence.cleanPorcelain === true && removedCleanup?.checkedAt === cleanedEvidence.checkedAt
      && Number.isFinite(removedCleanup?.removedAt) && removedCleanup!.removedAt >= removedCleanup!.checkedAt
      && (cleanedEvidence.mergeMethod === "no-changes"
        ? cleanedEvidence.intendedCommits.length === 0
        : cleanedEvidence.intendedCommits.includes(integration.completionHead))
      && await pathIsAbsent(job.isolation.path);
    if (completeCleanedMerge && cleanedEvidence) job.terminalDisposition = {
      kind: "merged_verified", recordedAt: removedCleanup!.removedAt,
      evidence: {
        method: cleanedEvidence.mergeMethod === "patch-equivalent" ? "patch-equivalence"
          : cleanedEvidence.mergeMethod === "superseded-branch-retained" ? "no-changes" : cleanedEvidence.mergeMethod,
        detail: "Migrated complete persisted evidence for a verified merge and physically removed checkout.",
        sourceCommit: integration.completionHead, targetRef: integration.targetRef, targetCommit: integration.targetHead,
      },
    };
    else if (job.integration?.status === "superseded" && job.integration.supersededByCommit) job.terminalDisposition = {
      kind: "superseded", recordedAt: job.integration.verifiedAt || job.updatedAt,
      supersededBy: job.integration.supersededByJobId || job.integration.supersededByCommit,
      evidence: {
        method: "coordinator-supersession",
        detail: job.integration.dispositionReason || "Migrated persisted coordinator-authorized supersession.",
        sourceCommit: job.integration.completionHead,
        targetRef: job.integration.targetRef,
        targetCommit: job.integration.supersededByCommit,
      },
    };
    else if (job.status === "cancelled") job.terminalDisposition = {
      kind: "cancelled", recordedAt: job.updatedAt,
      evidence: { method: "explicit-cancellation", detail: "Migrated persisted explicit cancellation." },
    };
    else if (job.status === "failed") job.terminalDisposition = {
      kind: "failed_terminal", recordedAt: job.updatedAt,
      evidence: { method: "process-failure", detail: job.error || "Migrated persisted terminal process failure." },
    };
  }
  return migrated;
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export class RuntimeStateStore {
  readonly root: string;
  readonly path: string;
  private latest?: { state: DurableRuntimeState; generation: number };
  private writing?: Promise<void>;
  private generation = 0;
  private readonly completions = new Map<number, {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();
  private currentOutcome?: { generation: number; error?: unknown };

  constructor(readonly workspaceRoot: string) {
    this.root = runtimeRoot(workspaceRoot);
    this.path = runtimeStatePath(workspaceRoot);
  }

  async load(): Promise<DurableRuntimeState | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return isRuntimeState(parsed, this.workspaceRoot) ? await migrateRuntimeState(parsed) : undefined;
    } catch {
      // Missing, truncated, or from another workspace: start clean. Atomic
      // writes mean corruption should only be possible through external edits.
      return undefined;
    }
  }

  /** Coalesce streaming updates while still serializing every atomic replace. */
  save(state: DurableRuntimeState): void {
    const generation = ++this.generation;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    // Fire-and-forget saves must not create an unhandled rejection; flush()
    // still awaits the original operation-scoped promise.
    void promise.catch(() => undefined);
    this.completions.set(generation, { promise, resolve, reject });
    // Orchestrator persistence already builds a detached state envelope. Keep
    // only the latest reference and serialize it synchronously when the drain
    // claims it; cloning a multi-megabyte runtime on every streamed activity
    // update can otherwise retain gigabytes faster than atomic writes drain.
    this.latest = { state, generation };
    if (!this.writing) this.startDrain();
  }

  async flush(): Promise<void> {
    const target = this.generation;
    if (!target) return;
    const pending = this.completions.get(target);
    if (pending) return pending.promise;
    if (this.currentOutcome?.generation === target) {
      if (this.currentOutcome.error !== undefined) throw this.currentOutcome.error;
      return;
    }
    throw new Error(`Runtime state generation ${target} has no completion outcome.`);
  }

  private startDrain(): void {
    // Start in a microtask so synchronous/concurrent saves can share one atomic
    // write and, critically, one non-consumable completion outcome.
    this.writing = Promise.resolve().then(() => this.drain()).finally(() => {
      this.writing = undefined;
      if (this.latest) this.startDrain();
    });
  }

  private settleThrough(generation: number, error?: unknown): void {
    for (const [candidate, completion] of this.completions) {
      if (candidate > generation) continue;
      if (error === undefined) completion.resolve();
      else completion.reject(error);
      this.completions.delete(candidate);
    }
    this.currentOutcome = { generation, ...(error === undefined ? {} : { error }) };
  }

  private async drain(): Promise<void> {
    while (this.latest) {
      const { state, generation } = this.latest;
      this.latest = undefined;
      try {
        await this.writeAtomic(state);
        this.settleThrough(generation);
      } catch (error) {
        this.settleThrough(generation, error);
        return;
      }
    }
  }

  private async writeAtomic(state: DurableRuntimeState): Promise<void> {
    // Snapshot before the first await so later in-memory mutations cannot tear
    // this generation, without paying for an additional structuredClone.
    const serialized = `${JSON.stringify(state)}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(this.root, `.state.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
    // Best effort directory fsync makes the rename durable on filesystems that
    // support it; Windows may reject opening a directory.
    const directory = await open(this.root, "r").catch(() => undefined);
    if (directory) {
      await directory.sync().catch(() => undefined);
      await directory.close();
    }
  }
}
