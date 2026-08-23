import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type {
  AgentJob,
  AgentStatus,
  AppSnapshot,
  RequestedIsolationMode,
  ServerMessage,
  TranscriptMessage,
} from "@neocode/protocol";
import { resolveIsolationMode } from "./isolation.js";
import {
  RUNTIME_STATE_VERSION,
  RuntimeStateStore,
  type DurableRuntimeState,
} from "./runtime-state.js";

const execFileAsync = promisify(execFile);

type Emit = (message: ServerMessage) => void;

interface RunningWorker {
  session: AgentSession;
  cancelled: boolean;
}

function id(): string {
  return randomUUID();
}

function textOf(message: AgentMessage): string {
  if (message.role === "bashExecution") return message.output;
  if ("summary" in message && typeof message.summary === "string") return message.summary;
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part: { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) => {
      if (part.type === "text") return part.text || "";
      if (part.type === "thinking") return part.thinking || "";
      if (part.type === "toolCall") return `${part.name}(${JSON.stringify(part.arguments)})`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant" || !("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function roleOf(message: AgentMessage): TranscriptMessage["role"] {
  if (message.role === "user") return "user";
  if (message.role === "assistant") return "assistant";
  if (message.role === "toolResult" || message.role === "bashExecution") return "tool";
  return "system";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "task";
}

export class Orchestrator {
  private readonly jobs = new Map<string, AgentJob>();
  private readonly workers = new Map<string, RunningWorker>();
  private readonly coordinatorMessages: TranscriptMessage[] = [];
  private readonly piSessionFiles = new Map<string, string>();
  private readonly stateStore: RuntimeStateStore;
  private coordinatorSessionFile?: string;
  private coordinatorStatus: AgentStatus = "idle";
  private modelRuntime!: ModelRuntime;
  private coordinator!: AgentSession;

  readonly cwd: string;

  constructor(
    cwd: string,
    private readonly emit: Emit,
  ) {
    // The server resolves this before constructing the orchestrator. Keeping a
    // single root here prevents the coordinator from following worker cwd state.
    this.cwd = cwd;
    this.stateStore = new RuntimeStateStore(cwd);
  }

  async initialize(): Promise<void> {
    await this.ensureLocalExcludes();
    const restored = await this.stateStore.load();
    if (restored) {
      this.coordinatorMessages.push(...restored.coordinator.messages);
      this.coordinatorSessionFile = restored.coordinator.piSessionFile;
      for (const entry of restored.jobs) {
        this.jobs.set(entry.job.id, entry.job);
        if (entry.piSessionFile) this.piSessionFiles.set(entry.job.id, entry.piSessionFile);
      }
      await this.reconcileRestoredJobs();
    }

    this.modelRuntime = await ModelRuntime.create();

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      systemPromptOverride: (base) => `${base ?? ""}\n\n# Neocode coordinator\nYou are the user's responsive, non-editing coordinator. You always run at the root repository. Discuss, investigate, and help the user understand the project, but never edit files or run mutating commands yourself. Delegate implementation work to background workers with delegate_task instead. Choose isolation=worktree for implementation or any potentially mutating task and isolation=root for clearly read-only investigation. Use isolation=auto when uncertain. An explicit user request for root or worktree isolation always takes precedence. Keep the main thread available: after delegation, report the job id briefly and continue helping. Use inspect_job only when the user asks to check a worker or when its result is needed. Never claim a worker succeeded before inspecting its status.`,

    });
    await loader.reload();

    const customTools = [
      {
        name: "delegate_task",
        label: "Delegate task",
        description: "Start a background task using auto, worktree, or root isolation and return immediately with a job id.",
        promptSnippet: "Delegate work to a background worker with an explicit isolation choice",
        promptGuidelines: ["Prefer worktree for implementation. Honor an explicit user isolation request. Root is only safe for read-only or explicitly requested work."],
        parameters: Type.Object({
          task: Type.String({ description: "A self-contained task with acceptance criteria" }),
          title: Type.Optional(Type.String({ description: "Short task title" })),
          isolation: Type.Optional(Type.Union([
            Type.Literal("auto"),
            Type.Literal("worktree"),
            Type.Literal("root"),
          ], { description: "Worker isolation. Explicit user instructions take precedence; auto conservatively selects worktree for mutating tasks." })),
        }),
        execute: async (_callId: string, params: { task: string; title?: string; isolation?: RequestedIsolationMode }) => {
          const job = await this.delegate(params.task, params.title, params.isolation ?? "auto");
          return {
            content: [{ type: "text" as const, text: `Started background job ${job.id}: ${job.title} (${job.isolation.mode}: ${job.isolation.path})` }],
            details: { jobId: job.id, isolation: job.isolation, worktree: job.worktree, branch: job.branch },
          };
        },
      },
      {
        name: "list_jobs",
        label: "List jobs",
        description: "List background worker jobs and their current status.",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{
            type: "text" as const,
            text: this.listJobs().map((job) => `${job.id} [${job.status}] ${job.title}`).join("\n") || "No jobs",
          }],
          details: {},
        }),
      },
      {
        name: "inspect_job",
        label: "Inspect job",
        description: "Inspect a background worker's report and current diff.",
        parameters: Type.Object({ jobId: Type.String() }),
        execute: async (_callId: string, params: { jobId: string }) => {
          const job = this.jobs.get(params.jobId);
          if (!job) throw new Error(`Unknown job: ${params.jobId}`);
          await this.refreshDiff(job);
          const output = [
            `${job.id} [${job.status}] ${job.title}`,
            `Isolation: ${job.isolation.mode} (${job.isolation.path})`,
            job.summary ? `\nReport:\n${job.summary}` : "",
            job.diff ? `\nDiff:\n${job.diff.slice(0, 40_000)}` : "\nNo diff yet.",
            job.error ? `\nError:\n${job.error}` : "",
          ].join("");
          return { content: [{ type: "text" as const, text: output }], details: { jobId: job.id } };
        },
      },
    ];

    const coordinatorSessionDir = join(this.stateStore.root, "pi-sessions", "coordinator");
    let coordinatorManager: SessionManager;
    try {
      coordinatorManager = this.coordinatorSessionFile && await this.pathExists(this.coordinatorSessionFile)
        ? SessionManager.open(this.coordinatorSessionFile, coordinatorSessionDir, this.cwd)
        : SessionManager.create(this.cwd, coordinatorSessionDir);
    } catch {
      // Neocode's transcript remains usable even if Pi's append-only session was
      // externally removed or corrupted. Start a fresh model context explicitly.
      coordinatorManager = SessionManager.create(this.cwd, coordinatorSessionDir);
    }
    this.coordinatorSessionFile = coordinatorManager.getSessionFile();

    const result = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      sessionManager: coordinatorManager,
      tools: ["read", "grep", "find", "ls", "delegate_task", "list_jobs", "inspect_job"],
      customTools,
    });
    this.coordinator = result.session;
    this.bindCoordinator();
    this.persist();
  }

  snapshot(): AppSnapshot {
    return {
      cwd: this.cwd,
      coordinator: {
        status: this.coordinatorStatus,
        messages: [...this.coordinatorMessages],
      },
      jobs: this.listJobs(),
    };
  }

  async prompt(text: string, context: string[] = []): Promise<void> {
    const content = context.length
      ? `${text}\n\n<context-basket>\n${context.join("\n\n---\n\n")}\n</context-basket>`
      : text;

    const userMessage: TranscriptMessage = { id: id(), role: "user", text, timestamp: Date.now() };
    this.coordinatorMessages.push(userMessage);
    this.persist();
    this.emit({ type: "coordinator_message", message: userMessage });

    try {
      await this.coordinator.prompt(content, this.coordinator.isStreaming ? { streamingBehavior: "steer" } : undefined);
    } catch (error) {
      this.fail(error);
    }
  }

  async abort(): Promise<void> {
    await this.coordinator.abort();
  }

  async dispose(): Promise<void> {
    await this.coordinator.abort().catch(() => undefined);
    for (const [jobId, worker] of this.workers) {
      worker.cancelled = true;
      await worker.session.abort().catch(() => undefined);
      worker.session.dispose();
      const job = this.jobs.get(jobId);
      if (job && (job.status === "running" || job.status === "queued")) {
        job.status = "interrupted";
        job.recoverable = true;
        job.updatedAt = Date.now();
      }
    }
    this.workers.clear();
    this.coordinator.dispose();
    this.coordinatorStatus = "idle";
    this.persist();
    await this.stateStore.flush();
  }

  async delegate(
    task: string,
    requestedTitle?: string,
    requestedIsolation: RequestedIsolationMode = "auto",
  ): Promise<AgentJob> {
    const shortId = id().slice(0, 8);
    const title = requestedTitle?.trim() || task.trim().split("\n")[0]!.slice(0, 60) || "Background task";
    // Pin the starting commit so a root worker that commits does not move the
    // comparison target and hide its own diff.
    const baseRef = await this.git(["rev-parse", "HEAD"]).catch(() => "HEAD");
    const currentBranch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD");
    const isolationMode = resolveIsolationMode(task, requestedIsolation);
    const branch = isolationMode === "worktree" ? `neocode/${slug(title)}-${shortId}` : currentBranch;
    const worktree = isolationMode === "worktree"
      ? join(this.cwd, ".worktrees", `${slug(title)}-${shortId}`)
      : this.cwd;

    const job: AgentJob = {
      id: shortId,
      title,
      prompt: task,
      status: "queued",
      branch,
      worktree,
      isolation: { requested: requestedIsolation, mode: isolationMode, path: worktree },
      baseRef,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: id(), role: "user", text: task, timestamp: Date.now() }],
    };
    this.jobs.set(job.id, job);
    this.publishJob(job);

    try {
      if (isolationMode === "worktree") {
        await mkdir(join(this.cwd, ".worktrees"), { recursive: true });
        await this.git(["worktree", "add", "-b", branch, worktree, baseRef]);
      }
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      this.publishJob(job);
      throw error;
    }

    job.status = "running";
    job.updatedAt = Date.now();
    this.publishJob(job);
    void this.runWorker(job);
    return job;
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const worker = this.workers.get(jobId);
    if (worker) {
      worker.cancelled = true;
      await worker.session.abort();
    }
    job.status = "cancelled";
    job.updatedAt = Date.now();
    this.publishJob(job);
  }

  private listJobs(): AgentJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private bindCoordinator(): void {
    let streaming: TranscriptMessage | undefined;
    let emitted = false;
    this.coordinator.subscribe((event) => {
      if (event.type === "agent_start") {
        this.coordinatorStatus = "running";
        this.persist();
        this.emit({ type: "coordinator_status", status: "running" });
      } else if (event.type === "message_start" && event.message.role === "assistant") {
        streaming = { id: id(), role: "assistant", text: "", timestamp: Date.now() };
        emitted = false;
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && streaming) {
        if (!emitted) {
          streaming.text = event.assistantMessageEvent.delta;
          this.coordinatorMessages.push(streaming);
          this.persist();
          this.emit({ type: "coordinator_message", message: { ...streaming } });
          emitted = true;
        } else {
          streaming.text += event.assistantMessageEvent.delta;
          this.persist();
          this.emit({ type: "coordinator_delta", messageId: streaming.id, delta: event.assistantMessageEvent.delta });
        }
      } else if (event.type === "message_end" && event.message.role === "assistant" && streaming) {
        const finalText = assistantText(event.message);
        if (finalText) {
          streaming.text = finalText;
          if (!emitted) {
            this.coordinatorMessages.push(streaming);
            this.emit({ type: "coordinator_message", message: { ...streaming } });
          } else {
            this.emit({ type: "coordinator_message_updated", message: { ...streaming } });
          }
        }
        this.persist();
        streaming = undefined;
        emitted = false;
      } else if (event.type === "agent_settled") {
        this.coordinatorStatus = "idle";
        this.persist();
        this.emit({ type: "coordinator_status", status: "idle" });
      }
    });
  }

  private async runWorker(job: AgentJob): Promise<void> {
    let session: AgentSession | undefined;
    try {
      const loader = new DefaultResourceLoader({
        cwd: job.isolation.path,
        agentDir: getAgentDir(),
        systemPromptOverride: (base) => `${base ?? ""}\n\n# Neocode background worker\nYou are a background worker running in ${job.isolation.mode === "worktree" ? "an isolated git worktree" : "the shared root checkout"} at ${job.isolation.path}. ${job.isolation.mode === "root" && job.isolation.requested === "auto" ? "This task was classified as non-mutating: inspect and report only; do not edit files." : "Complete the assigned task autonomously, including edits when requested."} Run relevant checks. Do not ask conversational questions unless completely blocked. End with a concise report covering changes, tests, and remaining risks.`,

      });
      await loader.reload();
      const workerSessionDir = join(this.stateStore.root, "pi-sessions", "workers", job.id);
      const workerManager = SessionManager.create(job.isolation.path, workerSessionDir);
      const workerSessionFile = workerManager.getSessionFile();
      if (workerSessionFile) this.piSessionFiles.set(job.id, workerSessionFile);
      this.persist();
      const result = await createAgentSession({
        cwd: job.isolation.path,
        model: this.coordinator.model,
        thinkingLevel: this.coordinator.thinkingLevel,
        modelRuntime: this.modelRuntime,
        resourceLoader: loader,
        sessionManager: workerManager,
      });
      session = result.session;
      this.workers.set(job.id, { session, cancelled: false });
      this.bindWorker(job, session);
      await session.prompt(job.prompt);

      if (this.workers.get(job.id)?.cancelled) return;
      job.status = "completed";
      job.summary = [...job.messages].reverse().find((message) => message.role === "assistant")?.text;
      await this.refreshDiff(job);
      job.updatedAt = Date.now();
      this.publishJob(job);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      this.publishJob(job);
    } finally {
      this.workers.delete(job.id);
      session?.dispose();
    }
  }

  private bindWorker(job: AgentJob, session: AgentSession): void {
    let streaming: TranscriptMessage | undefined;
    let emitted = false;
    session.subscribe((event) => {
      if (event.type === "message_start") {
        const role = roleOf(event.message);
        if (role === "assistant") {
          streaming = { id: id(), role, text: "", timestamp: Date.now() };
          emitted = false;
        } else if (role === "tool") {
          const text = textOf(event.message);
          if (!text) return;
          job.messages.push({ id: id(), role, text, timestamp: Date.now() });
          job.updatedAt = Date.now();
          this.publishJob(job);
        }
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && streaming) {
        if (!emitted) {
          streaming.text = event.assistantMessageEvent.delta;
          job.messages.push(streaming);
          emitted = true;
        } else {
          streaming.text += event.assistantMessageEvent.delta;
        }
        job.updatedAt = Date.now();
        this.publishJob(job);
      } else if (event.type === "message_end" && event.message.role === "assistant" && streaming) {
        const finalText = assistantText(event.message);
        if (finalText) {
          streaming.text = finalText;
          if (!emitted) job.messages.push(streaming);
          job.updatedAt = Date.now();
          this.publishJob(job);
        }
        streaming = undefined;
        emitted = false;
      }
    });
  }

  private async refreshDiff(job: AgentJob): Promise<void> {
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", job.baseRef], {
      cwd: job.isolation.path,
      maxBuffer: 10 * 1024 * 1024,
    });
    job.diff = stdout;
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: this.cwd });
    return stdout.trim();
  }

  private async ensureLocalExcludes(): Promise<void> {
    const gitDir = await this.git(["rev-parse", "--git-common-dir"]).catch(() => undefined);
    if (!gitDir) return;
    const absoluteGitDir = gitDir.startsWith("/") ? gitDir : join(this.cwd, gitDir);
    await appendFile(
      join(absoluteGitDir, "info", "exclude"),
      "\n# Neocode runtime (workspace-local, never source)\n.worktrees/\n.neocode/runtime/\n",
      "utf8",
    ).catch(() => undefined);
  }

  private publishJob(job: AgentJob): void {
    this.persist();
    this.emit({ type: "job_updated", job: structuredClone(job) });
  }

  private persist(): void {
    const state: DurableRuntimeState = {
      version: RUNTIME_STATE_VERSION,
      workspaceRoot: this.cwd,
      updatedAt: Date.now(),
      coordinator: {
        messages: [...this.coordinatorMessages],
        piSessionFile: this.coordinatorSessionFile,
      },
      jobs: this.listJobs().map((job) => ({
        job: structuredClone(job),
        piSessionFile: this.piSessionFiles.get(job.id),
      })),
    };
    this.stateStore.save(state);
  }

  private async pathExists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
  }

  private async reconcileRestoredJobs(): Promise<void> {
    const worktrees = await this.git(["worktree", "list", "--porcelain"]).catch(() => "");
    const registered = new Map<string, string | undefined>();
    let currentPath: string | undefined;
    for (const line of worktrees.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice(9);
        registered.set(currentPath, undefined);
      } else if (currentPath && line.startsWith("branch refs/heads/")) {
        registered.set(currentPath, line.slice("branch refs/heads/".length));
      }
    }

    for (const job of this.jobs.values()) {
      // No in-memory worker survives this process. Pi's session can be opened
      // later for context, but doing so does not resume a tool process safely.
      if (job.status === "running" || job.status === "queued") {
        job.status = "interrupted";
        job.updatedAt = Date.now();
      }

      if (job.isolation.mode === "root") {
        job.isolation.path = this.cwd;
        job.worktree = this.cwd;
        job.recoverable = await this.pathExists(this.cwd);
      } else {
        const exists = await this.pathExists(job.isolation.path);
        const registeredBranch = registered.get(job.isolation.path);
        const isRegistered = registered.has(job.isolation.path);
        const branchMatches = registeredBranch === job.branch;
        job.recoverable = exists && isRegistered && branchMatches;
        if (!exists || !isRegistered || !branchMatches) {
          job.recoveryIssue = !exists
            ? "The recorded worktree no longer exists."
            : !isRegistered
              ? "The recorded path exists but is not a registered git worktree."
              : `The worktree is on ${registeredBranch || "a detached HEAD"}, not ${job.branch}.`;
        } else {
          delete job.recoveryIssue;
          await this.refreshDiff(job).catch(() => undefined);
        }
      }
    }
  }

  private fail(error: unknown): void {
    this.coordinatorStatus = "error";
    this.persist();
    this.emit({ type: "coordinator_status", status: "error" });
    this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
