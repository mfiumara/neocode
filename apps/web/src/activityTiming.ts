import { useEffect, useState } from "react";
import type { AgentActivity } from "@neocode/protocol";

export interface LiveTimeAnchor {
  elapsedAtAnchorMs: number;
  monotonicAtAnchorMs: number;
}

export function createLiveTimeAnchor(
  startedAt: number,
  wallNow: number,
  monotonicNow: number,
): LiveTimeAnchor {
  return {
    elapsedAtAnchorMs: Math.max(0, wallNow - startedAt),
    monotonicAtAnchorMs: monotonicNow,
  };
}

export function liveElapsedMs(anchor: LiveTimeAnchor, monotonicNow: number): number {
  return Math.max(0, anchor.elapsedAtAnchorMs + monotonicNow - anchor.monotonicAtAnchorMs);
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** Browser-only ticking: no server messages or persisted updates are generated. */
export function useActivityDuration(activity?: AgentActivity): string {
  const completed = activity?.durationMs;
  const [display, setDisplay] = useState(() => formatDuration(completed ?? 0));

  useEffect(() => {
    if (!activity) {
      setDisplay(formatDuration(0));
      return;
    }
    if (activity.durationMs !== undefined) {
      setDisplay(formatDuration(activity.durationMs));
      return;
    }
    const anchor = createLiveTimeAnchor(activity.startedAt, Date.now(), performance.now());
    const update = () => setDisplay(formatDuration(liveElapsedMs(anchor, performance.now())));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [activity?.startedAt, activity?.completedAt, activity?.durationMs]);

  return display;
}
