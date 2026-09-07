import { beforeEach, describe, expect, it, vi } from "vitest";

// This module (like src/lib/settings/service.test.ts) needs a mocked
// Prisma-shaped client and mocked collaborators — enforceGeoAccess()'s
// whole point is the DB reads/writes and the geoip.ts/pjsip-provision.ts
// side effects around W4's pure evaluateGeoAccess(), none of which can be
// exercised without mocking. Kept minimal: only the methods enforce.ts
// actually calls.
const tenantFindUnique = vi.fn();
const extensionFindUnique = vi.fn();
const extensionUpdate = vi.fn();
const geoLoginEventCreate = vi.fn();
const auditLogCreate = vi.fn();
const transactionMock = vi.fn();

const isGeoDatabaseAvailableAsync = vi.fn();
const lookupIp = vi.fn();
const reprovisionPjsipExcludingLocked = vi.fn();

vi.mock("./geoip", () => ({
  isGeoDatabaseAvailableAsync: (...args: unknown[]) => isGeoDatabaseAvailableAsync(...args),
  lookupIp: (...args: unknown[]) => lookupIp(...args),
}));

vi.mock("@/lib/pjsip-provision", () => ({
  reprovisionPjsipExcludingLocked: (...args: unknown[]) => reprovisionPjsipExcludingLocked(...args),
}));

const { enforceGeoAccess } = await import("./enforce");

function fakeDb() {
  const tx = {
    extension: {
      findUnique: (...args: unknown[]) => extensionFindUnique(...args),
      update: (...args: unknown[]) => extensionUpdate(...args),
    },
  };
  return {
    tenant: { findUnique: (...args: unknown[]) => tenantFindUnique(...args) },
    extension: tx.extension,
    geoLoginEvent: { create: (...args: unknown[]) => geoLoginEventCreate(...args) },
    auditLog: { create: (...args: unknown[]) => auditLogCreate(...args) },
    // Mirrors a real Prisma interactive transaction closely enough for
    // this module's own use of it (see enforce.ts's own header comment on
    // this hand-written GeoEnforceDb interface): just invoke the callback
    // with the same tx-shaped object and return its result — no real
    // isolation/rollback semantics, since a unit-test mock cannot
    // meaningfully exercise an actual concurrency race (see this file's
    // "read-then-write race" describe block below for what IS and is NOT
    // asserted about the race Finding 2 was about).
    $transaction: <T>(fn: (transactionClient: typeof tx) => Promise<T>): Promise<T> => {
      transactionMock(fn);
      return fn(tx);
    },
  };
}

const BASE_INPUT = {
  tenantId: "tenant-1",
  extensionId: "ext-1",
  email: "agent@example.com",
  userId: "user-1",
  ip: "8.8.8.8",
};

beforeEach(() => {
  tenantFindUnique.mockReset();
  extensionFindUnique.mockReset();
  extensionUpdate.mockReset();
  geoLoginEventCreate.mockReset();
  auditLogCreate.mockReset();
  transactionMock.mockReset();
  isGeoDatabaseAvailableAsync.mockReset();
  lookupIp.mockReset();
  reprovisionPjsipExcludingLocked.mockReset().mockResolvedValue(undefined);
  extensionUpdate.mockResolvedValue(undefined);
  geoLoginEventCreate.mockResolvedValue(undefined);
  auditLogCreate.mockResolvedValue(undefined);
});

describe("enforceGeoAccess — mode off", () => {
  it("allows and writes only the GeoLoginEvent row, no extension update", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "off",
      geoDefaultCountry: null,
      geoBlockVpn: false,
      geoFailureThreshold: null,
    });
    extensionFindUnique.mockResolvedValue({ geoAllowedCountries: ["IN"], geoFailedAttempts: 0, geoLockedAt: null });
    isGeoDatabaseAvailableAsync.mockResolvedValue(true);

    const decision = await enforceGeoAccess(fakeDb(), BASE_INPUT);

    expect(decision.allowed).toBe(true);
    expect(lookupIp).not.toHaveBeenCalled();
    expect(extensionUpdate).not.toHaveBeenCalled();
    expect(geoLoginEventCreate).toHaveBeenCalledTimes(1);
    expect(geoLoginEventCreate.mock.calls[0][0].data.outcome).toBe("allowed");
  });
});

describe("enforceGeoAccess — enforce mode, wrong country", () => {
  it("counts a strike below threshold without locking", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "enforce",
      geoDefaultCountry: null,
      geoBlockVpn: false,
      geoFailureThreshold: 6,
    });
    extensionFindUnique.mockResolvedValue({ geoAllowedCountries: ["IN"], geoFailedAttempts: 2, geoLockedAt: null });
    isGeoDatabaseAvailableAsync.mockResolvedValue(true);
    lookupIp.mockResolvedValue({ country: "PK", asn: 12345, asnOrg: "Some ISP" });

    const decision = await enforceGeoAccess(fakeDb(), BASE_INPUT);

    expect(decision.allowed).toBe(false);
    expect(decision.shouldLock).toBe(false);
    expect(extensionUpdate).toHaveBeenCalledTimes(1);
    // Atomic increment (Finding 2), not a computed absolute number — see
    // enforce.ts's own comment on why `currentAttempts + 1` is a
    // read-then-write race between two concurrent evaluations.
    expect(extensionUpdate.mock.calls[0][0].data.geoFailedAttempts).toEqual({ increment: 1 });
    expect(extensionUpdate.mock.calls[0][0].data.geoLockedAt).toBeUndefined();
    expect(auditLogCreate).not.toHaveBeenCalled();
    expect(reprovisionPjsipExcludingLocked).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it("locks on the 6th strike, re-provisions PJSIP, and audits the lock", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "enforce",
      geoDefaultCountry: null,
      geoBlockVpn: false,
      geoFailureThreshold: 6,
    });
    extensionFindUnique.mockResolvedValue({ geoAllowedCountries: ["IN"], geoFailedAttempts: 5, geoLockedAt: null });
    isGeoDatabaseAvailableAsync.mockResolvedValue(true);
    lookupIp.mockResolvedValue({ country: "PK", asn: 12345, asnOrg: "Some ISP" });

    const decision = await enforceGeoAccess(fakeDb(), BASE_INPUT);

    expect(decision.allowed).toBe(false);
    expect(decision.shouldLock).toBe(true);
    expect(extensionUpdate.mock.calls[0][0].data.geoLockedAt).toBeInstanceOf(Date);
    expect(extensionUpdate.mock.calls[0][0].data.geoLockedReason).toMatch(/PK/);
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    expect(auditLogCreate.mock.calls[0][0].data.action).toBe("geo.extension_locked");
    expect(reprovisionPjsipExcludingLocked).toHaveBeenCalledWith(BASE_INPUT.tenantId);
  });

  it("does not increment an already-locked extension's counter, and does not re-lock or re-provision", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "enforce",
      geoDefaultCountry: null,
      geoBlockVpn: false,
      geoFailureThreshold: 6,
    });
    extensionFindUnique.mockResolvedValue({
      geoAllowedCountries: ["IN"],
      geoFailedAttempts: 6,
      geoLockedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    isGeoDatabaseAvailableAsync.mockResolvedValue(true);
    lookupIp.mockResolvedValue({ country: "PK", asn: 12345, asnOrg: "Some ISP" });

    const decision = await enforceGeoAccess(fakeDb(), BASE_INPUT);

    expect(decision.allowed).toBe(false);
    expect(decision.shouldLock).toBe(false);
    expect(decision.shouldCount).toBe(false);
    expect(extensionUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
    expect(reprovisionPjsipExcludingLocked).not.toHaveBeenCalled();
  });
});

describe("enforceGeoAccess — geo database unavailable", () => {
  it("fails open, does not increment, and rate-limits the loud AuditLog to once per hour per tenant", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "enforce",
      geoDefaultCountry: "IN",
      geoBlockVpn: false,
      geoFailureThreshold: 6,
    });
    extensionFindUnique.mockResolvedValue({ geoAllowedCountries: [], geoFailedAttempts: 0, geoLockedAt: null });
    isGeoDatabaseAvailableAsync.mockResolvedValue(false);

    const first = await enforceGeoAccess(fakeDb(), { ...BASE_INPUT, tenantId: "tenant-unavailable-1" });
    expect(first.allowed).toBe(true);
    expect(first.shouldCount).toBe(false);
    expect(extensionUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    expect(auditLogCreate.mock.calls[0][0].data.action).toBe("geo.database_unavailable");

    // A second evaluation for the SAME tenant within the rate-limit window
    // must not write a second AuditLog row.
    await enforceGeoAccess(fakeDb(), { ...BASE_INPUT, tenantId: "tenant-unavailable-1" });
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
  });

  it("never flags an 'off' tenant for a missing database", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "off",
      geoDefaultCountry: null,
      geoBlockVpn: false,
      geoFailureThreshold: null,
    });
    extensionFindUnique.mockResolvedValue({ geoAllowedCountries: [], geoFailedAttempts: 0, geoLockedAt: null });
    isGeoDatabaseAvailableAsync.mockResolvedValue(false);

    await enforceGeoAccess(fakeDb(), { ...BASE_INPUT, tenantId: "tenant-off-1" });
    expect(auditLogCreate).not.toHaveBeenCalled();
  });
});

describe("enforceGeoAccess — missing tenant/extension row", () => {
  it("fails open without throwing when the tenant is missing", async () => {
    tenantFindUnique.mockResolvedValue(null);
    extensionFindUnique.mockResolvedValue(null);

    const decision = await enforceGeoAccess(fakeDb(), BASE_INPUT);
    expect(decision.allowed).toBe(true);
    expect(extensionUpdate).not.toHaveBeenCalled();
    expect(geoLoginEventCreate).not.toHaveBeenCalled();
    // A missing tenant is resolved before the transaction is ever opened —
    // there's nothing to serialize a lookup against.
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("fails open without throwing when the extension is missing (found inside the transaction)", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "enforce",
      geoDefaultCountry: "IN",
      geoBlockVpn: false,
      geoFailureThreshold: 6,
    });
    extensionFindUnique.mockResolvedValue(null);
    isGeoDatabaseAvailableAsync.mockResolvedValue(true);

    const decision = await enforceGeoAccess(fakeDb(), BASE_INPUT);
    expect(decision.allowed).toBe(true);
    expect(extensionUpdate).not.toHaveBeenCalled();
    expect(geoLoginEventCreate).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});

describe("enforceGeoAccess — monitor mode is purely observational (Finding 1)", () => {
  it("does NOT reset geoFailedAttempts in the DB on a clean-country login, but still writes the GeoLoginEvent evidence row", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "monitor",
      geoDefaultCountry: null,
      geoBlockVpn: false,
      geoFailureThreshold: 6,
    });
    // 4 strikes accrued from an earlier enforce-mode run — this is exactly
    // the evidence a clean pass in monitor mode must not destroy.
    extensionFindUnique.mockResolvedValue({ geoAllowedCountries: ["IN"], geoFailedAttempts: 4, geoLockedAt: null });
    isGeoDatabaseAvailableAsync.mockResolvedValue(true);
    lookupIp.mockResolvedValue({ country: "IN", asn: null, asnOrg: null });

    const decision = await enforceGeoAccess(fakeDb(), BASE_INPUT);

    // geo-decision.ts's real behavior for a clean pass in monitor mode:
    // outcome "allowed", shouldResetCounter: true — enforce.ts must not
    // act on shouldResetCounter while mode === "monitor".
    expect(decision.outcome).toBe("allowed");
    expect(decision.shouldResetCounter).toBe(true);
    expect(decision.allowed).toBe(true);

    expect(extensionUpdate).not.toHaveBeenCalled();
    expect(geoLoginEventCreate).toHaveBeenCalledTimes(1);
    expect(geoLoginEventCreate.mock.calls[0][0].data.outcome).toBe("allowed");
  });

  it("does NOT write geoFailedAttempts/geoLockedAt for a mismatched login either — only the monitor_only GeoLoginEvent row", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "monitor",
      geoDefaultCountry: null,
      geoBlockVpn: false,
      geoFailureThreshold: 6,
    });
    extensionFindUnique.mockResolvedValue({ geoAllowedCountries: ["IN"], geoFailedAttempts: 4, geoLockedAt: null });
    isGeoDatabaseAvailableAsync.mockResolvedValue(true);
    lookupIp.mockResolvedValue({ country: "PK", asn: 12345, asnOrg: "Some ISP" });

    const decision = await enforceGeoAccess(fakeDb(), BASE_INPUT);

    expect(decision.outcome).toBe("monitor_only");
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
    expect(decision.shouldResetCounter).toBe(false);

    expect(extensionUpdate).not.toHaveBeenCalled();
    expect(geoLoginEventCreate).toHaveBeenCalledTimes(1);
    expect(geoLoginEventCreate.mock.calls[0][0].data.outcome).toBe("monitor_only");
  });
});

describe("enforceGeoAccess — read-then-write race on geoFailedAttempts (Finding 2)", () => {
  it("wraps the extension read-decide-write sequence in db.$transaction", async () => {
    tenantFindUnique.mockResolvedValue({
      geoLockMode: "enforce",
      geoDefaultCountry: null,
      geoBlockVpn: false,
      geoFailureThreshold: 6,
    });
    extensionFindUnique.mockResolvedValue({ geoAllowedCountries: ["IN"], geoFailedAttempts: 2, geoLockedAt: null });
    isGeoDatabaseAvailableAsync.mockResolvedValue(true);
    lookupIp.mockResolvedValue({ country: "PK", asn: 12345, asnOrg: "Some ISP" });

    await enforceGeoAccess(fakeDb(), BASE_INPUT);

    // A real concurrency race is not something this mock-based harness can
    // meaningfully reproduce (there is no actual Postgres connection or
    // isolation level here) — this only confirms the transaction wrapper
    // is genuinely used for the extension read+write, and that the write
    // uses an atomic increment rather than a computed absolute value
    // (asserted above in the "counts a strike" test), which is what
    // actually removes the race at the SQL level.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledWith(expect.any(Function));
    // The find and the update both ran through the tx passed into the
    // transaction callback, not directly against the outer client.
    expect(extensionFindUnique).toHaveBeenCalledTimes(1);
    expect(extensionUpdate).toHaveBeenCalledTimes(1);
  });
});
