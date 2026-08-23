import { randomUUID } from "node:crypto";
import {
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  type ImageAttachment,
} from "@neocode/protocol";

const supportedTypes = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function hasExpectedSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (mimeType === "image/gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mimeType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

/** Validate all untrusted image data at the WebSocket boundary before passing it to Pi. */
export function validateImageAttachments(input: unknown): ImageAttachment[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("Image attachments must be an array.");
  if (input.length > MAX_IMAGE_ATTACHMENTS) throw new Error(`At most ${MAX_IMAGE_ATTACHMENTS} images may be attached.`);

  return input.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`Image ${index + 1} is invalid.`);
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.mimeType !== "string" || !supportedTypes.has(candidate.mimeType)) {
      throw new Error(`Image ${index + 1} has an unsupported type.`);
    }
    if (typeof candidate.data !== "string" || !candidate.data || !base64Pattern.test(candidate.data)) {
      throw new Error(`Image ${index + 1} has invalid base64 data.`);
    }
    const bytes = Buffer.from(candidate.data, "base64");
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`Image ${index + 1} exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit.`);
    if (!hasExpectedSignature(bytes, candidate.mimeType)) throw new Error(`Image ${index + 1} does not match its declared type.`);

    return {
      id: randomUUID(),
      mimeType: candidate.mimeType as ImageAttachment["mimeType"],
      data: bytes.toString("base64"),
      size: bytes.byteLength,
      ...(typeof candidate.name === "string" && candidate.name.trim()
        ? { name: candidate.name.trim().slice(0, 160) }
        : {}),
    };
  });
}
