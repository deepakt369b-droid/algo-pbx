// Parses and classifies lines forwarded by the Dinstar gateway's own
// Diagnostic -> Syslog page (NOT the generic Tools -> Remote Server page,
// an unrelated feature with no port/level fields — confirmed live on the
// real device 2026-09-03).
//
// BUILT WITHOUT A REAL CAPTURED SAMPLE. The plan for this feature required
// capturing real Dinstar syslog bytes before writing this parser (the same
// discipline src/lib/cdr-mapper.ts's header wishes it had followed, and the
// same class of bug that broke the WhatsApp deep-link in production despite
// every unit test passing — see LLM.md's account of both). That capture did
// not happen: the gateway's Diagnostic -> Syslog config was confirmed live
// to SAVE and PERSIST through a full reboot (server/port/level all correct,
// Signal/System/Management Log enabled), but zero UDP or TCP traffic was
// ever observed arriving at the VPS — across a reboot, a config re-save, a
// port block/unblock toggle, and a mobile-call-test attempt, checked with
// tcpdump on both a narrow (tailscale0-only) and a wide (any interface,
// TCP+UDP, both candidate ports) capture. The operator's SIM was ejected
// mid-diagnosis, which is what would let a real GSM/call event be tried
// next, and live verification was explicitly deferred rather than forced.
//
// What IS confirmed live: the gateway's own Syslog Level dropdown offers
// exactly EMERG/ALERT/CRIT/ERROR/WARNING/NOTICE/INFO/DEBUG — standard
// syslog severity names — so this parser assumes an RFC-3164-shaped
// `<PRI>TIMESTAMP MESSAGE` line is plausible, without ever having seen one.
//
// THIS PARSER MUST BE RE-VALIDATED AND ITS TAXONOMY WIDENED AGAINST REAL
// GATEWAY OUTPUT before being trusted in production. Until then, treat its
// classification as a best-effort starting point, not a verified contract.
// `raw` is always populated precisely so a wrong or missed classification
// never loses the underlying data — the taxonomy below can be corrected
// retroactively over already-stored rows once real samples exist.

export type GatewaySeverity = "EMERG" | "ALERT" | "CRIT" | "ERROR" | "WARNING" | "NOTICE" | "INFO" | "DEBUG";
export type GatewayCategory = "GSM" | "SIP" | "VPN" | "SYSTEM" | "RAW";

export interface ParsedGatewayEvent {
  deviceTime: Date | null;
  severity: GatewaySeverity;
  category: GatewayCategory;
  eventType: string | null;
  port: number | null;
  message: string;
  raw: string;
}

// Standard syslog PRI-to-severity mapping (RFC 3164 §4.1.1 / RFC 5424):
// PRI = facility*8 + severity, severity 0-7 low-to-high urgency. Only the
// severity half matters here — facility isn't modeled since nothing about
// this feature needs to distinguish syslog facilities.
const PRI_SEVERITY: GatewaySeverity[] = ["EMERG", "ALERT", "CRIT", "ERROR", "WARNING", "NOTICE", "INFO", "DEBUG"];

const PRI_RE = /^<(\d{1,3})>\s*/;

// A loose RFC-3164 "Mmm dd hh:mm:ss" timestamp, or an ISO-ish stand-in —
// deliberately permissive since the real format is unconfirmed. Matched
// only at the very start of what remains after stripping PRI.
const RFC3164_TS_RE = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+/;
const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\s+/;

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseRfc3164Timestamp(raw: string): Date | null {
  const m = raw.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (month === undefined) return null;
  // RFC 3164 carries no year — assume the current year. Wrong only in the
  // few-second window around a year boundary, and deviceTime is display-
  // only (receivedAt is canonical, see the GatewayEvent schema comment),
  // so this approximation is acceptable.
  const now = new Date();
  const d = new Date(now.getFullYear(), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseIsoTimestamp(raw: string): Date | null {
  const d = new Date(raw.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

// A best-effort "which physical port does this line mention" extractor —
// looks for "port N" / "Port N" / "PortN". Conservative: returns null
// rather than guess when no clear marker is present.
const PORT_RE = /\bport\s*#?\s*(\d+)\b/i;

function extractPort(message: string): number | null {
  const m = message.match(PORT_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= 31 ? n : null;
}

interface ClassificationRule {
  test: (lower: string) => boolean;
  category: GatewayCategory;
  eventType: string;
}

// Conservative starting taxonomy (plan §B) — keyword substring match on
// the lowercased message body, checked in order, first match wins. WILL
// need widening once real samples exist; unmatched lines fall through to
// RAW rather than a wrong guess.
const RULES: ClassificationRule[] = [
  {
    test: (s) => s.includes("forbid call") || s.includes("call reject"),
    category: "GSM",
    eventType: "gsm.forbid_call",
  },
  {
    test: (s) => s.includes("sim absent") || s.includes("no sim"),
    category: "GSM",
    eventType: "gsm.sim_absent",
  },
  {
    test: (s) => s.includes("sim pin") || s.includes("pin lock"),
    category: "GSM",
    eventType: "gsm.sim_pin",
  },
  {
    // Checked before the plain "registered" rule below so "unregistered"
    // never matches that rule's substring test.
    test: (s) => s.includes("unregistered") || s.includes("unregister"),
    category: "GSM",
    eventType: "gsm.port_unregistered",
  },
  {
    test: (s) => s.includes("registered") || s.includes("register"),
    category: "GSM",
    eventType: "gsm.port_registered",
  },
  {
    test: (s) => s.includes("sip") && s.includes("unreachable"),
    category: "SIP",
    eventType: "sip.trunk_unreachable",
  },
  {
    test: (s) => s.includes("trunk unreachable"),
    category: "SIP",
    eventType: "sip.trunk_unreachable",
  },
  {
    test: (s) => s.includes("vpn") && (s.includes("down") || s.includes("disconnect")),
    category: "VPN",
    eventType: "vpn.down",
  },
  {
    test: (s) => s.includes("vpn") && (s.includes("up") || s.includes("connect")),
    category: "VPN",
    eventType: "vpn.up",
  },
];

function classify(message: string): { category: GatewayCategory; eventType: string | null } {
  const lower = message.toLowerCase();
  for (const rule of RULES) {
    if (rule.test(lower)) return { category: rule.category, eventType: rule.eventType };
  }
  return { category: "RAW", eventType: null };
}

/** Parses one line forwarded by the gateway's syslog client. Never throws —
 * a malformed, truncated, or entirely non-syslog-shaped line degrades to a
 * best-effort RAW event with `raw` intact rather than being dropped. */
export function parseGatewaySyslogLine(line: string): ParsedGatewayEvent {
  const original = typeof line === "string" ? line : String(line ?? "");
  let rest = original;
  let severity: GatewaySeverity = "INFO";

  const priMatch = rest.match(PRI_RE);
  if (priMatch) {
    const pri = Number(priMatch[1]);
    const sevIndex = pri % 8; // low 3 bits per RFC 3164 §4.1.1
    severity = PRI_SEVERITY[sevIndex] ?? "INFO";
    rest = rest.slice(priMatch[0].length);
  }

  let deviceTime: Date | null = null;
  const rfc3164Match = rest.match(RFC3164_TS_RE);
  if (rfc3164Match) {
    deviceTime = parseRfc3164Timestamp(rfc3164Match[1]);
    rest = rest.slice(rfc3164Match[0].length);
  } else {
    const isoMatch = rest.match(ISO_TS_RE);
    if (isoMatch) {
      deviceTime = parseIsoTimestamp(isoMatch[1]);
      rest = rest.slice(isoMatch[0].length);
    }
  }

  const message = rest.trim();
  const { category, eventType } = classify(message || original);
  const port = extractPort(message || original);

  return {
    deviceTime,
    severity,
    category,
    eventType,
    port,
    message: message || original,
    raw: original,
  };
}
