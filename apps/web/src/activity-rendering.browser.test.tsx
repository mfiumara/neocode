import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { AgentActivity, AgentJob, AppSnapshot, JobStatus } from "@neocode/protocol";

class MockSocket {
  static OPEN = 1;
  static instances: MockSocket[] = [];
  readyState = MockSocket.OPEN;
  onopen?: () => void;
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  onclose?: () => void;
  constructor(readonly url: string) { MockSocket.instances.push(this); }
  send() {}
  close() { this.readyState = 3; }
}

const recentActivity: AgentActivity = {
  phase: "tool_complete",
  description: "Finished request_worker_changes",
  toolName: "request_worker_changes",
  startedAt: 100,
  completedAt: 200,
  durationMs: 100,
  outcome: "completed",
  updatedAt: 200,
};

const currentActivity: AgentActivity = {
  phase: "responding",
  description: "Writing response",
  startedAt: Date.now(),
  updatedAt: Date.now(),
};

function worker(status: JobStatus): AgentJob {
  return {
    id: "worker-1",
    title: "Worker one",
    prompt: "Work",
    status,
    branch: "worker-1",
    worktree: "/tmp/worker-1",
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/worker-1" },
    baseRef: "main",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    activity: currentActivity,
    activityHistory: [recentActivity],
  };
}

function snapshot(coordinatorStatus: AppSnapshot["coordinator"]["status"], jobs: AgentJob[] = []): AppSnapshot {
  return {
    cwd: "/tmp/activity-rendering",
    coordinator: {
      status: coordinatorStatus,
      activity: currentActivity,
      activityHistory: [recentActivity],
      messages: [],
      settings: { variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: [] },
      model: null,
      models: [],
    },
    jobs,
    maintenance: { state: "idle" },
  };
}

test("transcript activity renders only while its coordinator or worker is active", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Event: dom.window.Event,
    MessageEvent: dom.window.MessageEvent,
    WebSocket: MockSocket,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  try {
    const [{ createRoot }, { act }, { App }] = await Promise.all([
      import("react-dom/client"), import("react"), import("./App"),
    ]);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<App />));
    const socket = MockSocket.instances.at(-1)!;
    const receive = async (message: unknown) => act(async () => socket.onmessage?.(new dom.window.MessageEvent("message", {
      data: JSON.stringify(message),
    }) as unknown as MessageEvent));
    const assertActivityVisible = (visible: boolean) => {
      assert.equal(Boolean(document.querySelector(".activity-history")), visible);
      assert.equal(Boolean(document.querySelector(".working-row")), visible);
      assert.equal(document.querySelector(".activity-history")?.textContent.includes("Finished request_worker_changes") || false, visible);
    };

    await act(async () => socket.onopen?.());

    // Persisted coordinator timing remains in state, but an idle/error transcript must not show it.
    await receive({ type: "snapshot", snapshot: snapshot("idle") });
    assertActivityVisible(false);
    await receive({ type: "coordinator_status", status: "running" });
    assertActivityVisible(true);
    await receive({ type: "coordinator_status", status: "idle" });
    assertActivityVisible(false);
    await receive({ type: "coordinator_activity", activity: currentActivity, activityHistory: [recentActivity] });
    assertActivityVisible(false);
    await receive({ type: "coordinator_status", status: "error" });
    assertActivityVisible(false);

    // Worker history follows worker lifecycle transitions without deleting its timing data.
    await receive({ type: "snapshot", snapshot: snapshot("idle", [worker("running")]) });
    await act(async () => document.querySelector<HTMLButtonElement>(".job-row")!.click());
    assertActivityVisible(true);
    for (const status of ["queued", "completed", "interrupted", "failed", "cancelled"] as const) {
      await receive({ type: "job_updated", job: worker(status) });
      assertActivityVisible(false);
      await receive({ type: "job_updated", job: worker("running") });
      assertActivityVisible(true);
    }

    await act(async () => root.unmount());
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    MockSocket.instances = [];
  }
});
