import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentJob, TranscriptMessage } from "@neocode/protocol";

export const RUNTIME_STATE_VERSION = 1;

export interface DurableJob {
  job: AgentJob;
  piSessionFile?: string;
}

export interface DurableRuntimeState {
  version: typeof RUNTIME_STATE_VERSION;
  workspaceRoot: string;
  updatedAt: number;
  coordinator: {
    messages: TranscriptMessage[];
    piSessionFile?: string;
  };
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

export class RuntimeStateStore {
  readonly root: string;
  readonly path: string;
  private latest?: DurableRuntimeState;
  private writing?: Promise<void>;
  private writeError?: unknown;

  constructor(readonly workspaceRoot: string) {
    this.root = runtimeRoot(workspaceRoot);
    this.path = runtimeStatePath(workspaceRoot);
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

  /** Coalesce streaming updates while still serializing every atomic replace. */
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

  private async drain(): Promise<void> {
    try {
      while (this.latest) {
        const state = this.latest;
        this.latest = undefined;
        await this.writeAtomic(state);
      }
    } finally {
      this.writing = undefined;
      // A save can race the finally block after the loop condition.
      if (this.latest) this.startDrain();
    }
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
