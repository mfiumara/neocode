export type AgentStatus = "idle" | "running" | "error";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS = 4;

/** Base64 is used instead of browser-local blob URLs so attachments can cross the WebSocket. */
export interface ImageAttachment {
  id: string;
  mimeType: (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];
  data: string;
  size: number;
  name?: string;
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
  worktree: string;
  baseRef: string;
  createdAt: number;
  updatedAt: number;
  messages: TranscriptMessage[];
  summary?: string;
  diff?: string;
  error?: string;
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
  | { type: "prompt"; text: string; context?: string[]; attachments?: ImageAttachment[] }
  | { type: "abort" }
  | { type: "delegate"; text: string; attachments?: ImageAttachment[] }
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
