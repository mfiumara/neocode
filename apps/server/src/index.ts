import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@neocode/protocol";
import { Orchestrator } from "./orchestrator.js";
import { MAX_WEBSOCKET_PAYLOAD_BYTES, validateImageAttachments } from "./image-attachments.js";

const execFileAsync = promisify(execFile);
const port = Number(process.env.NEOCODE_PORT || 4318);
const requestedCwd = process.env.NEOCODE_CWD || process.env.INIT_CWD || process.cwd();
// Both the coordinator and root-mode workers are anchored to the repository
// root, even when Neocode is launched from a nested directory.
const cwd = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: requestedCwd })
  .then(({ stdout }) => stdout.trim())
  .catch(() => requestedCwd);
const clients = new Set<WebSocket>();
const verbose = /^(1|true|yes)$/i.test(process.env.NEOCODE_VERBOSE || "");
const jobLogState = new Map<string, string>();

function verboseLog(event: string, details?: Record<string, unknown>): void {
  if (!verbose) return;
  console.log(`[neocode ${new Date().toISOString()}] ${event}${details ? ` ${JSON.stringify(details)}` : ""}`);
}

function send(client: WebSocket, message: ServerMessage): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  if (message.type === "coordinator_status") verboseLog("coordinator.status", { status: message.status });
  else if (message.type === "coordinator_activity") verboseLog("coordinator.activity", {
    phase: message.activity?.phase,
    description: message.activity?.description,
    tool: message.activity?.toolName,
  });
  else if (message.type === "coordinator_message" || message.type === "coordinator_message_updated") {
    verboseLog("coordinator.message", { role: message.message.role, characters: message.message.text.length });
  } else if (message.type === "job_updated") {
    const signature = JSON.stringify({
      status: message.job.status,
      phase: message.job.activity?.phase,
      tool: message.job.activity?.toolName,
      review: message.job.review?.status,
      integration: message.job.integration?.status,
    });
    if (jobLogState.get(message.job.id) !== signature) {
      jobLogState.set(message.job.id, signature);
      verboseLog("worker.update", { jobId: message.job.id, title: message.job.title, ...JSON.parse(signature) });
    }
  } else if (message.type === "maintenance_updated") verboseLog("maintenance.update", { ...message.maintenance });
  else if (message.type === "error") verboseLog("server.error", { message: message.message });
  for (const client of clients) send(client, message);
}

function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const orchestrator = new Orchestrator(cwd, broadcast, {
  graceMs: envMs("NEOCODE_JANITOR_GRACE_MS", 7 * 24 * 60 * 60 * 1000),
  intervalMs: envMs("NEOCODE_JANITOR_INTERVAL_MS", 6 * 60 * 60 * 1000),
  sweepIntervalMs: envMs("NEOCODE_SWEEP_INTERVAL_MS", 30_000),
  targetRef: process.env.NEOCODE_JANITOR_TARGET_REF || "main",
  startup: process.env.NEOCODE_JANITOR_STARTUP !== "false",
});
await orchestrator.initialize();

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, cwd }));
    return;
  }
  response.writeHead(404);
  response.end();
});

// Four 8 MiB images expand to roughly 43 MiB as base64. Bound the complete
// WebSocket frame as a second line of defense against memory exhaustion.
const websocket = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });
websocket.on("connection", (client) => {
  clients.add(client);
  verboseLog("client.connected", { clients: clients.size });
  send(client, { type: "snapshot", snapshot: orchestrator.snapshot() });

  client.on("message", (raw) => {
    void (async () => {
      try {
        const message = JSON.parse(raw.toString()) as ClientMessage;
        verboseLog("client.command", {
          type: message.type,
          jobId: "jobId" in message ? message.jobId : undefined,
          characters: "text" in message ? message.text.length : undefined,
          attachments: "attachments" in message ? message.attachments?.length : undefined,
        });
        if (message.type === "prompt") {
          if (typeof message.text !== "string" || (message.context !== undefined && !Array.isArray(message.context))) throw new Error("Invalid prompt.");
          await orchestrator.prompt(message.text, message.context, validateImageAttachments(message.attachments));
        } else if (message.type === "abort") await orchestrator.abort();
        else if (message.type === "delegate") {
          if (typeof message.text !== "string") throw new Error("Invalid task.");
          await orchestrator.delegate(message.text, undefined, message.isolation ?? "auto", validateImageAttachments(message.attachments));
        } else if (message.type === "cancel_job") await orchestrator.cancelJob(message.jobId);
        else if (message.type === "resume_job") await orchestrator.resumeJob(message.jobId);
        else if (message.type === "cycle_variant") orchestrator.cycleVariant();
        else if (message.type === "cycle_thinking") orchestrator.cycleThinking();
        else if (message.type === "set_model") await orchestrator.setModel(message.model);
        else if (message.type === "refresh") send(client, { type: "snapshot", snapshot: orchestrator.snapshot() });
        else if (message.type === "clean_now") await orchestrator.cleanNow(true);
      } catch (error) {
        send(client, { type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  client.on("close", () => {
    clients.delete(client);
    verboseLog("client.disconnected", { clients: clients.size });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`neocode server listening on http://127.0.0.1:${port}`);
  console.log(`workspace: ${cwd}`);
  if (verbose) console.log("verbose logging: enabled");
});

async function shutdown(): Promise<void> {
  for (const client of clients) client.close();
  await orchestrator.dispose();
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
