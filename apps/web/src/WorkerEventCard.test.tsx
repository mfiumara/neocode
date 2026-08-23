import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentJob, TranscriptMessage } from "@neocode/protocol";
import { parseWorkerEvent, WorkerEventCard } from "./WorkerEventCard";

const evidence = JSON.stringify({ checks: [{ output: "very large diagnostic" }], judge: { approved: false } });
const message: TranscriptMessage = {
  id: "event-1", role: "system", timestamp: 1,
  text: `[worker_status] ${JSON.stringify({ jobId: "job-7", title: "Fix pagination", state: "action_required", detail: evidence })}`,
};

test("lifecycle events are compact by default and retain expandable raw evidence", () => {
  const parsed = parseWorkerEvent(message);
  assert.equal(parsed?.actionRequired, true);
  const collapsed = renderToStaticMarkup(<WorkerEventCard message={message} />);
  assert.match(collapsed, /Fix pagination/);
  assert.match(collapsed, /action-required/);
  assert.doesNotMatch(collapsed, /very large diagnostic/, "raw evidence is not eagerly rendered");
});

test("structured cards resolve durable titles, semantic judge state, and short evidence references", () => {
  const jobId = "9b361a1b-625f-4ea7-83fd-29f4e0b942fe";
  const hash = "8b64f0c69c18ac2b8d41fbb6af65f90bbb98da36ef9ed849c56f09fe1f51a112";
  const job: AgentJob = {
    id: jobId, title: "Clean composer focus", prompt: "", status: "completed", branch: "branch", worktree: "/worktree",
    isolation: { requested: "worktree", mode: "worktree", path: "/worktree" }, baseRef: "main",
    createdAt: 1, updatedAt: 2, messages: [],
  };
  const event: TranscriptMessage = {
    id: "judge-event", role: "system", timestamp: 2, text: "Readable fallback",
    workerEvent: {
      jobId, title: "Stale title", state: "lifecycle_transition", summary: `judge:approved exact diff ${hash}`,
      actionRequired: false, rawEvidence: `[worker_status] jobId=${jobId} diff=${hash}`,
    },
  };
  const collapsed = renderToStaticMarkup(<WorkerEventCard message={event} jobs={[job]} />);
  assert.match(collapsed, /Clean composer focus/);
  assert.match(collapsed, /Review approved/);
  assert.match(collapsed, /exact diff 8b64f0c6/);
  assert.match(collapsed, /9b361a1b/);
  assert.doesNotMatch(collapsed, new RegExp(jobId));
  assert.doesNotMatch(collapsed, new RegExp(hash));
});

test("accessible disclosure renders full diagnostics only when expanded", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(<WorkerEventCard message={message} />));
  const button = dom.window.document.querySelector("button") as HTMLButtonElement;
  assert.equal(button.getAttribute("aria-expanded"), "false");
  await act(async () => button.click());
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.match(dom.window.document.querySelector("pre")?.textContent || "", /very large diagnostic/);
  await act(async () => root.unmount());
  dom.window.close();
});
