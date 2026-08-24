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
  type CoordinatorCompactionStatus,
  type CoordinatorContextState,
  type ImageAttachment,
  type JudgeEvidence,
  type ModelChoice,
  type ModelRef,
  type MaintenanceStatus,
  type PromptSettlementSnapshot,
  type RequestedIsolationMode,
  type ServerMessage,
  type TranscriptMessage,
  type TranscriptThread,
} from "@neocode/protocol";
import { activity, ActivityTimeline, toolActivity } from "./activity.js";
import { CompletionPipeline, LocalReviewAdapter, readWorktreeDiff } from "./completion-pipeline.js";
import { CoordinatorNotificationQueue } from "./coordinator-notifications.js";
import { checkpointPromptResponse, queuedCoordinatorPrompt, reconcileRestoredPromptStates, setPromptProcessing, settlePrompt } from "./coordinator-prompt-state.js";
import { imagesForPi } from "./image-attachments.js";


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
  type CoordinatorNotificationState,
  type CoordinatorWorkerEvent,
  type DurableCoordinatorPrompt,
  type DurableRuntimeState,
} from "./runtime-state.js";
import { OperationLock, WorktreeJanitor } from "./worktree-janitor.js";
import { transcriptPage } from "./transcript-pagination.js";
import { integrationComplexityScore } from "./integration-priority.js";

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
export interface MaintenanceConfig {
  graceMs?: number;
  intervalMs?: number;
  sweepIntervalMs?: number;
  reviewConcurrency?: number;
  targetRef?: string;
  startup?: boolean;
}

const BUILD_TOOLS = ["read", "grep", "find", "ls", "delegate_task", "list_jobs", "inspect_job", "resume_worker", "start_judge", "request_worker_changes", "retry_infrastructure", "guarded_merge", "verify_integration", "mark_not_required", "reconcile_jobs", "clean_worktrees"];
const PLAN_TOOLS = ["read", "grep", "find", "ls", "list_jobs", "inspect_job"];
const VARIANTS: AgentVariant[] = ["build", "plan"];

function id(): string {
  return randomUUID();
}

export function executeCoordinatorGuardedMerge(
  pipeline: Pick<CompletionPipeline, "requestMerge">,
  capability: symbol,
  requireJob: (jobId: string) => AgentJob,
  jobId: string,
) {
  pipeline.requestMerge(requireJob(jobId), capability);
  return { content: [{ type: "text" as const, text: `Coordinator authorized guarded rebased fast-forward for ${jobId}.` }], details: { jobId } };
}

export function workerSystemPrompt(base: string | undefined, job: Pick<AgentJob, "isolation">): string {
  const inWorktree = job.isolation.mode === "worktree";
  const checkout = inWorktree ? "an isolated git worktree" : "the explicitly selected shared root checkout";
  const assignment = inWorktree
    ? "Complete the assigned task autonomously, including edits when requested. Keep all implementation and conflict-resolution edits inside this assigned checkout; never mutate root/main."
    : "Root isolation remains recorded as requested, but background workers are read-only there: inspect and report only; do not edit or mutate the shared checkout.";
  return `${base ?? ""}\n\n# Neocode background worker\nYou are a background worker running in ${checkout} at ${job.isolation.path}. ${assignment} You never merge or advance the main ref, launch a judge, judge the work yourself, or directly start integration; only the MAIN coordinator owns those decisions and tool calls. Run relevant checks. Do not ask conversational questions unless completely blocked. End with a structured, concise handoff covering requirements, changes, tests, and unresolved risks.`;
}

function normalizeActivityTiming(value: AgentActivity): AgentActivity {
  const startedAt = Number.isFinite(value.startedAt) ? value.startedAt : value.updatedAt;
  return { ...value, startedAt, updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : startedAt };
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
  private readonly workerTimelines = new Map<string, ActivityTimeline>();
  private readonly coordinatorMessages: TranscriptMessage[] = [];
  private readonly pendingCoordinatorPrompts: DurableCoordinatorPrompt[] = [];
  private readonly acceptingCoordinatorPromptIds = new Set<string>();
  private promptDrain?: Promise<void>;
  private coordinatorPromptDrainBlocked = false;
  // User prompts and durable system wakes share one Pi AgentSession. Reserve
  // the turn synchronously so their independent drains cannot both observe an
  // idle session and race into prompt().
  private coordinatorTurnInFlight = false;
  private activeCoordinatorPromptId?: string;
  private promptResponseCheckpoint?: { messageId: string; flushed: Promise<void> };
  private promptSettlement: PromptSettlementSnapshot = { throughTimestamp: 0, failures: [] };
  private readonly coordinatorActivityHistory: AgentActivity[] = [];
  private readonly coordinatorTimeline = new ActivityTimeline(undefined, this.coordinatorActivityHistory);
  private readonly piSessionFiles = new Map<string, string>();
  private readonly stateStore: RuntimeStateStore;
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly startupRecoveryIds = new Set<string>();
  private readonly recoveryConfig: RecoveryConfig;
  private readonly notificationState: CoordinatorNotificationState = { events: [], lastSignals: {} };
  private coordinatorNotifications?: CoordinatorNotificationQueue;
  private coordinatorSessionFile?: string;
  private coordinatorStatus: AgentStatus = "idle";
  private coordinatorActivity: AgentActivity | undefined;
  private coordinatorVariant: AgentVariant = "build";
  private coordinatorAborting = false;
  private modelChangeInProgress = false;
  private coordinatorCompacting = false;
  private coordinatorContextUnknownAfterCompaction = false;
  private coordinatorCompaction?: CoordinatorCompactionStatus;
  private disposing = false;
  private modelRuntime!: ModelRuntime;
  private coordinator!: AgentSession;
  private completionPipeline!: CompletionPipeline;
  readonly #coordinatorMergeCapability = Symbol("main coordinator guarded integration");
  private readonly operationLock = new OperationLock();
  private readonly janitor: WorktreeJanitor;
  private maintenance: MaintenanceStatus = { state: "idle" };
  private janitorTimer?: NodeJS.Timeout;
  private janitorRun?: Promise<void>;
  private sweepTimer?: NodeJS.Timeout;
  private sweepScheduled = false;
  private sweepRun?: Promise<void>;
  private readonly sweepJobIds = new Set<string>();
  private readonly maintenanceConfig: Required<MaintenanceConfig>;


  readonly cwd: string;

  constructor(
    cwd: string,
    private readonly emit: Emit,
    maintenanceConfig: MaintenanceConfig = {},
  ) {
    // The server resolves this before constructing the orchestrator. Keeping a
    // single root here prevents the coordinator from following worker cwd state.
    this.cwd = cwd;
    this.stateStore = new RuntimeStateStore(cwd);
    this.recoveryConfig = recoveryConfig();
    this.maintenanceConfig = {
      graceMs: maintenanceConfig.graceMs ?? 7 * 24 * 60 * 60 * 1000,
      intervalMs: maintenanceConfig.intervalMs ?? 6 * 60 * 60 * 1000,
      sweepIntervalMs: maintenanceConfig.sweepIntervalMs ?? 30_000,
      reviewConcurrency: Math.max(1, Math.floor(maintenanceConfig.reviewConcurrency ?? 2)),
      targetRef: maintenanceConfig.targetRef ?? "main",
      startup: maintenanceConfig.startup ?? true,
    };
    this.janitor = new WorktreeJanitor(cwd, {
      graceMs: this.maintenanceConfig.graceMs,
      targetRef: this.maintenanceConfig.targetRef,
    });

  }

  async initialize(): Promise<void> {
    await this.ensureLocalExcludes();
    const restored = await this.stateStore.load();
    if (restored) {
      this.coordinatorMessages.push(...restored.coordinator.messages);
      this.pendingCoordinatorPrompts.push(...(restored.coordinator.pendingPrompts || []).map((entry) => ({
        ...entry,
        context: [...entry.context],
      })));
      this.promptSettlement = structuredClone(restored.coordinator.promptSettlement || this.promptSettlement);
      const respondedTimestamps = this.pendingCoordinatorPrompts
        .filter((entry) => entry.state === "responded")
        .map((entry) => entry.createdAt);
      reconcileRestoredPromptStates(this.coordinatorMessages, this.pendingCoordinatorPrompts);
      if (respondedTimestamps.length) this.promptSettlement.throughTimestamp = Math.max(
        this.promptSettlement.throughTimestamp, ...respondedTimestamps,
      );
      this.coordinatorActivityHistory.push(...(restored.coordinator.activityHistory || []).map(normalizeActivityTiming));
      if (restored.coordinator.activity) {
        const completedAt = Date.now();
        const interrupted = normalizeActivityTiming(restored.coordinator.activity);
        this.coordinatorActivityHistory.unshift({
          ...interrupted,
          completedAt,
          durationMs: Math.max(0, completedAt - interrupted.startedAt),
          outcome: "interrupted",
          updatedAt: completedAt,
        });
      }
      this.coordinatorActivityHistory.length = Math.min(this.coordinatorActivityHistory.length, 12);
      this.coordinatorSessionFile = restored.coordinator.piSessionFile;
      for (const entry of restored.jobs) {
        this.jobs.set(entry.job.id, entry.job);
        if (entry.piSessionFile) this.piSessionFiles.set(entry.job.id, entry.piSessionFile);
      }
      if (restored.coordinatorNotifications) {
        this.restoreCoordinatorNotificationState(restored.coordinatorNotifications);
      } else {
        // Upgrading an existing runtime must not replay every historical terminal job.
        for (const job of this.jobs.values()) this.notificationState.lastSignals[job.id] = `baseline:${job.updatedAt}`;
      }
      if (restored.maintenance) this.maintenance = { ...restored.maintenance, state: "idle" };
      await this.reconcileRestoredJobs();
    }

    this.modelRuntime = await ModelRuntime.create();
    await this.modelRuntime.getAvailable();

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      systemPromptOverride: (base) => `${base ?? ""}\n\n# Neocode coordinator\nYou are the user's responsive, non-editing MAIN coordinator. Your primary job is reconciliation and integration, while remaining available for normal user questions. You always run at the root repository. Never edit files or run mutating commands yourself. Delegate implementation to worktree workers. Worker handoffs appear as durable lifecycle events: inspect them, explicitly start a fresh independent judge, and only after final approval call guarded_merge. guarded_merge is a compatibility name: the server first rebases the worker onto current main, judges and validates that exact rebased head, and advances main with --ff-only; never create merge commits. Every action_required event must be inspected for the exact command/output. For source, test, judge, conflict, or post-merge failures, quote specific diagnostics with request_worker_changes so the SAME worktree is resumed; await its new handoff, rerun CI, and launch a fresh judge. For a genuinely transient failure use retry_infrastructure. Never bypass bounded repair rounds; needs_attention requires reporting all evidence. Judges report to you and never merge. Conflicts must return to the same worker, be handed off, and be re-judged. Never ask a worker to mutate root/main. After a guarded merge, call reconcile_jobs so externally or previously integrated workers move to Done, then clean_worktrees to safely remove only clean, Git-verified worktrees. While idle, durable backlog sweep events continuously fill a bounded set of review/remediation lanes, prioritized by deterministic diff size, file overlap, and aging; final main integration remains serialized. Act on each sweep rather than merely summarizing it: inspect the job and take the next safe lifecycle action. When committed work is demonstrably replaced by a job or commit already verified on main, use mark_not_required with specific evidence instead of reviewing obsolete work; never supersede dirty, active, or merely inconvenient work. Resume an interrupted recoverable worker with resume_worker; never resume a branch whose durable safety checks reject it. Lifecycle events queue while user prompts have priority; resume them afterward. Never claim success before exact-diff review and verified merge.`,

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
        name: "inspect_job", label: "Inspect job", description: "Inspect a worker handoff, review evidence, and exact diff.",
        parameters: Type.Object({ jobId: Type.String() }),
        execute: async (_callId: string, params: { jobId: string }) => {
          const job = this.requireJob(params.jobId); await this.refreshDiff(job);
          const output = [`${job.id} [${job.status}] ${job.title}`, `Isolation: ${job.isolation.mode} (${job.isolation.path})`,
            job.handoff ? `\nHandoff round ${job.handoff.round}:\n${JSON.stringify(job.handoff, null, 2)}` : "",
            job.summary ? `\nReport:\n${job.summary}` : "", job.diff ? `\nDiff:\n${job.diff.slice(0, 40_000)}` : "\nNo diff yet.",
            job.review ? `\nLifecycle:\n${JSON.stringify(job.review, null, 2)}` : "", job.error ? `\nError:\n${job.error}` : ""].join("");
          return { content: [{ type: "text" as const, text: output }], details: { jobId: job.id } };
        },
      },
      {
        name: "resume_worker", label: "Resume worker", description: "Resume an interrupted recoverable worker in its verified existing checkout.",
        parameters: Type.Object({ jobId: Type.String() }),
        execute: async (_callId: string, params: { jobId: string }) => {
          await this.resumeJob(params.jobId);
          return { content: [{ type: "text" as const, text: `Worker ${params.jobId} resumed in its existing checkout.` }], details: { jobId: params.jobId } };
        },
      },
      {
        name: "start_judge", label: "Start independent judge", description: "Coordinator-owned exact-diff CI and fresh independent judge review.",
        parameters: Type.Object({ jobId: Type.String() }),
        execute: async (_callId: string, params: { jobId: string }) => { this.completionPipeline.startJudge(this.requireJob(params.jobId)); return { content: [{ type: "text" as const, text: `Judge started for ${params.jobId}.` }], details: { jobId: params.jobId } }; },
      },
      {
        name: "request_worker_changes", label: "Request worker changes", description: "Send specific judge/coordinator feedback and resume the same worktree.",
        parameters: Type.Object({ jobId: Type.String(), feedback: Type.String() }),
        execute: async (_callId: string, params: { jobId: string; feedback: string }) => { await this.requestWorkerChanges(params.jobId, params.feedback); return { content: [{ type: "text" as const, text: `Feedback sent and worker ${params.jobId} resumed.` }], details: { jobId: params.jobId } }; },
      },
      {
        name: "retry_infrastructure", label: "Retry infrastructure", description: "Coordinator-owned bounded retry for a diagnosed transient CI/infrastructure failure.",
        parameters: Type.Object({ jobId: Type.String(), reason: Type.String() }),
        execute: async (_callId: string, params: { jobId: string; reason: string }) => {
          this.completionPipeline.retryInfrastructure(this.requireJob(params.jobId), params.reason);
          return { content: [{ type: "text" as const, text: `Bounded infrastructure retry scheduled for ${params.jobId}.` }], details: { jobId: params.jobId } };
        },
      },
      {
        name: "guarded_merge", label: "Guarded fast-forward", description: "Authorize serialized integration of the exact rebased diff with --ff-only after fresh judge approval.",
        parameters: Type.Object({ jobId: Type.String() }),
        execute: async (_callId: string, params: { jobId: string }) => executeCoordinatorGuardedMerge(
          this.completionPipeline, this.#coordinatorMergeCapability, (jobId) => this.requireJob(jobId), params.jobId,
        ),
      },
      {
        name: "verify_integration", label: "Verify integration", description: "Verify one job against main and return its persisted merge and CI evidence without authorizing a merge.",
        parameters: Type.Object({ jobId: Type.String() }),
        execute: async (_callId: string, params: { jobId: string }) => {
          await this.reconcileIntegratedJobs();
          const job = this.requireJob(params.jobId);
          if (job.integration?.status !== "merged") throw new Error(`Job ${params.jobId} is not verified on main.`);
          const evidence = {
            jobId: job.id,
            targetRef: job.integration.targetRef,
            targetHead: job.integration.targetHead,
            completionHead: job.integration.completionHead,
            verifiedAt: job.integration.verifiedAt,
            reviewedDiffSha256: job.review?.judge?.diffSha256,
            checks: job.review?.postMergeCi || [],
          };
          return { content: [{ type: "text" as const, text: `Verified ${job.id} on ${evidence.targetRef || "main"} at ${evidence.targetHead || "unknown head"}.` }], details: evidence };
        },
      },
      {
        name: "mark_not_required", label: "Mark not required", description: "Mark clean committed work as superseded only when a replacement job or commit is already verified on main. The branch is retained.",
        parameters: Type.Object({
          jobId: Type.String(),
          reason: Type.String({ description: "Specific evidence explaining why this work is no longer required" }),
          supersededByJobId: Type.Optional(Type.String()),
          supersededByCommit: Type.Optional(Type.String()),
        }),
        execute: async (_callId: string, params: { jobId: string; reason: string; supersededByJobId?: string; supersededByCommit?: string }) => {
          const job = await this.markNotRequired(params);
          return { content: [{ type: "text" as const, text: `Marked ${job.id} Not required · superseded. Its committed branch remains retained.` }], details: { jobId: job.id, integration: job.integration } };
        },
      },
      {
        name: "reconcile_jobs", label: "Reconcile jobs", description: "Verify completed worker commits against main and move proven integrated or no-op jobs to Done.",
        parameters: Type.Object({}),
        execute: async () => {
          const result = await this.reconcileIntegratedJobs();
          return { content: [{ type: "text" as const, text: `Reconciled ${result.integrated} integrated and ${result.noOp} no-op jobs; ${result.pending} still have unique work.` }], details: result };
        },
      },
      {
        name: "clean_worktrees", label: "Clean worktrees", description: "Remove clean worktrees only after Git proves their work is integrated or empty. Bypasses the observation grace period but never safety checks.",
        parameters: Type.Object({}),
        execute: async () => {
          await this.reconcileIntegratedJobs();
          await this.cleanNow(true);
          return { content: [{ type: "text" as const, text: `Verified worktree cleanup finished: ${this.maintenance.removed || 0} removed, ${this.maintenance.refused || 0} retained.` }], details: { ...this.maintenance } };
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
      tools: BUILD_TOOLS,
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
    this.completionPipeline = new CompletionPipeline(reviewAdapter, (job) => this.publishJob(job), targetBranch, this.cwd, this.operationLock, this.#coordinatorMergeCapability);
    await this.reconcileIntegratedJobs(targetBranch);
    this.initializeCoordinatorNotifications();
    // Old runtimes could have queued review metadata without the structured
    // handoff now required by coordinator-owned judging. Upgrade only that
    // passive queued state from a freshly read exact diff.
    for (const job of this.listJobs()) {
      if (job.status !== "completed" || job.handoff || job.review?.status !== "queued") continue;
      await this.refreshDiff(job).then(() => this.completionPipeline.migrateLegacyHandoff(job)).catch(() => undefined);
    }
    this.completionPipeline.recover(this.listJobs());
    await this.resumeClaimedRemediations();
    // Observe current durable states after queue construction so startup
    // recovery is visible without replaying side effects.
    for (const job of this.listJobs()) this.coordinatorNotifications!.observe(job);
    this.persist();
    if (!this.pendingCoordinatorPrompts.length) this.coordinatorNotifications!.settled();
    await this.resumeRestoredJobs();
    if (this.maintenanceConfig.startup) this.startCleanup("startup");
    if (this.maintenanceConfig.intervalMs > 0) {
      this.janitorTimer = setInterval(() => this.startCleanup("scheduled"), this.maintenanceConfig.intervalMs);
      this.janitorTimer.unref();
    }
    if (this.maintenanceConfig.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        // A restored Pi session can become idle without emitting a fresh
        // agent_settled event. Always retry durable wake delivery before the
        // fallback sweep so completed handoffs cannot remain stranded.
        this.coordinatorNotifications?.settled();
        this.scheduleBacklogSweep();
      }, this.maintenanceConfig.sweepIntervalMs);
      this.sweepTimer.unref();
      this.scheduleBacklogSweep();
    }
    this.schedulePromptDrain();

  }

  snapshot(): AppSnapshot {
    const coordinatorWindow = transcriptPage(this.coordinatorMessages);
    return {
      cwd: this.cwd,
      coordinator: {
        status: this.coordinatorStatus,
        activity: this.coordinatorActivity,
        activityHistory: [...this.coordinatorActivityHistory],
        messages: coordinatorWindow.messages,
        transcriptPage: coordinatorWindow.page,
        promptSettlement: this.promptSettlement
          ? { throughTimestamp: this.promptSettlement.throughTimestamp, failures: [...this.promptSettlement.failures] }
          : undefined,
        settings: this.settings(),
        model: this.currentModel(),
        models: this.modelChoices(),
        context: this.coordinatorContextState(),
      },
      jobs: this.listJobs().map((job) => this.transportJob(job)),
      maintenance: { ...this.maintenance },
    };
  }

  transcriptPage(thread: TranscriptThread, before?: string, limit?: number) {
    const source = thread.kind === "coordinator"
      ? this.coordinatorMessages
      : this.jobs.get(thread.jobId)?.messages;
    if (!source) throw new Error("Unknown transcript thread.");
    return transcriptPage(source, before, limit);
  }

  private transportJob(job: AgentJob): AgentJob {
    const window = transcriptPage(job.messages);
    // Exclude the durable transcript before cloning metadata. Cloning the full
    // job and then replacing messages makes every update O(total history).
    const { messages: _durableMessages, transcriptPage: _transportPage, ...metadata } = job;
    // send() serializes synchronously; a deep clone here duplicated large
    // diffs and CI evidence for every streamed activity update.
    return { ...metadata, messages: window.messages, transcriptPage: window.page };
  }

  async prompt(text: string, context: string[] = [], attachments: ImageAttachment[] = [], requestId?: string): Promise<void> {
    const messageId = requestId || id();
    // A reconnecting client may retry an accepted command. Its client id is the
    // durable idempotency key, so neither transcript nor queue can duplicate it.
    if (this.coordinatorMessages.some((message) => message.id === messageId)) return;
    const { message: userMessage, pending } = queuedCoordinatorPrompt({
      id: messageId,
      text,
      context,
      attachments,
      mode: this.coordinatorVariant,
      now: Date.now(),
      previousTimestamp: this.coordinatorMessages.at(-1)?.timestamp,
    });
    this.coordinatorMessages.push(userMessage);
    this.pendingCoordinatorPrompts.push(pending);
    this.acceptingCoordinatorPromptIds.add(messageId);
    this.persist();
    this.publishCoordinatorContext();
    try {
      // Queue acknowledgement is acceptance truth, so it must never race the
      // atomic durable write that makes this prompt recoverable.
      await this.stateStore.flush();
    } catch (error) {
      this.acceptingCoordinatorPromptIds.delete(messageId);
      this.pendingCoordinatorPrompts.splice(this.pendingCoordinatorPrompts.indexOf(pending), 1);
      this.coordinatorMessages.splice(this.coordinatorMessages.indexOf(userMessage), 1);
      this.persist();
      this.publishCoordinatorContext();
      throw error;
    }
    this.acceptingCoordinatorPromptIds.delete(messageId);
    this.emit({ type: "coordinator_message", message: { ...userMessage } });
    this.schedulePromptDrain();
  }

  private schedulePromptDrain(): void {
    if (this.promptDrain || this.coordinatorPromptDrainBlocked || !this.coordinator
      || this.coordinatorTurnInFlight || this.coordinatorCompacting || this.modelChangeInProgress || this.disposing) return;
    this.promptDrain = this.drainCoordinatorPrompts().finally(() => {
      this.promptDrain = undefined;
      const head = this.pendingCoordinatorPrompts[0];
      if (head && !this.coordinatorPromptDrainBlocked && !this.acceptingCoordinatorPromptIds.has(head.messageId)
        && !this.coordinatorTurnInFlight && !this.coordinatorCompacting && !this.modelChangeInProgress && !this.disposing
        && this.coordinatorStatus !== "running" && this.coordinator.isIdle) this.schedulePromptDrain();
    });
  }

  private async drainCoordinatorPrompts(): Promise<void> {
    while (this.pendingCoordinatorPrompts.length
      && !this.acceptingCoordinatorPromptIds.has(this.pendingCoordinatorPrompts[0]!.messageId)
      && !this.coordinatorTurnInFlight
      && !this.coordinatorCompacting && !this.modelChangeInProgress && !this.disposing
      && this.coordinatorStatus !== "running" && this.coordinator.isIdle) {
      const pending = this.pendingCoordinatorPrompts[0]!;
      const message = this.coordinatorMessages.find((entry) => entry.id === pending.messageId);
      if (!message) {
        this.pendingCoordinatorPrompts.shift();
        this.persist();
        continue;
      }
      setPromptProcessing(message, pending);
      this.activeCoordinatorPromptId = pending.messageId;
      this.promptResponseCheckpoint = undefined;
      this.persist();
      this.emit({ type: "coordinator_message_updated", message: { ...message } });

      const modeInstruction = pending.mode === "plan"
        ? "<neocode-mode>PLAN: investigate and propose a plan only. Do not delegate implementation.</neocode-mode>"
        : "<neocode-mode>BUILD: implementation work may be delegated to background workers.</neocode-mode>";
      const content = `${message.text}${pending.context.length
        ? `\n\n<context-basket>\n${pending.context.join("\n\n---\n\n")}\n</context-basket>`
        : ""}\n\n${modeInstruction}`;
      this.coordinatorTurnInFlight = true;
      try {
        await this.coordinator.prompt(content, message.attachments?.length ? { images: imagesForPi(message.attachments) } : undefined);
        // Persist a completed-response checkpoint before removing the queue
        // entry. If the backend dies in this window, startup settles without
        // replaying a turn whose assistant response was already durable.
        if (pending.state !== "responded") {
          checkpointPromptResponse(pending);
          this.persist();
          this.promptResponseCheckpoint = { messageId: pending.messageId, flushed: this.stateStore.flush() };
        }
        if (this.promptResponseCheckpoint?.messageId === pending.messageId) await this.promptResponseCheckpoint.flushed;
        this.pendingCoordinatorPrompts.shift();
        settlePrompt(message);
        this.recordPromptSettlement(message);
        this.activeCoordinatorPromptId = undefined;
        this.promptResponseCheckpoint = undefined;
        this.publishCoordinatorContext();
        this.persist();
        this.emit({ type: "coordinator_message_updated", message: { ...message } });
      } catch (error) {
        this.pendingCoordinatorPrompts.shift();
        this.activeCoordinatorPromptId = undefined;
        this.publishCoordinatorContext();
        this.promptResponseCheckpoint = undefined;
        const promptError = error instanceof Error ? error.message : String(error);
        settlePrompt(message, promptError);
        this.recordPromptSettlement(message, promptError);
        this.persist();
        try {
          // Terminal backend failure is authoritative only after the failed row,
          // settlement watermark, and queue removal share one durable write.
          await this.stateStore.flush();
        } catch (persistenceError) {
          // Fail closed: expose neither terminal prompt events nor later FIFO
          // progress when the claimed durable failure did not commit.
          this.coordinatorPromptDrainBlocked = true;
          if (!this.coordinatorAborting) this.fail(persistenceError);
          break;
        }
        this.emit({ type: "coordinator_message_updated", message: { ...message } });
        this.emit({ type: "coordinator_prompt_failed", messageId: message.id, error: promptError });
        if (!this.coordinatorAborting) this.fail(error);
        // This item is durably terminal; later independent FIFO entries may run.
        continue;
      } finally {
        this.coordinatorTurnInFlight = false;
        // agent_settled fires before prompt() necessarily resolves. Publish
        // again only after synchronous turn ownership is actually released so
        // manualCompactionAvailable cannot remain falsely disabled.
        this.publishCoordinatorContext();
      }
    }
    if (!this.pendingCoordinatorPrompts.length && this.coordinator.isIdle) {
      this.coordinatorNotifications?.settled();
      this.scheduleBacklogSweep();
    }
  }

  private recordPromptSettlement(message: TranscriptMessage, error?: string): void {
    this.promptSettlement.throughTimestamp = Math.max(this.promptSettlement.throughTimestamp, message.timestamp);
    this.promptSettlement.failures = this.promptSettlement.failures.filter((entry) => entry.messageId !== message.id);
    if (error) this.promptSettlement.failures.push({ messageId: message.id, error });
    this.promptSettlement.failures = this.promptSettlement.failures.slice(-100);
  }

  async abort(): Promise<void> {
    this.coordinatorAborting = true;
    try {
      await this.coordinator.abort();
    } finally {
      this.coordinatorStatus = "idle";
      this.emit({ type: "coordinator_status", status: "idle" });
      this.setCoordinatorActivity(undefined, "aborted");
      this.coordinatorAborting = false;
      this.persist();
      this.schedulePromptDrain();
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

  private manualCompactionAvailable(): boolean {
    return !!this.coordinator
      && !this.disposing
      && !this.coordinatorTurnInFlight
      && !this.coordinatorCompacting
      && !this.modelChangeInProgress
      && !this.coordinatorAborting
      && this.coordinatorStatus === "idle"
      && this.coordinator.isIdle
      && !this.activeCoordinatorPromptId
      && this.pendingCoordinatorPrompts.length === 0
      && this.acceptingCoordinatorPromptIds.size === 0;
  }

  private coordinatorContextState(): CoordinatorContextState {
    const raw = this.coordinator?.getContextUsage?.();
    const contextWindow = raw?.contextWindow && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0
      ? raw.contextWindow
      : undefined;
    const trustworthyTokens = !this.coordinatorContextUnknownAfterCompaction
      && raw?.tokens !== null && raw?.tokens !== undefined && Number.isFinite(raw.tokens) && raw.tokens >= 0
      ? raw.tokens
      : null;
    const usage = contextWindow ? {
      tokens: trustworthyTokens,
      contextWindow,
      percent: trustworthyTokens === null
        ? null
        : (raw?.percent !== null && raw?.percent !== undefined && Number.isFinite(raw.percent)
          ? raw.percent
          : trustworthyTokens / contextWindow * 100),
      updatedAt: Date.now(),
    } : undefined;
    return {
      usage,
      autoCompactionEnabled: this.coordinator?.autoCompactionEnabled ?? true,
      manualCompactionAvailable: this.manualCompactionAvailable(),
      compaction: this.coordinatorCompaction ? { ...this.coordinatorCompaction } : undefined,
    };
  }

  private publishCoordinatorContext(): void {
    if (!this.coordinator) return;
    this.emit({ type: "coordinator_context", context: this.coordinatorContextState() });
  }

  /** Compact only the coordinator's active SDK model context; durable Neocode messages are untouched. */
  async compactCoordinator(): Promise<void> {
    if (!this.manualCompactionAvailable()) {
      if (this.disposing) throw new Error("The coordinator is shutting down.");
      if (this.coordinatorTurnInFlight) throw new Error("Wait for the current coordinator turn to settle before compacting context.");
      if (this.modelChangeInProgress) throw new Error("Wait for the coordinator model change to finish before compacting context.");
      if (this.coordinatorCompacting) throw new Error("Coordinator context compaction is already in progress.");
      if (this.pendingCoordinatorPrompts.length || this.activeCoordinatorPromptId || this.acceptingCoordinatorPromptIds.size) {
        throw new Error("Wait for all queued coordinator prompts to finish before compacting context.");
      }
      throw new Error("Manual context compaction is available only while the coordinator is idle.");
    }
    // Claim the gate before entering SDK code so another command cannot race it.
    this.coordinatorCompacting = true;
    this.publishCoordinatorContext();
    let compactError: unknown;
    try {
      await this.coordinator.compact();
    } catch (error) {
      compactError = error;
      throw error;
    } finally {
      // The SDK normally emits compaction_end. Fail closed if an exceptional
      // implementation returns or throws without a terminal event.
      if (this.coordinatorCompacting) {
        this.coordinatorCompacting = false;
        const now = Date.now();
        this.coordinatorCompaction = {
          state: "failed",
          reason: "manual",
          startedAt: this.coordinatorCompaction?.startedAt ?? now,
          completedAt: now,
          error: compactError instanceof Error
            ? compactError.message
            : "Context compaction ended without a terminal SDK event.",
        };
        this.publishCoordinatorContext();
      }
      this.schedulePromptDrain();
    }
  }

  async setModel(selection: ModelRef): Promise<void> {
    if (this.disposing) throw new Error("The coordinator is shutting down.");
    if (this.coordinatorTurnInFlight) throw new Error("Wait for the current coordinator turn to settle before changing models.");
    if (this.modelChangeInProgress) throw new Error("A coordinator model change is already in progress.");
    if (this.coordinatorCompacting) throw new Error("Wait for coordinator context compaction to finish before changing models.");
    if (!this.coordinator.isIdle) throw new Error("Wait for the coordinator response to finish (or abort it) before changing models.");
    const model = this.modelRuntime.getAvailableSnapshot().find(
      (candidate) => candidate.provider === selection.provider && candidate.id === selection.id,
    );
    if (!model) throw new Error(`Model is not configured or available: ${selection.provider}/${selection.id}`);
    if (this.coordinator.model?.provider === model.provider && this.coordinator.model.id === model.id) return;
    this.modelChangeInProgress = true;
    this.publishCoordinatorContext();
    try {
      await this.coordinator.setModel(model);
      this.emit({ type: "coordinator_model_updated", model: { provider: model.provider, id: model.id } });
      this.publishSettings();
      this.publishCoordinatorContext();
      this.persist();
    } finally {
      this.modelChangeInProgress = false;
      this.publishCoordinatorContext();
      this.schedulePromptDrain();
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.publishCoordinatorContext();
    if (this.coordinatorCompacting) this.coordinator.abortCompaction();
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    if (this.janitorTimer) clearInterval(this.janitorTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.janitorRun;

    this.setCoordinatorActivity(undefined, "interrupted");
    this.coordinatorNotifications?.shutdown();

    await this.coordinator.abort().catch(() => undefined);
    for (const [jobId, worker] of this.workers) {
      worker.cancelled = true;
      await worker.session.abort().catch(() => undefined);
      worker.session.dispose();
      const job = this.jobs.get(jobId);
      if (job && this.isCurrentAttempt(job, worker.generation, worker.token)
        && (job.status === "running" || job.status === "queued")) {
        job.status = "interrupted";
        this.finishWorker(job);
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
      worktreeIdentity: isolationMode === "worktree" ? { path: worktree, branch, baseRef, createdAt: Date.now() } : undefined,
      activityHistory: [],
      startedAt: Date.now(),

      activity: activity("starting", "Waiting to start"),
      settings: { variant: "build", thinkingLevel: this.coordinator.thinkingLevel },
      recovery: { retryCount: 0, maxRetries: this.recoveryConfig.maxRetries, generation: 1 },
      attempts: [],
    };
    this.jobs.set(job.id, job);
    this.workerTimelines.set(job.id, new ActivityTimeline(job.activity, job.activityHistory));
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
      this.finishWorker(job);
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      this.publishJob(job);
      throw error;
    }

    job.status = "running";
    this.setWorkerActivity(job, activity("starting", "Starting worker · attempt 1"), false);

    job.updatedAt = Date.now();
    const token = id();
    job.recovery!.leaseToken = token;
    job.recovery!.leaseAcquiredAt = Date.now();
    job.attempts!.push({ number: 1, generation: 1, token, reason: "initial", startedAt: Date.now() });
    this.publishJob(job);
    void this.runWorker(job, attachments, { generation: 1, token, resume: false });
    return job;
  }

  private requireJob(jobId: string): AgentJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    return job;
  }

  private async resumeClaimedRemediations(): Promise<void> {
    for (const job of this.jobs.values()) {
      const remediation = job.review?.remediation;
      const action = remediation?.actions.find((entry) => entry.id === remediation.currentActionId);
      if (job.status !== "completed" || action?.state !== "repairing" || action.failureClass === "infrastructure" || this.workers.has(job.id)) continue;
      // The coordinator's durable repair claim happened before the previous
      // process died. Resume that exact same worktree without consuming another
      // round or inventing new feedback.
      this.completionPipeline.workerResumed(job);
      job.recoverable = true;
      await this.startRecoveryAttempt(job, "manual_resume");
    }
  }

  async requestWorkerChanges(jobId: string, feedback: string): Promise<void> {
    const job = this.requireJob(jobId);
    if (job.status !== "completed") throw new Error(`Worker ${jobId} is not awaiting review.`);
    if (job.isolation.mode !== "worktree") throw new Error("Review iterations require an isolated worktree worker.");
    this.completionPipeline.requestChanges(job, feedback);
    job.messages.push({ id: id(), role: "user", text: `Coordinator repair feedback (inspect the exact diagnostics and correct this checkout):\n${feedback}`, timestamp: Date.now() });
    job.recoverable = true;
    this.completionPipeline.workerResumed(job);
    await this.startRecoveryAttempt(job, "manual_resume");
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
    this.finishWorker(job);

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
    let lastAssistantMessageId: string | undefined;
    this.coordinator.subscribe((event) => {
      if (event.type === "agent_start") {
        lastAssistantMessageId = undefined;
        this.coordinatorStatus = "running";
        this.publishCoordinatorContext();
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
        lastAssistantMessageId = streaming.id;
        this.persist();
        streaming = undefined;
        emitted = false;
      } else if (event.type === "compaction_start") {
        this.coordinatorCompacting = true;
        this.coordinatorCompaction = {
          state: "active",
          reason: event.reason,
          startedAt: Date.now(),
        };
        this.publishCoordinatorContext();
      } else if (event.type === "compaction_end") {
        this.coordinatorCompacting = false;
        const completedAt = Date.now();
        const state = event.aborted ? "aborted" : event.errorMessage || !event.result ? "failed" : "completed";
        if (state === "completed") this.coordinatorContextUnknownAfterCompaction = true;
        this.coordinatorCompaction = {
          state,
          reason: event.reason,
          startedAt: this.coordinatorCompaction?.state === "active"
            ? this.coordinatorCompaction.startedAt
            : completedAt,
          completedAt,
          tokensBefore: event.result?.tokensBefore,
          estimatedTokensAfter: event.result?.estimatedTokensAfter,
          willRetry: event.willRetry || undefined,
          error: event.errorMessage,
        };
        this.publishCoordinatorContext();
        if (this.pendingCoordinatorPrompts.length) this.schedulePromptDrain();
        else this.coordinatorNotifications?.settled();
      } else if (event.type === "agent_settled") {
        const refreshedUsage = this.coordinator.getContextUsage?.();
        if (refreshedUsage?.tokens !== null && refreshedUsage?.tokens !== undefined) {
          this.coordinatorContextUnknownAfterCompaction = false;
        }
        if (this.coordinatorStatus !== "error") {
          this.coordinatorStatus = "idle";
          this.emit({ type: "coordinator_status", status: "idle" });
        }
        this.setCoordinatorActivity(undefined, this.coordinatorAborting ? "aborted" : "completed");
        // Finalize any durable system wake on the authoritative Pi settlement,
        // even when user-prompt bookkeeping is also present, then transport the
        // newly trustworthy post-response context usage.
        this.coordinatorNotifications?.agentSettled();
        this.publishCoordinatorContext();
        const pending = this.pendingCoordinatorPrompts[0];
        if (!this.coordinatorAborting && pending && pending.messageId === this.activeCoordinatorPromptId && pending.state === "processing") {
          // Only agent settlement proves the assistant/tool loop is complete;
          // intermediate assistant message_end events may merely request tools.
          checkpointPromptResponse(pending, lastAssistantMessageId);
          this.persist();
          this.promptResponseCheckpoint = { messageId: pending.messageId, flushed: this.stateStore.flush() };
        } else this.persist();
        if (this.pendingCoordinatorPrompts.length) this.schedulePromptDrain();
        else {
          this.scheduleBacklogSweep();
        }
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
        systemPromptOverride: (base) => workerSystemPrompt(base, job),
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
        images: imagesForPi(attachments),

      } : undefined);

      const activeWorker = this.workers.get(job.id);
      if (activeWorker?.cancelled || !this.isCurrentAttempt(job, attempt.generation, attempt.token)) return;
      this.setWorkerActivity(job, activity("starting", "Finalizing results"));
      if (job.isolation.mode === "worktree") {
        job.completion = { head: await this.gitAt(["rev-parse", "HEAD"], job.isolation.path), finishedAt: Date.now() };
        job.integration = { status: "unmerged" };
      }

      job.summary = [...job.messages].reverse().find((message) => message.role === "assistant")?.text;
      await this.refreshDiff(job);
      job.status = "completed";
      this.finishWorker(job);
      job.updatedAt = Date.now();
      job.recoverable = false;
      delete job.recoveryIssue;
      this.finishAttempt(job);
      this.publishJob(job);
      // Completion records a durable handoff and wakes the main coordinator.
      // It deliberately does not launch a judge or merge action.
      if (job.review) this.completionPipeline.nextHandoff(job);
      else this.completionPipeline.enqueue(job);
    } catch (error) {
      if (this.workers.get(job.id)?.cancelled || job.status === "cancelled"
        || !this.isCurrentAttempt(job, attempt.generation, attempt.token)) return;
      job.status = "failed";
      this.finishWorker(job);
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      this.finishAttempt(job, job.error);
      this.publishJob(job);
    } finally {
      const worker = this.workers.get(job.id);
      if (worker?.generation === attempt.generation && worker.token === attempt.token) {
        this.workers.delete(job.id);
        this.workerConfigs.delete(job.id);
        this.workerTimelines.delete(job.id);
      }

      session?.dispose();
    }
  }

  private bindWorker(job: AgentJob, session: AgentSession, generation: number, token: string): void {
    let streaming: TranscriptMessage | undefined;
    let emitted = false;
    const setActivity = (next: AgentActivity | undefined) => {
      if (!this.isCurrentAttempt(job, generation, token)) return;
      this.setWorkerActivity(job, next);
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
    job.diff = await readWorktreeDiff(job.isolation.path, job.review?.reviewBaseRef || job.baseRef);
  }

  private async git(args: string[]): Promise<string> {
    return this.gitAt(args, this.cwd);
  }

  private async gitAt(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  }

  /** Completion/integration code must use this lock so cleanup cannot race it. */
  async withIntegrationLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.operationLock.run(operation);
  }

  private async markNotRequired(params: {
    jobId: string; reason: string; supersededByJobId?: string; supersededByCommit?: string;
  }): Promise<AgentJob> {
    const job = this.requireJob(params.jobId);
    if (job.isolation.mode !== "worktree" || this.workers.has(job.id)
      || job.status === "running" || job.status === "queued") {
      throw new Error("Only an inactive worktree job can be marked not required.");
    }
    if (job.integration?.status === "merged") throw new Error("Integrated work is already Done.");
    if (params.reason.trim().length < 20) throw new Error("Specific supersession evidence is required.");

    let evidenceCommit = params.supersededByCommit;
    if (params.supersededByJobId) {
      const replacement = this.requireJob(params.supersededByJobId);
      if (replacement.integration?.status !== "merged") throw new Error("The replacement job must be verified on main first.");
      evidenceCommit = replacement.integration.targetHead || replacement.review?.mergeCommit;
    }
    if (!evidenceCommit || !await execFileAsync("git", ["merge-base", "--is-ancestor", evidenceCommit, this.maintenanceConfig.targetRef], { cwd: this.cwd })
      .then(() => true, () => false)) {
      throw new Error("A replacement commit already contained in main is required.");
    }
    const porcelain = await this.gitAt(["status", "--porcelain=v1", "--untracked-files=all"], job.isolation.path);
    if (porcelain) throw new Error("The worktree is dirty; preserve it with a worker handoff before superseding it.");
    const branch = await this.gitAt(["branch", "--show-current"], job.isolation.path);
    if (branch !== job.branch) throw new Error("The registered worktree branch does not match durable metadata.");
    const head = await this.gitAt(["rev-parse", "HEAD"], job.isolation.path);
    const now = Date.now();
    job.status = "completed";
    job.completion = { head, finishedAt: job.completion?.finishedAt || now };
    job.worktreeIdentity ??= { path: job.isolation.path, branch: job.branch, baseRef: job.baseRef, createdAt: job.createdAt };
    job.integration = {
      ...job.integration,
      status: "superseded",
      targetRef: this.maintenanceConfig.targetRef,
      verifiedAt: now,
      targetHead: evidenceCommit,
      completionHead: head,
      disposition: "superseded",
      dispositionReason: params.reason.trim(),
      supersededByJobId: params.supersededByJobId,
      supersededByCommit: evidenceCommit,
    };
    delete job.cleanup;
    job.updatedAt = now;
    this.publishJob(job);
    return job;
  }

  /**
   * Reconcile durable worker records with Git instead of trusting stale review
   * labels. This repairs jobs integrated externally, by an older harness, or as
   * patch-equivalent commits, and safely classifies clean no-op wrapper jobs.
   */
  private async reconcileIntegratedJobs(targetRef = process.env.NEOCODE_MERGE_BRANCH || "main"):
    Promise<{ integrated: number; noOp: number; pending: number }> {
    const result = { integrated: 0, noOp: 0, pending: 0 };
    const targetHead = await this.git(["rev-parse", targetRef]);

    for (const job of this.jobs.values()) {
      if (job.status !== "completed" || job.isolation.mode !== "worktree"
        || job.integration?.status === "superseded"
        || (job.integration?.status === "merged" && job.worktreeIdentity)
        || this.workers.has(job.id)) continue;
      try {
        const porcelain = await this.gitAt(["status", "--porcelain=v1", "--untracked-files=all"], job.isolation.path);
        if (porcelain) { result.pending += 1; continue; }
        const branch = await this.gitAt(["branch", "--show-current"], job.isolation.path);
        if (branch !== job.branch) { result.pending += 1; continue; }
        const actualHead = await this.gitAt(["rev-parse", "HEAD"], job.isolation.path);
        const commits = (await this.git(["rev-list", "--reverse", `${job.baseRef}..${actualHead}`]))
          .split("\n").filter(Boolean);
        let integrated = commits.length === 0;
        if (!integrated) {
          const cherry = await this.git(["cherry", targetRef, actualHead]).catch(() => "");
          const equivalent = new Set(cherry.split("\n")
            .filter((line) => line.startsWith("- "))
            .map((line) => line.slice(2).trim()));
          integrated = true;
          for (const commit of commits) {
            const ancestor = await execFileAsync("git", ["merge-base", "--is-ancestor", commit, targetHead], { cwd: this.cwd })
              .then(() => true, () => false);
            if (!ancestor && !equivalent.has(commit)) { integrated = false; break; }
          }
        }
        if (!integrated) { result.pending += 1; continue; }

        const now = Date.now();
        job.completion = { head: actualHead, finishedAt: job.completion?.finishedAt || now };
        // Older durable records predate worktreeIdentity. Reconstruct it only
        // after verifying the registered path, expected branch, clean checkout,
        // immutable base and fully integrated commit set above.
        job.worktreeIdentity ??= {
          path: job.isolation.path,
          branch: job.branch,
          baseRef: job.baseRef,
          createdAt: job.createdAt,
        };
        job.integration = {
          ...job.integration,
          status: "merged", targetRef, verifiedAt: now,
          targetHead, completionHead: actualHead,
          disposition: job.integration?.disposition || "already_integrated",
        };
        if (job.review) {
          job.review.status = "merged";
          job.review.mergeCommit = targetHead;
          job.review.updatedAt = now;
          delete job.review.error;
          job.review.transitions.push({
            status: "merged", at: now, owner: "server",
            detail: commits.length
              ? "Git reconciliation proved every worker commit is integrated or patch-equivalent."
              : "Git reconciliation proved this clean wrapper job contains no unique commits.",
          });
        }
        delete job.cleanup;
        job.updatedAt = now;
        this.publishJob(job);
        if (commits.length) result.integrated += 1;
        else result.noOp += 1;
      } catch {
        result.pending += 1;
      }
    }
    return result;
  }

  cleanNow(ignoreGrace = false): Promise<void> {
    this.startCleanup("manual", ignoreGrace);
    return this.janitorRun ?? Promise.resolve();
  }

  private startCleanup(source: "startup" | "scheduled" | "manual", ignoreGrace = false): void {
    if (this.janitorRun) return;
    this.janitorRun = this.operationLock.run(async () => {
      this.maintenance = { state: "running", source };
      this.emit({ type: "maintenance_updated", maintenance: { ...this.maintenance } });
      try {
        const janitor = ignoreGrace
          ? new WorktreeJanitor(this.cwd, { graceMs: 0, targetRef: this.maintenanceConfig.targetRef })
          : this.janitor;
        const result = await janitor.run(this.listJobs(), (job) => this.publishJob(job));
        this.maintenance = { state: "idle", source, lastRunAt: Date.now(), ...result };
      } catch (error) {
        this.maintenance = {
          state: "idle", source, lastRunAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      this.persist();
      this.emit({ type: "maintenance_updated", maintenance: { ...this.maintenance } });
    }).finally(() => { this.janitorRun = undefined; });
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

  private setCoordinatorActivity(next: AgentActivity | undefined, outcome: NonNullable<AgentActivity["outcome"]> = "completed"): void {
    const changed = next ? this.coordinatorTimeline.set(next) : this.coordinatorTimeline.finish(outcome);
    if (!changed) return;
    this.coordinatorActivity = this.coordinatorTimeline.current;
    this.persist();
    this.emit({ type: "coordinator_activity", activity: this.coordinatorActivity, activityHistory: [...this.coordinatorActivityHistory] });
  }

  private setWorkerActivity(job: AgentJob, next: AgentActivity | undefined, publish = true): void {
    let timeline = this.workerTimelines.get(job.id);
    if (!timeline) {
      job.activityHistory ||= [];
      timeline = new ActivityTimeline(job.activity, job.activityHistory);
      this.workerTimelines.set(job.id, timeline);
    }
    if (!timeline.set(next)) return;
    job.activity = timeline.current;
    job.updatedAt = Date.now();
    if (publish) this.publishJob(job);
  }

  private finishWorker(job: AgentJob): void {
    let timeline = this.workerTimelines.get(job.id);
    if (!timeline) {
      job.activityHistory ||= [];
      timeline = new ActivityTimeline(job.activity, job.activityHistory);
      this.workerTimelines.set(job.id, timeline);
    }
    const outcome = job.status === "cancelled" ? "cancelled"
      : job.status === "interrupted" ? "interrupted"
        : job.status === "failed" ? "error" : "completed";
    timeline.finish(outcome);
    job.activity = undefined;
    const completedAt = Date.now();
    job.completedAt = completedAt;
    job.durationMs = Math.max(0, completedAt - (job.startedAt ?? job.createdAt));
  }

  private scheduleBacklogSweep(): void {
    if (this.sweepScheduled) return;
    this.sweepScheduled = true;
    queueMicrotask(() => {
      this.sweepScheduled = false;
      if (this.sweepRun) return;
      this.sweepRun = this.runBacklogSweep().finally(() => { this.sweepRun = undefined; });
    });
  }

  private async assessIntegrationComplexity(job: AgentJob): Promise<number> {
    try {
      const target = this.maintenanceConfig.targetRef;
      const mergeBase = await this.git(["merge-base", target, job.branch]);
      const [numstat, mainNames, workerNames] = await Promise.all([
        this.git(["diff", "--numstat", `${target}...${job.branch}`]),
        this.git(["diff", "--name-only", `${mergeBase}..${target}`]),
        this.git(["diff", "--name-only", `${mergeBase}..${job.branch}`]),
      ]);
      let additions = 0, deletions = 0, files = 0;
      for (const line of numstat.split("\n").filter(Boolean)) {
        const [added, deleted] = line.split("\t");
        additions += added === "-" ? 50 : Number(added) || 0;
        deletions += deleted === "-" ? 50 : Number(deleted) || 0;
        files += 1;
      }
      const mainChanged = new Set(mainNames.split("\n").filter(Boolean));
      const overlappingFiles = workerNames.split("\n").filter((path) => mainChanged.has(path)).length;
      const score = integrationComplexityScore({
        files, additions, deletions, overlappingFiles, ageMs: Date.now() - job.createdAt,
      });
      job.integration ??= { status: "unmerged", targetRef: target };
      job.integration.priority = { files, additions, deletions, overlappingFiles, score, assessedAt: Date.now() };
      return score;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  private activeReviewLaneIds(): Set<string> {
    const active = new Set<string>();
    const activeReview = new Set(["ci_running", "judging", "merge_queued", "merging", "post_merge_ci"]);
    for (const job of this.jobs.values()) {
      const action = job.review?.remediation?.actions.find((entry) => entry.id === job.review?.remediation?.currentActionId);
      const hasLiveWorker = this.workers.has(job.id);
      const activeRepairWorker = hasLiveWorker && (job.review?.status === "worker_resumed" || action?.state === "repairing" || this.sweepJobIds.has(job.id));
      // Durable worker_resumed/repairing metadata can outlive a crashed or
      // exhausted worker. Only an actual RunningWorker consumes a lane.
      if ((job.review && activeReview.has(job.review.status)) || activeRepairWorker) active.add(job.id);
    }
    // Reservations whose coordinator turn produced no asynchronous work must
    // not consume capacity forever, especially while a later durable wake is
    // waiting at the head of the FIFO queue.
    for (const jobId of [...this.sweepJobIds]) if (!active.has(jobId)) this.sweepJobIds.delete(jobId);
    return active;
  }

  private async runBacklogSweep(): Promise<void> {
    const queue = this.coordinatorNotifications;
    if (!queue || this.coordinatorStatus !== "idle" || !this.coordinator.isIdle || queue.hasPendingWake()) return;

    const eligible = (job: AgentJob): boolean => {
      if (job.isolation.mode !== "worktree" || job.integration?.status === "merged" || job.integration?.status === "superseded") return false;
      if (job.status === "interrupted") return job.recoverable === true;
      if (job.status === "needs_attention") return true;
      if (job.status !== "completed") return false;
      return job.review?.status !== "merged";
    };
    const activeReview = new Set(["ci_running", "judging", "merge_queued", "merging", "post_merge_ci"]);
    const integrationReview = new Set(["merge_queued", "merging", "post_merge_ci"]);
    const integrationInFlight = [...this.sweepJobIds].some((jobId) => {
      const status = this.jobs.get(jobId)?.review?.status;
      return status ? integrationReview.has(status) : false;
    });
    const targetHead = await this.git(["rev-parse", this.maintenanceConfig.targetRef]).catch(() => "");

    // Retain active review/remediation lanes, but release completed or stable
    // no-action lanes so another candidate can enter the bounded pool.
    for (const jobId of [...this.sweepJobIds]) {
      const job = this.jobs.get(jobId);
      if (!job || !eligible(job)) { this.sweepJobIds.delete(jobId); continue; }
      if (this.workers.has(job.id) || (job.review && activeReview.has(job.review.status))) continue;
      if (job.review?.status === "approved" && integrationInFlight) continue;
      if (targetHead) this.completionPipeline.invalidateApprovalForTargetAdvance(job, targetHead);
      if (queue.requestBacklogSweep(job)) return;
      this.sweepJobIds.delete(jobId);
    }

    if (this.activeReviewLaneIds().size >= this.maintenanceConfig.reviewConcurrency) return;
    const candidates = this.listJobs()
      .filter(eligible)
      .filter((job) => !this.sweepJobIds.has(job.id) && !this.workers.has(job.id))
      .filter((job) => !(job.review && activeReview.has(job.review.status)));
    const scored = await Promise.all(candidates.map(async (job) => ({ job, score: await this.assessIntegrationComplexity(job) })));
    scored.sort((left, right) => left.score - right.score || left.job.createdAt - right.job.createdAt);
    this.persist();
    for (const { job } of scored) {
      if (this.activeReviewLaneIds().size >= this.maintenanceConfig.reviewConcurrency) break;
      if (!queue.requestBacklogSweep(job)) continue;
      this.sweepJobIds.add(job.id);
      return; // The single coordinator handles one durable decision at a time.
    }
  }

  private publishJob(job: AgentJob): void {
    this.persist();
    this.emit({ type: "job_updated", job: this.transportJob(job) });
    this.coordinatorNotifications?.observe(job);
    this.scheduleBacklogSweep();
  }

  private appendCoordinatorWorkerEvent(event: CoordinatorWorkerEvent): void {
    const message: TranscriptMessage = {
      id: event.messageId,
      role: "system",
      text: `[worker_status] ${event.title || event.jobId}: ${event.kind.replaceAll("_", " ")} — ${event.summary || "status updated"}`,
      timestamp: event.createdAt,
      workerEvent: {
        jobId: event.jobId,
        title: event.title || event.jobId,
        state: event.kind,
        summary: event.summary || event.kind.replaceAll("_", " "),
        rawEvidence: event.text,
        actionRequired: event.kind === "action_required" || event.kind === "failed" || event.kind === "needs_attention",
      },
    };
    if (this.coordinatorMessages.some((entry) => entry.id === message.id)) return;
    this.coordinatorMessages.push(message);
    this.emit({ type: "coordinator_message", message });
  }

  private persist(): void {
    const state: DurableRuntimeState = {
      version: RUNTIME_STATE_VERSION,
      workspaceRoot: this.cwd,
      updatedAt: Date.now(),
      coordinator: {
        messages: [...this.coordinatorMessages],
        activity: this.coordinatorActivity,
        activityHistory: [...this.coordinatorActivityHistory],
        piSessionFile: this.coordinatorSessionFile,
        pendingPrompts: this.pendingCoordinatorPrompts.map((prompt) => ({ ...prompt, context: [...prompt.context] })),
        promptSettlement: { throughTimestamp: this.promptSettlement.throughTimestamp, failures: [...this.promptSettlement.failures] },
      },
      maintenance: { ...this.maintenance },
      coordinatorNotifications: {
        events: [...this.notificationState.events],
        lastSignals: { ...this.notificationState.lastSignals },
        // This permanent checkpoint is intentionally detached from compactable
        // event rows. Without it, restart can replay a duplicate stable ID.
        settledEventIds: { ...this.notificationState.settledEventIds },
      },
      // RuntimeStateStore snapshots this envelope synchronously before its
      // first write await. Avoid cloning every large diff/transcript twice on
      // each high-frequency activity transition.
      jobs: this.listJobs().map((job) => ({
        job,
        piSessionFile: this.piSessionFiles.get(job.id),
      })),
    };
    this.stateStore.save(state);
  }

  private async pathExists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
  }

  /** Shared production construction kept isolated so restart tests exercise the real hooks. */
  private initializeCoordinatorNotifications(): void {
    this.coordinatorNotifications = new CoordinatorNotificationQueue(this.notificationState, {
      append: (event) => this.appendCoordinatorWorkerEvent(event),
      persist: () => { this.persist(); return this.stateStore.flush(); },
      currentJob: (jobId) => this.jobs.get(jobId),
      isIdle: () => this.coordinatorStatus === "idle" && this.coordinator.isIdle
        && !this.coordinatorCompacting && !this.modelChangeInProgress && !this.disposing,
      reserveTurn: (event) => {
        if (this.coordinatorTurnInFlight || this.coordinatorCompacting || this.modelChangeInProgress || this.disposing) return undefined;
        const activeLanes = this.activeReviewLaneIds();
        if (!activeLanes.has(event.jobId) && activeLanes.size >= this.maintenanceConfig.reviewConcurrency) return undefined;
        this.coordinatorTurnInFlight = true;
        this.sweepJobIds.add(event.jobId);
        return () => { this.coordinatorTurnInFlight = false; };
      },
      turnReleased: () => {
        // NotificationQueue invokes this only after its reservation release.
        this.publishCoordinatorContext();
        this.schedulePromptDrain();
      },
      wake: async (event, started) => {
        const prompt = this.coordinator.prompt(
          `<neocode-worker-event event-id="${event.id}">${event.text}</neocode-worker-event>\n${event.kind === "backlog_sweep"
            ? "Autonomous backlog sweep: inspect this exact job and take its next safe lifecycle action now. Do not merely summarize it. Resume a verified interrupted worker, start a fresh judge for a completed handoff, remediate exact failures in the same worktree, or guarded-merge only a fresh approval. Process only this job."
            : "Resume coordinator-owned reconciliation now: inspect the handoff, start an independent judge when appropriate, and report each decision concisely. Never merge without a fresh exact-diff approval."}`,
        );
        started();
        await prompt;
      },
    });
  }

  /** Initialization migration kept isolated so restart tests exercise exact restoration semantics. */
  private restoreCoordinatorNotificationState(restored: CoordinatorNotificationState): void {
    this.notificationState.events.push(...restored.events);
    Object.assign(this.notificationState.lastSignals, restored.lastSignals);
    Object.assign(this.notificationState.settledEventIds ??= {}, restored.settledEventIds || {});
  }

  private async reconcileRestoredJobs(): Promise<void> {
    for (const job of this.jobs.values()) {
      job.activityHistory = (job.activityHistory || []).map(normalizeActivityTiming);
      if (job.activity) job.activity = normalizeActivityTiming(job.activity);
      const wasActive = job.status === "running" || job.status === "queued";
      const wasScheduledRecovery = job.status === "interrupted" && job.recovery?.nextRetryAt !== undefined;
      // No process survives restart; close a persisted live step as interrupted.
      if (job.activity) {
        const completedAt = Date.now();
        job.activityHistory.unshift({ ...job.activity, completedAt, durationMs: Math.max(0, completedAt - job.activity.startedAt), outcome: "interrupted", updatedAt: completedAt });
        job.activityHistory.length = Math.min(job.activityHistory.length, 12);
        job.activity = undefined;
        job.completedAt ||= completedAt;
        job.durationMs ||= Math.max(0, completedAt - (job.startedAt ?? job.createdAt));
      }
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
    this.setCoordinatorActivity(undefined, "error");
    this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
