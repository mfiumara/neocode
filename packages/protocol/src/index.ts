export type AgentStatus = "idle" | "running" | "error";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AgentVariant = "build" | "plan";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentSettings {
  variant: AgentVariant;
  thinkingLevel: ThinkingLevel;
  availableVariants: AgentVariant[];
  availableThinkingLevels: ThinkingLevel[];
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
  summary?: string;
  diff?: string;
  error?: string;
  /** Settings captured when this worker was delegated. */
  settings?: Pick<AgentSettings, "variant" | "thinkingLevel">;
}

export interface AppSnapshot {
  cwd: string;
  coordinator: {
    status: AgentStatus;
    messages: TranscriptMessage[];
    settings: AgentSettings;
  };
  jobs: AgentJob[];
}

export type ClientMessage =
  | { type: "prompt"; text: string; context?: string[] }
  | { type: "abort" }
  | { type: "delegate"; text: string }
  | { type: "cancel_job"; jobId: string }
  | { type: "cycle_variant" }
  | { type: "cycle_thinking" }
  | { type: "refresh" };

export type ServerMessage =
  | { type: "snapshot"; snapshot: AppSnapshot }
  | { type: "coordinator_status"; status: AgentStatus }
  | { type: "coordinator_message"; message: TranscriptMessage }
  | { type: "coordinator_message_updated"; message: TranscriptMessage }
  | { type: "coordinator_delta"; messageId: string; delta: string }
  | { type: "coordinator_settings"; settings: AgentSettings }
  | { type: "job_updated"; job: AgentJob }
  | { type: "error"; message: string };
