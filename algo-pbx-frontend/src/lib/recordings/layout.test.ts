import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import {
  recordingsRoot,
  tenantRelativePath,
  isTenantScopedPath,
  resolveRecordingPath,
  remoteObjectKey,
} from "./layout";

const ORIGINAL = process.env.RECORDINGS_DIR;

beforeEach(() => {
  process.env.RECORDINGS_DIR = path.resolve("/tmp/rec-test");
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RECORDINGS_DIR;
  else process.env.RECORDINGS_DIR = ORIGINAL;
});

describe("layout shape", () => {
  it("puts new recordings under the tenant id", () => {
    expect(tenantRelativePath("t123", "abc.wav")).toBe("t123/abc.wav");
  });

  it("recognises which layout a stored path is in", () => {
    expect(isTenantScopedPath("t123/abc.wav")).toBe(true);
    expect(isTenantScopedPath("abc.wav")).toBe(false);
  });
});

describe("resolveRecordingPath — dual layout during migration", () => {
  it("resolves an already-migrated path", () => {
    const r = resolveRecordingPath("t123", "t123/abc.wav");
    expect(r?.layout).toBe("tenant");
    expect(r?.absolute).toBe(path.join(recordingsRoot(), "t123", "abc.wav"));
  });

  it("prefers the tenant location for a legacy flat filename", () => {
    // So a migrated file is found first, and the legacy path stops being
    // consulted once migration completes.
    const r = resolveRecordingPath("t123", "abc.wav");
    expect(r?.layout).toBe("tenant");
    expect(r?.absolute).toBe(path.join(recordingsRoot(), "t123", "abc.wav"));
  });
});

// ============================================================================
// The guard that matters. This function now joins MORE segments than the code
// it replaces, and every extra segment is another way a `..` could enter.
// ============================================================================
describe("resolveRecordingPath — traversal refusal", () => {
  it.each([
    "../../etc/passwd",
    "..\\..\\windows\\system32\\config\\sam",
    "t123/../../../etc/shadow",
    "/etc/passwd",
  ])("refuses to escape the recordings root via %j", (evil) => {
    const r = resolveRecordingPath("t123", evil);
    if (r === null) return; // refused outright — fine
    expect(
      r.absolute.startsWith(recordingsRoot() + path.sep),
      `resolved outside the root: ${r.absolute}`,
    ).toBe(true);
  });

  it("refuses a traversal smuggled through the tenant id", () => {
    const r = resolveRecordingPath("../../etc", "passwd");
    if (r === null) return;
    expect(r.absolute.startsWith(recordingsRoot() + path.sep)).toBe(true);
  });

  it("keeps a legitimate nested name inside the root", () => {
    const r = resolveRecordingPath("t123", "t123/2026/abc.wav");
    expect(r?.absolute.startsWith(recordingsRoot() + path.sep)).toBe(true);
  });
});

describe("remoteObjectKey", () => {
  it("mirrors the local layout so a customer's bucket looks like ours", () => {
    expect(remoteObjectKey("t123", "abc.wav")).toBe("t123/abc.wav");
    expect(remoteObjectKey("t123", "t123/abc.wav")).toBe("t123/abc.wav");
  });

  it("applies a prefix without doubling or leading slashes", () => {
    expect(remoteObjectKey("t123", "abc.wav", "recordings")).toBe("recordings/t123/abc.wav");
    expect(remoteObjectKey("t123", "abc.wav", "/recordings/")).toBe("recordings/t123/abc.wav");
  });

  it("never produces a key starting with a slash", () => {
    expect(remoteObjectKey("t123", "abc.wav", "").startsWith("/")).toBe(false);
  });
});
