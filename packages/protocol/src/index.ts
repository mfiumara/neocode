export type AgentStatus = "idle" | "running" | "error";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** A deliberately compact, user-facing summary of an agent's current work. */
export interface AgentActivity {
  phase: "starting" | "thinking" | "responding" | "tool_pending" | "tool_running" | "tool_complete" | "tool_error";
  description: string;
  toolName?: string;
  updatedAt: number;
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
  worktree: string;
  baseRef: string;
  createdAt: number;
  updatedAt: number;
  messages: TranscriptMessage[];
  activity?: AgentActivity;
  summary?: string;
  diff?: string;
  error?: string;
}

export interface AppSnapshot {
  cwd: string;
  coordinator: {
    status: AgentStatus;
    activity?: AgentActivity;
    messages: TranscriptMessage[];
  };
  jobs: AgentJob[];
}

export type ClientMessage =
  | { type: "prompt"; text: string; context?: string[] }
  | { type: "abort" }
  | { type: "delegate"; text: string }
  | { type: "cancel_job"; jobId: string }
  | { type: "refresh" };

export type ServerMessage =
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "coordinator_status"; status: AgentStatus }
  | { type: "coordinator_activity"; activity?: AgentActivity }
  | { type: "coordinator_message"; message: TranscriptMessage }
  | { type: "coordinator_message_updated"; message: TranscriptMessage }
  | { type: "coordinator_delta"; messageId: string; delta: string }
  | { type: "job_updated"; job: AgentJob }
  | { type: "error"; message: string };
