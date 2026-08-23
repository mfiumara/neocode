import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { AppSnapshot } from "@neocode/protocol";

class Socket {
  static OPEN = 1;
  static instance: Socket;
  readyState = 1;
  onmessage?: (event: MessageEvent) => void;
  onopen?: () => void;
  onclose?: () => void;
  constructor() { Socket.instance = this; }
  send() {}
  close() { this.readyState = 3; }
}

test("10,000 loaded dynamic-height messages mount only an overscanned window", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    location: dom.window.location, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Event: dom.window.Event, MessageEvent: dom.window.MessageEvent,
    WebSocket: Socket, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    const [{ createRoot }, { act }, { App }] = await Promise.all([import("react-dom/client"), import("react"), import("./App")]);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<App />));
    const messages = Array.from({ length: 10_000 }, (_, index) => ({
      id: `m-${index}`, role: "assistant" as const, timestamp: index,
      text: index % 7 === 0 ? `# Dynamic heading ${index}\n\n${"wrapped markdown ".repeat(40)}` : `row ${index}`,
      ...(index === 9_999 ? { attachments: [{ id: "image", mimeType: "image/png" as const, data: "AA==", size: 1 }] } : {}),
    }));
    const snapshot: AppSnapshot = {
      cwd: "/tmp/large", coordinator: {
        status: "idle", activityHistory: [], messages, transcriptPage: { hasOlder: false, oldestCursor: "m-0" },
        settings: { variant: "build", thinkingLevel: "off", availableVariants: ["build"], availableThinkingLevels: [] },
        model: null, models: [],
      }, jobs: [], maintenance: { state: "idle" },
    };
    await act(async () => Socket.instance.onmessage?.(new dom.window.MessageEvent("message", { data: JSON.stringify({ type: "snapshot", snapshot }) }) as unknown as MessageEvent));
    const mounted = document.querySelectorAll("[data-virtual-row]").length;
    assert.ok(mounted > 0 && mounted <= 40, `mounted ${mounted} of 10,000 rows`);
    assert.ok(document.querySelector(".message-attachments img"), "dynamic image row participates in the measured window");
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous) descriptor
      ? Object.defineProperty(globalThis, key, descriptor)
      : Reflect.deleteProperty(globalThis, key);
    dom.window.close();
  }
});
