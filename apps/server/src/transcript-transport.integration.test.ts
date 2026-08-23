import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { AppSnapshot, TranscriptMessage } from "@neocode/protocol";
import { Orchestrator } from "./orchestrator.js";
import { RUNTIME_STATE_VERSION, RuntimeStateStore, type DurableRuntimeState } from "./runtime-state.js";
import { transcriptPage } from "./transcript-pagination.js";

const history = (count: number): TranscriptMessage[] => Array.from({ length: count }, (_, index) => ({
  id: `m-${index}`, role: "assistant", timestamp: index,
  text: index % 100 === 0 ? `lifecycle ${"evidence ".repeat(2_000)}` : `message ${index}`,
}));

function receive(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once("message", (value) => resolve(value.toString())));
}

test("durable 10,000-message state yields a bounded orchestrator snapshot and lossless WebSocket pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neocode-transcript-transport-"));
  const durableMessages = history(10_000);
  const store = new RuntimeStateStore(directory);
  const state: DurableRuntimeState = {
    version: RUNTIME_STATE_VERSION, workspaceRoot: directory, updatedAt: 1,
    coordinator: { messages: durableMessages, activityHistory: [] },
    coordinatorNotifications: { events: [], lastSignals: {} }, jobs: [],
  };
  try {
    store.save(state);
    await store.flush();
    const restored = await store.load();
    assert.equal(restored?.coordinator.messages.length, 10_000);

    // Exercise the production snapshot method without starting model sessions.
    const orchestrator = Object.create(Orchestrator.prototype) as Orchestrator & Record<string, unknown>;
    Object.assign(orchestrator, {
      cwd: directory, coordinatorMessages: restored!.coordinator.messages,
      coordinatorStatus: "idle", coordinatorActivityHistory: [], maintenance: { state: "idle" },
      settings: () => ({ variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: [] }),
      currentModel: () => null, modelChoices: () => [], listJobs: () => [],
    });
    const snapshot = orchestrator.snapshot();
    assert.equal(snapshot.coordinator.messages.length, 100);
    const fullBytes = Buffer.byteLength(JSON.stringify({ ...snapshot, coordinator: { ...snapshot.coordinator, messages: durableMessages } }));
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
    const receivedSnapshot = JSON.parse(await receive(client)) as { snapshot: AppSnapshot };
    let loaded = receivedSnapshot.snapshot.coordinator.messages;
    let cursor = receivedSnapshot.snapshot.coordinator.transcriptPage?.oldestCursor;
    let hasOlder = receivedSnapshot.snapshot.coordinator.transcriptPage?.hasOlder;
    while (hasOlder) {
      const result = transcriptPage(restored!.coordinator.messages, cursor);
      peer.send(JSON.stringify({ type: "transcript_page", thread: { kind: "coordinator" }, ...result }));
      const wire = JSON.parse(await receive(client)) as { messages: TranscriptMessage[]; page: { oldestCursor?: string; hasOlder: boolean } };
      loaded = [...wire.messages, ...loaded];
      cursor = wire.page.oldestCursor;
      hasOlder = wire.page.hasOlder;
    }
    assert.deepEqual(loaded.map(({ id }) => id), durableMessages.map(({ id }) => id));
    assert.equal(new Set(loaded.map(({ id }) => id)).size, 10_000);
    client.close(); peer.close(); wss.close(); http.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
