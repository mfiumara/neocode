import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@neocode/protocol";
import { Orchestrator } from "./orchestrator.js";

const execFileAsync = promisify(execFile);
const port = Number(process.env.NEOCODE_PORT || 4318);
const requestedCwd = process.env.NEOCODE_CWD || process.env.INIT_CWD || process.cwd();
// Both the coordinator and root-mode workers are anchored to the repository
// root, even when Neocode is launched from a nested directory.
const cwd = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: requestedCwd })
  .then(({ stdout }) => stdout.trim())
  .catch(() => requestedCwd);
const clients = new Set<WebSocket>();

function send(client: WebSocket, message: ServerMessage): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  for (const client of clients) send(client, message);
}

const orchestrator = new Orchestrator(cwd, broadcast);
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

const websocket = new WebSocketServer({ server, path: "/ws" });
websocket.on("connection", (client) => {
  clients.add(client);
  send(client, { type: "snapshot", snapshot: orchestrator.snapshot() });

  client.on("message", (raw) => {
    void (async () => {
      try {
        const message = JSON.parse(raw.toString()) as ClientMessage;
        if (message.type === "prompt") await orchestrator.prompt(message.text, message.context);
        else if (message.type === "abort") await orchestrator.abort();
        else if (message.type === "delegate") await orchestrator.delegate(message.text, undefined, message.isolation ?? "auto");
        else if (message.type === "cancel_job") await orchestrator.cancelJob(message.jobId);
        else if (message.type === "refresh") send(client, { type: "snapshot", snapshot: orchestrator.snapshot() });
      } catch (error) {
        send(client, { type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  client.on("close", () => clients.delete(client));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`neocode server listening on http://127.0.0.1:${port}`);
  console.log(`workspace: ${cwd}`);
});

async function shutdown(): Promise<void> {
  for (const client of clients) client.close();
  await orchestrator.dispose();
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
