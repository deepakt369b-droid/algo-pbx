// Which just-ingested Dinstar gateway events (see api/gateway-events's
// ingest route) are alert-worthy, and the DB-free half of the per-type
// email rate limit. Pure functions, no Prisma import — same
// unit-testable-without-a-database convention as contact-ownership.ts and
// deal-ownership.ts.
//
// KNOWN SIMPLIFICATION (first version — see the plan's "a first version of
// that pipeline" framing): the plan describes threshold rules ("FORBID
// CALL burst", "port unregistered > 5 min") that need cross-request
// historical state this per-batch detector doesn't have. This version
// alerts on the FIRST occurrence of each critical event type within an
// ingest batch rather than waiting for a burst/duration threshold — safer
// to over-notify than under-notify before real event volume from the
// gateway is understood, and the thresholds can be tightened once it is.

export type CriticalAlertType = "gsm.forbid_call" | "gsm.port_unregistered" | "sip.trunk_unreachable";

// Exported (not just the Set below) so /api/admin/gateway-alerts' "active
// alerts" query can filter on the same list without a second hardcoded copy
// silently drifting from this one if the taxonomy is ever widened.
export const CRITICAL_ALERT_TYPES: readonly CriticalAlertType[] = [
  "gsm.forbid_call",
  "gsm.port_unregistered",
  "sip.trunk_unreachable",
];

const CRITICAL_TYPES: ReadonlySet<string> = new Set<CriticalAlertType>(CRITICAL_ALERT_TYPES);

export interface IngestedEventForAlerting {
  eventType: string | null;
  port: number | null;
  message: string;
}

/** Every distinct critical alert type present in a just-ingested batch,
 * each paired with the first matching event (for the alert's message/port
 * context). Order follows first occurrence in the batch. */
export function detectCriticalAlerts(
  events: IngestedEventForAlerting[]
): { type: CriticalAlertType; event: IngestedEventForAlerting }[] {
  const seen = new Set<string>();
  const result: { type: CriticalAlertType; event: IngestedEventForAlerting }[] = [];
  for (const event of events) {
    if (!event.eventType || !CRITICAL_TYPES.has(event.eventType) || seen.has(event.eventType)) continue;
    seen.add(event.eventType);
    result.push({ type: event.eventType as CriticalAlertType, event });
  }
  return result;
}

// getSetting("RESEND_API_KEY") resolves the literal string "change-me" as a
// truthy, non-empty value when the .env placeholder has never been rotated
// (confirmed live on this deployment — see handoff.md) — Boolean(value)
// alone would treat that as "configured" and attempt a real Resend API call
// that can only fail. Narrow, named check so the ingest route's
// resendConfigured gate actually matches the plan's "ship in-app alerts
// only, record blocked-on-secret" requirement instead of silently sending
// one doomed HTTP request per critical alert type.
export function isConfiguredSecret(value: string | undefined): boolean {
  return Boolean(value) && value !== "change-me";
}

export const ALERT_RATE_LIMIT_MS = 15 * 60 * 1000;

/** True if enough time has passed since the last alert of this type to
 * send another one. `lastSentAt` is null when no prior alert is on
 * record. Pure — the caller looks up lastSentAt (from AuditLog, see the
 * ingest route) and `now` is injectable for tests. */
export function isAlertDue(lastSentAt: Date | null, now: Date = new Date()): boolean {
  if (!lastSentAt) return true;
  return now.getTime() - lastSentAt.getTime() >= ALERT_RATE_LIMIT_MS;
}
