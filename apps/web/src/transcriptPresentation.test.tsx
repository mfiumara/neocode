import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentJob, TranscriptMessage } from "@neocode/protocol";
import { ReviewView, TechnicalEvidence, TranscriptMessageBody } from "./App";
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

test("judge and failure lifecycle transitions use concrete semantic labels", () => {
  const cases = [
    ["judge:approved Exact diff accepted", "Review approved"],
    ["judge:rejected Required behavior is missing", "Review rejected"],
    ["server:ci_failed Candidate checks failed", "Verification failed"],
    ["server:post_ci_failed Main verification failed", "Integration verification failed"],
    ["coordinator:blocked Awaiting safe repair", "Blocked · needs attention"],
    ["server:conflict Rebase stopped", "Conflict needs attention"],
    ["server:conflicted Worktree remains conflicted", "Conflict needs attention"],
  ] as const;
  for (const [detail, expected] of cases) {
    const presentation = presentTranscriptMessage(statusMessage({ jobId, state: "lifecycle_transition", detail }), [job()]);
    assert.equal(presentation.primary, `Clean composer focus · ${expected}`, detail);
  }
});

test("unknown lifecycle IDs have a readable short-reference fallback", () => {
  const unknownId = "f14ecabe-7b93-4872-9f70-72553543ab61";
  const presentation = presentTranscriptMessage(statusMessage({ eventId: "event", jobId: unknownId, state: "needs_attention" }), []);

  assert.equal(presentation.primary, "Unknown worker · Needs attention");
  assert.equal(presentation.secondary, "Worker · f14ecabe");
  assert.match(presentation.technical || "", new RegExp(unknownId));
});

test("known IDs resolve in lifecycle sentences that do not match a fixed template", () => {
  const message: TranscriptMessage = {
    id: "completion", role: "assistant", timestamp: 4,
    text: `Worker ${jobId} completed successfully`,
  };
  const presentation = presentTranscriptMessage(message, [job()]);

  assert.equal(presentation.primary, "Worker Clean composer focus completed successfully");
  assert.equal(presentation.secondary, "Clean composer focus · 9b361a1b");
  assert.equal(presentation.technical, message.text);
});

test("ordinary system and tool text shortens commit, diff, and fingerprint hashes", () => {
  const commit = "ab1234567890ab1234567890ab1234567890abcd";
  const fingerprint = "cd1234567890cd1234567890cd1234567890cd1234567890cd1234567890cdef";
  for (const role of ["system", "tool"] as const) {
    const message: TranscriptMessage = {
      id: role, role, timestamp: 5,
      text: `Commit ${commit}; diff ${exactDiff}; fingerprint ${fingerprint}.`,
    };
    const presentation = presentTranscriptMessage(message, []);
    assert.equal(presentation.primary, "Commit ab123456; diff 8b64f0c6; fingerprint cd123456.");
    assert.equal(presentation.technical, message.text);
  }
});

test("mixed known and unknown IDs stay readable and retain their exact original", () => {
  const unknownId = "f14ecabe-7b93-4872-9f70-72553543ab61";
  const message: TranscriptMessage = {
    id: "mixed", role: "system", timestamp: 6,
    text: `Compared ${jobId} with ${unknownId}.`,
  };
  const presentation = presentTranscriptMessage(message, [job()]);

  assert.equal(presentation.primary, "Compared Clean composer focus with f14ecabe.");
  assert.equal(presentation.secondary, "Clean composer focus · 9b361a1b");
  assert.equal(presentation.technical, message.text);
  assert.doesNotMatch(presentation.primary, /625f|7b93/);
});

test("ordinary prose and user-authored identifiers are not hidden", () => {
  const prose: TranscriptMessage = { id: "prose", role: "assistant", timestamp: 7, text: "Worker completed successfully." };
  const user: TranscriptMessage = { id: "user", role: "user", timestamp: 8, text: `Please inspect ${exactDiff}.` };
  assert.deepEqual(presentTranscriptMessage(prose, [job()]), { primary: prose.text, lifecycle: false });
  assert.deepEqual(presentTranscriptMessage(user, [job()]), { primary: user.text, lifecycle: false });
});

test("review free-form fields stay readable while exact identifiers remain collapsed", () => {
  const value = job();
  const unknownId = "f14ecabe-7b93-4872-9f70-72553543ab61";
  const commit = "ab1234567890ab1234567890ab1234567890abcd";
  const fingerprint = "cd1234567890cd1234567890cd1234567890cd1234567890cd1234567890cdef";
  const report = `Report for ${jobId} at commit ${commit}.`;
  const summary = `Compared unknown worker ${unknownId} against diff ${exactDiff}.`;
  const requirement = `Preserve fingerprint ${fingerprint}.`;
  const evidence = `Evidence from ${jobId}, ${unknownId}, and commit ${commit}.`;
  value.handoff = {
    report, requirements: [], diffSha256: exactDiff, branch: value.branch, worktree: value.isolation.path,
    tests: [], risks: [], round: 1, createdAt: 2,
  };
  value.review = {
    hookToken: "hook", status: "approved", attempt: 1, targetBranch: "main", updatedAt: 3, transitions: [],
    judge: {
      approved: true, summary, requirements: [{ requirement, satisfied: true, evidence }],
      model: { provider: "test", id: "judge" }, diffSha256: exactDiff, raw: "exact raw verdict",
    },
  };

  const markup = renderToStaticMarkup(<ReviewView job={value} jobs={[value]} />);
  const visible = markup.replace(/<details class="technical-evidence">[\s\S]*?<\/details>/g, "");
  for (const exact of [jobId, unknownId, commit, exactDiff, fingerprint]) assert.doesNotMatch(visible, new RegExp(exact));
  assert.match(visible, /Report for Clean composer focus at commit ab123456/);
  assert.match(visible, /unknown worker f14ecabe against diff 8b64f0c6/);
  assert.match(visible, /Preserve fingerprint cd123456/);
  assert.match(visible, /Evidence from Clean composer focus, f14ecabe, and commit ab123456/);
  for (const exact of [report, summary, requirement, evidence]) assert.ok(markup.includes(exact), `missing exact audit text: ${exact}`);
  assert.doesNotMatch(markup, /<details[^>]* open/);
});

test("CI check summaries hide exact commands and hashes in closed technical details", () => {
  const value = job();
  const target = "ab1234567890ab1234567890ab1234567890abcd";
  const localCommand = `git diff --check ${target} HEAD # fingerprint ${exactDiff}`;
  const postCommand = `git diff --check ${exactDiff} HEAD # target ${target}`;
  value.review = {
    hookToken: "hook", status: "post_merge_ci", attempt: 1, targetBranch: "main", updatedAt: 3, transitions: [],
    ci: [{ command: localCommand, ok: true, exitCode: 0, durationMs: 12, output: `checked ${target}` }],
    postMergeCi: [{ command: postCommand, ok: true, exitCode: 0, durationMs: 15, output: `fingerprint ${exactDiff}` }],
  };

  const markup = renderToStaticMarkup(<ReviewView job={value} />);
  const visible = markup.replace(/<details[^>]*><summary>([\s\S]*?)<\/summary>[\s\S]*?<\/details>/g, "$1");
  assert.equal((visible.match(/Diff validation/g) || []).length, 2);
  assert.doesNotMatch(visible, new RegExp(target));
  assert.doesNotMatch(visible, new RegExp(exactDiff));
  for (const exact of [localCommand, postCommand, `checked ${target}`, `fingerprint ${exactDiff}`]) {
    assert.ok(markup.includes(exact), `missing exact check audit evidence: ${exact}`);
  }
  assert.doesNotMatch(markup, /<details[^>]* open/);
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

  const ordinary = statusMessage({ eventId: "event", jobId, state: "handoff", detail: exactDiff });
  const transcript = renderToStaticMarkup(<TranscriptMessageBody message={ordinary} jobs={[job()]} />);
  assert.match(transcript, /Clean composer focus · Ready for review/);
  assert.match(transcript, /<details class="technical-evidence"><summary>Technical details<\/summary><pre>\[worker_status\]/);
  assert.match(transcript, new RegExp(exactDiff));
  assert.doesNotMatch(transcript, /<details[^>]* open/);
});
