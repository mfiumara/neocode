import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentJob } from "@neocode/protocol";
import {
  RUNTIME_STATE_VERSION,
  RuntimeStateStore,
  runtimeStatePath,
  type DurableRuntimeState,
} from "./runtime-state.js";

function fixture(root: string, title = "durable"): DurableRuntimeState {
  const job: AgentJob = {
    id: "job-1",
    title,
    prompt: "do work",
    status: "interrupted",
    branch: "neocode/durable-job-1",
    worktree: join(root, ".worktrees", "durable-job-1"),
    isolation: { requested: "auto", mode: "worktree", path: join(root, ".worktrees", "durable-job-1") },
    baseRef: "abc123",
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: "m1", role: "user", text: "do work", timestamp: 1 }],
    summary: "summary",
    diff: "+change",
    recoverable: true,
    worktreeIdentity: {
      path: join(root, ".worktrees", "durable-job-1"), branch: "neocode/durable-job-1", baseRef: "abc123", createdAt: 1,
    },
    completion: { head: "def456", finishedAt: 2 },
    integration: { status: "merged", targetRef: "main", verifiedAt: 3, targetHead: "fed789", completionHead: "def456" },
    cleanup: {
      status: "removed", checkedAt: 3, removedAt: 4,
      evidence: {
        checkedAt: 3, targetRef: "main", targetHead: "fed789", completionHead: "def456",
        intendedCommits: ["def456"], mergeMethod: "commit-ancestry", cleanPorcelain: true,
        registeredPath: join(root, ".worktrees", "durable-job-1"), registeredBranch: "neocode/durable-job-1",
      },
    },
  };
  return {
    version: RUNTIME_STATE_VERSION,
    workspaceRoot: root,
    updatedAt: 3,
    maintenance: { state: "idle", lastRunAt: 4, source: "scheduled", checked: 1, removed: 1, refused: 0 },
    coordinator: {
      messages: [{ id: "c1", role: "assistant", text: "hello", timestamp: 1 }],
      piSessionFile: join(root, ".neocode", "runtime", "server-v1", "pi-sessions", "coordinator", "session.jsonl"),
    },
    jobs: [{ job, piSessionFile: join(root, "worker.jsonl") }],
  };
}

test("runtime state atomically round-trips all job and session metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-"));
  try {
    const store = new RuntimeStateStore(root);
    store.save(fixture(root));
    await store.flush();
    const restored = await store.load();
    assert.equal(restored?.jobs[0]?.job.summary, "summary");
    assert.equal(restored?.jobs[0]?.job.diff, "+change");
    assert.equal(restored?.jobs[0]?.job.cleanup?.status, "removed");
    assert.equal(restored?.jobs[0]?.job.integration?.status, "merged");
    assert.equal(restored?.maintenance?.removed, 1);
    assert.match(restored?.coordinator.piSessionFile || "", /pi-sessions/);
    assert.match(runtimeStatePath(root), /\.neocode\/runtime\/server-v1\/state\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable coordinator queue survives refresh with context and transcript lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-prompts-"));
  try {
    const state = fixture(root);
    state.coordinator.messages.push({ id: "queued-1", role: "user", text: "later", timestamp: 5, promptState: "queued" });
    state.coordinator.pendingPrompts = [{ messageId: "queued-1", context: ["selected context"], mode: "build", createdAt: 5, state: "queued" }];
    const store = new RuntimeStateStore(root);
    store.save(state);
    await store.flush();
    const restored = await store.load();
    assert.equal(restored?.coordinator.messages.at(-1)?.promptState, "queued");
    assert.deepEqual(restored?.coordinator.pendingPrompts?.[0]?.context, ["selected context"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable transcripts preserve image data used by restored clickable threads", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-images-"));
  try {
    const state = fixture(root);
    state.coordinator.messages[0]!.attachments = [{
      id: "image-1",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
      size: 8,
      name: "restored.png",
    }];
    const store = new RuntimeStateStore(root);
    store.save(state);
    await store.flush();
    assert.deepEqual((await store.load())?.coordinator.messages[0]?.attachments, state.coordinator.messages[0]?.attachments);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all flush waiters covered by one failed write reject and a distinct save can recover", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-generation-"));
  try {
    const store = new RuntimeStateStore(root);
    const harness = store as unknown as { writeAtomic(state: DurableRuntimeState): Promise<void> };
    const writeAtomic = harness.writeAtomic.bind(harness);
    const injected = new Error("injected atomic write failure");
    let fail = true;
    harness.writeAtomic = async (state) => {
      if (fail) { fail = false; throw injected; }
      await writeAtomic(state);
    };

    store.save(fixture(root, "first concurrent acceptance"));
    const first = store.flush();
    store.save(fixture(root, "second concurrent acceptance"));
    const second = store.flush();
    const outcomes = await Promise.allSettled([first, second]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected"]);
    for (const outcome of outcomes) if (outcome.status === "rejected") assert.equal(outcome.reason, injected);
    assert.equal(await store.load(), undefined, "the failed coalesced generation was never durable");

    store.save(fixture(root, "successful distinct retry"));
    await store.flush();
    assert.equal((await store.load())?.jobs[0]?.job.title, "successful distinct retry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming saves coalesce to the latest complete snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-"));
  try {
    const store = new RuntimeStateStore(root);
    for (let index = 0; index < 30; index += 1) store.save(fixture(root, `update-${index}`));
    await store.flush();
    assert.equal((await store.load())?.jobs[0]?.job.title, "update-29");
    const raw = await readFile(runtimeStatePath(root), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid or cross-workspace state is ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "neocode-state-"));
  try {
    const path = runtimeStatePath(root);
    await mkdir(join(root, ".neocode", "runtime", "server-v1"), { recursive: true });
    await writeFile(path, "{truncated", "utf8");
    assert.equal(await new RuntimeStateStore(root).load(), undefined);
    await writeFile(path, JSON.stringify(fixture(`${root}-other`)), "utf8");
    assert.equal(await new RuntimeStateStore(root).load(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
