import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentActivity, AgentJob, MaintenanceStatus, TranscriptMessage } from "@neocode/protocol";


export const RUNTIME_STATE_VERSION = 1;
const execFileAsync = promisify(execFile);
const LOCAL_HOSTNAME = hostname();

export interface RuntimeLockOwner {
  token: string;
  pid: number;
  hostname: string;
  processIdentity: string;
  createdAt: number;
  ticket: number;
}

async function processIdentity(pid: number): Promise<string | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTicks = fields[19]; // proc field 22; slice starts at field 3.
    if (startTicks) return `proc:${startTicks}`;
  } catch {
    // Non-Linux platforms use the process start timestamp below.
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const started = stdout.trim();
    return started ? `ps:${started}` : undefined;
  } catch {
    return undefined;
  }
}

function parseLockOwner(value: string): RuntimeLockOwner | undefined {
  try {
    const owner = JSON.parse(value) as Partial<RuntimeLockOwner>;
    return typeof owner.token === "string" && owner.token.length > 0
      && Number.isSafeInteger(owner.pid) && owner.pid! > 0
      && typeof owner.hostname === "string" && owner.hostname.length > 0
      && typeof owner.processIdentity === "string" && owner.processIdentity.length > 0
      && typeof owner.createdAt === "number"
      && Number.isSafeInteger(owner.ticket) && owner.ticket! >= 0
      ? owner as RuntimeLockOwner : undefined;
  } catch {
    return undefined;
  }
}

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
}

export interface CoordinatorNotificationState {
  events: CoordinatorWorkerEvent[];
  lastSignals: Record<string, string>;
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
  return candidate.version === RUNTIME_STATE_VERSION
    && candidate.workspaceRoot === workspaceRoot
    && !!candidate.coordinator
    && Array.isArray(candidate.coordinator.messages)
    && candidate.coordinator.messages.every((message) => !!message && typeof message.id === "string" && typeof message.text === "string")
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

function revision(job: AgentJob): number { return job.runtimeRevision ?? 0; }
function active(job: AgentJob): boolean { return job.status === "running" || job.status === "queued"; }

function matchesExpectation(job: AgentJob, expected: JobCasExpectation, authoritativeNow: number): boolean {
  if (expected.revision !== undefined && revision(job) !== expected.revision) return false;
  if (expected.generation !== undefined && job.recovery?.generation !== expected.generation) return false;
  if (expected.token !== undefined
    && job.recovery?.leaseToken !== (expected.token === null ? undefined : expected.token)) return false;
  if (expected.requireExpiredLease
    && job.recovery?.leaseExpiresAt !== undefined
    && job.recovery.leaseExpiresAt > authoritativeNow) return false;
  if (expected.requireUnexpiredLease
    && (!job.recovery?.leaseExpiresAt || job.recovery.leaseExpiresAt <= authoritativeNow)) return false;
  return true;
}

function mayReplaceJob(current: AgentJob, proposed: AgentJob): boolean {
  if (revision(proposed) <= revision(current)) return false;
  if (current.status === "cancelled" && proposed.status !== "cancelled") return false;
  const currentGeneration = current.recovery?.generation ?? 0;
  const proposedGeneration = proposed.recovery?.generation ?? 0;
  if (proposedGeneration < currentGeneration) return false;
  if (active(current) && active(proposed)) {
    const sameOwner = currentGeneration === proposedGeneration
      && current.recovery?.leaseToken === proposed.recovery?.leaseToken;
    if (sameOwner) {
      // A stale snapshot from another process that merely observed this token
      // must not shorten the owner's latest renewable lease.
      return (proposed.recovery?.leaseExpiresAt ?? 0) >= (current.recovery?.leaseExpiresAt ?? 0);
    }
    // Acquiring the initial token is allowed; generation takeover is CAS-only.
    return !current.recovery?.leaseToken && currentGeneration === proposedGeneration;
  }
  if (!active(current) && active(proposed)) return false;
  return true;
}

function mergeRuntimeState(current: DurableRuntimeState, proposed: DurableRuntimeState): DurableRuntimeState {
  const merged = structuredClone(proposed);
  const proposedById = new Map(merged.jobs.map((entry) => [entry.job.id, entry]));
  for (const currentEntry of current.jobs) {
    const candidate = proposedById.get(currentEntry.job.id);
    if (!candidate) {
      merged.jobs.push(structuredClone(currentEntry));
    } else if (!mayReplaceJob(currentEntry.job, candidate.job)) {
      const index = merged.jobs.indexOf(candidate);
      merged.jobs[index] = structuredClone(currentEntry);
    }
  }
  merged.updatedAt = Math.max(current.updatedAt, proposed.updatedAt);
  return merged;
}

export interface JobCasExpectation {
  revision?: number;
  generation?: number;
  token?: string | null;
  requireExpiredLease?: boolean;
  requireUnexpiredLease?: boolean;
  /** Assign a fresh lease from the in-lock commit time; caller timestamps are never trusted. */
  establishLeaseMs?: number;
}

export class RuntimeStateStore {
  readonly root: string;
  readonly path: string;
  readonly lockPath: string;
  private latest?: DurableRuntimeState;
  private writing?: Promise<void>;
  private writeError?: unknown;

  constructor(
    readonly workspaceRoot: string,
    /** Injectable only for deterministic store tests; production never supplies renewal timestamps. */
    private readonly clock: () => number = Date.now,
  ) {
    this.root = runtimeRoot(workspaceRoot);
    this.path = runtimeStatePath(workspaceRoot);
    this.lockPath = join(this.root, "state.lock.claims");
  }

  async load(): Promise<DurableRuntimeState | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return isRuntimeState(parsed, this.workspaceRoot) ? parsed : undefined;
    } catch {
      // Missing, truncated, or from another workspace: start clean. Atomic
      // writes mean corruption should only be possible through external edits.
      return undefined;
    }
  }

  /** Coalesce streaming updates; each drain merges under an inter-process lock. */
  save(state: DurableRuntimeState): void {
    this.latest = structuredClone(state);
    if (!this.writing) this.startDrain();
  }

  async flush(): Promise<void> {
    while (this.writing) await this.writing;
    if (this.writeError) {
      const error = this.writeError;
      this.writeError = undefined;
      throw error;
    }
  }

  private startDrain(): void {
    this.writing = this.drain().catch((error: unknown) => {
      // Save is intentionally fire-and-forget; retain the error for an explicit
      // lifecycle flush without creating an unhandled rejection.
      this.writeError = error;
    });
  }

  /**
   * Atomically replace one job only if the latest durable revision and worker
   * ownership still match. Other runtime fields and jobs are preserved.
   */
  async compareAndSwapJob(nextJob: AgentJob, expected: JobCasExpectation): Promise<AgentJob | undefined> {
    await this.flush();
    return this.withLock(async () => {
      const state = await this.load();
      if (!state) return undefined;
      const commitTime = this.clock();
      const entry = state.jobs.find((candidate) => candidate.job.id === nextJob.id);
      if (!entry || !matchesExpectation(entry.job, expected, commitTime)) return undefined;
      const committed = structuredClone(nextJob);
      committed.runtimeRevision = revision(entry.job) + 1;
      if (expected.establishLeaseMs !== undefined) {
        if (!committed.recovery?.leaseToken) return undefined;
        committed.recovery.leaseAcquiredAt = commitTime;
        committed.recovery.leaseExpiresAt = commitTime + Math.max(1, expected.establishLeaseMs);
      }
      entry.job = committed;
      state.updatedAt = commitTime;
      await this.writeAtomic(state);
      return structuredClone(committed);
    });
  }

  async renewJobLease(
    jobId: string,
    expected: JobCasExpectation,
    leaseMs: number,
  ): Promise<AgentJob | undefined> {
    await this.flush();
    return this.withLock(async () => {
      const state = await this.load();
      if (!state) return undefined;
      // This is the sole authoritative renewal time. It is sampled only after
      // every pre-lock await and the durable reread, while the inter-process
      // lock excludes takeover. Callers cannot provide an invocation-time value.
      const commitTime = this.clock();
      const entry = state.jobs.find((candidate) => candidate.job.id === jobId);
      if (!entry || !matchesExpectation(entry.job, expected, commitTime)
        || (entry.job.status !== "running" && entry.job.status !== "queued")
        || !entry.job.recovery?.leaseExpiresAt || entry.job.recovery.leaseExpiresAt <= commitTime) return undefined;
      const committed = structuredClone(entry.job);
      committed.runtimeRevision = revision(entry.job) + 1;
      committed.updatedAt = commitTime;
      committed.recovery!.leaseExpiresAt = commitTime + Math.max(1, leaseMs);
      entry.job = committed;
      state.updatedAt = commitTime;
      await this.writeAtomic(state);
      return structuredClone(committed);
    });
  }

  private async drain(): Promise<void> {
    try {
      while (this.latest) {
        const proposed = this.latest;
        this.latest = undefined;
        await this.withLock(async () => {
          const current = await this.load();
          await this.writeAtomic(current ? mergeRuntimeState(current, proposed) : proposed);
        });
      }
    } finally {
      this.writing = undefined;
      // A save can race the finally block after the loop condition.
      if (this.latest) this.startDrain();
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.lockPath, { recursive: true });
    const identity = await processIdentity(process.pid);
    if (!identity) throw new Error("Cannot establish runtime lock process identity; refusing ambiguous ownership.");
    const token = randomUUID();
    const choosingPath = join(this.lockPath, `${token}.choosing`);
    const marker: RuntimeLockOwner = {
      token, pid: process.pid, hostname: LOCAL_HOSTNAME,
      processIdentity: identity, createdAt: Date.now(), ticket: 0,
    };
    await symlink(JSON.stringify(marker), choosingPath);
    let owner: RuntimeLockOwner | undefined;
    try {
      const claims = await this.readLockEntries(".claim");
      const maxTicket = claims.reduce((maximum, entry) => Math.max(maximum, entry.owner?.ticket ?? 0), 0);
      owner = { ...marker, ticket: maxTicket + 1 };
      await symlink(JSON.stringify(owner), join(this.lockPath, `${token}.claim`));
    } finally {
      await this.removeOwnedEntry(choosingPath, token);
    }
    if (!owner) throw new Error("Failed to publish runtime lock claim.");

    try {
      for (;;) {
        let blocked = false;
        for (const entry of await this.readLockEntries(".choosing")) {
          if (entry.owner?.token === token) continue;
          if (!entry.owner || !await this.removeIfProvenDead(entry)) { blocked = true; break; }
        }
        if (!blocked) {
          for (const entry of await this.readLockEntries(".claim")) {
            if (entry.owner?.token === token) continue;
            if (!entry.owner) { blocked = true; break; }
            const precedes = entry.owner.ticket < owner.ticket
              || (entry.owner.ticket === owner.ticket && entry.owner.token < owner.token);
            if (precedes && !await this.removeIfProvenDead(entry)) { blocked = true; break; }
          }
        }
        if (!blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return await operation();
    } finally {
      await this.releaseLock(owner.token);
    }
  }

  private async readLockEntries(suffix: ".choosing" | ".claim") {
    const names = await readdir(this.lockPath).catch(() => [] as string[]);
    const entries = await Promise.all(names.filter((name) => name.endsWith(suffix)).map(async (name) => {
      const path = join(this.lockPath, name);
      const serialized = await readlink(path).catch(() => undefined);
      return { path, serialized, owner: serialized ? parseLockOwner(serialized) : undefined };
    }));
    return entries.sort((left, right) => (left.owner?.ticket ?? -1) - (right.owner?.ticket ?? -1)
      || (left.owner?.token ?? "").localeCompare(right.owner?.token ?? ""));
  }

  private async ownerIsProvenDead(owner: RuntimeLockOwner): Promise<boolean> {
    if (owner.hostname !== LOCAL_HOSTNAME) return false;
    try {
      process.kill(owner.pid, 0);
      const currentIdentity = await processIdentity(owner.pid);
      return Boolean(currentIdentity && currentIdentity !== owner.processIdentity);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private async removeIfProvenDead(entry: { path: string; serialized?: string; owner?: RuntimeLockOwner }): Promise<boolean> {
    if (!entry.owner || !entry.serialized || !await this.ownerIsProvenDead(entry.owner)) return false;
    // Claim paths include an unguessable token and are never reused. A stale
    // remover can therefore only unlink the exact dead claim it validated;
    // no live successor can ever occupy this pathname.
    const current = await readlink(entry.path).catch(() => undefined);
    if (current !== entry.serialized) return false;
    await unlink(entry.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return true;
  }

  private async removeOwnedEntry(path: string, token: string): Promise<boolean> {
    const serialized = await readlink(path).catch(() => undefined);
    const owner = serialized && parseLockOwner(serialized);
    if (!owner || owner.token !== token) return false;
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return true;
  }

  private releaseLock(token: string): Promise<boolean> {
    return this.removeOwnedEntry(join(this.lockPath, `${token}.claim`), token);
  }

  private async writeAtomic(state: DurableRuntimeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(this.root, `.state.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
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
