import { describe, it, expect } from "vitest";
import {
  backoffMs,
  isDue,
  needsAttention,
  isRetryable,
  canPurgeLocal,
  nextStateAfterAttempt,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  BASE_BACKOFF_MS,
  type DeliveryRecord,
} from "./delivery-policy";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function rec(o: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    state: "PENDING",
    attempts: 0,
    lastAttemptAt: null,
    deliveredAt: null,
    verifiedAt: null,
    purgedAt: null,
    ...o,
  };
}

const target = { verifyBeforePurge: true, enabled: true };

// ============================================================================
// The rule that protects customer audio.
// ============================================================================
describe("canPurgeLocal — verify then purge", () => {
  it("purges only a delivered AND verified recording", () => {
    const r = rec({ state: "DELIVERED", deliveredAt: NOW, verifiedAt: NOW });
    expect(canPurgeLocal(r, target)).toEqual({ purge: true });
  });

  // The unrecoverable failure this exists to prevent.
  it("refuses to purge a delivered but unverified recording", () => {
    const r = rec({ state: "DELIVERED", deliveredAt: NOW, verifiedAt: null });
    const verdict = canPurgeLocal(r, target);
    expect(verdict.purge).toBe(false);
    if (verdict.purge) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/not yet verified/i);
  });

  // Turning verification off must not become a licence to delete blind.
  it("still refuses when verifyBeforePurge is off — it means never purge, not purge blindly", () => {
    const r = rec({ state: "DELIVERED", deliveredAt: NOW, verifiedAt: null });
    const verdict = canPurgeLocal(r, { verifyBeforePurge: false, enabled: true });
    expect(verdict.purge).toBe(false);
    if (verdict.purge) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/no local copy is ever purged/i);
  });

  it.each<DeliveryRecord["state"]>(["PENDING", "IN_FLIGHT", "FAILED"])(
    "refuses to purge while state is %s",
    (state) => {
      expect(canPurgeLocal(rec({ state, verifiedAt: NOW, deliveredAt: NOW }), target).purge).toBe(false);
    }
  );

  it("refuses when the target is disabled", () => {
    const r = rec({ state: "DELIVERED", deliveredAt: NOW, verifiedAt: NOW });
    expect(canPurgeLocal(r, { verifyBeforePurge: true, enabled: false }).purge).toBe(false);
  });

  it("refuses a second purge", () => {
    const r = rec({ state: "DELIVERED", deliveredAt: NOW, verifiedAt: NOW, purgedAt: NOW });
    const verdict = canPurgeLocal(r, target);
    expect(verdict.purge).toBe(false);
    if (verdict.purge) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/already purged/i);
  });

  it("refuses when marked verified but never delivered — an impossible state, still refused", () => {
    expect(canPurgeLocal(rec({ state: "DELIVERED", deliveredAt: null, verifiedAt: NOW }), target).purge).toBe(
      false
    );
  });

  it("gives a readable reason for every refusal", () => {
    const cases: DeliveryRecord[] = [
      rec(),
      rec({ state: "FAILED" }),
      rec({ state: "DELIVERED", deliveredAt: NOW }),
      rec({ state: "DELIVERED", deliveredAt: NOW, verifiedAt: NOW, purgedAt: NOW }),
    ];
    for (const c of cases) {
      const v = canPurgeLocal(c, target);
      if (!v.purge) expect(v.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("backoff", () => {
  it("grows exponentially from the base", () => {
    expect(backoffMs(1)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(2)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(3)).toBe(BASE_BACKOFF_MS * 4);
  });

  it("is capped, so a target fixed on Tuesday is retried before Friday", () => {
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(MAX_ATTEMPTS)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it("has no delay before the first attempt", () => {
    expect(backoffMs(0)).toBe(0);
  });
});

describe("isDue", () => {
  it("picks up a brand-new row immediately", () => {
    expect(isDue(rec(), NOW)).toBe(true);
  });

  it("waits out the backoff after a failure", () => {
    const justFailed = rec({ state: "FAILED", attempts: 2, lastAttemptAt: ago(1000) });
    expect(isDue(justFailed, NOW)).toBe(false);

    const waited = rec({ state: "FAILED", attempts: 2, lastAttemptAt: ago(backoffMs(2) + 1) });
    expect(isDue(waited, NOW)).toBe(true);
  });

  it("never re-runs a delivered row", () => {
    expect(isDue(rec({ state: "DELIVERED", deliveredAt: NOW }), NOW)).toBe(false);
  });

  it("does not pick up a row another worker holds", () => {
    // Prevents two workers uploading the same audio concurrently.
    expect(isDue(rec({ state: "IN_FLIGHT", lastAttemptAt: ago(1e9) }), NOW)).toBe(false);
  });

  it("stops once attempts are exhausted", () => {
    const exhausted = rec({ state: "FAILED", attempts: MAX_ATTEMPTS, lastAttemptAt: ago(1e9) });
    expect(isDue(exhausted, NOW)).toBe(false);
    expect(needsAttention(exhausted)).toBe(true);
  });
});

describe("isRetryable", () => {
  it.each([
    { code: "AccessDenied" },
    { code: "InvalidAccessKeyId" },
    { code: "SignatureDoesNotMatch" },
    { code: "NoSuchBucket" },
    { code: "ENOTFOUND" },
    { name: "EAUTH" },
    { statusCode: 403 },
    { statusCode: 404 },
    { statusCode: 400 },
  ])("treats %o as permanent", (err) => {
    // Retrying these wastes attempts a transient failure might later need,
    // and hammers the customer's endpoint for nothing.
    expect(isRetryable(err)).toBe(false);
  });

  it.each([
    { statusCode: 500 },
    { statusCode: 503 },
    { statusCode: 429 },
    { statusCode: 408 },
    { code: "ETIMEDOUT" },
    { code: "ECONNRESET" },
    {},
  ])("treats %o as retryable", (err) => {
    expect(isRetryable(err)).toBe(true);
  });
});

describe("nextStateAfterAttempt", () => {
  it("marks a success delivered and counts the attempt", () => {
    expect(nextStateAfterAttempt(rec({ attempts: 2 }), { ok: true })).toEqual({
      state: "DELIVERED",
      attempts: 3,
    });
  });

  it("counts a retryable failure normally", () => {
    expect(nextStateAfterAttempt(rec({ attempts: 1 }), { ok: false, retryable: true })).toEqual({
      state: "FAILED",
      attempts: 2,
    });
  });

  it("jumps a permanent failure straight to the ceiling", () => {
    // Eight identical AccessDenied retries help nobody.
    expect(nextStateAfterAttempt(rec({ attempts: 0 }), { ok: false, retryable: false })).toEqual({
      state: "FAILED",
      attempts: MAX_ATTEMPTS,
    });
  });

  it("makes a permanently-failed row immediately visible as needing attention", () => {
    const next = nextStateAfterAttempt(rec(), { ok: false, retryable: false });
    expect(needsAttention({ ...rec(), ...next })).toBe(true);
  });
});
