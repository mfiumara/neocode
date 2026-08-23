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
  };
  return {
    version: RUNTIME_STATE_VERSION,
    workspaceRoot: root,
    updatedAt: 3,
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
    assert.match(restored?.coordinator.piSessionFile || "", /pi-sessions/);
    assert.match(runtimeStatePath(root), /\.neocode\/runtime\/server-v1\/state\.json$/);
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
