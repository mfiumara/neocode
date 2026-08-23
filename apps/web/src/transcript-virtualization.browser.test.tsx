import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentJob, AppSnapshot, ServerMessage, TranscriptMessage } from "@neocode/protocol";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .find((candidate): candidate is string => !!candidate && existsSync(candidate));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(check: () => Promise<boolean>, timeout = 15_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for browser condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function coordinatorSnapshot(messages: TranscriptMessage[], job: AgentJob): AppSnapshot {
  return {
    cwd: "/tmp/virtual", coordinator: {
      status: "idle", activityHistory: [], messages,
      transcriptPage: { oldestCursor: messages[0]?.id, hasOlder: true },
      settings: { variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: [] },
      model: null, models: [], context: { autoCompactionEnabled: true, manualCompactionAvailable: true },
    }, jobs: [job], maintenance: { state: "idle" },
  };
}

test("real browser virtualizes, measures, paginates, navigates, and preserves reading position", { skip: !chrome, timeout: 45_000 }, async () => {
  const webPort = await freePort();
  const debugPort = await freePort();
  const backendPort = await freePort();
  const http = await import("node:http").then(({ createServer }) => createServer());
  const wss = new WebSocketServer({ server: http });
  try {
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(backendPort, "127.0.0.1", resolve); });
  } catch {
    wss.close();
    http.close();
    return;
  }
  const all = Array.from({ length: 10_000 }, (_, index): TranscriptMessage => ({
    id: `m-${index}`, role: "assistant", timestamp: index,
    text: index % 17 === 0 ? `# Markdown ${index}\n\n${"dynamic wrapped content ".repeat(20)}` : `row ${index}`,
  }));
  const job: AgentJob = {
    id: "job-browser", title: "Browser worker", prompt: "test", status: "running", branch: "test", worktree: "/tmp/worker",
    isolation: { requested: "worktree", mode: "worktree", path: "/tmp/worker" }, baseRef: "main", createdAt: 4_500, updatedAt: 4_500,
    messages: [{ id: "worker-1", role: "assistant", text: "worker transcript", timestamp: 1 }],
    transcriptPage: { hasOlder: false },
  };
  let peer: WebSocket | undefined;
  let loadRequests = 0;
  let pageResponses = 0;
  let serverHistory = all;
  let serverHasOlder = true;
  const pageSizes: number[] = [];
  wss.on("connection", (socket) => {
    peer = socket;
    socket.send(JSON.stringify({ type: "snapshot", snapshot: coordinatorSnapshot(all.slice(-100), job) } satisfies ServerMessage));
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { type: string; before?: string };
      if (request.type !== "load_older_messages") return;
      loadRequests += 1;
      const end = serverHistory.findIndex((message) => message.id === request.before);
      const start = Math.max(0, end - 250);
      const messages = end < 0 ? [] : serverHistory.slice(start, end);
      const page = { oldestCursor: messages[0]?.id || request.before, hasOlder: start > 0 };
      pageSizes.push(messages.length);
      serverHasOlder = page.hasOlder;
      setTimeout(() => {
        socket.send(JSON.stringify({ type: "transcript_page", thread: { kind: "coordinator" }, messages, page } satisfies ServerMessage));
        pageResponses += 1;
      }, 30);
    });
  });

  let vite: ChildProcess | undefined;
  let browser: ChildProcess | undefined;
  let cdp: WebSocket | undefined;
  try {
    vite = spawn(process.execPath, [resolve(webRoot, "../../node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(webPort)], {
      cwd: webRoot, stdio: "ignore", env: { ...process.env, NEOCODE_BACKEND_URL: `ws://127.0.0.1:${backendPort}` },
    });
    await waitFor(async () => fetch(`http://127.0.0.1:${webPort}`).then((response) => response.ok, () => false));
    browser = spawn(chrome!, ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${debugPort}`, "about:blank"], { stdio: "ignore" });
    let pageTarget: { webSocketDebuggerUrl: string } | undefined;
    await waitFor(async () => {
      pageTarget = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json()).then((items) => items.find((item: { type: string }) => item.type === "page"), () => undefined);
      return !!pageTarget;
    });
    cdp = new WebSocket(pageTarget!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { cdp!.once("open", resolve); cdp!.once("error", reject); });
    let commandId = 0;
    const pending = new Map<number, (value: unknown) => void>();
    cdp.on("message", (raw) => {
      const response = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: unknown };
      if (response.id) { pending.get(response.id)?.(response.error ? { error: response.error } : response.result); pending.delete(response.id); }
    });
    const command = <T,>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve) => {
      const id = ++commandId; pending.set(id, resolve as (value: unknown) => void); cdp!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async <T,>(expression: string): Promise<T> => {
      const result = await command<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await command("Page.navigate", { url: `http://127.0.0.1:${webPort}` });
    await waitFor(async () => evaluate<boolean>("document.querySelectorAll('[data-virtual-row]').length > 0"));

    // Let the initial ResizeObserver pass settle before recording the anchor.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Top-scroll drives real protocol requests; every response is production-capped.
    await evaluate("(() => { const v=document.querySelector('.transcript-viewport'); v.scrollTop=0; v.dispatchEvent(new Event('scroll',{bubbles:true})); return true })()");
    await waitFor(async () => loadRequests === 1);
    const initialAnchor = await evaluate<{ key: string; offset: number }>("(() => { const v=document.querySelector('.transcript-viewport'); const r=[...v.querySelectorAll('[data-row-key]')].map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.bottom>v.getBoundingClientRect().top&&x.r.top<v.getBoundingClientRect().bottom).sort((a,b)=>a.r.top-b.r.top)[0]; return {key:r.e.dataset.rowKey,offset:r.r.top-v.getBoundingClientRect().top} })()");
    await waitFor(async () => pageResponses >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const restoredAnchorOffset = await evaluate<number>(`document.querySelector('[data-row-key="${initialAnchor.key}"]')?.getBoundingClientRect().top-document.querySelector('.transcript-viewport').getBoundingClientRect().top`);
    assert.ok(Math.abs(restoredAnchorOffset - initialAnchor.offset) < 3,
      `prepend moved stable interleaved anchor ${initialAnchor.key}: ${initialAnchor.offset} -> ${restoredAnchorOffset}`);
    for (let guard = 0; serverHasOlder && guard < 50; guard += 1) {
      const previous = pageResponses;
      await new Promise((resolve) => setTimeout(resolve, 60));
      await evaluate("(() => { const v=document.querySelector('.transcript-viewport'); v.scrollTop=1; v.dispatchEvent(new Event('scroll',{bubbles:true})); v.scrollTop=0; v.dispatchEvent(new Event('scroll',{bubbles:true})); return true })()");
      await waitFor(async () => pageResponses > previous || !serverHasOlder);
    }
    assert.equal(serverHasOlder, false);
    assert.ok(pageSizes.length > 30 && pageSizes.every((size) => size <= 250));
    await waitFor(async () => evaluate<boolean>("document.querySelector('.transcript-window').style.height.replace('px','') > 100000"));
    await new Promise((resolve) => setTimeout(resolve, 200)); // allow ResizeObserver measurements
    const mounted = await evaluate<number>("document.querySelectorAll('[data-virtual-row]').length");
    assert.ok(mounted > 0 && mounted < 80, `actual virtualizer mounted ${mounted}/10,001 rows`);

    // Keyboard j/k selection follows mounted row identity.
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.querySelector('.message')?.click(); true");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const selectedBefore = await evaluate<number>("+document.querySelector('.message.selected')?.dataset.rowIndex");
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); true");
    await waitFor(async () => evaluate<boolean>(`+document.querySelector('.message.selected')?.dataset.rowIndex === ${selectedBefore + 1}`));
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true})); true");
    await waitFor(async () => evaluate<boolean>(`+document.querySelector('.message.selected')?.dataset.rowIndex === ${selectedBefore}`));
    await evaluate("(() => { const v=document.querySelector('.transcript-viewport'); v.scrollTop=v.scrollHeight/2; v.dispatchEvent(new Event('scroll',{bubbles:true})); return true })()");
    await waitFor(async () => evaluate<boolean>("[...document.querySelectorAll('[data-row-index]')].some(e => +e.dataset.rowIndex > 4000 && +e.dataset.rowIndex < 6000)"));

    const readingTop = await evaluate<number>("document.querySelector('.transcript-viewport').scrollTop");
    const readingKey = await evaluate<string>("(() => { const v=document.querySelector('.transcript-viewport'); return [...v.querySelectorAll('[data-row-key]')].map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.bottom>v.getBoundingClientRect().top&&x.r.top<v.getBoundingClientRect().bottom).sort((a,b)=>a.r.top-b.r.top)[0]?.e.dataset.rowKey || '' })()");
    peer!.send(JSON.stringify({ type: "coordinator_message", message: { id: "stream-new", role: "assistant", text: "stream", timestamp: 20_000 } } satisfies ServerMessage));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterStream = await evaluate<{ top: number; max: number; key: string }>("(() => { const v=document.querySelector('.transcript-viewport'); const key=[...v.querySelectorAll('[data-row-key]')].map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.bottom>v.getBoundingClientRect().top&&x.r.top<v.getBoundingClientRect().bottom).sort((a,b)=>a.r.top-b.r.top)[0]?.e.dataset.rowKey || ''; return {top:v.scrollTop,max:v.scrollHeight-v.clientHeight,key} })()");
    assert.equal(afterStream.key, readingKey, `streaming changed visible row while reading at ${readingTop}`);
    assert.ok(afterStream.max - afterStream.top > 100, `history reader snapped to bottom at ${afterStream.top}/${afterStream.max}`);

    // Dynamic Markdown and an image resize the measured row; context remains usable.
    const visibleKey = await evaluate<string>("document.querySelector('[data-row-key^=\"message-\"]')?.dataset.rowKey || ''");
    const target = all.find((entry) => `message-${entry.id}` === visibleKey) || all[5_000]!;
    const heightBefore = await evaluate<number>(`document.querySelector('[data-row-key="${visibleKey}"]')?.getBoundingClientRect().height || 0`);
    peer!.send(JSON.stringify({ type: "coordinator_message_updated", message: { ...target, text: `# Resized\n\n${"tall markdown ".repeat(200)}`, attachments: [{ id: "pixel", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", size: 68 }] } } satisfies ServerMessage));
    await waitFor(async () => evaluate<boolean>(`!!document.querySelector('[data-row-key="message-${target.id}"] img')`));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const heightAfter = await evaluate<number>(`document.querySelector('[data-row-key="message-${target.id}"]')?.getBoundingClientRect().height || 0`);
    assert.ok(heightAfter > heightBefore, `ResizeObserver row height did not grow: ${heightBefore} -> ${heightAfter}`);
    await evaluate("document.querySelector('.message-meta button')?.click(); true");
    assert.equal(await evaluate<boolean>("!!document.querySelector('.context-chips button')"), true);

    const beforeSwitch = await evaluate<{ key: string; offset: number }>("(() => { const v=document.querySelector('.transcript-viewport'); const r=[...v.querySelectorAll('[data-row-key]')].map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.bottom>v.getBoundingClientRect().top&&x.r.top<v.getBoundingClientRect().bottom).sort((a,b)=>a.r.top-b.r.top)[0]; return {key:r.e.dataset.rowKey,offset:r.r.top-v.getBoundingClientRect().top} })()");
    await evaluate("document.querySelector('.job-row')?.click(); true");
    await waitFor(async () => evaluate<boolean>("document.querySelector('h1')?.textContent === 'Browser worker'"));
    await evaluate("document.querySelector('.thread-row')?.click(); true");
    await waitFor(async () => evaluate<boolean>("document.querySelector('h1')?.textContent === 'Coordinator'"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const restored = await evaluate<{ key: string; offset: number }>("(() => { const v=document.querySelector('.transcript-viewport'); const r=[...v.querySelectorAll('[data-row-key]')].map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.bottom>v.getBoundingClientRect().top&&x.r.top<v.getBoundingClientRect().bottom).sort((a,b)=>a.r.top-b.r.top)[0]; return {key:r.e.dataset.rowKey,offset:r.r.top-v.getBoundingClientRect().top} })()");
    assert.equal(restored.key, beforeSwitch.key);
    assert.ok(Math.abs(restored.offset - beforeSwitch.offset) < 3, `thread anchor offset was not restored: ${beforeSwitch.offset} -> ${restored.offset}`);

    // Reconnect with a disjoint tail while deep in history. The cached reader
    // range and exact visual anchor remain while capped pages fill the gap.
    const reconnectAnchor = restored;
    const additions = Array.from({ length: 500 }, (_, offset): TranscriptMessage => ({
      id: `m-${10_000 + offset}`, role: "assistant", timestamp: 20_001 + offset, text: `downtime ${offset}`,
    }));
    serverHistory = [...all, { id: "stream-new", role: "assistant", text: "stream", timestamp: 20_000 }, ...additions];
    serverHasOlder = true;
    const reconnectSnapshot = coordinatorSnapshot(serverHistory.slice(-100), job);
    peer!.send(JSON.stringify({ type: "snapshot", snapshot: reconnectSnapshot } satisfies ServerMessage));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterReconnect = await evaluate<{ key: string; offset: number }>("(() => { const v=document.querySelector('.transcript-viewport'); const r=[...v.querySelectorAll('[data-row-key]')].map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.bottom>v.getBoundingClientRect().top&&x.r.top<v.getBoundingClientRect().bottom).sort((a,b)=>a.r.top-b.r.top)[0]; return {key:r.e.dataset.rowKey,offset:r.r.top-v.getBoundingClientRect().top} })()");
    assert.equal(afterReconnect.key, reconnectAnchor.key);
    assert.ok(Math.abs(afterReconnect.offset - reconnectAnchor.offset) < 3,
      `disjoint reconnect moved ${reconnectAnchor.key}: ${reconnectAnchor.offset} -> ${afterReconnect.offset}`);
    for (let guard = 0; serverHasOlder && guard < 50; guard += 1) {
      const previous = pageResponses;
      await new Promise((resolve) => setTimeout(resolve, 60));
      await evaluate("(() => { const v=document.querySelector('.transcript-viewport'); v.scrollTop=1; v.dispatchEvent(new Event('scroll',{bubbles:true})); v.scrollTop=0; v.dispatchEvent(new Event('scroll',{bubbles:true})); return true })()");
      await waitFor(async () => pageResponses > previous || !serverHasOlder);
    }
    assert.equal(serverHasOlder, false);
    await waitFor(async () => evaluate<boolean>("+document.querySelector('.transcript-window').dataset.rowCount === 10502"));
    assert.ok(pageSizes.every((size) => size <= 250), `oversized pages: ${pageSizes.join(',')}`);
  } finally {
    cdp?.close();
    browser?.kill("SIGKILL");
    vite?.kill("SIGKILL");
    peer?.close();
    wss.close();
    http.close();
  }
});
