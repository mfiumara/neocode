import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import test from "node:test";
import { createLogger, createServer as createViteServer, type ViteDevServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";

const floodPayload = Buffer.alloc(1024 * 1024);

interface Backend {
  http: HttpServer;
  wss: WebSocketServer;
  port: number;
  floodNextConnection: boolean;
  floodSocket?: WebSocket;
}

async function listenBackend(port = 0): Promise<Backend> {
  const http = createHttpServer();
  const wss = new WebSocketServer({ server: http });
  const backend: Backend = { http, wss, port: 0, floodNextConnection: false };
  wss.on("connection", (socket) => {
    if (backend.floodNextConnection) {
      backend.floodNextConnection = false;
      backend.floodSocket = socket;
      // Start the real failure ordering: the initial snapshot reaches the
      // browser, whose close is coordinated by the harness below.
      socket.send(floodPayload, () => {});
    } else {
      socket.send("snapshot");
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => resolve());
  });
  const address = http.address();
  assert.ok(address && typeof address === "object");
  backend.port = address.port;
  return backend;
}

async function closeBackend(backend: Backend): Promise<void> {
  for (const client of backend.wss.clients) client.terminate();
  await new Promise<void>((resolve) => backend.wss.close(() => resolve()));
  if (backend.http.listening) await new Promise<void>((resolve) => backend.http.close(() => resolve()));
}

async function waitFor(check: () => boolean, description: string, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function openedWithMessage(url: string): Promise<{ socket: WebSocket; message: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("message", (raw) => resolve({ socket, message: raw.toString() }));
    socket.once("error", reject);
  });
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function closeVite(vite: ViteDevServer | undefined): Promise<void> {
  if (vite) await vite.close();
}

/** Send an upgrade by hand and abandon it as soon as proxied bytes arrive. */
function abandonUpgrade(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, "127.0.0.1", () => {
      socket.write([
        "GET /ws HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", "",
      ].join("\r\n"));
    });
    socket.once("error", reject);
    socket.once("data", () => {
      // A reset models a renderer/navigation disappearing during the upgrade and
      // makes the downstream write failure deterministic across platforms.
      socket.resetAndDestroy();
      resolve(socket);
    });
  });
}

test("Vite proxy identifies the abandoned-upgrade EPIPE while clean close, reconnect, and backend restart stay quiet", { timeout: 20_000 }, async () => {
  let backend = await listenBackend();
  let vite: ViteDevServer | undefined;
  const errors: Array<{ message: string; code?: string }> = [];
  const recorded = (code: string, phrase?: string): boolean => errors.some((entry) =>
    entry.code === code && (!phrase || entry.message.includes(phrase)));
  const logger = createLogger("silent");
  logger.error = (message, options) => {
    const error = options?.error as NodeJS.ErrnoException | undefined;
    errors.push({ message, code: error?.code });
  };

  try {
    vite = await createViteServer({
      configFile: false,
      customLogger: logger,
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: { "/ws": { target: `ws://127.0.0.1:${backend.port}`, ws: true } },
      },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address === "object");
    const proxyPort = address.port;
    const url = `ws://127.0.0.1:${proxyPort}/ws`;

    let abandoned: Socket | undefined;
    // Kernel scheduling decides whether one reset reaches the proxy before its
    // queued target reads. Repeat the exact coordinated ordering a few times so
    // the harness deterministically observes the platform's EPIPE path rather
    // than depending on one scheduler timeslice.
    for (let attempt = 0; attempt < 10 && !recorded("EPIPE"); attempt += 1) {
      backend.floodNextConnection = true;
      backend.floodSocket = undefined;
      abandoned = await abandonUpgrade(proxyPort);
      const floodSocket = backend.floodSocket as WebSocket | undefined;
      assert.ok(floodSocket, "backend upgrade completed before downstream abandonment");
      // Queue backend writes only after resetAndDestroy(), before the event loop
      // can propagate that downstream close through the proxy.
      for (let index = 0; index < 16; index += 1) floodSocket.send(floodPayload, () => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(recorded("EPIPE"), "Vite must expose the reproduced downstream write failure");
    assert.equal(abandoned?.destroyed, true);
    assert.ok(recorded("EPIPE", "ws proxy error"));
    assert.ok(recorded("EPIPE", "ws proxy socket error"));

    // The production policy avoids that path: after open, a normal close frame
    // is quiet, and repeating it proves reconnect does not retain stale state.
    errors.length = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const opened = await openedWithMessage(url);
      assert.equal(opened.message, "snapshot");
      const didClose = closed(opened.socket);
      opened.socket.close(1000, "intentional");
      await didClose;
    }
    assert.equal(errors.length, 0);

    // Model a backend watch restart with an active client. Its abrupt transport
    // loss closes the browser, then a replacement on the same kernel-assigned
    // port accepts a clean reconnect without proxy EPIPE noise.
    const beforeRestart = await openedWithMessage(url);
    assert.equal(beforeRestart.message, "snapshot");
    const restartClose = closed(beforeRestart.socket);
    const backendPort = backend.port;
    await closeBackend(backend);
    await restartClose;
    backend = await listenBackend(backendPort);
    const afterRestart = await openedWithMessage(url);
    assert.equal(afterRestart.message, "snapshot");
    const afterRestartClose = closed(afterRestart.socket);
    afterRestart.socket.close(1000, "intentional");
    await afterRestartClose;
    assert.equal(errors.length, 0, "backend restart and reconnect must not emit proxy errors");

    // Do not suppress genuine proxy failures: with the owned backend stopped,
    // Vite's normal logger still receives the target connection refusal.
    await closeBackend(backend);
    const unavailable = new WebSocket(url);
    unavailable.on("error", () => {});
    await closed(unavailable);
    await waitFor(() => recorded("ECONNREFUSED"), "observable target refusal");
    assert.ok(recorded("ECONNREFUSED", "ws proxy error"));
  } finally {
    await closeVite(vite);
    if (backend.http.listening) await closeBackend(backend);
  }
});
