import { expect, test, type Page } from "@playwright/test";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createLogger } from "vite";
import { WebSocketServer } from "ws";
import { startViteOnKernelPort } from "./vite-harness";

const webRoot = resolve(import.meta.dirname, "..");
const snapshot = {
  cwd: "/tmp/websocket-lifecycle",
  coordinator: {
    status: "idle", activityHistory: [], messages: [],
    settings: { variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: [] },
    model: null, models: [],
  },
  jobs: [], maintenance: { state: "idle" },
};

async function waitFor(check: () => boolean, description: string, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function connected(page: Page): Promise<void> {
  await expect(page.getByRole("status")).toHaveText(/local/);
}

test("real browser lifecycle closes Vite-proxied sockets cleanly", async ({ page }) => {
  test.setTimeout(30_000);
  const http = createHttpServer();
  const wss = new WebSocketServer({ noServer: true });
  let handshakeDelayMs = 200;
  let upgrades = 0;
  let connections = 0;
  let closes = 0;
  http.on("upgrade", (request, socket, head) => {
    upgrades += 1;
    setTimeout(() => {
      wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
    }, handshakeDelayMs);
  });
  wss.on("connection", (socket) => {
    connections += 1;
    socket.on("close", () => { closes += 1; });
    socket.send(JSON.stringify({ type: "snapshot", snapshot }));
  });
  await new Promise<void>((resolveListen, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolveListen);
  });
  const backendAddress = http.address();
  expect(backendAddress && typeof backendAddress === "object").toBeTruthy();
  const backendPort = typeof backendAddress === "object" && backendAddress ? backendAddress.port : 0;

  const errors: Array<{ message: string; code?: string }> = [];
  const logger = createLogger("silent");
  logger.error = (message, options) => {
    errors.push({ message, code: (options?.error as NodeJS.ErrnoException | undefined)?.code });
  };
  const harnessModule = "virtual:neocode-websocket-lifecycle";
  const resolvedHarnessModule = `\0${harnessModule}`;
  const web = await startViteOnKernelPort({
    configFile: false,
    root: webRoot,
    customLogger: logger,
    plugins: [
      {
        name: "neocode-websocket-lifecycle-harness",
        transformIndexHtml(html) {
          return html.replace("/src/main.tsx", "/src/websocket-lifecycle-harness.tsx");
        },
        resolveId(id) {
          return id.endsWith("/src/websocket-lifecycle-harness.tsx") ? resolvedHarnessModule : undefined;
        },
        load(id) {
          if (id !== resolvedHarnessModule) return undefined;
          return `
            import { createElement, StrictMode } from "react";
            import { createRoot } from "react-dom/client";
            import { App } from "/src/App.tsx";
            import "/src/styles.css";
            let root;
            window.__mountNeocode = () => {
              root = createRoot(document.getElementById("root"));
              root.render(createElement(StrictMode, null, createElement(App)));
            };
            window.__unmountNeocode = () => { root?.unmount(); root = undefined; };
            window.__mountNeocode();
          `;
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": resolve(webRoot, "src") } },
    server: {
      proxy: { "/ws": { target: `ws://127.0.0.1:${backendPort}`, ws: true } },
    },
  });

  try {
    const url = `http://127.0.0.1:${web.port}`;

    // Wait until the zero-delay connect task has fired and Vite has forwarded
    // the upgrade, then unmount while the browser WebSocket is still CONNECTING.
    await page.goto(url);
    await waitFor(() => upgrades === 1, "delayed backend upgrade");
    await page.evaluate(() => (window as unknown as { __unmountNeocode(): void }).__unmountNeocode());
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    await waitFor(() => connections === 1 && closes === 1, "clean post-timer CONNECTING disposal");
    expect(errors).toEqual([]);

    // Exercise an ordinary remount, browser reload, Vite full reload (the HMR
    // lifecycle fallback), and page close.
    handshakeDelayMs = 0;
    await page.evaluate(() => (window as unknown as { __mountNeocode(): void }).__mountNeocode());
    await connected(page);
    await page.reload();
    await connected(page);
    const loaded = page.waitForEvent("load");
    web.vite.ws.send({ type: "full-reload" });
    await loaded;
    await connected(page);
    await page.close();
    await waitFor(() => wss.clients.size === 0, "browser lifecycle socket closure");
    expect(errors.filter((entry) => entry.code === "EPIPE")).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) await page.close();
    // Break owned proxy targets before asking Vite to drain; otherwise a failed
    // assertion during a delayed upgrade could leave close() waiting on them.
    for (const client of wss.clients) client.terminate();
    http.closeAllConnections();
    if (http.listening) await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
    await web.close();
  }
});
