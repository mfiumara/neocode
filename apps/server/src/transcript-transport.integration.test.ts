import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentJob, AppSnapshot, TranscriptMessage, TranscriptThread } from "@neocode/protocol";
import { Orchestrator } from "./orchestrator.js";
import { RUNTIME_STATE_VERSION, RuntimeStateStore, type DurableRuntimeState } from "./runtime-state.js";
import { transcriptPage } from "./transcript-pagination.js";

const history = (count: number, prefix = "m"): TranscriptMessage[] => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`, role: "assistant", timestamp: index,
  text: index % 100 === 0 ? `lifecycle ${"evidence ".repeat(2_000)}` : `message ${index}`,
}));

function worker(messages: TranscriptMessage[]): AgentJob {
  return {
    id: "worker-10k", title: "Large worker", prompt: "test", status: "completed", branch: "worker-10k",
    worktree: "/tmp/worker-10k", isolation: { requested: "worktree", mode: "worktree", path: "/tmp/worker-10k" },
    baseRef: "main", createdAt: 1, updatedAt: 2, messages,
  };
}

function receive(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once("message", (value) => resolve(value.toString())));
}

test("durable coordinator and worker histories use bounded snapshots and capped lossless WebSocket pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neocode-transcript-transport-"));
  const coordinatorMessages = history(10_000);
  const workerMessages = history(10_000, "w");
  const durableWorker = worker(workerMessages);
  const store = new RuntimeStateStore(directory);
  const state: DurableRuntimeState = {
    version: RUNTIME_STATE_VERSION, workspaceRoot: directory, updatedAt: 1,
    coordinator: { messages: coordinatorMessages, activityHistory: [] },
    coordinatorNotifications: { events: [], lastSignals: {} }, jobs: [{ job: durableWorker }],
  };
  try {
    store.save(state);
    await store.flush();
    const restored = await store.load();
    assert.equal(restored?.coordinator.messages.length, 10_000);
    assert.equal(restored?.jobs[0]?.job.messages.length, 10_000);

    const orchestrator = Object.create(Orchestrator.prototype) as Orchestrator & Record<string, unknown>;
    Object.assign(orchestrator, {
      cwd: directory, coordinatorMessages: restored!.coordinator.messages,
      jobs: new Map([[durableWorker.id, restored!.jobs[0]!.job]]),
      coordinatorStatus: "idle", coordinatorActivityHistory: [], maintenance: { state: "idle" },
      settings: () => ({ variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: [] }),
      currentModel: () => null, modelChoices: () => [], listJobs: () => [restored!.jobs[0]!.job],
    });

    let emittedUpdate: unknown;
    Object.assign(orchestrator, { persist: () => undefined, emit: (message: unknown) => { emittedUpdate = message; }, scheduleBacklogSweep: () => undefined });
    const nativeClone = globalThis.structuredClone;
    let clonedWholeWorkerTranscript = false;
    globalThis.structuredClone = ((value: unknown) => {
      if (value && typeof value === "object" && "messages" in value
        && Array.isArray((value as { messages?: unknown }).messages)
        && (value as { messages: unknown[] }).messages.length === 10_000) clonedWholeWorkerTranscript = true;
      return nativeClone(value);
    }) as typeof structuredClone;
    let snapshot: AppSnapshot;
    try {
      snapshot = orchestrator.snapshot();
      (orchestrator as unknown as { publishJob(job: AgentJob): void }).publishJob(restored!.jobs[0]!.job);
    } finally { globalThis.structuredClone = nativeClone; }

    assert.equal(clonedWholeWorkerTranscript, false, "worker snapshot/update must exclude durable messages before metadata cloning");
    const update = emittedUpdate as { type: string; job: AgentJob };
    assert.equal(update.type, "job_updated");
    assert.equal(update.job.messages.length, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(update)) < 1_500_000, "worker update transport budget exceeded");
    assert.equal(snapshot.coordinator.messages.length, 100);
    assert.equal(snapshot.jobs[0]?.messages.length, 100);
    assert.equal(restored!.jobs[0]!.job.messages.length, 10_000, "transport never mutates durable worker history");
    const fullBytes = Buffer.byteLength(JSON.stringify({
      ...snapshot,
      coordinator: { ...snapshot.coordinator, messages: coordinatorMessages },
      jobs: [{ ...snapshot.jobs[0], messages: workerMessages }],
    }));
    const initialPayload = JSON.stringify({ type: "snapshot", snapshot });
    const initialBytes = Buffer.byteLength(initialPayload);
    assert.ok(initialBytes <= 2_500_000, `initial budget exceeded: ${initialBytes} bytes`);
    assert.ok(initialBytes < fullBytes / 20, `before=${fullBytes}, after=${initialBytes}`);

    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address === "object");
    const serverSocket = new Promise<import("ws").WebSocket>((resolve) => wss.once("connection", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    const peer = await serverSocket;

    peer.send(initialPayload);
    const received = JSON.parse(await receive(client)) as { snapshot: AppSnapshot };
    const reconstruct = async (
      thread: TranscriptThread,
      source: TranscriptMessage[],
      initial: TranscriptMessage[],
      initialCursor: string | undefined,
      initialHasOlder: boolean | undefined,
    ) => {
      let loaded = initial;
      let cursor = initialCursor;
      let hasOlder = initialHasOlder;
      let pages = 0;
      while (hasOlder) {
        const result = transcriptPage(source, cursor, 250);
        assert.ok(result.messages.length <= 250);
        peer.send(JSON.stringify({ type: "transcript_page", thread, ...result }));
        const wire = JSON.parse(await receive(client)) as { messages: TranscriptMessage[]; page: { oldestCursor?: string; hasOlder: boolean } };
        assert.ok(wire.messages.length <= 250, "serialized protocol page exceeded cap");
        const known = new Set(loaded.map(({ id }) => id));
        loaded = [...wire.messages.filter(({ id }) => !known.has(id)), ...loaded];
        cursor = wire.page.oldestCursor;
        hasOlder = wire.page.hasOlder;
        pages += 1;
      }
      assert.ok(pages >= 39, `expected repeated production pages, got ${pages}`);
      assert.deepEqual(loaded.map(({ id }) => id), source.map(({ id }) => id));
      assert.equal(new Set(loaded.map(({ id }) => id)).size, source.length);
    };
    await reconstruct(
      { kind: "coordinator" }, coordinatorMessages, received.snapshot.coordinator.messages,
      received.snapshot.coordinator.transcriptPage?.oldestCursor, received.snapshot.coordinator.transcriptPage?.hasOlder,
    );
    await reconstruct(
      { kind: "job", jobId: durableWorker.id }, workerMessages, received.snapshot.jobs[0]!.messages,
      received.snapshot.jobs[0]!.transcriptPage?.oldestCursor, received.snapshot.jobs[0]!.transcriptPage?.hasOlder,
    );
    client.close(); peer.close(); wss.close(); http.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
