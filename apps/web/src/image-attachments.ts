import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  type ImageAttachment,
} from "@neocode/protocol";

export interface PreparedImage extends ImageAttachment {
  blob: Blob;
}

export interface ClipboardFiles {
  files: File[];
  unreadableFileItems: number;
}

const supportedTypes = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);
const mimeAliases = new Map<string, ImageAttachment["mimeType"]>([
  ["image/jpg", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/x-png", "image/png"],
]);

/**
 * Read both clipboard representations used by browsers. Firefox and some
 * WebKit/macOS pasteboards expose an image only through `files`, while Chromium
 * normally exposes it through a file DataTransferItem. Do not filter on the
 * item's MIME: macOS frequently leaves it blank even when the File is valid.
 */
export function filesFromClipboard(clipboard: DataTransfer): ClipboardFiles {
  const itemFiles: File[] = [];
  let unreadableFileItems = 0;
  for (const item of Array.from(clipboard.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) itemFiles.push(file);
    else unreadableFileItems += 1;
  }

  // `items` and `files` usually mirror one another. Using files only as a
  // fallback avoids attaching each image twice when getAsFile returns a new
  // wrapper around the same native pasteboard object.
  return {
    files: itemFiles.length ? itemFiles : Array.from(clipboard.files || []),
    unreadableFileItems,
  };
}

export function clipboardPlainText(clipboard: DataTransfer): string {
  try {
    return clipboard.getData("text/plain") || clipboard.getData("Text") || "";
  } catch {
    return "";
  }
}

function declaredMime(type: string): ImageAttachment["mimeType"] | undefined {
  const normalized = type.toLowerCase().split(";", 1)[0]!.trim();
  if (supportedTypes.has(normalized)) return normalized as ImageAttachment["mimeType"];
  return mimeAliases.get(normalized);
}

/** Prefer magic bytes over unreliable clipboard MIME metadata. */
export function detectImageMime(bytes: Uint8Array): ImageAttachment["mimeType"] | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.subarray(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

function bytesAsBase64(bytes: Uint8Array): string {
  // Keep chunks below apply/string argument limits for images near 8 MiB.
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name || "Clipboard image"} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name || "Clipboard image"} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  }
  const sniffed = detectImageMime(bytes);
  const mimeType = sniffed || declaredMime(file.type);
  if (!mimeType) {
    const detail = file.type ? ` (${file.type})` : " with no MIME type";
    throw new Error(`Clipboard file ${file.name || "image"}${detail} is not a supported PNG, JPEG, GIF, or WebP image.`);
  }
  // A declared supported MIME with unrecognizable bytes would only fail later
  // at the server boundary. Reject it here with an actionable visible error.
  if (!sniffed) throw new Error(`Clipboard file ${file.name || "image"} does not contain a recognizable ${mimeType} image.`);

  const blob = new Blob([bytes], { type: mimeType });
  return {
    id: crypto.randomUUID(),
    mimeType,
    data: bytesAsBase64(bytes),
    size: bytes.byteLength,
    name: file.name || "clipboard image",
    blob,
  };
}
