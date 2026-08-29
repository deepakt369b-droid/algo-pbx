// Pure mapping from an Asterisk AMI `Cdr` event to the POST /api/cdr
// ingestion contract (src/app/api/cdr/route.ts's CdrIngestSchema). Extracted
// as a standalone function, independent of the AMI connection, specifically
// so it's unit-testable without a live Asterisk or a socket — the whole
// point of the CDR listener process (scripts/ami-cdr-listener.mjs) is that
// it CANNOT be exercised any other way in an environment with no live infra.
//
// Verified live against production 2026-08-29 (real calls, real Cdr events
// read off `docker exec algo-postgres psql` rows and the listener's own
// logs) after the header comment's own "UNVERIFIED against a live capture"
// caveat turned out to hide two real bugs:
//
// 1. There is NO `Context` field on a `Cdr` event — `dcontext` (the
//    dialplan's own name for it) is serialized as `DestinationContext`.
//    `sourceContext` must be read from that field, never from `Context`
//    (see ami-cdr-listener.ts). Reading a field that doesn't exist made
//    `inferDirection` fall through to `"internal"` on 100% of calls,
//    inbound and outbound alike — confirmed on production rows.
// 2. `agentExtension` was never assigned anywhere in this file. It is
//    derived below from the channel name Asterisk puts on the event
//    (`PJSIP/1002-00000123` -> `1002`) — `Channel` for a call the agent
//    ORIGINATED (outbound/internal), `DestinationChannel` for one the agent
//    ANSWERED (inbound, after the queue bridge).
//
// `callerNumber` also used to prefer `CallerID` over `Source`. `CallerID` is
// the full display form (`"Algo Call Center" <1002>`, per
// extensions.conf's `Set(CALLERID(name)=...)`), which is what production
// rows showed stored verbatim — breaking every downstream contact-name
// match. `Source` (the CDR `src` field) is the bare number and is preferred
// now, with `CallerID` parsed as a fallback only.

export interface AmiCdrEvent {
  Event?: string;
  UniqueID?: string;
  LinkedID?: string;
  Source?: string;
  Destination?: string;
  DestinationContext?: string;
  Channel?: string;
  DestinationChannel?: string;
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
 * `from-dinstar` → inbound, `from-agent-*` → outbound, anything else
 * (internal extension-to-extension dialing) → internal. This mirrors the
 * contexts defined there — if that dialplan is restructured, this mapping
 * must move with it (as it just did for Loop C2's dial-permission split).
 *
 * A `startsWith` match, not an exact one, deliberately covers BOTH
 * possibilities left open by Loop C2's `Goto(from-agent-common,...)`
 * indirection (see extensions.conf): whether Asterisk's Cdr event reports
 * the tier context an agent's endpoint actually dialed from
 * (`from-agent-local`/`-national`/`-international`) or the shared handler
 * context execution lands in after the Goto (`from-agent-common`) is
 * unverified against a live capture — same "probable, not proven"
 * confidence tier as the rest of this file's Cdr field assumptions.
 */
function inferDirection(sourceContext: string | undefined): "inbound" | "outbound" | "internal" {
  if (sourceContext === "from-dinstar") return "inbound";
  if (sourceContext?.startsWith("from-agent")) return "outbound";
  return "internal";
}

// Matches the endpoint-name portion of a PJSIP channel name, e.g.
// "PJSIP/1002-00000123" -> "1002". Endpoint names are the extension numbers
// themselves (src/lib/pjsip-config.ts provisions `[1002]` etc.), so this is
// the extension, not an opaque channel id.
const PJSIP_CHANNEL_PATTERN = /^PJSIP\/(\d{3,6})-/;

function extractExtension(channel: string | undefined): string | undefined {
  return channel?.match(PJSIP_CHANNEL_PATTERN)?.[1];
}

/** Which channel actually names the agent's extension depends on direction:
 * for an outbound/internal call the agent ORIGINATED it, so their extension
 * is on `Channel`; for an inbound call the agent ANSWERED it after the
 * `[from-dinstar]` -> Queue() bridge, so their extension is on
 * `DestinationChannel` (the leg Asterisk dialed out to reach them).
 * `Channel`/`DestinationChannel` are always PJSIP for this deployment (no
 * other endpoint technology is provisioned), so a non-matching value simply
 * yields undefined rather than a wrong extension. */
function extractAgentExtension(
  event: Pick<AmiCdrEvent, "Channel" | "DestinationChannel">,
  direction: "inbound" | "outbound" | "internal"
): string | undefined {
  if (direction === "inbound") return extractExtension(event.DestinationChannel);
  return extractExtension(event.Channel) ?? extractExtension(event.DestinationChannel);
}

/** `CallerID` is the full display-name form Asterisk builds from
 * CALLERID(name)/CALLERID(num) (e.g. `"Algo Call Center" <1002>`), not a
 * bare number — extensions.conf sets that name on every agent-originated
 * call. `Source` (CDR `src`) is the bare number and is always preferred;
 * this only parses `CallerID` as a fallback for the rare event missing
 * `Source` entirely. */
function extractCallerNumber(event: Pick<AmiCdrEvent, "Source" | "CallerID">): string {
  if (event.Source) return event.Source;
  const angleMatch = event.CallerID?.match(/<([^>]+)>/);
  return angleMatch?.[1] ?? event.CallerID ?? "unknown";
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

  const direction = inferDirection(opts.sourceContext);

  const payload: CdrIngestPayload = {
    uniqueId,
    callerNumber: extractCallerNumber(event),
    destination: event.Destination ?? "unknown",
    direction,
    disposition: event.Disposition ?? "UNKNOWN",
    startedAt,
    durationSec: Number(event.Duration ?? 0),
    billsecSec: Number(event.BillableSeconds ?? 0),
  };

  const agentExtension = extractAgentExtension(event, direction);
  if (agentExtension) payload.agentExtension = agentExtension;

  const answeredAt = toIso(event.AnswerTime);
  if (answeredAt) payload.answeredAt = answeredAt;

  const endedAt = toIso(event.EndTime);
  if (endedAt) payload.endedAt = endedAt;

  if (opts.recordingUrlBase) payload.recordingUrl = `${opts.recordingUrlBase}/${uniqueId}`;

  return payload;
}
