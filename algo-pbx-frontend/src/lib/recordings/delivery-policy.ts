// Retry, backoff and purge decisions for recording delivery.
//
// Pure, so the rules that govern customer audio are testable without an S3
// bucket, an SFTP server, or a clock.
//
// ============================================================================
// THE VERIFY-THEN-PURGE RULE
// ============================================================================
// A local recording is deleted ONLY after the delivered copy has been read
// back and matched. Never on "the upload returned 200".
//
// The failure this prevents is not hypothetical and is unrecoverable when it
// happens: a bucket policy changes, or an SFTP server silently writes to a
// full disk, and the upload call still succeeds. Purge on that signal and the
// customer's call recordings are gone from both ends — no backup, no retry,
// nothing to apologise with. Every other failure mode in this pipeline is
// recoverable by trying again; this one is not, so it gets the strictest rule.
// ============================================================================

export type DeliveryState = "PENDING" | "IN_FLIGHT" | "DELIVERED" | "FAILED";

export interface DeliveryRecord {
  state: DeliveryState;
  attempts: number;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  verifiedAt: Date | null;
  purgedAt: Date | null;
}

/** After this many failures a delivery stops retrying and waits for a human.
 * Retrying forever turns one misconfigured target into an unbounded stream of
 * requests against a customer's infrastructure. */
export const MAX_ATTEMPTS = 8;

/** Exponential backoff, capped. The cap matters: an uncapped doubling reaches
 * days between attempts, so a target fixed on Tuesday would not be noticed
 * until Friday. */
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

/** Whether the worker should pick this row up now. */
export function isDue(record: DeliveryRecord, now: Date = new Date()): boolean {
  if (record.state === "DELIVERED") return false;
  if (record.state === "IN_FLIGHT") return false;
  if (record.attempts >= MAX_ATTEMPTS) return false;
  if (record.lastAttemptAt === null) return true;
  return now.getTime() - record.lastAttemptAt.getTime() >= backoffMs(record.attempts);
}

/** Exhausted its retries and is now waiting for someone to look at it. This
 * is what surfaces in the console's attention queue. */
export function needsAttention(record: DeliveryRecord): boolean {
  return record.state === "FAILED" && record.attempts >= MAX_ATTEMPTS;
}

/**
 * Errors worth retrying versus errors that will fail identically forever.
 *
 * Retrying a permanent error wastes attempts that a transient failure later
 * might have needed, and hammers the customer's endpoint for no reason. So
 * authentication and authorisation failures, and a missing bucket or path,
 * stop immediately: none of those fix themselves.
 */
export function isRetryable(error: { name?: string; code?: string; statusCode?: number; message?: string }): boolean {
  const code = (error.code ?? error.name ?? "").toString();
  const status = error.statusCode ?? 0;

  const permanent = [
    "AccessDenied",
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
    "NoSuchBucket",
    "AllAccessDisabled",
    "AuthenticationFailed",
    "ENOTFOUND",
    "EAUTH",
  ];
  if (permanent.some((p) => code.includes(p))) return false;

  // 4xx other than 408/429 is a request we should not repeat unchanged.
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false;

  return true;
}

export type PurgeVerdict = { purge: true } | { purge: false; reason: string };

/**
 * The gate on deleting a local recording. Deliberately verbose in its
 * refusals: if this ever says no when someone expected yes, the reason has to
 * be readable in a log at 3am.
 */
export function canPurgeLocal(
  record: DeliveryRecord,
  target: { verifyBeforePurge: boolean; enabled: boolean }
): PurgeVerdict {
  if (!target.enabled) return { purge: false, reason: "Delivery target is not enabled." };
  if (record.state !== "DELIVERED") {
    return { purge: false, reason: `Delivery is ${record.state}, not DELIVERED.` };
  }
  if (record.deliveredAt === null) {
    return { purge: false, reason: "No delivery timestamp recorded." };
  }
  if (record.purgedAt !== null) return { purge: false, reason: "Already purged." };

  // The rule. Note it holds even though `verifyBeforePurge` is configurable:
  // turning verification off does NOT authorise purging an unverified copy,
  // it only means we skip the read-back and therefore never purge at all.
  // There is no configuration in which we delete audio we have not confirmed
  // exists elsewhere.
  if (record.verifiedAt === null) {
    return {
      purge: false,
      reason: target.verifyBeforePurge
        ? "Delivered but not yet verified by read-back."
        : "Read-back verification is disabled for this target, so no local copy is ever purged.",
    };
  }

  return { purge: true };
}

/** Next state after an attempt. Kept here so the worker contains no policy. */
export function nextStateAfterAttempt(
  record: DeliveryRecord,
  outcome: { ok: boolean; retryable?: boolean }
): { state: DeliveryState; attempts: number } {
  const attempts = record.attempts + 1;
  if (outcome.ok) return { state: "DELIVERED", attempts };
  // A permanent error jumps straight to the retry ceiling rather than
  // burning through attempts that will each fail the same way.
  if (outcome.retryable === false) return { state: "FAILED", attempts: MAX_ATTEMPTS };
  return { state: "FAILED", attempts };
}
