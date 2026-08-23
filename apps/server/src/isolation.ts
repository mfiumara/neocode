import type { IsolationMode, RequestedIsolationMode } from "@neocode/protocol";

/**
 * Auto is intentionally conservative: a task only shares the root checkout when
 * it starts like an investigation and contains no language suggesting changes.
 */
export function resolveIsolationMode(task: string, requested: RequestedIsolationMode): IsolationMode {
  if (requested !== "auto") return requested;

  const normalized = task.trim().toLowerCase();
  const readOnlyIntent = /^(inspect|investigate|review|analy[sz]e|explain|summari[sz]e|describe|find|locate|check|diagnose|research|answer)\b/.test(normalized);
  const mutationIntent = /\b(implement|change|edit|fix|add|remove|delete|write|create|refactor|update|upgrade|migrate|rename|format|commit|apply|modify|build)\b/.test(normalized);
  return readOnlyIntent && !mutationIntent ? "root" : "worktree";
}
