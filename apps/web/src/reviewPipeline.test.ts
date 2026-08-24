import assert from "node:assert/strict";
import test from "node:test";
import type { AgentJob, JudgeEvidence, ReviewStatus } from "@neocode/protocol";
import { latestJudgeEvidence, reviewPipeline } from "./reviewPipeline";

function job(status?: ReviewStatus, top: AgentJob["status"] = "completed"): AgentJob {
  return {
    id: "worker", title: "Worker", prompt: "", status: top, branch: "worker", worktree: "/tmp/worker",
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/worker" }, baseRef: "base",
    createdAt: 1_000, updatedAt: 2_000, messages: [], integration: { status: "reviewing" },
    handoff: { report: "done", requirements: [], diffSha256: "hash", branch: "worker", worktree: "/tmp/worker", tests: [], risks: [], round: 1, createdAt: 2_000 },
    review: status ? { hookToken: "hook", status, attempt: 1, targetBranch: "main", updatedAt: 3_000, transitions: [{ status, at: 3_000 }] } : undefined,
  };
}
const verdict = (summary: string, approved = false): JudgeEvidence => ({ approved, summary, requirements: [], model: { provider: "pi", id: "judge" }, diffSha256: "hash", raw: JSON.stringify({ approved, summary }) });
const stage = (value: AgentJob, id: ReturnType<typeof reviewPipeline>["stages"][number]["id"]) => reviewPipeline(value).stages.find((item) => item.id === id)!;

test("ready for review is explicitly distinct from active coordinator review", () => {
  const ready = reviewPipeline(job("handoff_received"));
  assert.equal(ready.headline, "Ready for review");
  assert.match(ready.guidance, /no review is currently running/i);
  assert.equal(ready.active, false);
  for (const [status, expected] of [["ci_running", "Product CI"], ["judging", "Independent judge"]] as const) {
    const pipeline = reviewPipeline(job(status));
    assert.equal(pipeline.headline, "Reviewing now");
    assert.equal(pipeline.stages.find((item) => item.tone === "active")?.label, expected);
  }
});

test("conflicted integration does not erase specific production failure guidance", () => {
  const cases: Array<[ReviewStatus, RegExp, "ci" | "judge" | "verification" | "merge"]> = [
    ["ci_failed", /CI failed; repair is required/i, "ci"],
    ["rejected", /Judge rejected/, "judge"],
    ["post_ci_failed", /Post-merge CI failed/, "verification"],
    ["blocked", /recorded reason|coordinator action/i, "merge"],
    ["failed", /recorded reason|coordinator action/i, "merge"],
  ];
  for (const [status, guidance, failedStage] of cases) {
    const value = job(status); value.integration = { status: "conflicted" }; value.review!.error = `${status} exact diagnostic`;
    if (status === "ci_failed") value.review!.ci = [{ command: "npm test", ok: false, exitCode: 1, durationMs: 40, output: "fail" }];
    if (status === "rejected") value.review!.judge = verdict("Missing behavior");
    if (status === "post_ci_failed") value.review!.postMergeCi = [{ command: "npm test", ok: false, exitCode: 1, durationMs: 50, output: "fail" }];
    if (status === "blocked" || status === "failed") value.review!.coordinatorAuthorizedAt = 2_500;
    const pipeline = reviewPipeline(value);
    assert.match(pipeline.guidance, guidance, status);
    assert.doesNotMatch(pipeline.guidance, /rebase conflict/i, status);
    assert.ok(["failed", "blocked"].includes(pipeline.stages.find((item) => item.id === failedStage)!.tone), status);
  }
});

test("action-required evidence marks its specific repair and failed stage without inventing conflict", () => {
  const value = job("blocked"); value.integration = { status: "conflicted" };
  value.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "ci-action", actions: [{ id: "ci-action", failureClass: "candidate_ci", fingerprint: "f", state: "pending", attempt: 1, maxAttempts: 2, createdAt: 3_000, updatedAt: 3_500, evidence: { detail: "candidate check failed" } }] };
  const pipeline = reviewPipeline(value);
  assert.match(pipeline.guidance, /candidate ci requires coordinator action/i);
  assert.equal(pipeline.stages.find((item) => item.id === "ci")?.tone, "blocked");
  assert.equal(pipeline.stages.find((item) => item.id === "repair")?.tone, "blocked");
  assert.doesNotMatch(pipeline.guidance, /rebase conflict/i);
});

test("rebase conflict requires review conflict status and supporting durable evidence", () => {
  const unsupported = job("conflict"); unsupported.integration = { status: "conflicted" };
  assert.doesNotMatch(reviewPipeline(unsupported).guidance, /rebase conflict/i);
  const supported = job("conflict"); supported.integration = { status: "conflicted" }; supported.review!.error = "Worker rebase onto main conflicts";
  assert.match(reviewPipeline(supported).guidance, /rebase conflict/i);
  assert.equal(stage(supported, "preparation").tone, "blocked");
});

test("preparation completes only with durable base evidence and early CI remains truthful", () => {
  const early = job("ci_running");
  assert.equal(stage(early, "preparation").tone, "waiting");
  assert.match(stage(early, "preparation").summary, /not yet durably confirmed/i);
  early.review!.reviewBaseRef = "prepared-base";
  assert.equal(stage(early, "preparation").tone, "complete");
});

test("fresh ci_running authority wins over retained failed checks", () => {
  const value = job("ci_running");
  value.review!.ci = [{ command: "old check", ok: false, exitCode: 1, durationMs: 40, output: "old failure" }];
  assert.equal(stage(value, "ci").tone, "active");
  assert.match(stage(value, "ci").summary, /0\/1/);
});

test("durable stage durations use checks, transitions, and remediation timestamps", () => {
  const value = job("rejected");
  value.review!.transitions = [{ status: "ci_running", at: 3_000 }, { status: "judging", at: 4_000 }, { status: "rejected", at: 5_500 }];
  value.review!.ci = [{ command: "test", ok: true, exitCode: 0, durationMs: 700, output: "" }];
  value.review!.judge = verdict("No");
  value.review!.remediation = { maxAttempts: 2, rounds: {}, actions: [{ id: "a", failureClass: "judge_changes", fingerprint: "f", state: "pending", attempt: 1, maxAttempts: 2, createdAt: 5_500, updatedAt: 6_250, evidence: { detail: "repair" } }] };
  assert.equal(stage(value, "ci").durationMs, 700);
  assert.equal(stage(value, "judge").durationMs, 1_500);
  assert.equal(stage(value, "repair").durationMs, 750);
});

test("latest judge survives remediation and superseded outcomes remain terminal", () => {
  const value = job("blocked");
  const preserved = verdict("Fresh approval required");
  value.review!.remediation = { maxAttempts: 2, rounds: {}, actions: [
    { id: "older", failureClass: "judge_changes", fingerprint: "1", state: "resolved", attempt: 1, maxAttempts: 2, createdAt: 1, updatedAt: 10, evidence: { detail: "old", judge: verdict("Old") } },
    { id: "latest", failureClass: "judge_changes", fingerprint: "2", state: "pending", attempt: 2, maxAttempts: 2, createdAt: 11, updatedAt: 20, evidence: { detail: "new", judge: preserved } },
  ] };
  assert.equal(latestJudgeEvidence(value), preserved);
  assert.match(stage(value, "judge").summary, /Fresh approval required/);

  value.integration = { status: "superseded" };
  const pipeline = reviewPipeline(value);
  assert.equal(pipeline.headline, "Verified outcome");
  assert.equal(pipeline.active, false);
  assert.equal(pipeline.stages.some((item) => item.tone === "active"), false);
  assert.equal(stage(value, "merge").tone, "complete");
  assert.equal(stage(value, "verification").summary, "Superseded terminal outcome");
});

test("major approval, repair, integration, and terminal states have production guidance", () => {
  const cases: Array<[ReviewStatus, string, "waiting" | "active" | "complete"]> = [
    ["approved", "Approved — merge not started", "waiting"],
    ["merge_queued", "Approved — integration queued", "waiting"],
    ["merging", "Integrating now", "active"],
    ["post_merge_ci", "Integrating now", "active"],
    ["merged", "Verified outcome", "complete"],
    ["feedback_sent", "Repair requested", "waiting"],
    ["worker_resumed", "Repairing feedback", "waiting"],
  ];
  for (const [status, headline, tone] of cases) {
    const value = job(status);
    if (status === "merged") value.integration = { status: "merged", verifiedAt: 4_000 };
    const pipeline = reviewPipeline(value);
    assert.equal(pipeline.headline, headline, status);
    if (status === "merging") assert.equal(pipeline.stages.find((item) => item.id === "merge")?.tone, tone);
    if (status === "post_merge_ci" || status === "merged") assert.equal(pipeline.stages.find((item) => item.id === "verification")?.tone, tone);
  }
});

test("interrupted judge infrastructure evidence is surfaced without inventing a verdict", () => {
  const value = job("blocked");
  value.review!.transitions = [{ status: "judging", at: 3_000 }, { status: "blocked", at: 4_000 }];
  value.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "infra", actions: [{ id: "infra", failureClass: "infrastructure", fingerprint: "f", state: "pending", attempt: 1, maxAttempts: 2, createdAt: 4_000, updatedAt: 4_000, evidence: { detail: "Judge process interrupted" } }] };
  assert.match(stage(value, "judge").summary, /Interrupted: Judge process interrupted/);
  assert.equal(stage(value, "judge").tone, "blocked");
  assert.doesNotMatch(stage(value, "judge").summary, /has not started/);
});

test("pending conflict requests action while repairing conflict reports active repair", () => {
  const conflict = (state: "pending" | "repairing", top: AgentJob["status"] = "completed") => {
    const value = job("conflict", top); value.integration = { status: "conflicted" }; value.review!.error = "Worker rebase onto main conflicts";
    value.review!.remediation = { maxAttempts: 2, rounds: {}, currentActionId: "conflict", actions: [{ id: "conflict", failureClass: "conflict", fingerprint: "f", state, attempt: 1, maxAttempts: 2, createdAt: 3_000, updatedAt: 4_000, evidence: { detail: "rebase conflict" } }] };
    return value;
  };
  assert.match(reviewPipeline(conflict("pending")).guidance, /awaiting coordinator action/i);
  assert.doesNotMatch(reviewPipeline(conflict("pending")).guidance, /worker is resolving/i);
  assert.match(reviewPipeline(conflict("repairing")).guidance, /worker is resolving/i);
  assert.match(reviewPipeline(conflict("repairing", "running")).guidance, /same worktree/i);
});

test("target advancement and a fresh handoff invalidate an older prepared base", () => {
  const advanced = job("handoff_received"); advanced.review!.reviewBaseRef = "old-main"; advanced.review!.judgeHandoffRound = 1;
  advanced.handoff!.round = 2; advanced.review!.transitions = [{ status: "handoff_received", at: 4_000, detail: "Main advanced to new-main; prior approval invalidated" }];
  assert.equal(stage(advanced, "preparation").tone, "waiting");
  assert.match(stage(advanced, "preparation").summary, /fresh approval required/i);
  assert.match(reviewPipeline(advanced).guidance, /rebase and preparation plus fresh approval/i);
});

test("fresh active rounds label retained checks and verdicts as historical", () => {
  const ci = job("ci_running"); ci.review!.ci = [{ command: "old", ok: false, exitCode: 1, durationMs: 20, output: "old" }];
  assert.match(stage(ci, "ci").summary, /^Historical prior-round evidence/);
  assert.equal(stage(ci, "ci").durationMs, undefined);
  const judging = job("judging"); judging.review!.judge = verdict("Old rejection");
  assert.match(stage(judging, "judge").summary, /^Historical prior-round verdict/);
  assert.equal(stage(judging, "judge").tone, "active");
});

test("top-level authority and reconnect suppress stale active phases while recovered work wins", () => {
  const interrupted = job("judging", "interrupted");
  assert.equal(reviewPipeline(interrupted).active, false);
  assert.equal(reviewPipeline(interrupted).stages.some((item) => item.tone === "active"), false);
  const recovered = job("blocked", "running");
  assert.equal(reviewPipeline(recovered).headline, "Repairing now");
  assert.equal(reviewPipeline(recovered, false).headline, "Action required");
  assert.equal(reviewPipeline(job("judging"), false).stages.some((item) => item.tone === "active"), false);
});
