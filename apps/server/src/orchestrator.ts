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
import type { AgentMessage, ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  SUPPORTED_IMAGE_MIME_TYPES,
  type AgentActivity,
  type AgentJob,
  type AgentSettings,
  type AgentStatus,
  type AgentVariant,
  type AppSnapshot,
  type ImageAttachment,
  type JudgeEvidence,
  type ModelChoice,
  type ModelRef,
  type RequestedIsolationMode,
  type ServerMessage,
  type TranscriptMessage,
} from "@neocode/protocol";
import { activity, toolActivity } from "./activity.js";
import { CompletionPipeline, LocalReviewAdapter, readWorktreeDiff } from "./completion-pipeline.js";
import { resolveIsolationMode } from "./isolation.js";
import {
  canAutomaticallyResume,
  continuationPrompt,
  isClearlyReadOnlyRoot,
  isDurableAttemptCurrent,
  openRecoverySession,
  recoveryConfig,
  retryDelay,
  type RecoveryConfig,
} from "./recovery.js";
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
  generation: number;
  token: string;
}
interface WorkerConfig {
  model: AgentSession["model"];
  thinkingLevel: PiThinkingLevel;
}

const BUILD_TOOLS = ["read", "grep", "find", "ls", "delegate_task", "list_jobs", "inspect_job"];
const PLAN_TOOLS = ["read", "grep", "find", "ls", "list_jobs", "inspect_job"];
const VARIANTS: AgentVariant[] = ["build", "plan"];

function id(): string {
  return randomUUID();
}

function transcriptText(value: string): string {
  const limit = 12_000;
  return value.length > limit ? `${value.slice(0, limit)}\n\n… output truncated for display` : value;
}

function textOf(message: AgentMessage): string {
  if (message.role === "bashExecution") return transcriptText(message.output);
  if ("summary" in message && typeof message.summary === "string") return transcriptText(message.summary);
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return transcriptText(message.content
    .map((part: { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) => {
      if (part.type === "text") return part.text || "";
      if (part.type === "thinking") return part.thinking || "";
      if (part.type === "toolCall") return `${part.name}(${JSON.stringify(part.arguments)})`;
      return "";
    })
    .filter(Boolean)
    .join("\n"));
}

function attachmentsOf(message: AgentMessage): ImageAttachment[] | undefined {
  if (!("content" in message) || !Array.isArray(message.content)) return undefined;
  const attachments = message.content.flatMap((part) => part.type === "image"
    && SUPPORTED_IMAGE_MIME_TYPES.includes(part.mimeType as ImageAttachment["mimeType"]) ? [{
      id: id(), mimeType: part.mimeType as ImageAttachment["mimeType"], data: part.data,
      size: Buffer.byteLength(part.data, "base64"),
    }] : []);
  return attachments.length ? attachments : undefined;
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
  private readonly workerConfigs = new Map<string, WorkerConfig>();
  private readonly coordinatorMessages: TranscriptMessage[] = [];
  private readonly piSessionFiles = new Map<string, string>();
  private readonly stateStore: RuntimeStateStore;
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly startupRecoveryIds = new Set<string>();
  private readonly recoveryConfig: RecoveryConfig;
  private coordinatorSessionFile?: string;
  private coordinatorStatus: AgentStatus = "idle";
  private coordinatorActivity: AgentActivity | undefined;
  private coordinatorVariant: AgentVariant = "build";
  private coordinatorAborting = false;
  private modelChangeInProgress = false;
  private modelRuntime!: ModelRuntime;
  private coordinator!: AgentSession;
  private completionPipeline!: CompletionPipeline;

  readonly cwd: string;

  constructor(
    cwd: string,
    private readonly emit: Emit,
  ) {
    // The server resolves this before constructing the orchestrator. Keeping a
    // single root here prevents the coordinator from following worker cwd state.
    this.cwd = cwd;
    this.stateStore = new RuntimeStateStore(cwd);
    this.recoveryConfig = recoveryConfig();
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
    await this.modelRuntime.getAvailable();

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
    this.applyVariantTools();
    this.bindCoordinator();

    const targetBranch = process.env.NEOCODE_MERGE_BRANCH || "main";
    const reviewAdapter = new LocalReviewAdapter(this.cwd, {
      targetBranch,
      judge: (job, diff, diffSha256) => this.runJudge(job, diff, diffSha256),
    });
    this.completionPipeline = new CompletionPipeline(reviewAdapter, (job) => this.publishJob(job), targetBranch, this.cwd);
    this.completionPipeline.recover(this.listJobs());
    this.persist();
    await this.resumeRestoredJobs();
  }

  snapshot(): AppSnapshot {
    return {
      cwd: this.cwd,
      coordinator: {
        status: this.coordinatorStatus,
        activity: this.coordinatorActivity,
        messages: [...this.coordinatorMessages],
        settings: this.settings(),
        model: this.currentModel(),
        models: this.modelChoices(),
      },
      jobs: this.listJobs(),
    };
  }

  async prompt(text: string, context: string[] = [], attachments: ImageAttachment[] = []): Promise<void> {
    const modeInstruction = this.coordinatorVariant === "plan"
      ? "<neocode-mode>PLAN: investigate and propose a plan only. Do not delegate implementation.</neocode-mode>"
      : "<neocode-mode>BUILD: implementation work may be delegated to background workers.</neocode-mode>";
    const content = `${text}${context.length
      ? `\n\n<context-basket>\n${context.join("\n\n---\n\n")}\n</context-basket>`
      : ""}\n\n${modeInstruction}`;

    const userMessage: TranscriptMessage = { id: id(), role: "user", text, timestamp: Date.now(), attachments: attachments.length ? attachments : undefined };
    this.coordinatorMessages.push(userMessage);
    this.persist();
    this.emit({ type: "coordinator_message", message: userMessage });

    try {
      await this.coordinator.prompt(content, {
        ...(attachments.length ? { images: attachments.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })) } : {}),
        ...(this.coordinator.isStreaming ? { streamingBehavior: "steer" as const } : {}),
      });
    } catch (error) {
      if (!this.coordinatorAborting) this.fail(error);
    }
  }

  async abort(): Promise<void> {
    this.coordinatorAborting = true;
    try {
      await this.coordinator.abort();
    } finally {
      this.coordinatorStatus = "idle";
      this.emit({ type: "coordinator_status", status: "idle" });
      this.setCoordinatorActivity(undefined);
      this.coordinatorAborting = false;
      this.persist();
    }
  }

  cycleVariant(): AgentSettings {
    const available = this.availableVariants();
    const index = available.indexOf(this.coordinatorVariant);
    this.coordinatorVariant = available[(index + 1) % available.length] ?? available[0] ?? "plan";
    this.applyVariantTools();
    return this.publishSettings();
  }

  cycleThinking(): AgentSettings {
    if (this.coordinator.supportsThinking()) this.coordinator.cycleThinkingLevel();
    return this.publishSettings();
  }

  async setModel(selection: ModelRef): Promise<void> {
    if (this.modelChangeInProgress) throw new Error("A coordinator model change is already in progress.");
    if (!this.coordinator.isIdle) throw new Error("Wait for the coordinator response to finish (or abort it) before changing models.");
    const model = this.modelRuntime.getAvailableSnapshot().find(
      (candidate) => candidate.provider === selection.provider && candidate.id === selection.id,
    );
    if (!model) throw new Error(`Model is not configured or available: ${selection.provider}/${selection.id}`);
    if (this.coordinator.model?.provider === model.provider && this.coordinator.model.id === model.id) return;
    this.modelChangeInProgress = true;
    try {
      await this.coordinator.setModel(model);
      this.emit({ type: "coordinator_model_updated", model: { provider: model.provider, id: model.id } });
      this.publishSettings();
      this.persist();
    } finally {
      this.modelChangeInProgress = false;
    }
  }

  async dispose(): Promise<void> {
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    await this.coordinator.abort().catch(() => undefined);
    for (const [jobId, worker] of this.workers) {
      worker.cancelled = true;
      await worker.session.abort().catch(() => undefined);
      worker.session.dispose();
      const job = this.jobs.get(jobId);
      if (job && this.isCurrentAttempt(job, worker.generation, worker.token)
        && (job.status === "running" || job.status === "queued")) {
        job.status = "interrupted";
        job.activity = undefined;
        job.recoverable = true;
        job.recovery ??= { retryCount: 0, maxRetries: this.recoveryConfig.maxRetries, generation: worker.generation };
        job.recovery.nextRetryAt = Date.now() + retryDelay(this.recoveryConfig, job.recovery.retryCount + 1);
        job.updatedAt = Date.now();
        this.finishAttempt(job, "Backend shutdown interrupted this attempt.");
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
    attachments: ImageAttachment[] = [],
  ): Promise<AgentJob> {
    if (this.coordinatorVariant === "plan") throw new Error("Delegation is unavailable in Plan mode. Switch to Build mode first.");
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
      messages: [{ id: id(), role: "user", text: task, timestamp: Date.now(), attachments: attachments.length ? attachments : undefined }],
      activity: activity("starting", "Waiting to start"),
      settings: { variant: "build", thinkingLevel: this.coordinator.thinkingLevel },
      recovery: { retryCount: 0, maxRetries: this.recoveryConfig.maxRetries, generation: 1 },
      attempts: [],
    };
    this.jobs.set(job.id, job);
    this.workerConfigs.set(job.id, { model: this.coordinator.model, thinkingLevel: this.coordinator.thinkingLevel });
    this.publishJob(job);

    try {
      if (isolationMode === "worktree") {
        await mkdir(join(this.cwd, ".worktrees"), { recursive: true });
        await this.git(["worktree", "add", "-b", branch, worktree, baseRef]);
      }
    } catch (error) {
      this.workerConfigs.delete(job.id);
      job.status = "failed";
      job.activity = undefined;
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      this.publishJob(job);
      throw error;
    }

    job.status = "running";
    job.activity = activity("starting", "Starting worker · attempt 1");
    job.updatedAt = Date.now();
    const token = id();
    job.recovery!.leaseToken = token;
    job.recovery!.leaseAcquiredAt = Date.now();
    job.attempts!.push({ number: 1, generation: 1, token, reason: "initial", startedAt: Date.now() });
    this.publishJob(job);
    void this.runWorker(job, attachments, { generation: 1, token, resume: false });
    return job;
  }

  retryReview(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    this.completionPipeline.retry(job);
  }

  mergeReview(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    this.completionPipeline.requestMerge(job);
  }

  async resumeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.status !== "interrupted" && job.status !== "needs_attention") {
      throw new Error(`Job ${jobId} cannot be resumed from ${job.status}.`);
    }
    if (this.workers.has(jobId)) throw new Error(`Job ${jobId} already has an active worker.`);
    const timer = this.recoveryTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.recoveryTimers.delete(jobId);
    }
    await this.validateRecoveryCheckout(job);
    if (job.status !== "interrupted" && job.status !== "needs_attention") throw new Error(`Job ${jobId} is already being resumed.`);
    if (this.workers.has(jobId)) throw new Error(`Job ${jobId} already has an active worker.`);
    if (!job.recoverable || job.recoveryIssue) throw new Error(job.recoveryIssue || "The recorded checkout is not recoverable.");
    await this.startRecoveryAttempt(job, "manual_resume");
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const timer = this.recoveryTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.recoveryTimers.delete(jobId);
    }
    const worker = this.workers.get(jobId);
    if (worker) {
      worker.cancelled = true;
      await worker.session.abort();
    }
    job.status = "cancelled";
    job.activity = undefined;
    job.recoverable = false;
    job.recoveryIssue = "Cancelled intentionally; automatic recovery is disabled.";
    delete job.recovery?.leaseToken;
    delete job.recovery?.nextRetryAt;
    job.updatedAt = Date.now();
    this.finishAttempt(job, "Cancelled intentionally.");
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
        this.setCoordinatorActivity(activity("starting", "Starting"));
      } else if (event.type === "message_start" && event.message.role === "assistant") {
        streaming = { id: id(), role: "assistant", text: "", timestamp: Date.now() };
        emitted = false;
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_start" || update.type === "thinking_delta") {
          this.setCoordinatorActivity(activity("thinking", "Thinking"));
        } else if (update.type === "toolcall_end") {
          this.setCoordinatorActivity(toolActivity("tool_pending", update.toolCall.name, update.toolCall.arguments));
        } else if (update.type === "text_start" || update.type === "text_delta") {
          this.setCoordinatorActivity(activity("responding", "Writing response"));
          if (update.type === "text_delta" && streaming) {
            if (!emitted) {
              streaming.text = update.delta;
              this.coordinatorMessages.push(streaming);
              this.emit({ type: "coordinator_message", message: { ...streaming } });
              emitted = true;
            } else {
              streaming.text += update.delta;
              this.emit({ type: "coordinator_delta", messageId: streaming.id, delta: update.delta });
            }
            this.persist();
          }
        }
      } else if (event.type === "tool_execution_start") {
        this.setCoordinatorActivity(toolActivity("tool_running", event.toolName, event.args));
      } else if (event.type === "tool_execution_end") {
        this.setCoordinatorActivity(toolActivity(event.isError ? "tool_error" : "tool_complete", event.toolName));
      } else if (event.type === "message_end" && event.message.role === "assistant" && streaming) {
        const finalText = assistantText(event.message);
        const attachments = attachmentsOf(event.message);
        if (finalText || attachments) {
          streaming.text = finalText;
          streaming.attachments = attachments;
          if (!emitted) {
            this.coordinatorMessages.push(streaming);
            this.emit({ type: "coordinator_message", message: { ...streaming } });
          } else this.emit({ type: "coordinator_message_updated", message: { ...streaming } });
        }
        this.persist();
        streaming = undefined;
        emitted = false;
      } else if (event.type === "agent_settled") {
        if (this.coordinatorStatus !== "error") {
          this.coordinatorStatus = "idle";
          this.emit({ type: "coordinator_status", status: "idle" });
        }
        this.setCoordinatorActivity(undefined);
        this.persist();
      }
    });
  }

  private async runWorker(
    job: AgentJob,
    attachments: ImageAttachment[] = [],
    attempt: { generation: number; token: string; resume: boolean },
  ): Promise<void> {
    let session: AgentSession | undefined;
    try {
      if (!this.isCurrentAttempt(job, attempt.generation, attempt.token) || this.workers.has(job.id)) return;
      const loader = new DefaultResourceLoader({
        cwd: job.isolation.path,
        agentDir: getAgentDir(),
        systemPromptOverride: (base) => `${base ?? ""}\n\n# Neocode background worker\nYou are a background worker running in ${job.isolation.mode === "worktree" ? "an isolated git worktree" : "the shared root checkout"} at ${job.isolation.path}. ${job.isolation.mode === "root" && job.isolation.requested === "auto" ? "This task was classified as non-mutating: inspect and report only; do not edit files." : "Complete the assigned task autonomously, including edits when requested."} Run relevant checks. Do not ask conversational questions unless completely blocked. End with a concise report covering changes, tests, and remaining risks.`,
      });
      await loader.reload();
      const workerSessionDir = join(this.stateStore.root, "pi-sessions", "workers", job.id);
      let workerManager: SessionManager;
      let reopened = false;
      const previousSessionFile = this.piSessionFiles.get(job.id);
      if (attempt.resume) {
        const choice = openRecoverySession(
          Boolean(previousSessionFile && await this.pathExists(previousSessionFile)),
          () => SessionManager.open(previousSessionFile!, workerSessionDir, job.isolation.path),
          () => SessionManager.create(job.isolation.path, workerSessionDir),
        );
        workerManager = choice.manager;
        reopened = choice.reopened;
        this.setAttemptSession(job, choice.mode, choice.reopened ? previousSessionFile : undefined);
      } else {
        workerManager = SessionManager.create(job.isolation.path, workerSessionDir);
        this.setAttemptSession(job, "created");
      }
      const workerSessionFile = workerManager.getSessionFile();
      if (workerSessionFile) this.piSessionFiles.set(job.id, workerSessionFile);
      this.persist();
      const workerConfig = this.workerConfigs.get(job.id);
      const result = await createAgentSession({
        cwd: job.isolation.path,
        model: workerConfig?.model,
        thinkingLevel: workerConfig?.thinkingLevel,
        modelRuntime: this.modelRuntime,
        resourceLoader: loader,
        sessionManager: workerManager,
      });
      session = result.session;
      if (!this.isCurrentAttempt(job, attempt.generation, attempt.token) || this.workers.has(job.id)) {
        session.dispose();
        return;
      }
      this.workers.set(job.id, { session, cancelled: false, generation: attempt.generation, token: attempt.token });
      this.bindWorker(job, session, attempt.generation, attempt.token);
      const prompt = attempt.resume ? continuationPrompt(job, reopened) : job.prompt;
      await session.prompt(prompt, attachments.length ? {
        images: attachments.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
      } : undefined);

      const activeWorker = this.workers.get(job.id);
      if (activeWorker?.cancelled || !this.isCurrentAttempt(job, attempt.generation, attempt.token)) return;
      job.status = "completed";
      job.activity = undefined;
      job.summary = [...job.messages].reverse().find((message) => message.role === "assistant")?.text;
      await this.refreshDiff(job);
      job.updatedAt = Date.now();
      job.recoverable = false;
      delete job.recoveryIssue;
      this.finishAttempt(job);
      this.publishJob(job);
      // This call is in the worker lifecycle itself: no coordinator prompt,
      // list_jobs poll, or WebSocket request is needed to start review.
      this.completionPipeline.enqueue(job);
    } catch (error) {
      if (this.workers.get(job.id)?.cancelled || job.status === "cancelled"
        || !this.isCurrentAttempt(job, attempt.generation, attempt.token)) return;
      job.status = "failed";
      job.activity = undefined;
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      this.finishAttempt(job, job.error);
      this.publishJob(job);
    } finally {
      const worker = this.workers.get(job.id);
      if (worker?.generation === attempt.generation && worker.token === attempt.token) {
        this.workers.delete(job.id);
        this.workerConfigs.delete(job.id);
      }
      session?.dispose();
    }
  }

  private bindWorker(job: AgentJob, session: AgentSession, generation: number, token: string): void {
    let streaming: TranscriptMessage | undefined;
    let emitted = false;
    const setActivity = (next: AgentActivity | undefined) => {
      if (!this.isCurrentAttempt(job, generation, token)) return;
      if (job.activity?.phase === next?.phase && job.activity?.description === next?.description) return;
      job.activity = next;
      job.updatedAt = Date.now();
      this.publishJob(job);
    };
    session.subscribe((event) => {
      if (!this.isCurrentAttempt(job, generation, token)) return;
      if (event.type === "agent_start") setActivity(activity("starting", `Starting · attempt ${job.attempts?.length || 1}`));
      else if (event.type === "message_start") {
        const role = roleOf(event.message);
        if (role === "assistant") {
          streaming = { id: id(), role, text: "", timestamp: Date.now() };
          emitted = false;
        } else if (role === "tool") {
          const text = textOf(event.message);
          const messageAttachments = attachmentsOf(event.message);
          if (!text && !messageAttachments) return;
          job.messages.push({ id: id(), role, text, timestamp: Date.now(), attachments: messageAttachments });
          job.updatedAt = Date.now();
          this.publishJob(job);
        }
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_start" || update.type === "thinking_delta") setActivity(activity("thinking", "Thinking"));
        else if (update.type === "toolcall_end") setActivity(toolActivity("tool_pending", update.toolCall.name, update.toolCall.arguments));
        else if (update.type === "text_start" || update.type === "text_delta") {
          setActivity(activity("responding", "Writing response"));
          if (update.type === "text_delta" && streaming) {
            if (!emitted) { streaming.text = update.delta; job.messages.push(streaming); emitted = true; }
            else streaming.text += update.delta;
            job.updatedAt = Date.now();
            this.publishJob(job);
          }
        }
      } else if (event.type === "tool_execution_start") setActivity(toolActivity("tool_running", event.toolName, event.args));
      else if (event.type === "tool_execution_end") setActivity(toolActivity(event.isError ? "tool_error" : "tool_complete", event.toolName));
      else if (event.type === "message_end" && event.message.role === "assistant" && streaming) {
        const finalText = assistantText(event.message);
        const messageAttachments = attachmentsOf(event.message);
        if (finalText || messageAttachments) {
          streaming.text = finalText;
          streaming.attachments = messageAttachments;
          if (!emitted) job.messages.push(streaming);
          job.updatedAt = Date.now();
          this.publishJob(job);
        }
        streaming = undefined;
        emitted = false;
      }
    });
  }

  private async runJudge(job: AgentJob, diff: string, diffSha256: string): Promise<JudgeEvidence> {
    const configured = process.env.NEOCODE_JUDGE_MODEL?.trim();
    const available = this.modelRuntime.getAvailableSnapshot();
    const separator = configured?.indexOf("/") ?? -1;
    if (configured && (separator < 1 || separator === configured.length - 1)) {
      throw new Error("NEOCODE_JUDGE_MODEL must be provider/model-id.");
    }
    const model = configured
      ? available.find((candidate) => candidate.provider === configured.slice(0, separator) && candidate.id === configured.slice(separator + 1))
      : this.coordinator.model;
    if (!model) throw new Error(configured
      ? `Configured judge model is unavailable: ${configured}`
      : "No judge model is available. Configure NEOCODE_JUDGE_MODEL=provider/model-id.");

    const judgeDir = join(this.stateStore.root, "pi-sessions", "judges", job.id, `${job.review?.attempt || 1}-${randomUUID()}`);
    const manager = SessionManager.create(job.isolation.path, judgeDir);
    const sessionFile = manager.getSessionFile();
    const loader = new DefaultResourceLoader({
      cwd: job.isolation.path,
      agentDir: getAgentDir(),
      systemPromptOverride: () => `# Neocode independent completion judge\nYou are a fresh, read-only review session. You did not implement the change. Evaluate only the supplied task requirements and exact diff. Do not trust the worker report or prose claims. You may inspect repository files with read-only tools. Return one JSON object and no markdown: {"approved":boolean,"summary":string,"diffSha256":string,"requirements":[{"requirement":string,"satisfied":boolean,"evidence":string}]}. Approval requires every material requirement to be represented, satisfied, and supported by concrete diff/CI evidence.`,
    });
    await loader.reload();
    let raw = "";
    const result = await createAgentSession({
      cwd: job.isolation.path,
      model,
      thinkingLevel: "high",
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      sessionManager: manager,
      tools: ["read", "grep", "find", "ls"],
    });
    const session = result.session;
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") raw = assistantText(event.message);
    });
    try {
      await session.prompt(`TASK REQUIREMENTS:\n${job.prompt}\n\nCI EVIDENCE:\n${JSON.stringify(job.review?.ci || [])}\n\nEXACT DIFF SHA-256: ${diffSha256}\n\nEXACT DIFF:\n${diff || "(empty diff)"}`);
    } finally {
      session.dispose();
    }

    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: unknown;
    try { parsed = JSON.parse(jsonText); } catch { throw new Error("Judge did not return valid structured JSON."); }
    if (!parsed || typeof parsed !== "object") throw new Error("Judge verdict is not an object.");
    const verdict = parsed as Record<string, unknown>;
    if (typeof verdict.approved !== "boolean" || typeof verdict.summary !== "string" || verdict.diffSha256 !== diffSha256 || !Array.isArray(verdict.requirements)) {
      throw new Error("Judge verdict is missing required structured fields or the exact diff hash.");
    }
    const requirements = verdict.requirements.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Judge requirement evidence is invalid.");
      const item = entry as Record<string, unknown>;
      if (typeof item.requirement !== "string" || typeof item.satisfied !== "boolean" || typeof item.evidence !== "string") {
        throw new Error("Judge requirement evidence is invalid.");
      }
      return { requirement: item.requirement, satisfied: item.satisfied, evidence: item.evidence };
    });
    return {
      approved: verdict.approved,
      summary: verdict.summary,
      requirements,
      model: { provider: model.provider, id: model.id },
      diffSha256,
      sessionFile,
      raw,
    };
  }

  private async refreshDiff(job: AgentJob): Promise<void> {
    job.diff = await readWorktreeDiff(job.isolation.path, job.baseRef);
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

  private availableVariants(): AgentVariant[] {
    const toolNames = new Set(this.coordinator.getAllTools().map((tool) => tool.name));
    return VARIANTS.filter((variant) => variant === "plan" || toolNames.has("delegate_task"));
  }

  private applyVariantTools(): void {
    const available = this.availableVariants();
    if (!available.includes(this.coordinatorVariant)) this.coordinatorVariant = available[0] ?? "plan";
    this.coordinator.setActiveToolsByName(this.coordinatorVariant === "plan" ? PLAN_TOOLS : BUILD_TOOLS);
  }

  private settings(): AgentSettings {
    return {
      variant: this.coordinatorVariant,
      thinkingLevel: this.coordinator.thinkingLevel,
      availableVariants: this.availableVariants(),
      availableThinkingLevels: this.coordinator.supportsThinking()
        ? [...this.coordinator.getAvailableThinkingLevels()]
        : [],
    };
  }

  private publishSettings(): AgentSettings {
    const settings = this.settings();
    this.emit({ type: "coordinator_settings", settings });
    return settings;
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

  private setCoordinatorActivity(next: AgentActivity | undefined): void {
    if (this.coordinatorActivity?.phase === next?.phase
      && this.coordinatorActivity?.description === next?.description) return;
    this.coordinatorActivity = next;
    this.emit({ type: "coordinator_activity", activity: next });
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
    for (const job of this.jobs.values()) {
      const wasActive = job.status === "running" || job.status === "queued";
      const wasScheduledRecovery = job.status === "interrupted" && job.recovery?.nextRetryAt !== undefined;
      // Activity describes live in-process work and must never be fabricated on restore.
      job.activity = undefined;
      if (!wasActive && !wasScheduledRecovery) continue; // Terminal/review states are never made resumable by startup.

      job.status = "interrupted";
      job.updatedAt = Date.now();
      job.recovery ??= { retryCount: 0, maxRetries: this.recoveryConfig.maxRetries, generation: 0 };
      job.recovery.maxRetries = this.recoveryConfig.maxRetries;
      delete job.recovery.leaseToken; // the old process did not survive
      delete job.recovery.leaseAcquiredAt;
      if (wasActive) this.finishAttempt(job, "Backend restart interrupted this attempt.");
      await this.validateRecoveryCheckout(job);

      if (job.isolation.mode === "root" && !isClearlyReadOnlyRoot(job)) {
        job.status = "needs_attention";
        job.recoverable = true;
        job.recovery.needsConfirmation = true;
        job.recoveryIssue = "Shared-root or potentially mutating root work requires explicit Resume confirmation after restart.";
      } else if (job.recoverable) {
        this.startupRecoveryIds.add(job.id);
      } else {
        job.status = "needs_attention";
      }
      this.publishJob(job);
    }
  }

  private async validateRecoveryCheckout(job: AgentJob): Promise<void> {
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

    const path = job.isolation.mode === "root" ? this.cwd : job.isolation.path;
    if (job.isolation.mode === "root") {
      job.isolation.path = this.cwd;
      job.worktree = this.cwd;
    }
    const exists = await this.pathExists(path);
    const registeredBranch = registered.get(path);
    const isRegistered = registered.has(path);
    const branchMatches = registeredBranch === job.branch;
    job.recoverable = exists && isRegistered && branchMatches;
    if (!exists || !isRegistered || !branchMatches) {
      job.recoveryIssue = !exists
        ? "The recorded worktree no longer exists."
        : !isRegistered
          ? "The recorded path exists but is not a registered git worktree."
          : `The worktree is on ${registeredBranch || "a detached HEAD"}, not ${job.branch}.`;
      return;
    }

    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: path }).then(({ stdout }) => stdout, () => undefined);
    if (status === undefined) {
      job.recoverable = false;
      job.recoveryIssue = "The recorded checkout could not be inspected with git status.";
      return;
    }
    job.recovery ??= { retryCount: 0, maxRetries: this.recoveryConfig.maxRetries, generation: 0 };
    job.recovery.checkoutDirty = status.trim().length > 0;
    delete job.recoveryIssue;
    await this.refreshDiff(job).catch(() => undefined);
  }

  private async resumeRestoredJobs(): Promise<void> {
    for (const jobId of this.startupRecoveryIds) {
      const job = this.jobs.get(jobId);
      if (!job || !canAutomaticallyResume(job)) continue;
      const recovery = job.recovery!;
      if (recovery.retryCount >= recovery.maxRetries) {
        job.status = "needs_attention";
        job.recoverable = true;
        job.recoveryIssue = `Automatic recovery exhausted after ${recovery.retryCount} restart attempt${recovery.retryCount === 1 ? "" : "s"}. Use Resume to continue explicitly.`;
        delete recovery.nextRetryAt;
        this.publishJob(job);
        continue;
      }

      const nextRetry = recovery.retryCount + 1;
      const delay = recovery.nextRetryAt === undefined
        ? retryDelay(this.recoveryConfig, nextRetry)
        : Math.max(0, recovery.nextRetryAt - Date.now());
      recovery.nextRetryAt ??= Date.now() + delay;
      job.activity = activity("starting", `Recovery attempt ${nextRetry}/${recovery.maxRetries} scheduled`);
      job.updatedAt = Date.now();
      this.publishJob(job);
      await this.stateStore.flush();
      const timer = setTimeout(() => {
        this.recoveryTimers.delete(job.id);
        void this.launchScheduledRecovery(job);
      }, delay);
      timer.unref?.();
      this.recoveryTimers.set(job.id, timer);
    }
    this.startupRecoveryIds.clear();
  }

  private async launchScheduledRecovery(job: AgentJob): Promise<void> {
    if (job.status !== "interrupted" || this.workers.has(job.id) || !job.recovery?.nextRetryAt) return;
    await this.validateRecoveryCheckout(job);
    if (job.status !== "interrupted" || this.workers.has(job.id)) return;
    if (!canAutomaticallyResume(job)) {
      job.status = "needs_attention";
      job.activity = undefined;
      job.recoveryIssue ||= "The checkout changed while automatic recovery was waiting.";
      this.publishJob(job);
      return;
    }
    await this.startRecoveryAttempt(job, "backend_restart");
  }

  private async startRecoveryAttempt(job: AgentJob, reason: "backend_restart" | "manual_resume"): Promise<void> {
    if (this.workers.has(job.id)) throw new Error(`Job ${job.id} already has an active worker.`);
    const recovery = job.recovery ??= { retryCount: 0, maxRetries: this.recoveryConfig.maxRetries, generation: 0 };
    if (reason === "backend_restart") recovery.retryCount += 1;
    const generation = recovery.generation + 1;
    const token = id();
    recovery.generation = generation;
    recovery.leaseToken = token;
    recovery.leaseAcquiredAt = Date.now();
    delete recovery.nextRetryAt;
    delete recovery.needsConfirmation;
    job.attempts ??= [];
    job.attempts.push({
      number: job.attempts.length + 1,
      generation,
      token,
      reason,
      startedAt: Date.now(),
    });
    job.messages.push({
      id: id(),
      role: "system",
      text: `${reason === "manual_resume" ? "Manual resume" : "Automatic backend-restart recovery"}: starting worker attempt ${job.attempts.length} (retry ${recovery.retryCount}/${recovery.maxRetries}). Existing checkout changes and durable transcript are preserved.`,
      timestamp: Date.now(),
    });
    job.status = "running";
    job.activity = activity("starting", `${reason === "manual_resume" ? "Resuming" : "Recovering"} · attempt ${job.attempts.length} · retry ${recovery.retryCount}`);
    job.updatedAt = Date.now();
    delete job.error;
    delete job.recoveryIssue;
    this.workerConfigs.set(job.id, { model: this.coordinator.model, thinkingLevel: job.settings?.thinkingLevel || this.coordinator.thinkingLevel });
    // The generation/lease and visible attempt must reach disk before any Pi
    // process can execute tools. Stale callbacks are ignored by generation.
    this.publishJob(job);
    await this.stateStore.flush();
    void this.runWorker(job, [], { generation, token, resume: true });
  }

  private isCurrentAttempt(job: AgentJob, generation: number, token: string): boolean {
    return isDurableAttemptCurrent(job, generation, token);
  }

  private setAttemptSession(job: AgentJob, mode: "created" | "opened" | "fresh_fallback", sessionFile?: string): void {
    const attempt = job.attempts?.at(-1);
    if (!attempt) return;
    attempt.sessionMode = mode;
    attempt.sessionFile = sessionFile;
    job.updatedAt = Date.now();
  }

  private finishAttempt(job: AgentJob, error?: string): void {
    const attempt = job.attempts?.at(-1);
    if (attempt && !attempt.finishedAt) {
      attempt.finishedAt = Date.now();
      if (error) attempt.error = error;
    }
    if (job.recovery) {
      delete job.recovery.leaseToken;
      delete job.recovery.leaseAcquiredAt;
    }
  }

  private fail(error: unknown): void {
    this.coordinatorStatus = "error";
    this.persist();
    this.emit({ type: "coordinator_status", status: "error" });
    this.setCoordinatorActivity(undefined);
    this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
