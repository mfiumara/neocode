import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES } from "@neocode/protocol";
import { imagesForPi, MAX_WEBSOCKET_PAYLOAD_BYTES, validateImageAttachments } from "./image-attachments.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("normalizes a valid image and does not trust client metadata", () => {
  const [image] = validateImageAttachments([{
    id: "client-id",
    mimeType: "image/png",
    data: onePixelPng,
    size: 1,
    name: "  paste.png  ",
  }]);
  assert.ok(image);
  assert.notEqual(image.id, "client-id");
  assert.equal(image.size, Buffer.from(onePixelPng, "base64").byteLength);
  assert.equal(image.name, "paste.png");
});

test("rejects spoofed image data", () => {
  assert.throws(() => validateImageAttachments([{
    mimeType: "image/png",
    data: Buffer.from("not an image").toString("base64"),
  }]), /does not match/);
});

test("bounds attachment count", () => {
  const image = { mimeType: "image/png", data: onePixelPng };
  assert.throws(() => validateImageAttachments(Array(MAX_IMAGE_ATTACHMENTS + 1).fill(image)), /At most/);
});

test("maps validated attachments to Pi multimodal prompt options", () => {
  const images = validateImageAttachments([{ mimeType: "image/png", data: onePixelPng }]);
  assert.deepEqual(imagesForPi(images), [{ type: "image", mimeType: "image/png", data: onePixelPng }]);
});

test("WebSocket payload bound fits four maximum base64 images with metadata headroom", () => {
  const maximumBase64Bytes = MAX_IMAGE_ATTACHMENTS * 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
  assert.ok(maximumBase64Bytes + 1024 * 1024 < MAX_WEBSOCKET_PAYLOAD_BYTES);
});
