export type AgentStatus = "idle" | "running" | "error";
export type JobStatus = "queued" | "running" | "interrupted" | "needs_attention" | "completed" | "failed" | "cancelled";
export type IntegrationStatus = "unmerged" | "reviewing" | "integrating" | "conflicted" | "merged" | "superseded";
export type CleanupRefusalReason =
  | "not_completed" | "missing_durable_identity" | "grace_period" | "integration_active" | "conflicted"
  | "identity_mismatch" | "not_registered" | "branch_mismatch" | "head_mismatch" | "dirty"
  | "no_intended_commits" | "not_merged" | "git_error" | "removal_unverified";

export type RequestedIsolationMode = "auto" | "worktree" | "root";
export type IsolationMode = Exclude<RequestedIsolationMode, "auto">;
export type AgentVariant = "build" | "plan";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReviewStatus =
  | "queued" | "ci_running" | "ci_failed" | "judging" | "rejected"
  | "approved" | "merge_queued" | "merging" | "post_merge_ci"
  | "merged" | "post_ci_failed" | "blocked" | "conflict" | "failed"
  | "feedback_sent" | "worker_resumed" | "handoff_received" | "needs_attention";

export type RemediationFailureClass =
  | "worker_ci" | "candidate_ci" | "judge_changes" | "conflict" | "post_merge_ci" | "infrastructure";

export interface RemediationRound {
  failureClass: RemediationFailureClass;
  fingerprint: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: number;
  updatedAt: number;
}

export interface ActionRequiredEvidence {
  detail: string;
  checks?: CheckEvidence[];
  judge?: JudgeEvidence;
  mergeCommit?: string;
}

export interface ActionRequired {
  id: string;
  failureClass: RemediationFailureClass;
  fingerprint: string;
  state: "pending" | "repairing" | "resolved" | "exhausted";
  attempt: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  evidence: ActionRequiredEvidence;
  feedback?: string;
}

export interface CheckEvidence {
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated?: boolean;
  timedOut?: boolean;
}

export interface JudgeRequirementEvidence {
  requirement: string;
  satisfied: boolean;
  evidence: string;
}

export interface JudgeEvidence {
  approved: boolean;
  summary: string;
  requirements: JudgeRequirementEvidence[];
  model: ModelRef;
  diffSha256: string;
  sessionFile?: string;
  raw: string;
}

export interface ReviewTransition {
  status: ReviewStatus;
  at: number;
  detail?: string;
  /** Product decisions are attributable to the main coordinator, never the supervisor. */
  owner?: "worker" | "coordinator" | "judge" | "server";
}

export interface WorkerHandoff {
  report: string;
  requirements: string[];
  diffSha256: string;
  branch: string;
  worktree: string;
  tests: string[];
  risks: string[];
  round: number;
  createdAt: number;
}

export interface JobReview {
  /** Stable completion-hook token. Its presence prevents duplicate coordinator wakes. */
  hookToken: string;
  status: ReviewStatus;
  attempt: number;
  targetBranch: string;
  /** Exact target commit onto which the candidate was most recently rebased for review. */
  reviewBaseRef?: string;
  updatedAt: number;
  transitions: ReviewTransition[];
  ci?: CheckEvidence[];
  postMergeCi?: CheckEvidence[];
  judge?: JudgeEvidence;
  mergeCommit?: string;
  /** Set only by the coordinator's guarded_merge tool call. */
  coordinatorAuthorizedAt?: number;
  /** Handoff round durably claimed by the most recent explicit judge start. */
  judgeHandoffRound?: number;
  feedback?: string[];
  /** Durable coordinator-owned repair accounting and complete failure evidence. */
  remediation?: {
    maxAttempts: number;
    rounds: Partial<Record<RemediationFailureClass, RemediationRound>>;
    actions: ActionRequired[];
    currentActionId?: string;
  };
  error?: string;
}

export interface AgentActivity {
  phase: "starting" | "thinking" | "responding" | "tool_pending" | "tool_running" | "tool_complete" | "tool_error";
  description: string;
  toolName?: string;
  /** Wall-clock timestamps, suitable for transport and durable restoration. */
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  outcome?: "completed" | "aborted" | "error" | "cancelled" | "interrupted";
  /** Kept for compatibility; changes only when the activity itself changes. */
  updatedAt: number;
}

export interface ModelRef { provider: string; id: string }
export interface ModelChoice extends ModelRef { label: string }

/** Safe aggregate model-context telemetry. No prompt or summary content is transported. */
export interface ModelContextUsage {
  /** Null after compaction until a successful post-compaction model response makes usage trustworthy. */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  updatedAt: number;
}

export type CompactionState = "active" | "completed" | "failed" | "aborted";
export interface CoordinatorCompactionStatus {
  state: CompactionState;
  reason: "manual" | "threshold" | "overflow";
  startedAt: number;
  completedAt?: number;
  /** Safe SDK metadata only. The generated summary and private context are never transported. */
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  /** SDK indicates that automatic compaction recovery will make another attempt. */
  willRetry?: boolean;
  error?: string;
}

export interface CoordinatorContextState {
  usage?: ModelContextUsage;
  autoCompactionEnabled: boolean;
  /** Authoritative server gate; manual compaction is coordinator-only and idle-only. */
  manualCompactionAvailable: boolean;
  compaction?: CoordinatorCompactionStatus;
}

export interface AgentSettings {
  variant: AgentVariant;
  thinkingLevel: ThinkingLevel;
  availableVariants: AgentVariant[];
  availableThinkingLevels: ThinkingLevel[];
}

export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS = 4;
export interface ImageAttachment {
  id: string;
  mimeType: (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];
  data: string;
  size: number;
  name?: string;
}

export interface JobIsolation {
  /** The caller's selection. `auto` is resolved by the server before startup. */
  requested: RequestedIsolationMode;
  /** The effective mode used for this job. */
  mode: IsolationMode;
  /** Absolute directory in which the worker runs. */
  path: string;
}

export interface WorkerEventPresentation {
  jobId: string;
  title: string;
  state: string;
  summary: string;
  /** Full structured payload, rendered only inside the disclosure. */
  rawEvidence?: string;
  actionRequired?: boolean;
}

export type PromptState = "sending" | "queued" | "processing" | "failed";
export interface PromptSettlementSnapshot {
  /** All FIFO prompts at or before this timestamp are terminal. */
  throughTimestamp: number;
  /** Bounded recent failure tombstones; other terminal prompts settled normally. */
  failures: Array<{ messageId: string; error: string }>;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  /** Durable transcript text; structured event evidence may live in workerEvent. */
  text: string;
  timestamp: number;
  attachments?: ImageAttachment[];
  /** Compact transport/presentation metadata for structured lifecycle events. */
  workerEvent?: WorkerEventPresentation;
  /** Coordinator user-prompt delivery state. Absence means the prompt settled. */
  promptState?: PromptState;
  promptError?: string;
}

export interface WorkerAttempt {
  number: number;
  generation: number;
  token: string;
  reason: "initial" | "backend_restart" | "manual_resume";
  startedAt: number;
  finishedAt?: number;
  sessionMode?: "created" | "opened" | "fresh_fallback";
  sessionFile?: string;
  error?: string;
}

export interface WorkerRecovery {
  retryCount: number;
  maxRetries: number;
  generation: number;
  leaseToken?: string;
  leaseAcquiredAt?: number;
  nextRetryAt?: number;
  needsConfirmation?: boolean;
  checkoutDirty?: boolean;
}

export interface WorktreeIdentity {
  path: string;
  branch: string;
  baseRef: string;
  createdAt: number;
}

export interface JobCompletion {
  /** Immutable branch head captured when the worker finished successfully. */
  head: string;
  finishedAt: number;
}

export interface JobIntegration {
  status: IntegrationStatus;
  targetRef?: string;
  verifiedAt?: number;
  targetHead?: string;
  completionHead?: string;
  disposition?: "integrated" | "already_integrated" | "superseded";
  dispositionReason?: string;
  supersededByJobId?: string;
  supersededByCommit?: string;
  priority?: {
    files: number;
    additions: number;
    deletions: number;
    overlappingFiles: number;
    score: number;
    assessedAt: number;
  };
}

export interface CleanupEvidence {
  checkedAt: number;
  targetRef: string;
  targetHead: string;
  completionHead: string;
  intendedCommits: string[];
  mergeMethod: "commit-ancestry" | "patch-equivalent" | "identical-content" | "no-changes" | "superseded-branch-retained";
  cleanPorcelain: true;
  registeredPath: string;
  registeredBranch: string;
}

export type JobCleanup =
  | { status: "refused"; checkedAt: number; reason: CleanupRefusalReason; detail: string }
  | { status: "removed"; checkedAt: number; removedAt: number; evidence: CleanupEvidence };


export interface TranscriptPageInfo {
  /** Message id immediately anchoring the loaded window. Opaque to clients. */
  oldestCursor?: string;
  hasOlder: boolean;
}

export type TranscriptThread = { kind: "coordinator" } | { kind: "job"; jobId: string };

export interface AgentJob {
  id: string;
  title: string;
  prompt: string;
  status: JobStatus;
  branch: string;
  /** @deprecated Use isolation.path. Kept for transport compatibility. */
  worktree: string;
  isolation: JobIsolation;
  baseRef: string;
  createdAt: number;
  updatedAt: number;
  messages: TranscriptMessage[];
  /** Transport-only window metadata; omitted from durable state. */
  transcriptPage?: TranscriptPageInfo;
  activity?: AgentActivity;
  activityHistory?: AgentActivity[];
  /** Total worker lifetime, including startup and queued time. */
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  settings?: Pick<AgentSettings, "variant" | "thinkingLevel">;
  summary?: string;
  diff?: string;
  error?: string;
  /** A stopped job whose checkout/session artifacts remain available for review or manual continuation. */
  recoverable?: boolean;
  /** Set when durable metadata no longer agrees with the git checkout. */
  recoveryIssue?: string;
  /** Durable worker restart accounting and generation lease. */
  recovery?: WorkerRecovery;
  /** Every process launch is a distinct, visible attempt. */
  attempts?: WorkerAttempt[];
  /** Durable coordinator-owned review and reconciliation state. */
  review?: JobReview;
  /** Structured worker-to-main-thread completion evidence. */
  handoff?: WorkerHandoff;
  /** Immutable creation identity used to reject stale or repurposed paths. */
  worktreeIdentity?: WorktreeIdentity;
  completion?: JobCompletion;
  /** `completed` means the worker stopped; only `merged` means Git verified integration. */
  integration?: JobIntegration;
  cleanup?: JobCleanup;
}

export interface MaintenanceStatus {
  state: "idle" | "running";
  lastRunAt?: number;
  source?: "startup" | "scheduled" | "manual";
  checked?: number;
  removed?: number;
  refused?: number;
  error?: string;

}

export interface AppSnapshot {
  cwd: string;
  coordinator: {
    status: AgentStatus;
    activity?: AgentActivity;
    activityHistory: AgentActivity[];
    messages: TranscriptMessage[];
    transcriptPage?: TranscriptPageInfo;
    /** Bounded authority for reconciling lifecycle state in cached older pages. */
    promptSettlement?: PromptSettlementSnapshot;
    settings: AgentSettings;
    model: ModelRef | null;
    models: ModelChoice[];
    context: CoordinatorContextState;
  };
  jobs: AgentJob[];
  maintenance: MaintenanceStatus;
}

export type ClientMessage =
  | { type: "prompt"; id?: string; text: string; context?: string[]; attachments?: ImageAttachment[] }
  | { type: "abort" }
  | { type: "delegate"; text: string; isolation?: RequestedIsolationMode; attachments?: ImageAttachment[] }
  | { type: "cancel_job"; jobId: string }
  | { type: "resume_job"; jobId: string }
  | { type: "cycle_variant" }
  | { type: "cycle_thinking" }
  | { type: "set_model"; model: ModelRef }
  | { type: "compact_coordinator" }
  | { type: "refresh" }
  | { type: "load_older_messages"; thread: TranscriptThread; before?: string; limit?: number }
  | { type: "clean_now" };

export type ServerMessage =
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "coordinator_status"; status: AgentStatus }
  | { type: "coordinator_activity"; activity?: AgentActivity; activityHistory: AgentActivity[] }
  | { type: "coordinator_settings"; settings: AgentSettings }
  | { type: "coordinator_model_updated"; model: ModelRef }
  | { type: "coordinator_context"; context: CoordinatorContextState }
  | { type: "coordinator_message"; message: TranscriptMessage }
  | { type: "coordinator_message_updated"; message: TranscriptMessage }
  | { type: "coordinator_prompt_failed"; messageId: string; error: string }
  | { type: "coordinator_delta"; messageId: string; delta: string }
  | { type: "job_updated"; job: AgentJob }
  | { type: "transcript_page"; thread: TranscriptThread; messages: TranscriptMessage[]; page: TranscriptPageInfo }
  | { type: "maintenance_updated"; maintenance: MaintenanceStatus }
  | { type: "error"; message: string };
