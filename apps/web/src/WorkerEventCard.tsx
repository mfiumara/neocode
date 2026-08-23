import { useState } from "react";
import type { AgentJob, TranscriptMessage, WorkerEventPresentation } from "@neocode/protocol";
import { presentIdentifierText, semanticLifecycleState, shortReference } from "./transcriptPresentation";

interface ParsedWorkerEvent extends WorkerEventPresentation { raw: string }

export function parseWorkerEvent(message: TranscriptMessage): ParsedWorkerEvent | undefined {
  if (message.workerEvent) return { ...message.workerEvent, raw: message.workerEvent.rawEvidence || message.text };
  const marker = message.text.indexOf("[worker_status]");
  if (marker < 0 && !message.text.includes("<neocode-worker-event")) return undefined;
  const jsonStart = message.text.indexOf("{", Math.max(0, marker));
  if (jsonStart < 0) return undefined;
  try {
    const payload = JSON.parse(message.text.slice(jsonStart).replace(/<\/neocode-worker-event>\s*$/, "")) as Record<string, unknown>;
    const state = typeof payload.state === "string" ? payload.state : "worker event";
    const detail = typeof payload.detail === "string" ? payload.detail.replace(/\s+/g, " ").trim() : state.replaceAll("_", " ");
    const summary = state === "action_required"
      ? "Action required — review diagnostics and evidence"
      : detail;
    return {
      jobId: typeof payload.jobId === "string" ? payload.jobId : "unknown",
      title: typeof payload.title === "string" ? payload.title : "Worker",
      state,
      summary: summary.length > 240 ? `${summary.slice(0, 239)}…` : summary,
      actionRequired: state === "action_required" || state === "failed" || state === "needs_attention",
      raw: message.text,
    };
  } catch {
    return undefined;
  }
}

export function WorkerEventCard({ message, jobs = [] }: { message: TranscriptMessage; jobs?: AgentJob[] }) {
  const event = parseWorkerEvent(message);
  const [open, setOpen] = useState(false);
  if (!event) return null;
  const known = jobs.find((job) => job.id === event.jobId);
  const title = known?.title || presentIdentifierText(event.title, jobs).primary;
  const summary = presentIdentifierText(event.summary, jobs);
  const state = semanticLifecycleState(event.state, event.summary);
  return <section className={`worker-event-card ${event.actionRequired ? "action-required" : ""}`} aria-label={`Worker ${state}`}>
    <div className="worker-event-summary">
      <strong>{event.actionRequired ? "⚠ " : ""}{title}</strong><code>{shortReference(event.jobId)}</code>
      <span className="worker-event-state">{state}</span>
      <span className="worker-event-action">{summary.primary}</span>
      {summary.secondary && <small className="identifier-reference">{summary.secondary}</small>}
    </div>
    <button type="button" className="worker-event-disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? "Hide evidence" : "Evidence and diagnostics"}
    </button>
    {open && <pre className="worker-event-evidence" tabIndex={0}>{event.raw}</pre>}
  </section>;
}
