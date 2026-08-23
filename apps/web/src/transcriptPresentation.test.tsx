import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentJob, TranscriptMessage } from "@neocode/protocol";
import { ReviewView, TechnicalEvidence } from "./App";
import { presentTranscriptMessage } from "./transcriptPresentation";

const jobId = "9b361a1b-625f-4ea7-83fd-29f4e0b942fe";
const exactDiff = "8b64f0c69c18ac2b8d41fbb6af65f90bbb98da36ef9ed849c56f09fe1f51a112";

function job(): AgentJob {
  return {
    id: jobId,
    title: "Clean composer focus",
    prompt: "",
    status: "completed",
    branch: "neocode/clean-composer",
    worktree: "/repo/.worktrees/clean-composer",
    isolation: { requested: "worktree", mode: "worktree", path: "/repo/.worktrees/clean-composer" },
    baseRef: "main",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
  };
}

function statusMessage(payload: object): TranscriptMessage {
  return { id: "event-message", role: "system", timestamp: 3, text: `[worker_status] ${JSON.stringify(payload)}` };
}

test("known lifecycle IDs render durable titles and semantic action labels first", () => {
  const message = statusMessage({ eventId: "opaque-event-id", jobId, title: "Stale title", state: "handoff", detail: `diff=${exactDiff}` });
  const presentation = presentTranscriptMessage(message, [job()]);

  assert.equal(presentation.primary, "Clean composer focus · Ready for review");
  assert.equal(presentation.secondary, "Worker · 9b361a1b");
  assert.equal(presentation.technical, message.text);
  assert.doesNotMatch(presentation.primary, /opaque-event-id|9b361a1b-625f/);
});

test("unknown lifecycle IDs have a readable short-reference fallback", () => {
  const unknownId = "f14ecabe-7b93-4872-9f70-72553543ab61";
  const presentation = presentTranscriptMessage(statusMessage({ eventId: "event", jobId: unknownId, state: "needs_attention" }), []);

  assert.equal(presentation.primary, "Unknown worker · Needs attention");
  assert.equal(presentation.secondary, "Worker · f14ecabe");
  assert.match(presentation.technical || "", new RegExp(unknownId));
});

test("exact hashes and identifiers remain available only in collapsed technical evidence", () => {
  const value = job();
  value.handoff = {
    report: "Composer focus is stable.", requirements: [], diffSha256: exactDiff,
    branch: value.branch, worktree: value.isolation.path, tests: ["npm test"], risks: [], round: 1, createdAt: 2,
  };
  value.review = {
    hookToken: "hook", status: "approved", attempt: 1, targetBranch: "main", updatedAt: 3,
    transitions: [{ status: "approved", at: 3, owner: "judge", detail: `exact diff ${exactDiff}` }],
  };
  const markup = renderToStaticMarkup(<ReviewView job={value} />);

  assert.match(markup, /Reviewed changes · 8b64f0c6/);
  assert.match(markup, new RegExp(`<details class="technical-evidence"><summary>Exact handoff evidence</summary><pre>diff sha256 ${exactDiff}`));
  assert.doesNotMatch(markup, /<details[^>]* open/);

  const identity = renderToStaticMarkup(<TechnicalEvidence>{jobId}</TechnicalEvidence>);
  assert.match(identity, new RegExp(`<details class="technical-evidence"><summary>Technical details</summary><pre>${jobId}`));
  assert.doesNotMatch(identity, /<details[^>]* open/);
});
