import assert from "node:assert/strict";
import test from "node:test";
import { File } from "node:buffer";
import { JSDOM } from "jsdom";
import type { AppSnapshot } from "@neocode/protocol";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const pngBytes = Buffer.from(pngBase64, "base64");

class MockSocket {
  static OPEN = 1;
  static instances: MockSocket[] = [];
  readyState = MockSocket.OPEN;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  onclose?: () => void;
  constructor(readonly url: string) { MockSocket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; }
}

function snapshot(): AppSnapshot {
  return {
    cwd: "/tmp/repo",
    coordinator: {
      status: "idle",
      activityHistory: [],
      messages: [{
        id: "persisted",
        role: "user",
        text: "",
        timestamp: 1,
        attachments: [{ id: "image-1", mimeType: "image/png", data: pngBase64, size: pngBytes.length, name: "restored.png" }],
      }],
      settings: { variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: [] },
      model: null,
      models: [],
    },
    jobs: [],
    maintenance: { state: "idle" },
  };
}

async function settle(act: (callback: () => void | Promise<void>) => Promise<void>): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

test("the React textarea paste path handles item MIME quirks, files fallback, text, previews, and image-only send", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Event: dom.window.Event,
    MessageEvent: dom.window.MessageEvent,
    WebSocket: MockSocket,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const created: string[] = [];
  const revoked: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => { const value = `blob:test-${created.length}`; created.push(value); return value; };
  URL.revokeObjectURL = (value) => { revoked.push(String(value)); };

  try {
    const [{ createRoot }, { act }, { App }] = await Promise.all([
      import("react-dom/client"), import("react"), import("./App"),
    ]);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<App />));
    const socket = MockSocket.instances.at(-1)!;
    await act(async () => socket.onmessage?.(new dom.window.MessageEvent("message", {
      data: JSON.stringify({ type: "snapshot", snapshot: snapshot() }),
    }) as unknown as MessageEvent));

    // A durable snapshot image renders as a clickable full-size data URL.
    const restored = document.querySelector<HTMLAnchorElement>(".message-attachments a");
    assert.ok(restored?.href.startsWith("data:image/png;base64,"));
    assert.equal(restored?.querySelector("img")?.alt, "restored.png");

    const textarea = document.querySelector("textarea")!;
    const blankMimeFile = new File([pngBytes], "Screenshot.png", { type: "" }) as unknown as globalThis.File;
    const itemPaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(itemPaste, "clipboardData", { value: {
      items: [{ kind: "file", type: "", getAsFile: () => blankMimeFile }],
      files: [],
      getData: () => "caption kept by native paste",
    } });
    await act(async () => textarea.dispatchEvent(itemPaste));
    await settle(act);
    assert.equal(itemPaste.defaultPrevented, false, "text plus image must retain native text paste");
    assert.equal(document.querySelectorAll(".attachment-preview").length, 1);

    const filesOnly = new File([pngBytes], "files-only.png", { type: "image/x-png" }) as unknown as globalThis.File;
    const filePaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(filePaste, "clipboardData", { value: {
      items: [], files: [filesOnly], getData: () => "",
    } });
    await act(async () => textarea.dispatchEvent(filePaste));
    await settle(act);
    assert.equal(filePaste.defaultPrevented, true, "image-only paste must not insert junk text");
    assert.equal(document.querySelectorAll(".attachment-preview").length, 2);
    assert.equal(document.querySelectorAll<HTMLAnchorElement>(".attachment-preview a[target='_blank']").length, 2);

    // Remove is immediate and revokes its object URL.
    await act(async () => (document.querySelector<HTMLButtonElement>(".attachment-preview button")!).click());
    assert.equal(document.querySelectorAll(".attachment-preview").length, 1);
    assert.equal(revoked.length, 1);

    // Empty text with one image remains sendable and serializes the normalized attachment.
    await act(async () => (document.querySelector<HTMLButtonElement>(".send-button")!).click());
    const sent = JSON.parse(socket.sent.at(-1)!) as { text: string; attachments: Array<{ mimeType: string; data: string }> };
    assert.equal(sent.text, "");
    assert.equal(sent.attachments[0]?.mimeType, "image/png");
    assert.equal(sent.attachments[0]?.data, pngBase64);
    assert.equal(document.querySelectorAll(".attachment-preview").length, 0);
    assert.equal(revoked.length, 2);

    // Bad clipboard metadata/data is not silent: the composer shows a useful error.
    const badFile = new File(["not an image"], "broken.png", { type: "image/png" }) as unknown as globalThis.File;
    const badPaste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(badPaste, "clipboardData", { value: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => badFile }], files: [], getData: () => "",
    } });
    await act(async () => textarea.dispatchEvent(badPaste));
    await settle(act);
    assert.match(document.querySelector(".error-toast")?.textContent || "", /does not contain a recognizable image\/png image/);
    assert.equal(document.querySelectorAll(".attachment-preview").length, 0);

    await act(async () => root.unmount());
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    MockSocket.instances = [];
  }
});
