// Loop D2 — pure retention-decision logic, kept separate from the
// prune route's actual DB queries/filesystem walk (neither of which are
// exercisable without a live Postgres/spool in this environment, same
// constraint as every other route in this repo) so the one piece that
// CAN be tested actually is.

/** True once `createdAt` is older than `retentionDays`, measured from
 * `now`. `retentionDays <= 0` means retention is disabled — nothing is
 * ever expired, matching RECORDING_RETENTION_DAYS's own "0 disables
 * pruning entirely" documented behavior. */
export function isExpired(createdAt: Date, retentionDays: number, now: Date = new Date()): boolean {
  if (retentionDays <= 0) return false;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return createdAt.getTime() < cutoff;
}
