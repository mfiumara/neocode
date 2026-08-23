import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentJob } from "@neocode/protocol";
import { App, JobSidebarRow, ReviewView } from "./App";

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
