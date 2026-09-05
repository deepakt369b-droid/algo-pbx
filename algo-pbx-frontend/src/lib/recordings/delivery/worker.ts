import { unlink, stat } from "node:fs/promises";
import { unsafeGlobalDb as db } from "@/lib/db";
import { resolveRecordingPath, remoteObjectKey } from "../layout";
import {
  isDue,
  canPurgeLocal,
  isRetryable,
  nextStateAfterAttempt,
  MAX_ATTEMPTS,
} from "../delivery-policy";
import { decodeTargetConfig } from "./targets";
import { createTransport } from "./transport";

// The delivery worker.
//
// Contains no policy of its own — every decision (is this due, is this error
// worth retrying, may this local file be deleted) comes from
// delivery-policy.ts, which is pure and tested. This file is the side effects:
// claim a row, read a file, call a transport, write the result.
//
// Two properties worth being explicit about:
//
//   1. CLAIMING. A row is moved to IN_FLIGHT with a conditional update before
//      any upload starts, so two workers cannot deliver the same recording
//      concurrently. isDue() ignores IN_FLIGHT rows for the same reason.
//   2. PURGE IS SEPARATE FROM DELIVERY. Deleting the local file is a distinct
//      pass over already-verified rows, not a step at the end of a successful
//      upload. That way a crash between "verified" and "purged" leaves the
//      file present — the safe direction — and the purge decision is always
//      made against persisted state rather than in-memory optimism.

export interface WorkerResult {
  claimed: number;
  delivered: number;
  verified: number;
  failed: number;
  purged: number;
  skipped: string[];
}

/** Enqueue any recording for an enabled target that has no delivery row yet. */
export async function enqueuePending(limit = 500): Promise<number> {
  const targets = await db.recordingStorageTarget.findMany({
    where: { enabled: true, kind: { not: "PLATFORM_LOCAL" } },
    select: { id: true, tenantId: true },
  });
  if (targets.length === 0) return 0;

  let created = 0;
  for (const target of targets) {
    const recordings = await db.recording.findMany({
      where: { tenantId: target.tenantId, deliveries: { none: { targetId: target.id } } },
      select: { id: true },
      take: limit,
    });
    if (recordings.length === 0) continue;

    const result = await db.recordingDelivery.createMany({
      data: recordings.map((r) => ({
        tenantId: target.tenantId,
        recordingId: r.id,
        targetId: target.id,
      })),
      // The [recordingId, targetId] unique makes this idempotent, so a
      // concurrent enqueue cannot double up.
      skipDuplicates: true,
    });
    created += result.count;
  }
  return created;
}

export async function runDeliveryPass(batchSize = 25, now: Date = new Date()): Promise<WorkerResult> {
  const result: WorkerResult = { claimed: 0, delivered: 0, verified: 0, failed: 0, purged: 0, skipped: [] };

  const candidates = await db.recordingDelivery.findMany({
    where: { state: { in: ["PENDING", "FAILED"] }, attempts: { lt: MAX_ATTEMPTS } },
    include: { recording: true, target: true },
    orderBy: { lastAttemptAt: "asc" },
    take: batchSize * 4,
  });

  const due = candidates.filter((c) => isDue(c, now)).slice(0, batchSize);

  for (const row of due) {
    if (!row.target.enabled || !row.target.configEncrypted) {
      result.skipped.push(`${row.id}: target disabled or unconfigured`);
      continue;
    }

    // Claim it. The `state` condition makes this a compare-and-set: if
    // another worker got there first, count is 0 and we move on rather than
    // uploading the same audio twice.
    const claim = await db.recordingDelivery.updateMany({
      where: { id: row.id, state: row.state },
      data: { state: "IN_FLIGHT", lastAttemptAt: new Date() },
    });
    if (claim.count === 0) continue;
    result.claimed++;

    const resolved = resolveRecordingPath(row.tenantId, row.recording.filePath);
    if (!resolved) {
      await db.recordingDelivery.update({
        where: { id: row.id },
        data: {
          state: "FAILED",
          attempts: MAX_ATTEMPTS,
          lastError: `Recording path "${row.recording.filePath}" resolves outside the recordings root — refusing to read it.`,
        },
      });
      result.failed++;
      continue;
    }

    try {
      await stat(resolved.absolute);
    } catch {
      // The file is gone. Permanent: no number of retries brings it back, and
      // continuing to try would mask the real problem.
      await db.recordingDelivery.update({
        where: { id: row.id },
        data: {
          state: "FAILED",
          attempts: MAX_ATTEMPTS,
          lastError: `Local file missing at ${resolved.absolute}.`,
        },
      });
      result.failed++;
      continue;
    }

    const config = decodeTargetConfig(row.target.configEncrypted);
    const transport = createTransport(config);
    const key = remoteObjectKey(
      row.tenantId,
      row.recording.filePath,
      config.kind === "CUSTOMER_S3" ? config.prefix : ""
    );

    try {
      const outcome = await transport.deliver(resolved.absolute, key);
      const next = nextStateAfterAttempt(row, {
        ok: outcome.ok,
        retryable: outcome.error ? isRetryable(outcome.error) : undefined,
      });

      await db.recordingDelivery.update({
        where: { id: row.id },
        data: {
          state: next.state,
          attempts: next.attempts,
          lastError: outcome.error?.message ?? null,
          deliveredAt: outcome.ok ? new Date() : null,
          // verifiedAt is set ONLY on a genuine read-back match. This single
          // assignment is what later authorises deleting the customer's local
          // copy, which is why it is never set from outcome.ok alone.
          verifiedAt: outcome.ok && outcome.verified ? new Date() : null,
        },
      });

      if (outcome.ok) {
        result.delivered++;
        if (outcome.verified) result.verified++;
      } else {
        result.failed++;
      }
    } finally {
      await transport.close();
    }
  }

  result.purged = await runPurgePass();
  return result;
}

/**
 * Deletes local files whose delivered copy has been verified.
 *
 * A separate pass over persisted state, deliberately: a crash between "we
 * verified it" and "we deleted it" then leaves the file present, which is the
 * only safe direction to fail in.
 */
export async function runPurgePass(batchSize = 100): Promise<number> {
  const rows = await db.recordingDelivery.findMany({
    where: { state: "DELIVERED", verifiedAt: { not: null }, purgedAt: null },
    include: { recording: true, target: true },
    take: batchSize,
  });

  let purged = 0;
  for (const row of rows) {
    const verdict = canPurgeLocal(row, row.target);
    if (!verdict.purge) continue;

    const resolved = resolveRecordingPath(row.tenantId, row.recording.filePath);
    if (!resolved) continue;

    try {
      await unlink(resolved.absolute);
    } catch (err) {
      // Already gone counts as purged; anything else leaves the row alone so
      // the next pass tries again rather than claiming a deletion that did
      // not happen.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }

    await db.recordingDelivery.update({ where: { id: row.id }, data: { purgedAt: new Date() } });
    purged++;
  }
  return purged;
}
