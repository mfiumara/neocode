import type { AgentJob, TranscriptMessage } from "@neocode/protocol";

export interface TranscriptPresentation {
  primary: string;
  secondary?: string;
  /** The exact stored text, exposed only by collapsed technical UI. */
  technical?: string;
  lifecycle: boolean;
}

export function shortReference(value: string | undefined, length = 8): string | undefined {
  if (!value) return undefined;
  return value.length > length ? value.slice(0, length) : value;
}

const stateLabels: Record<string, string> = {
  action_required: "Action required",
  approved: "Review approved",
  backlog_sweep: "Queued for coordinator review",
  ci_running: "Running verification",
  ci_failed: "Verification failed",
  conflict: "Conflict needs attention",
  conflicted: "Conflict needs attention",
  blocked: "Blocked · needs attention",
  failed: "Worker failed",
  feedback_sent: "Changes requested",
  handoff: "Ready for review",
  handoff_received: "New handoff ready for review",
  judging: "Independent review in progress",
  lifecycle_transition: "Lifecycle updated",
  merge_queued: "Integration approved",
  merged: "Integrated and verified",
  merging: "Integrating",
  needs_attention: "Needs attention",
  post_merge_ci: "Verifying integration",
  post_ci_failed: "Integration verification failed",
  queued: "Queued for review",
  rejected: "Review rejected",
  worker_resumed: "Worker resumed",
};

export function semanticLifecycleState(state: unknown, detail?: unknown): string {
  if (state !== "lifecycle_transition") return stateLabels[String(state)] || String(state).replaceAll("_", " ");
  if (typeof detail === "string") {
    const match = detail.match(/^(?:worker|server|coordinator|judge):([a-z_]+)/);
    if (match) return stateLabels[match[1]!] || match[1]!.replaceAll("_", " ");
  }
  return stateLabels.lifecycle_transition!;
}

function workerStatusPresentation(text: string, jobs: AgentJob[]): TranscriptPresentation | undefined {
  const prefix = "[worker_status] ";
  if (!text.startsWith(prefix)) return undefined;
  try {
    const payload = JSON.parse(text.slice(prefix.length)) as Record<string, unknown>;
    if (typeof payload.jobId !== "string" || typeof payload.state !== "string") return undefined;
    const known = jobs.find((job) => job.id === payload.jobId);
    const payloadTitle = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : undefined;
    const title = known?.title || payloadTitle || "Unknown worker";
    return {
      primary: `${title} · ${semanticLifecycleState(payload.state, payload.detail)}`,
      secondary: `Worker · ${shortReference(payload.jobId)}`,
      technical: text,
      lifecycle: true,
    };
  } catch {
    return undefined;
  }
}

const fullUuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const longHash = /\b[0-9a-f]{16,}\b/gi;

export function presentIdentifierText(text: string, jobs: AgentJob[]): TranscriptPresentation {
  let primary = text;
  let transformed = false;
  const knownReferences: string[] = [];
  // Durable IDs win over stale transcript labels and sentence-shape guesses.
  // This handles every assistant/system/tool sentence, not only known templates.
  for (const job of jobs) {
    if (!primary.includes(job.id)) continue;
    primary = primary.split(job.id).join(job.title);
    knownReferences.push(`${job.title} · ${shortReference(job.id)}`);
    transformed = true;
  }
  primary = primary.replace(fullUuid, (identifier) => {
    transformed = true;
    return shortReference(identifier)!;
  });
  primary = primary.replace(longHash, (identifier) => {
    transformed = true;
    return shortReference(identifier)!;
  });

  if (!transformed) return { primary: text, lifecycle: false };
  return {
    primary,
    secondary: knownReferences.length ? [...new Set(knownReferences)].join(" · ") : undefined,
    technical: text,
    lifecycle: true,
  };
}

/** Build readable display copy without changing the exact durable transcript. */
export function presentTranscriptMessage(message: TranscriptMessage, jobs: AgentJob[]): TranscriptPresentation {
  if (message.role === "user") return { primary: message.text, lifecycle: false };
  const status = workerStatusPresentation(message.text, jobs);
  return status || presentIdentifierText(message.text, jobs);
}
