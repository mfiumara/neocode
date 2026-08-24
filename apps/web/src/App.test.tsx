import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentJob } from "@neocode/protocol";
import { TooltipProvider } from "./components/ui/tooltip";
import { App, ContextIndicator, JobSidebarRow, ReviewStatusPanel, ReviewView } from "./App";

test("the composer exposes send and an accessible image-picker fallback without a keyboard mode badge", () => {
  const markup = renderToStaticMarkup(<App />);
  const actions = markup.match(/<div class="action-buttons">(.*?)<\/div>/)?.[1];

  assert.ok(actions);
  assert.equal(actions.match(/<button/g)?.length, 2);
  assert.match(actions, /aria-label="Choose image attachments"/);
  assert.match(actions, />Attach images<\/button>/);
  assert.match(actions, />Send <span>↵<\/span><\/button>/);
  assert.doesNotMatch(markup, /mode-badge|>INSERT<|>NORMAL</);
});

test("context indicator exposes usage, capacity, percentage, auto state, and an accessible compact action", () => {
  const markup = renderToStaticMarkup(<TooltipProvider><ContextIndicator
    connected
    onCompact={() => {}}
    context={{
      usage: { tokens: 48_000, contextWindow: 128_000, percent: 37.5, updatedAt: 1 },
      autoCompactionEnabled: true,
      manualCompactionAvailable: true,
      compaction: { state: "completed", reason: "manual", startedAt: 1, completedAt: 2, tokensBefore: 60_000 },
    }}
  /></TooltipProvider>);

  assert.match(markup, /48,000 \/ 128,000/);
  assert.match(markup, /38%/);
  assert.match(markup, /<meter[^>]+max="128000"[^>]+value="48000"/);
  assert.match(markup, /Automatic context compaction enabled/);
  assert.match(markup, /aria-label="Compact coordinator model context"/);
  assert.match(markup, /role="status" aria-live="polite">Compaction completed/);
});

test("context indicator clearly announces unknown post-compaction usage and disables unsafe compaction", () => {
  const markup = renderToStaticMarkup(<TooltipProvider><ContextIndicator
    connected
    onCompact={() => {}}
    context={{
      usage: { tokens: null, contextWindow: 128_000, percent: null, updatedAt: 1 },
      autoCompactionEnabled: false,
      manualCompactionAvailable: false,
      compaction: { state: "completed", reason: "overflow", startedAt: 1, completedAt: 2 },
    }}
  /></TooltipProvider>);

  assert.match(markup, /unknown \/ 128,000/);
  assert.match(markup, /Usage unknown after compaction/);
  assert.match(markup, /Automatic context compaction disabled/);
  assert.match(markup, /<button[^>]+disabled=""[^>]+aria-label="Compact coordinator model context"/);
  assert.match(markup, /Compaction completed/);
  assert.doesNotMatch(markup, /<meter/);
});

test("terminal compaction status preserves SDK retry intent without a stale spinner", () => {
  const markup = renderToStaticMarkup(<TooltipProvider><ContextIndicator
    connected
    onCompact={() => {}}
    context={{
      usage: { tokens: 80_000, contextWindow: 128_000, percent: 62.5, updatedAt: 1 },
      autoCompactionEnabled: true,
      manualCompactionAvailable: false,
      compaction: { state: "failed", reason: "overflow", startedAt: 1, completedAt: 2, willRetry: true, error: "temporary provider error" },
    }}
  /></TooltipProvider>);

  assert.match(markup, /Compaction failed · SDK will retry: temporary provider error/);
  assert.doesNotMatch(markup, />Compacting…</);
  assert.match(markup, />Compact</);
});

test("the workspace command-palette label uses Command/Ctrl-K", () => {
  const markup = renderToStaticMarkup(<App />);

  assert.match(markup, /Open command palette \(Command\/Ctrl-K\)/);
  assert.match(markup, /⌘\/Ctrl K/);
});

function sidebarJob(
  reviewStatus: NonNullable<AgentJob["review"]>["status"],
  status: AgentJob["status"] = "completed",
  integrationStatus: NonNullable<AgentJob["integration"]>["status"] = "reviewing",
): AgentJob {
  return {
    id: reviewStatus, title: "Lifecycle worker", prompt: "", status, branch: "worker",
    worktree: "/worktree", isolation: { requested: "worktree", mode: "worktree", path: "/worktree" },
    baseRef: "base", createdAt: 1, updatedAt: 2, messages: [], integration: { status: integrationStatus },
    review: { hookToken: "hook", status: reviewStatus, attempt: 1, targetBranch: "main", updatedAt: 2, transitions: [] },
  };
}

test("sidebar renders current lifecycle execution as a labelled spinner only while connected", () => {
  const active = renderToStaticMarkup(<JobSidebarRow job={sidebarJob("judging")} active={false} activityReady onOpen={() => {}} />);
  assert.match(active, /job-glyph in-progress/);
  assert.match(active, /Under review/);

  for (const status of ["blocked", "failed", "approved"] as const) {
    const settled = renderToStaticMarkup(<JobSidebarRow job={sidebarJob(status)} active={false} activityReady onOpen={() => {}} />);
    assert.doesNotMatch(settled, /job-glyph in-progress/);
  }
  const reconnecting = renderToStaticMarkup(<JobSidebarRow job={sidebarJob("merging")} active={false} activityReady={false} onOpen={() => {}} />);
  assert.doesNotMatch(reconnecting, /job-glyph in-progress/);
});

test("sidebar keeps queued and terminal worker labels authoritative over stale lifecycle state", () => {
  const cases: Array<[AgentJob, string]> = [
    [sidebarJob("judging", "queued"), "Queued"],
    [sidebarJob("worker_resumed", "queued"), "Queued"],
    [sidebarJob("merge_queued", "completed", "integrating"), "Approved · awaiting integration"],
    [sidebarJob("worker_resumed", "interrupted"), "Interrupted · recoverable"],
    [sidebarJob("worker_resumed", "failed"), "Failed"],
    [sidebarJob("judging", "needs_attention"), "Needs attention"],
  ];

  for (const [job, label] of cases) {
    const freshSnapshot = renderToStaticMarkup(<JobSidebarRow job={job} active={false} activityReady onOpen={() => {}} />);
    assert.doesNotMatch(freshSnapshot, /job-glyph in-progress/);
    assert.ok(freshSnapshot.includes(label), `${job.status}/${job.review?.status} should render ${label}`);
  }
});


test("compact review panel has timeline semantics, check counts, and collapsed technical evidence", () => {
  const value = sidebarJob("judging");
  value.review!.ci = [
    { command: "npm run test", ok: true, exitCode: 0, durationMs: 10, output: "secret diagnostic" },
    { command: "npm run check", ok: false, exitCode: 1, durationMs: 20, output: "type diagnostic" },
  ];
  value.review!.judge = { approved: false, summary: "One requirement remains", requirements: [], model: { provider: "pi", id: "judge" }, diffSha256: "exacthash", raw: "{\"approved\":false}" };
  const markup = renderToStaticMarkup(<ReviewStatusPanel job={value} activityReady />);

  assert.match(markup, /aria-label="Worker review progress"/);
  assert.match(markup, /aria-current="step"/);
  assert.match(markup, /1\/2 product checks passed/);
  assert.match(markup, /Rejected: One requirement remains/);
  assert.match(markup, /<details class="technical-evidence">/);
  assert.match(markup, /Technical review evidence/);
  assert.match(markup, /npm run test/);
  assert.doesNotMatch(markup, /<details class="technical-evidence" open/);
});

test("compact panel preserves remediation judge audit evidence after the current verdict is cleared", () => {
  const value = sidebarJob("blocked");
  value.review!.remediation = { maxAttempts: 2, rounds: {}, actions: [{
    id: "opaque-action", failureClass: "judge_changes", fingerprint: "fingerprint", state: "pending",
    attempt: 1, maxAttempts: 2, createdAt: 10, updatedAt: 20,
    evidence: { detail: "Fresh approval required", checks: [{ command: "npm test -- exact", ok: false, exitCode: 1, durationMs: 22, output: "nested diagnostic" }], judge: {
      approved: false, summary: "Durable remediation verdict", requirements: [], model: { provider: "pi", id: "judge" }, diffSha256: "nested-hash", raw: "{\"approved\":false}",
    } },
  }] };
  const markup = renderToStaticMarkup(<ReviewStatusPanel job={value} />);
  assert.match(markup, /Rejected: Durable remediation verdict/);
  assert.match(markup, /opaque-action/);
  assert.match(markup, /npm test -- exact/);
  assert.match(markup, /nested diagnostic/);
  assert.match(markup, /nested-hash/);
  assert.doesNotMatch(markup, /<details class="technical-evidence" open/);
});

test("compact panel does not show an active marker for stale review metadata", () => {
  const markup = renderToStaticMarkup(<ReviewStatusPanel job={sidebarJob("judging")} activityReady={false} />);
  assert.match(markup, /Review status recorded/);
  assert.match(markup, /live activity is not confirmed/);
  assert.doesNotMatch(markup, /aria-current="step"/);
});

test("review renders the complete handoff and owned lifecycle evidence", () => {
  const job: AgentJob = {
    id: "worker-1", title: "Ship", prompt: "ship", status: "completed",
    branch: "neocode/ship", worktree: "/tmp/ship",
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/ship" },
    baseRef: "base", createdAt: 1, updatedAt: 2, messages: [],
    handoff: {
      report: "Implemented safely.", requirements: ["preserve ownership"],
      diffSha256: "abc123", branch: "neocode/ship", worktree: "/tmp/ship",
      tests: ["npm test passed"], risks: ["none"], round: 2, createdAt: 2,
    },
    review: {
      hookToken: "hook", status: "approved", attempt: 2, targetBranch: "main", updatedAt: 2,
      transitions: [
        { status: "handoff_received", at: 1, owner: "worker", detail: "structured handoff" },
        { status: "approved", at: 2, owner: "judge", detail: "exact diff approved" },
      ],
    },
  };

  const markup = renderToStaticMarkup(<ReviewView job={job} />);
  for (const evidence of ["Implemented safely.", "preserve ownership", "npm test passed", "none", "neocode/ship", "/tmp/ship", "abc123", "worker", "handoff received", "judge", "approved"]) {
    assert.ok(markup.includes(evidence), `missing handoff or lifecycle evidence: ${evidence}`);
  }
});
