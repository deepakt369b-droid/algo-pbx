import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSetting } from "./crypto";

// This module (unlike the rest of this codebase's pure-function test
// culture) needs a mocked Prisma client — getSetting()'s whole point is
// the DB-first resolution order, which can't be exercised without one.
// Kept minimal: only the two methods service.ts actually calls.
const findUnique = vi.fn();
const upsert = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { appSetting: { findUnique: (...args: unknown[]) => findUnique(...args), upsert: (...args: unknown[]) => upsert(...args) } },
}));

// Import after the mock is registered (vi.mock is hoisted, so this is
// safe even though it reads top-to-bottom below).
const { getSetting, setSetting, onSettingChanged } = await import("./service");

beforeEach(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  findUnique.mockReset();
  upsert.mockReset();
  vi.resetModules();
});

describe("getSetting resolution order", () => {
  it("returns the DB value when a row exists", async () => {
    findUnique.mockResolvedValue({ valueEncrypted: encryptSetting("db-value") });
    // Cache is module-level and shared across tests importing the same
    // module instance — use a unique key per test to avoid cross-test
    // pollution rather than trying to reset the cache from outside.
    expect(await getSetting("TEST_KEY_DB")).toBe("db-value");
  });

  it("falls back to process.env via the registry's envFallback when no row exists", async () => {
    findUnique.mockResolvedValue(null);
    process.env.RESEND_API_KEY = "env-value";
    expect(await getSetting("RESEND_API_KEY")).toBe("env-value");
  });

  it("falls back to the registry default when neither a row nor an env var exists", async () => {
    findUnique.mockResolvedValue(null);
    delete process.env.OTP_CHANNEL;
    expect(await getSetting("OTP_CHANNEL")).toBe("OPENWA");
  });

  it("returns undefined for an unknown key with no row and no env fallback", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getSetting("TOTALLY_UNKNOWN_KEY")).toBeUndefined();
  });
});

describe("setSetting", () => {
  it("upserts an encrypted value and fires registered reset hooks for that key", async () => {
    let hookFired = false;
    onSettingChanged(["TEST_KEY_HOOK"], () => {
      hookFired = true;
    });

    await setSetting("TEST_KEY_HOOK", "new-value", "admin-id");

    expect(upsert).toHaveBeenCalledOnce();
    const call = upsert.mock.calls[0][0];
    expect(call.where).toEqual({ key: "TEST_KEY_HOOK" });
    expect(call.create.valueEncrypted).not.toContain("new-value"); // stored ciphertext, not plaintext
    expect(hookFired).toBe(true);
  });
});
