export type AgentStatus = "idle" | "running" | "error";
export type JobStatus = "queued" | "running" | "interrupted" | "completed" | "failed" | "cancelled";
export type RequestedIsolationMode = "auto" | "worktree" | "root";
export type IsolationMode = Exclude<RequestedIsolationMode, "auto">;

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
  summary?: string;
  diff?: string;
  error?: string;
  /** A stopped job whose checkout/session artifacts remain available for review or manual continuation. */
  recoverable?: boolean;
  /** Set when durable metadata no longer agrees with the git checkout. */
  recoveryIssue?: string;
}

export interface AppSnapshot {
  cwd: string;
  coordinator: {
    status: AgentStatus;
    messages: TranscriptMessage[];
  };
  jobs: AgentJob[];
}

export type ClientMessage =
  | { type: "prompt"; text: string; context?: string[] }
  | { type: "abort" }
  | { type: "delegate"; text: string; isolation?: RequestedIsolationMode }
  | { type: "cancel_job"; jobId: string }
  | { type: "refresh" };

export type ServerMessage =
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "coordinator_status"; status: AgentStatus }
  | { type: "coordinator_message"; message: TranscriptMessage }
  | { type: "coordinator_message_updated"; message: TranscriptMessage }
  | { type: "coordinator_delta"; messageId: string; delta: string }
  | { type: "job_updated"; job: AgentJob }
  | { type: "error"; message: string };
