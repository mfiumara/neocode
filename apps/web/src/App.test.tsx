import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentJob } from "@neocode/protocol";
import { App, JobSidebarRow } from "./App";

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

function sidebarJob(reviewStatus: NonNullable<AgentJob["review"]>["status"]): AgentJob {
  return {
    id: reviewStatus, title: "Lifecycle worker", prompt: "", status: "completed", branch: "worker",
    worktree: "/worktree", isolation: { requested: "worktree", mode: "worktree", path: "/worktree" },
    baseRef: "base", createdAt: 1, updatedAt: 2, messages: [], integration: { status: "reviewing" },
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
