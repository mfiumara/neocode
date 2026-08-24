import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../../..");
const appRoot = resolve(process.env.NEOCODE_E2E_APP_ROOT || repo);
const viteConfig = process.env.NEOCODE_E2E_VITE_CONFIG;
const verifyCurrentBundle = process.env.NEOCODE_E2E_VERIFY_CURRENT_BUNDLE !== "false";
const webPort = Number(process.env.NEOCODE_E2E_WEB_PORT || 14317);
const serverPort = Number(process.env.NEOCODE_E2E_SERVER_PORT || 14318);
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let fixture = "";
let server: ChildProcess;
let web: ChildProcess;

function start(command: string, env: NodeJS.ProcessEnv, ready: RegExp): Promise<ChildProcess> {
  return new Promise((resolveStart, reject) => {
    const child = spawn(command, { cwd: appRoot, env: { ...process.env, ...env }, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (ready.test(output)) resolveStart(child);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => reject(new Error(`${command} exited ${code} before startup:\n${output}`)));
  });
}

async function stop(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await Promise.race([
    new Promise<void>((resolveStop) => child.once("exit", () => resolveStop())),
    new Promise<void>((resolveStop) => setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      resolveStop();
    }, 5_000)),
  ]);
}

async function startServer(): Promise<ChildProcess> {
  return start("npm run start -w @neocode/server", {
    NEOCODE_PORT: String(serverPort),
    NEOCODE_CWD: fixture,
    NEOCODE_JANITOR_STARTUP: "false",
  }, /neocode server listening/);
}

async function controlledPaste(page: Page, mode: "blank-item" | "files-fallback"): Promise<boolean> {
  return page.locator("textarea").evaluate((textarea, { mode, pngBase64 }) => {
    const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0));
    const file = new File([bytes], `${mode}.png`, { type: mode === "blank-item" ? "" : "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    const clipboardData = mode === "blank-item"
      ? transfer
      : { items: [], files: transfer.files, getData: () => "" };
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    let received = false;
    textarea.addEventListener("paste", () => { received = true; }, { once: true });
    textarea.dispatchEvent(event);
    return received && event.defaultPrevented;
  }, { mode, pngBase64 });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fixture = await mkdtemp(join(tmpdir(), "neocode-image-e2e-"));
  await writeFile(join(fixture, "README.md"), "# E2E fixture\n");
  await new Promise<void>((resolveGit, reject) => {
    const git = spawn("git init -q -b main && git add README.md && git -c user.name=E2E -c user.email=e2e@example.test commit -qm init", { cwd: fixture, shell: true });
    git.once("exit", (code) => code === 0 ? resolveGit() : reject(new Error(`git fixture failed: ${code}`)));
  });
  server = await startServer();
  const configArgument = viteConfig ? ` --config ${JSON.stringify(resolve(viteConfig))}` : "";
  web = await start(`npm run dev -w @neocode/web -- --host 127.0.0.1${configArgument}`, {
    NEOCODE_WEB_PORT: String(webPort),
    NEOCODE_SERVER_PORT: String(serverPort),
  }, new RegExp(String(webPort)));
});

test.afterAll(async () => {
  await stop(web);
  await stop(server);
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

test("narrow App keeps compaction status accessible across live context and reconnect snapshots", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    class ContextSocket {
      static OPEN = 1;
      static instances: ContextSocket[] = [];
      readyState = ContextSocket.OPEN;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      onclose?: () => void;
      constructor(_url: string) {
        ContextSocket.instances.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      send() { /* transport assertions only need server-to-client messages */ }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    class RoutedSocket {
      static CONNECTING = NativeSocket.CONNECTING;
      static OPEN = NativeSocket.OPEN;
      static CLOSING = NativeSocket.CLOSING;
      static CLOSED = NativeSocket.CLOSED;
      constructor(url: string | URL, protocols?: string | string[]) {
        if (new URL(String(url), location.href).pathname === "/ws") return new ContextSocket(String(url)) as unknown as RoutedSocket;
        return (protocols === undefined ? new NativeSocket(url) : new NativeSocket(url, protocols)) as unknown as RoutedSocket;
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: RoutedSocket });
    Object.defineProperty(window, "__contextSockets", { configurable: true, value: ContextSocket.instances });
  });
  const context = (tokens: number | null, contextWindow: number, state: "completed" | "failed", error?: string) => ({
    usage: { tokens, contextWindow, percent: tokens === null ? null : tokens / contextWindow * 100, updatedAt: Date.now() },
    autoCompactionEnabled: true,
    manualCompactionAvailable: true,
    compaction: { state, reason: "manual", startedAt: 1, completedAt: 2, willRetry: state === "failed", error },
  });
  const snapshot = (contextState: ReturnType<typeof context>) => ({
    cwd: "/transport", coordinator: {
      status: "idle", activityHistory: [], messages: [],
      settings: { variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: ["off"] },
      model: null, models: [], context: contextState,
    }, jobs: [], maintenance: { state: "idle" },
  });
  const send = async (message: unknown) => page.evaluate((payload) => {
    const sockets = (window as unknown as { __contextSockets: Array<{ onmessage?: (event: { data: string }) => void }> }).__contextSockets;
    sockets.at(-1)!.onmessage?.({ data: JSON.stringify(payload) });
  }, message);

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __contextSockets: unknown[] }).__contextSockets.length)).toBeGreaterThan(0);
  const initialSocketCount = await page.evaluate(() => (window as unknown as { __contextSockets: unknown[] }).__contextSockets.length);
  await send({ type: "snapshot", snapshot: snapshot(context(50_000, 128_000, "failed", "first failure")) });
  const status = page.locator("#compaction-status");
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveText("Compaction failed · SDK will retry: first failure");
  expect(await status.evaluate((node) => ({ display: getComputedStyle(node).display, height: node.getBoundingClientRect().height })))
    .toMatchObject({ display: "block" });
  expect(await status.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Compact coordinator model context" })).toHaveText("Compact");

  await send({ type: "coordinator_context", context: context(null, 128_000, "completed") });
  await expect(status).toHaveText("Compaction completed");
  await expect(page.locator(".context-usage strong")).toHaveText("unknown / 128,000");
  await expect(page.getByRole("button", { name: "Compact coordinator model context" })).toHaveText("Compact");

  await page.evaluate(() => {
    const sockets = (window as unknown as { __contextSockets: Array<{ close(): void }> }).__contextSockets;
    sockets.at(-1)!.close();
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __contextSockets: unknown[] }).__contextSockets.length), { timeout: 3_000 }).toBe(initialSocketCount + 1);
  await send({ type: "snapshot", snapshot: snapshot(context(99_000, 200_000, "failed", "refreshed failure")) });
  await expect(page.locator(".context-usage strong")).toHaveText("99,000 / 200,000");
  await expect(status).toHaveText("Compaction failed · SDK will retry: refreshed failure");
  await expect(status).toBeVisible();
  await expect(page.getByRole("button", { name: "Compact coordinator model context" })).toHaveText("Compact");
});

test("integrated app pastes, opens, sends, validates, and restores image attachments", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${webPort}` });
  await page.goto("/");
  await expect(page.locator("textarea")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "local" })).toHaveText(/local/);

  const servedSource = await page.evaluate(() => fetch("/src/App.tsx").then((response) => response.text()));
  if (verifyCurrentBundle) {
    expect(servedSource).toContain("Attach images");
    expect(servedSource).toContain("mountedRef.current = true");
  }

  // shadcn's forwarded textarea remains focusable, while Cmd-K is still a
  // global command rather than being inserted into the composer.
  await page.locator("textarea").focus();
  await expect(page.locator("textarea")).toBeFocused();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("textarea").focus();
  await expect(page.locator("textarea")).toBeFocused();

  expect(await controlledPaste(page, "blank-item")).toBe(true);
  await expect(page.locator(".attachment-preview")).toHaveCount(1);
  expect(await controlledPaste(page, "files-fallback")).toBe(true);
  await expect(page.locator(".attachment-preview")).toHaveCount(2);

  const popupPromise = page.waitForEvent("popup");
  await page.locator(".attachment-preview a").first().click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toMatch(/^blob:/);
  await popup.close();

  // Chromium exposes async clipboard on trustworthy localhost origins, but an
  // automated/native paste can still be denied by the host OS. Exercise it
  // when available and always verify the picker fallback.
  const clipboardWrite = await page.evaluate(async (base64) => {
    try {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
      return { ok: true, secure: isSecureContext };
    } catch (error) {
      return { ok: false, secure: isSecureContext, error: String(error) };
    }
  }, pngBase64);
  expect(clipboardWrite.secure).toBe(true);
  if (clipboardWrite.ok) {
    const before = await page.locator(".attachment-preview").count();
    await page.locator("textarea").focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
    await expect(page.locator(".attachment-preview")).toHaveCount(before + 1);
    console.log("E2E_NATIVE_CLIPBOARD=passed");
  } else {
    console.log(`E2E_NATIVE_CLIPBOARD=unavailable (${clipboardWrite.error})`);
  }

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach images" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "picker.png", mimeType: "image/png", buffer: Buffer.from(pngBase64, "base64") });
  await expect(page.locator(".attachment-preview")).toHaveCount(clipboardWrite.ok ? 4 : 3);

  await page.locator("textarea").fill("image e2e persistence");
  await page.getByRole("button", { name: /^Send/ }).click();
  const sent = page.locator("article.message.user").filter({ hasText: "image e2e persistence" });
  await expect(sent).toBeVisible();
  await expect(sent.locator(".message-attachments img")).toHaveCount(clipboardWrite.ok ? 4 : 3);
  await expect(sent.locator(".message-attachments a").first()).toHaveAttribute("href", /^data:image\/png;base64,/);

  // Restart the real server against the same fixture. A fresh snapshot proves
  // that validation accepted the WebSocket payload and durable restore kept it.
  await stop(server);
  server = await startServer();
  await page.reload();
  const restored = page.locator("article.message.user").filter({ hasText: "image e2e persistence" });
  await expect(restored).toBeVisible({ timeout: 15_000 });
  await expect(restored.locator(".message-attachments img")).toHaveCount(clipboardWrite.ok ? 4 : 3);
});
