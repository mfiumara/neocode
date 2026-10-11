import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
  ModelChoice,
  ModelRef,
  ServerMessage,
  TranscriptMessage,
} from "@neocode/protocol";

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
  private coordinatorStatus: AgentStatus = "idle";
  private modelRuntime!: ModelRuntime;
  private coordinator!: AgentSession;
  private modelChangeInProgress = false;

  constructor(
    readonly cwd: string,
    private readonly emit: Emit,
  ) {}

  async initialize(): Promise<void> {
    this.modelRuntime = await ModelRuntime.create();
    // getAvailable is Pi's configured/authenticated model enumeration API. It also
    // ensures the synchronous snapshot used by selection is current.
    await this.modelRuntime.getAvailable();

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      systemPromptOverride: (base) => `${base ?? ""}\n\n# Neocode coordinator\nYou are the user's responsive coordinator. Discuss, investigate, and help the user understand the project. Delegate implementation work to background workers with delegate_task instead of editing files yourself. Keep the main thread available: after delegation, report the job id briefly and continue helping. Use inspect_job only when the user asks to check a worker or when its result is needed. Never claim a worker succeeded before inspecting its status.`,
    });
    await loader.reload();

    const customTools = [
      {
        name: "delegate_task",
        label: "Delegate task",
        description: "Start an implementation task in an isolated git worktree and return immediately with a background job id.",
        promptSnippet: "Delegate implementation work to an isolated background worker",
        promptGuidelines: ["Use delegate_task for implementation work so the coordinator remains responsive."],
        parameters: Type.Object({
          task: Type.String({ description: "A self-contained implementation task with acceptance criteria" }),
          title: Type.Optional(Type.String({ description: "Short task title" })),
        }),
        execute: async (_callId: string, params: { task: string; title?: string }) => {
          const job = await this.delegate(params.task, params.title);
          return {
            content: [{ type: "text" as const, text: `Started background job ${job.id}: ${job.title}` }],
            details: { jobId: job.id, worktree: job.worktree, branch: job.branch },
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
            job.summary ? `\nReport:\n${job.summary}` : "",
            job.diff ? `\nDiff:\n${job.diff.slice(0, 40_000)}` : "\nNo diff yet.",
            job.error ? `\nError:\n${job.error}` : "",
          ].join("");
          return { content: [{ type: "text" as const, text: output }], details: { jobId: job.id } };
        },
      },
    ];

    const result = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.create(this.cwd),
      tools: ["read", "grep", "find", "ls", "delegate_task", "list_jobs", "inspect_job"],
      customTools,
    });
    this.coordinator = result.session;
    this.bindCoordinator();
  }

  snapshot(): AppSnapshot {
    return {
      cwd: this.cwd,
      coordinator: {
        status: this.coordinatorStatus,
        messages: [...this.coordinatorMessages],
        model: this.currentModel(),
        models: this.modelChoices(),
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

  async setModel(selection: ModelRef): Promise<void> {
    if (this.modelChangeInProgress) {
      throw new Error("A coordinator model change is already in progress.");
    }
    if (this.coordinator.isStreaming) {
      throw new Error("Wait for the coordinator response to finish (or abort it) before changing models.");
    }

    const model = this.modelRuntime.getAvailableSnapshot().find(
      (candidate) => candidate.provider === selection.provider && candidate.id === selection.id,
    );
    if (!model) {
      throw new Error(`Model is not configured or available: ${selection.provider}/${selection.id}`);
    }
    if (this.coordinator.model?.provider === model.provider && this.coordinator.model.id === model.id) return;

    this.modelChangeInProgress = true;
    try {
      // AgentSession.setModel performs Pi's auth validation and only then updates
      // the live session/default. New workers read this session model at creation.
      await this.coordinator.setModel(model);
      this.emit({ type: "coordinator_model_updated", model: { provider: model.provider, id: model.id } });
    } catch (error) {
      throw new Error(
        `Could not switch coordinator to ${selection.provider}/${selection.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.modelChangeInProgress = false;
    }
  }

  async dispose(): Promise<void> {
    await this.coordinator.abort().catch(() => undefined);
    for (const worker of this.workers.values()) {
      worker.cancelled = true;
      await worker.session.abort().catch(() => undefined);
      worker.session.dispose();
    }
    this.workers.clear();
    this.coordinator.dispose();
  }

  async delegate(task: string, requestedTitle?: string): Promise<AgentJob> {
    const shortId = id().slice(0, 8);
    const title = requestedTitle?.trim() || task.trim().split("\n")[0]!.slice(0, 60) || "Background task";
    const baseRef = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD");
    const branch = `neocode/${slug(title)}-${shortId}`;
    const worktree = join(this.cwd, ".worktrees", `${slug(title)}-${shortId}`);

    const job: AgentJob = {
      id: shortId,
      title,
      prompt: task,
      status: "queued",
      branch,
      worktree,
      baseRef,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: id(), role: "user", text: task, timestamp: Date.now() }],
    };
    this.jobs.set(job.id, job);
    this.publishJob(job);

    try {
      await mkdir(join(this.cwd, ".worktrees"), { recursive: true });
      await this.ensureLocalExcludes();
      await this.git(["worktree", "add", "-b", branch, worktree, baseRef]);
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

  private currentModel(): ModelRef | null {
    const model = this.coordinator?.model;
    return model ? { provider: model.provider, id: model.id } : null;
  }

  private modelChoices(): ModelChoice[] {
    return this.modelRuntime.getAvailableSnapshot()
      .map((model) => ({ provider: model.provider, id: model.id, label: model.name || model.id }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
  }

  private bindCoordinator(): void {
    let streamingId: string | undefined;
    this.coordinator.subscribe((event) => {
      if (event.type === "agent_start") {
        this.coordinatorStatus = "running";
        this.emit({ type: "coordinator_status", status: "running" });
      } else if (event.type === "message_start" && event.message.role === "assistant") {
        streamingId = id();
        const message: TranscriptMessage = {
          id: streamingId,
          role: "assistant",
          text: "",
          timestamp: Date.now(),
        };
        this.coordinatorMessages.push(message);
        this.emit({ type: "coordinator_message", message });
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && streamingId) {
        const message = this.coordinatorMessages.find((candidate) => candidate.id === streamingId);
        if (message) message.text += event.assistantMessageEvent.delta;
        this.emit({ type: "coordinator_delta", messageId: streamingId, delta: event.assistantMessageEvent.delta });
      } else if (event.type === "message_end" && event.message.role === "assistant" && streamingId) {
        const message = this.coordinatorMessages.find((candidate) => candidate.id === streamingId);
        if (message) message.text = textOf(event.message);
        streamingId = undefined;
      } else if (event.type === "agent_settled") {
        this.coordinatorStatus = "idle";
        this.emit({ type: "coordinator_status", status: "idle" });
      }
    });
  }

  private async runWorker(job: AgentJob): Promise<void> {
    let session: AgentSession | undefined;
    try {
      const loader = new DefaultResourceLoader({
        cwd: job.worktree,
        agentDir: getAgentDir(),
        systemPromptOverride: (base) => `${base ?? ""}\n\n# Neocode background worker\nYou are an implementation worker in an isolated git worktree. Complete the assigned task autonomously. Inspect the project, edit files, run relevant tests, and leave the worktree ready for review. Do not ask conversational questions unless completely blocked. End with a concise report covering changes, tests, and remaining risks.`,
      });
      await loader.reload();
      const result = await createAgentSession({
        cwd: job.worktree,
        model: this.coordinator.model,
        thinkingLevel: this.coordinator.thinkingLevel,
        modelRuntime: this.modelRuntime,
        resourceLoader: loader,
        sessionManager: SessionManager.create(job.worktree),
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
    let streamingId: string | undefined;
    session.subscribe((event) => {
      if (event.type === "message_start") {
        const role = roleOf(event.message);
        if (role !== "assistant" && role !== "tool") return;
        streamingId = role === "assistant" ? id() : undefined;
        const message: TranscriptMessage = {
          id: streamingId || id(),
          role,
          text: textOf(event.message),
          timestamp: Date.now(),
        };
        job.messages.push(message);
        job.updatedAt = Date.now();
        this.publishJob(job);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && streamingId) {
        const message = job.messages.find((candidate) => candidate.id === streamingId);
        if (message) message.text += event.assistantMessageEvent.delta;
        job.updatedAt = Date.now();
        this.publishJob(job);
      } else if (event.type === "message_end" && event.message.role === "assistant" && streamingId) {
        const message = job.messages.find((candidate) => candidate.id === streamingId);
        if (message) message.text = textOf(event.message);
        streamingId = undefined;
        this.publishJob(job);
      }
    });
  }

  private async refreshDiff(job: AgentJob): Promise<void> {
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", job.baseRef], {
      cwd: job.worktree,
      maxBuffer: 10 * 1024 * 1024,
    });
    job.diff = stdout;
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: this.cwd });
    return stdout.trim();
  }

  private async ensureLocalExcludes(): Promise<void> {
    const gitDir = await this.git(["rev-parse", "--git-common-dir"]);
    const absoluteGitDir = gitDir.startsWith("/") ? gitDir : join(this.cwd, gitDir);
    await appendFile(join(absoluteGitDir, "info", "exclude"), "\n.worktrees/\n", "utf8").catch(() => undefined);
  }

  private publishJob(job: AgentJob): void {
    this.emit({ type: "job_updated", job: structuredClone(job) });
  }

  private fail(error: unknown): void {
    this.coordinatorStatus = "error";
    this.emit({ type: "coordinator_status", status: "error" });
    this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
