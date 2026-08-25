import sharp from "sharp";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Agent profile photo processing (registration form) — validation and
// storage. Deliberately does NOT trust the browser-supplied Content-Type
// header for format validation: an uploaded .php renamed .jpg has a
// Content-Type the client controls entirely. sharp's metadata() call
// actually decodes the image header — if the bytes aren't a real
// jpeg/png/webp, it throws, which is what genuinely proves the format
// rather than trusting a client-supplied label.
//
// EXIF is stripped on write by construction: sharp only preserves
// metadata when .withMetadata() is explicitly called, so a plain
// re-encode through sharp (what processAgentPhoto does below) drops all
// EXIF — including GPS coordinates, which phone cameras routinely embed.
// Storing an employee's home location as an accidental side effect of a
// profile picture upload is not something to do silently.

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);
const OUTPUT_MAX_DIMENSION = 1024;

export class InvalidPhotoError extends Error {}

export interface ProcessedPhoto {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * Validate and re-encode an uploaded photo. Always outputs JPEG,
 * capped to OUTPUT_MAX_DIMENSION on the long edge, EXIF-stripped.
 * Throws InvalidPhotoError for anything that isn't a real, decodable
 * image within the size/format allowlist — callers should catch this
 * specifically and return a 400, not a 500.
 */
export async function processAgentPhoto(input: Buffer): Promise<ProcessedPhoto> {
  if (input.length === 0) throw new InvalidPhotoError("Empty file.");
  if (input.length > MAX_UPLOAD_BYTES) {
    throw new InvalidPhotoError(`Photo exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit.`);
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input).metadata();
  } catch {
    throw new InvalidPhotoError("File is not a valid image.");
  }

  if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format)) {
    throw new InvalidPhotoError(`Unsupported image format "${metadata.format ?? "unknown"}" — use JPEG, PNG, or WebP.`);
  }

  // Re-encoding through sharp with no .withMetadata() call is what
  // strips EXIF — this is not an extra step, it's the default behavior
  // being relied upon deliberately (see file header).
  const buffer = await sharp(input)
    .rotate() // apply EXIF orientation BEFORE stripping EXIF, so the image doesn't end up sideways
    .resize({ width: OUTPUT_MAX_DIMENSION, height: OUTPUT_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  return { buffer, filename: `${randomUUID()}.jpg`, mimeType: "image/jpeg" };
}

const PHOTO_ID_PATTERN = /^[0-9a-f-]{36}\.jpg$/;

export function isValidPhotoFilename(name: string): boolean {
  return PHOTO_ID_PATTERN.test(name);
}

export function photoStorageDir(): string {
  return process.env.AGENT_PHOTOS_DIR || "/agent-photos";
}

/** Resolve a stored photo filename to an absolute path, refusing
 * anything that would escape photoStorageDir() — same double-guard
 * pattern (filename regex + resolved-prefix check) as
 * src/app/api/recordings/[uniqueid]/route.ts. */
export function resolvePhotoPath(filename: string): string {
  if (!isValidPhotoFilename(filename)) {
    throw new InvalidPhotoError("Invalid photo filename.");
  }
  const dir = path.resolve(photoStorageDir());
  const resolved = path.resolve(dir, filename);
  if (!resolved.startsWith(dir + path.sep)) {
    throw new InvalidPhotoError("Invalid photo filename.");
  }
  return resolved;
}
