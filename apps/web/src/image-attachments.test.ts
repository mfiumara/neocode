import assert from "node:assert/strict";
import test from "node:test";
import { File } from "node:buffer";
import {
  clipboardPlainText,
  detectImageMime,
  filesFromClipboard,
  prepareImage,
} from "./image-attachments";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function clipboard(parts: Partial<DataTransfer>): DataTransfer {
  return {
    items: [] as unknown as DataTransferItemList,
    files: [] as unknown as FileList,
    getData: () => "",
    ...parts,
  } as DataTransfer;
}

test("uses a file DataTransferItem even when macOS leaves its MIME blank", () => {
  const file = new File([pngBytes], "Screenshot.png", { type: "" }) as unknown as globalThis.File;
  const result = filesFromClipboard(clipboard({
    items: [{ kind: "file", type: "", getAsFile: () => file }] as unknown as DataTransferItemList,
  }));
  assert.deepEqual(result.files, [file]);
});

test("falls back to clipboardData.files when items has no usable file", () => {
  const file = new File([pngBytes], "clipboard", { type: "image/x-png" }) as unknown as globalThis.File;
  const result = filesFromClipboard(clipboard({
    items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] as unknown as DataTransferItemList,
    files: [file] as unknown as FileList,
  }));
  assert.deepEqual(result.files, [file]);
});

test("sniffs and normalizes image bytes rather than trusting clipboard MIME", async () => {
  const file = new File([pngBytes], "pasted-image", { type: "application/octet-stream" }) as unknown as globalThis.File;
  const image = await prepareImage(file);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, pngBytes.toString("base64"));
  assert.equal(image.size, pngBytes.byteLength);
  assert.equal(detectImageMime(new Uint8Array(pngBytes)), "image/png");
});

test("keeps accompanying plain text detectable and rejects spoofed images visibly", async () => {
  assert.equal(clipboardPlainText(clipboard({ getData: (type) => type === "text/plain" ? "caption" : "" })), "caption");
  const file = new File([Buffer.from("not an image")], "bad.png", { type: "image/png" }) as unknown as globalThis.File;
  await assert.rejects(prepareImage(file), /does not contain a recognizable image\/png image/);
});
