import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { AgentJob, ClientMessage } from "@neocode/protocol";

function candidate(): AgentJob {
  return {
    id: "stale-browser", title: "Historical", prompt: "", status: "failed", branch: "neocode/stale",
    worktree: "/repo/.worktrees/stale", isolation: { requested: "worktree", mode: "worktree", path: "/repo/.worktrees/stale" },
    baseRef: "base", createdAt: 1, updatedAt: 2, messages: [],
    staleCandidate: {
      state: "pending", nominatedAt: 1, nominatedBy: "coordinator", reason: "Historical implementation has specific replacement evidence.",
      suspectedReplacementJobId: "replacement-full-id", suspectedReplacementCommit: "0123456789abcdef",
      evidenceSource: "audit.json", confirmation: "pending", resumeState: { status: "failed" },
      audit: { path: "/repo/.worktrees/stale", branch: "neocode/stale", head: "head", dirty: true, porcelain: " M file", trackedDiffSha256: "tracked", contentFingerprint: "fingerprint", untrackedFiles: [] },
    },
  };
}

test("stale decision buttons confirm explicitly and exact evidence copies from keyboard-focusable controls", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const confirmations: string[] = [];
  dom.window.confirm = (message) => { confirmations.push(String(message)); return true; };
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { StaleDecisionControls, StaleEvidence } = await import("./App.js");
  const sent: ClientMessage[] = [];
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<><StaleEvidence job={candidate()} /><StaleDecisionControls job={candidate()} send={(message) => { sent.push(message); return true; }} /></>));

  const group = document.querySelector('[role="group"][aria-label="Stale candidate decision"]');
  assert.ok(group);
  const buttons = [...group!.querySelectorAll("button")];
  assert.deepEqual(buttons.map((button) => button.textContent), ["Still wanted", "Confirm superseded"]);
  for (const button of buttons) { button.focus(); assert.equal(document.activeElement, button); assert.equal(button.tabIndex, 0); }
  await act(async () => buttons[1]!.click());
  assert.match(confirmations[0] || "", /archive/i);
  assert.deepEqual(sent[0], { type: "decide_stale_candidate", jobId: "stale-browser", decision: "confirm_superseded" });

  const details = document.querySelector(".stale-evidence details");
  assert.ok(details && !details.hasAttribute("open"), "exact identifiers are collapsed by default");
  const summaryText = document.querySelector(".stale-evidence")!.textContent!.split("Exact audit")[0]!;
  assert.doesNotMatch(summaryText, /replacement-full-id|0123456789abcdef/);
  const copy = [...document.querySelectorAll("button")].find((button) => button.textContent === "Copy exact evidence")!;
  copy.focus(); assert.equal(document.activeElement, copy);
  await act(async () => { copy.click(); await Promise.resolve(); });
  assert.match(copied, /replacement-full-id/);
  assert.match(copied, /0123456789abcdef/);
  assert.equal(document.querySelector('[role="status"]')?.textContent, "Exact stale evidence copied");
  await act(async () => root.unmount());
  dom.window.close();
  void React;
});
