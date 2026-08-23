export type AgentStatus = "idle" | "running" | "error";
export type JobStatus = "queued" | "running" | "interrupted" | "completed" | "failed" | "cancelled";
export type RequestedIsolationMode = "auto" | "worktree" | "root";
export type IsolationMode = Exclude<RequestedIsolationMode, "auto">;
export type AgentVariant = "build" | "plan";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReviewStatus =
  | "queued" | "ci_running" | "ci_failed" | "judging" | "rejected"
  | "approved" | "merge_queued" | "merging" | "post_merge_ci"
  | "merged" | "post_ci_failed" | "blocked" | "conflict" | "failed";

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
}

export interface JobReview {
  /** Stable completion-hook token. Its presence prevents duplicate automatic runs. */
  hookToken: string;
  status: ReviewStatus;
  attempt: number;
  targetBranch: string;
  updatedAt: number;
  transitions: ReviewTransition[];
  ci?: CheckEvidence[];
  postMergeCi?: CheckEvidence[];
  judge?: JudgeEvidence;
  mergeCommit?: string;
  error?: string;
}

export interface AgentActivity {
  phase: "starting" | "thinking" | "responding" | "tool_pending" | "tool_running" | "tool_complete" | "tool_error";
  description: string;
  toolName?: string;
  updatedAt: number;
}

export interface ModelRef { provider: string; id: string }
export interface ModelChoice extends ModelRef { label: string }
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

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  timestamp: number;
  attachments?: ImageAttachment[];
}

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
  activity?: AgentActivity;
  settings?: Pick<AgentSettings, "variant" | "thinkingLevel">;
  summary?: string;
  diff?: string;
  error?: string;
  /** A stopped job whose checkout/session artifacts remain available for review or manual continuation. */
  recoverable?: boolean;
  /** Set when durable metadata no longer agrees with the git checkout. */
  recoveryIssue?: string;
  /** Durable automated CI, independent review, and reconciliation state. */
  review?: JobReview;
}

export interface AppSnapshot {
  cwd: string;
  coordinator: {
    status: AgentStatus;
    activity?: AgentActivity;
    messages: TranscriptMessage[];
    settings: AgentSettings;
    model: ModelRef | null;
    models: ModelChoice[];
  };
  jobs: AgentJob[];
}

export type ClientMessage =
  | { type: "prompt"; text: string; context?: string[]; attachments?: ImageAttachment[] }
  | { type: "abort" }
  | { type: "delegate"; text: string; isolation?: RequestedIsolationMode; attachments?: ImageAttachment[] }
  | { type: "cancel_job"; jobId: string }
  | { type: "retry_review"; jobId: string }
  | { type: "merge_review"; jobId: string }
  | { type: "cycle_variant" }
  | { type: "cycle_thinking" }
  | { type: "set_model"; model: ModelRef }
  | { type: "refresh" };

export type ServerMessage =
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "coordinator_status"; status: AgentStatus }
  | { type: "coordinator_activity"; activity?: AgentActivity }
  | { type: "coordinator_settings"; settings: AgentSettings }
  | { type: "coordinator_model_updated"; model: ModelRef }
  | { type: "coordinator_message"; message: TranscriptMessage }
  | { type: "coordinator_message_updated"; message: TranscriptMessage }
  | { type: "coordinator_delta"; messageId: string; delta: string }
  | { type: "job_updated"; job: AgentJob }
  | { type: "error"; message: string };
