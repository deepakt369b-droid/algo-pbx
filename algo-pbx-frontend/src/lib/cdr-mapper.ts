// Pure mapping from an Asterisk AMI `Cdr` event to the POST /api/cdr
// ingestion contract (src/app/api/cdr/route.ts's CdrIngestSchema). Extracted
// as a standalone function, independent of the AMI connection, specifically
// so it's unit-testable without a live Asterisk or a socket — the whole
// point of the CDR listener process (scripts/ami-cdr-listener.mjs) is that
// it CANNOT be exercised any other way in an environment with no live infra.
//
// Field names below (UniqueID, LinkedID, Source, Destination, CallerID,
// StartTime, AnswerTime, EndTime, Duration, BillableSeconds, Disposition)
// are Asterisk's conventional Cdr-event field names, consistent with
// manager.conf's `read = cdr` class — NOT verified against a live capture.
// Treat as probable-not-proven until checked against a real Asterisk 20 Cdr
// event.

export interface AmiCdrEvent {
  Event?: string;
  UniqueID?: string;
  LinkedID?: string;
  Source?: string;
  Destination?: string;
  CallerID?: string;
  Disposition?: string;
  StartTime?: string;
  AnswerTime?: string;
  EndTime?: string;
  Duration?: string;
  BillableSeconds?: string;
  [key: string]: string | undefined;
}

export interface CdrIngestPayload {
  uniqueId: string;
  callerNumber: string;
  destination: string;
  direction: "inbound" | "outbound" | "internal";
  disposition: string;
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  durationSec: number;
  billsecSec: number;
  recordingUrl?: string;
  agentExtension?: string;
}

/**
 * Direction is inferred from the destination context's dialplan naming
 * convention already established in pbx_configs/extensions.conf:
 * `from-dinstar` → inbound, `from-agent` → outbound, anything else (internal
 * extension-to-extension dialing) → internal. This mirrors the contexts
 * defined there — if that dialplan is restructured, this mapping must move
 * with it.
 */
function inferDirection(sourceContext: string | undefined): "inbound" | "outbound" | "internal" {
  if (sourceContext === "from-dinstar") return "inbound";
  if (sourceContext === "from-agent") return "outbound";
  return "internal";
}

/** Asterisk's Cdr `StartTime`/`AnswerTime`/`EndTime` are typically
 * `YYYY-MM-DD HH:MM:SS` (space-separated, no timezone) — convert to an ISO
 * string `Date` can parse unambiguously across the wire to the ingestion
 * route's `z.coerce.date()`. */
function toIso(asteriskTimestamp: string | undefined): string | undefined {
  if (!asteriskTimestamp) return undefined;
  const isoish = asteriskTimestamp.trim().replace(" ", "T");
  const date = new Date(isoish);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function mapCdrEventToIngestPayload(
  event: AmiCdrEvent,
  opts: { sourceContext?: string; recordingUrlBase?: string } = {}
): CdrIngestPayload | null {
  const uniqueId = event.UniqueID;
  const startedAt = toIso(event.StartTime);
  if (!uniqueId || !startedAt) return null; // can't ingest a row with no key or no start time

  const payload: CdrIngestPayload = {
    uniqueId,
    callerNumber: event.CallerID ?? event.Source ?? "unknown",
    destination: event.Destination ?? "unknown",
    direction: inferDirection(opts.sourceContext),
    disposition: event.Disposition ?? "UNKNOWN",
    startedAt,
    durationSec: Number(event.Duration ?? 0),
    billsecSec: Number(event.BillableSeconds ?? 0),
  };

  const answeredAt = toIso(event.AnswerTime);
  if (answeredAt) payload.answeredAt = answeredAt;

  const endedAt = toIso(event.EndTime);
  if (endedAt) payload.endedAt = endedAt;

  if (opts.recordingUrlBase) payload.recordingUrl = `${opts.recordingUrlBase}/${uniqueId}`;

  return payload;
}
