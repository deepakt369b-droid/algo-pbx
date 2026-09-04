import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSetting } from "./crypto";

// This module (unlike the rest of this codebase's pure-function test
// culture) needs a mocked Prisma client — getSetting()'s whole point is
// the DB-first resolution order, which can't be exercised without one.
// Kept minimal: only the methods service.ts actually calls.
//
// Wave 2a multi-tenant migration: service.ts now imports `unsafeGlobalDb`
// (not `db`) and, for the platform-default row (no `tenantId` argument —
// every call below is the pre-existing untenanted call shape), resolves via
// `findFirst({ where: { tenantId: null, key } })` rather than
// `findUnique({ where: { key } })` — see service.ts's own comment on why
// (Prisma's compound-unique `tenantId_key` input type requires a real
// string, so a null-tenant lookup can't use `findUnique` at all). `setSetting`'s
// null-tenant path is a plain find-then-create/update, not an atomic
// `upsert`, for the same reason.
const findUnique = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();
vi.mock("@/lib/db", () => ({
  unsafeGlobalDb: {
    appSetting: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      findFirst: (...args: unknown[]) => findFirst(...args),
      create: (...args: unknown[]) => create(...args),
      update: (...args: unknown[]) => update(...args),
    },
  },
}));

// Import after the mock is registered (vi.mock is hoisted, so this is
// safe even though it reads top-to-bottom below).
const { getSetting, setSetting, onSettingChanged } = await import("./service");

beforeEach(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  findUnique.mockReset();
  findFirst.mockReset();
  create.mockReset();
  update.mockReset();
  vi.resetModules();
});

describe("getSetting resolution order", () => {
  it("returns the DB value when a row exists", async () => {
    findFirst.mockResolvedValue({ valueEncrypted: encryptSetting("db-value") });
    // Cache is module-level and shared across tests importing the same
    // module instance — use a unique key per test to avoid cross-test
    // pollution rather than trying to reset the cache from outside.
    expect(await getSetting("TEST_KEY_DB")).toBe("db-value");
  });

  it("falls back to process.env via the registry's envFallback when no row exists", async () => {
    findFirst.mockResolvedValue(null);
    process.env.RESEND_API_KEY = "env-value";
    expect(await getSetting("RESEND_API_KEY")).toBe("env-value");
  });

  it("falls back to the registry default when neither a row nor an env var exists", async () => {
    findFirst.mockResolvedValue(null);
    delete process.env.OTP_CHANNEL;
    expect(await getSetting("OTP_CHANNEL")).toBe("OPENWA");
  });

  it("returns undefined for an unknown key with no row and no env fallback", async () => {
    findFirst.mockResolvedValue(null);
    expect(await getSetting("TOTALLY_UNKNOWN_KEY")).toBeUndefined();
  });
});

describe("setSetting", () => {
  it("creates an encrypted platform-default row and fires registered reset hooks for that key when none exists yet", async () => {
    let hookFired = false;
    onSettingChanged(["TEST_KEY_HOOK"], () => {
      hookFired = true;
    });
    findFirst.mockResolvedValue(null);

    await setSetting("TEST_KEY_HOOK", "new-value", "admin-id");

    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0][0];
    expect(call.data.tenantId).toBeNull();
    expect(call.data.key).toBe("TEST_KEY_HOOK");
    expect(call.data.valueEncrypted).not.toContain("new-value"); // stored ciphertext, not plaintext
    expect(update).not.toHaveBeenCalled();
    expect(hookFired).toBe(true);
  });

  it("updates the existing platform-default row instead of creating a duplicate", async () => {
    findFirst.mockResolvedValue({ id: "row-1", valueEncrypted: encryptSetting("old-value") });

    await setSetting("TEST_KEY_EXISTING", "new-value", "admin-id");

    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0].where).toEqual({ id: "row-1" });
    expect(create).not.toHaveBeenCalled();
  });
});
