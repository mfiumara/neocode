export type AgentStatus = "idle" | "running" | "error";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  timestamp: number;
}

export interface AgentJob {
  id: string;
  title: string;
  prompt: string;
  status: JobStatus;
  branch: string;
  worktree: string;
  baseRef: string;
  createdAt: number;
  updatedAt: number;
  messages: TranscriptMessage[];
  summary?: string;
  diff?: string;
  error?: string;
}

export interface ModelRef {
  /** Provider-scoped model identifier used by Pi. */
  id: string;
  provider: string;
}

export interface ModelChoice extends ModelRef {
  /** Human-readable name supplied by the provider catalog. */
  label: string;
}

export interface AppSnapshot {
  cwd: string;
  coordinator: {
    status: AgentStatus;
    messages: TranscriptMessage[];
    model: ModelRef | null;
    models: ModelChoice[];
  };
  jobs: AgentJob[];
}

export type ClientMessage =
  | { type: "prompt"; text: string; context?: string[] }
  | { type: "abort" }
  | { type: "delegate"; text: string }
  | { type: "cancel_job"; jobId: string }
  | { type: "set_model"; model: ModelRef }
  | { type: "refresh" };

export type ServerMessage =
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "coordinator_status"; status: AgentStatus }
  | { type: "coordinator_model_updated"; model: ModelRef }
  | { type: "coordinator_message"; message: TranscriptMessage }
  | { type: "coordinator_message_updated"; message: TranscriptMessage }
  | { type: "coordinator_delta"; messageId: string; delta: string }
  | { type: "job_updated"; job: AgentJob }
  | { type: "error"; message: string };
