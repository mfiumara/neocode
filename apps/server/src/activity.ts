import type { AgentActivity } from "@neocode/protocol";

const MAX_DESCRIPTION = 140;
const OMITTED_KEYS = /(?:password|passwd|secret|token|authorization|api[_-]?key)/i;
const PREFERRED_KEYS = ["path", "file", "pattern", "query", "command", "cmd", "title", "jobId", "task"];

function compact(value: unknown, limit = 64): string | undefined {
  if (value === null || value === undefined) return undefined;
  let text: string;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else if (Array.isArray(value)) {
    text = value.slice(0, 3).map((entry) => compact(entry, 24)).filter(Boolean).join(", ");
    if (value.length > 3) text += ", …";
  } else {
    return undefined;
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

/** Produce a small, safe hint for a status line; never serialize arbitrary objects or tool output. */
export function summarizeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return compact(args);
  const record = args as Record<string, unknown>;
  const keys = [
    ...PREFERRED_KEYS.filter((key) => key in record),
    ...Object.keys(record).filter((key) => !PREFERRED_KEYS.includes(key)),
  ];
  const parts: string[] = [];
  for (const key of keys) {
    if (OMITTED_KEYS.test(key) || parts.length >= 3) continue;
    const value = compact(record[key]);
    if (value) parts.push(`${key}: ${value}`);
  }
  if (!parts.length) return undefined;
  const summary = parts.join(" · ");
  return summary.length > 110 ? `${summary.slice(0, 109)}…` : summary;
}

export interface ActivityClock {
  wallNow(): number;
  monotonicNow(): number;
}

export const systemActivityClock: ActivityClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
};

export function activity(
  phase: AgentActivity["phase"],
  description: string,
  toolName?: string,
  now = Date.now(),
): AgentActivity {
  const normalized = description.replace(/\s+/g, " ").trim();
  return {
    phase,
    description: normalized.length > MAX_DESCRIPTION
      ? `${normalized.slice(0, MAX_DESCRIPTION - 1)}…`
      : normalized,
    toolName,
    startedAt: now,
    updatedAt: now,
  };
}

/** Owns one activity step. Duplicate streaming deltas do not restart its clock. */
export class ActivityTimeline {
  current?: AgentActivity;
  readonly history: AgentActivity[];
  private monotonicStartedAt?: number;

  constructor(
    current?: AgentActivity,
    history: AgentActivity[] = [],
    private readonly clock: ActivityClock = systemActivityClock,
    private readonly historyLimit = 12,
  ) {
    this.current = current;
    this.history = history;
    if (current) this.monotonicStartedAt = clock.monotonicNow();
  }

  set(next?: AgentActivity): boolean {
    if (this.current?.phase === next?.phase
      && this.current?.description === next?.description
      && this.current?.toolName === next?.toolName) return false;
    this.completeCurrent();
    this.current = next;
    this.monotonicStartedAt = next ? this.clock.monotonicNow() : undefined;
    return true;
  }

  finish(outcome: NonNullable<AgentActivity["outcome"]> = "completed"): boolean {
    if (!this.current) return false;
    this.completeCurrent(outcome);
    return true;
  }

  /** Finish restored/in-process work truthfully on interruption. */
  completeCurrent(outcome: NonNullable<AgentActivity["outcome"]> = "completed"): AgentActivity | undefined {
    if (!this.current) return undefined;
    const completedAt = this.clock.wallNow();
    const elapsed = this.monotonicStartedAt === undefined
      ? completedAt - this.current.startedAt
      : this.clock.monotonicNow() - this.monotonicStartedAt;
    const completed = {
      ...this.current,
      completedAt,
      durationMs: Math.max(0, Math.round(elapsed)),
      outcome,
      updatedAt: completedAt,
    };
    this.history.unshift(completed);
    if (this.history.length > this.historyLimit) this.history.length = this.historyLimit;
    this.current = undefined;
    this.monotonicStartedAt = undefined;
    return completed;
  }
}

export function toolActivity(
  phase: "tool_pending" | "tool_running" | "tool_complete" | "tool_error",
  toolName: string,
  args?: unknown,
): AgentActivity {
  const hint = summarizeToolArgs(args);
  const verb = phase === "tool_pending" ? "Preparing"
    : phase === "tool_running" ? "Running"
      : phase === "tool_error" ? "Failed"
        : "Finished";
  return activity(phase, `${verb} ${toolName}${hint ? ` — ${hint}` : ""}`, toolName);
}
