// Pure decision logic for per-extension geo allocation + lock (plan §3.3,
// node W4). Deliberately has ZERO Prisma/DB/fs/network imports — same
// "extract the pure decision, keep the side effect thin" discipline as
// src/lib/tenancy/scope-rules.ts, so this module is fully unit-testable
// (geo-decision.test.ts) without a live Postgres connection or a real
// mmdb file. The caller (W5's src/lib/geo/enforce.ts) is responsible for:
//   - resolving the mmdb lookup (or reporting dbAvailable: false),
//   - persisting geoFailedAttempts/geoLockedAt/geoLoginEvent rows,
//   - deciding the actual HTTP response / cookie based on this output.
//
// ONE KNOWN LIMITATION (documented here so nobody "fixes" it into a false
// sense of security): a country check alone is defeated by exactly the
// case it targets — an agent physically in Pakistan running a VPN that
// exits in India presents an Indian IP and passes. The datacenter-ASN
// check (below, gated by Tenant.geoBlockVpn) is the only IP-based signal
// that closes part of that hole; a residential-proxy VPN defeats both.
// Built as specified, with the toggle available when the owner wants it.

import { isDatacenterAsn } from "./datacenter-asns";

export type GeoLookup = {
  country: string | null;
  asn: number | null;
  asnOrg: string | null;
};

export type GeoDecisionInput = {
  ip: string;
  lookup: GeoLookup | null;
  dbAvailable: boolean;
  allowedCountries: string[];
  tenantDefaultCountry: string | null;
  mode: "off" | "monitor" | "enforce" | null;
  blockVpn: boolean;
  currentAttempts: number;
  threshold: number;
  alreadyLocked: boolean;
};

export type GeoOutcome =
  | "allowed"
  | "wrong_country"
  | "vpn_suspected"
  | "unknown_ip"
  | "db_unavailable"
  | "monitor_only";

export type GeoDecision = {
  outcome: GeoOutcome;
  allowed: boolean;
  shouldCount: boolean;
  shouldLock: boolean;
  shouldResetCounter: boolean;
  remainingAttempts: number | null;
  agentMessage: string | null;
};

// ---------------------------------------------------------------------
// IP exemption — fail OPEN for unknown/private/CGNAT addresses. Hand-
// rolled prefix checks on purpose: this repo has no CIDR-matching
// dependency and the exemption list is small and fixed (plan §3.3), so
// pulling in a library for it would be unjustified extra surface.
// ---------------------------------------------------------------------

function extractIPv4(ip: string): string | null {
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return ip;
  return null;
}

/**
 * True for: `"unknown"` (getClientIp()'s own sentinel for "could not
 * determine"), IPv6 loopback (`::1`), and the IPv4 ranges 127.0.0.0/8,
 * 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, and 100.64.0.0/10 — the
 * CGNAT range this stack's own OpenVPN/Headscale/Tailscale overlay uses
 * (locking an agent for reaching the app over the site's own VPN tunnel
 * would be self-inflicted). Anything else (including IPv6 addresses other
 * than `::1`, which this stack does not currently assign to agents) is
 * NOT exempt.
 */
export function isExemptIp(ip: string): boolean {
  if (!ip || ip === "unknown") return true;
  if (ip === "::1") return true;

  const v4 = extractIPv4(ip);
  if (!v4) return false;

  const octets = v4.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;

  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

// ---------------------------------------------------------------------
// Human-readable messaging. The agent has already proven password + 2FA
// by the time they see this (plan §3.3, W6), so there is no enumeration
// risk left to protect against — the message is deliberately specific.
// ---------------------------------------------------------------------

const COUNTRY_NAMES: Record<string, string> = {
  IN: "India",
  PK: "Pakistan",
  AE: "the United Arab Emirates",
  US: "the United States",
  GB: "the United Kingdom",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  FR: "France",
  NL: "the Netherlands",
  SG: "Singapore",
  BD: "Bangladesh",
  LK: "Sri Lanka",
  NP: "Nepal",
  SA: "Saudi Arabia",
  QA: "Qatar",
  OM: "Oman",
  KW: "Kuwait",
  BH: "Bahrain",
  RU: "Russia",
  CN: "China",
  NG: "Nigeria",
  PH: "the Philippines",
};

function countryLabel(code: string | null): string {
  if (!code) return "an unrecognized location";
  return COUNTRY_NAMES[code] ?? code;
}

function allowedLabel(allowedSet: string[]): string {
  const labels = allowedSet.map(countryLabel);
  if (labels.length === 0) return "an unconfigured location";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

const LOCKED_MESSAGE =
  "This extension is locked after repeated sign-ins from an unexpected location or network. Contact your administrator to request an unlock.";

function wrongCountryMessage(allowedSet: string[], actual: string | null, remaining: number): string {
  return (
    `Extension is allocated to ${allowedLabel(allowedSet)} and this connection appears to be from ` +
    `${countryLabel(actual)}. ${remaining} attempt${remaining === 1 ? "" : "s"} remain before the extension is locked.`
  );
}

function vpnSuspectedMessage(remaining: number): string {
  return (
    `Sign-in from a hosting or VPN provider is not permitted for this extension. ` +
    `${remaining} attempt${remaining === 1 ? "" : "s"} remain before the extension is locked.`
  );
}

// ---------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------

type UnderlyingKind = "allowed" | "wrong_country" | "vpn_suspected";

function resolveAllowedSet(allowedCountries: string[], tenantDefaultCountry: string | null): string[] {
  if (allowedCountries.length > 0) return allowedCountries;
  return tenantDefaultCountry ? [tenantDefaultCountry] : [];
}

/**
 * The country/VPN check alone, ignoring mode and lock state — shared by
 * both the enforce and monitor branches below so "what would have
 * happened" (monitor) and "what actually happens" (enforce) can never
 * drift apart.
 */
function evaluateUnderlying(
  lookup: GeoLookup,
  allowedSet: string[],
  blockVpn: boolean
): { kind: UnderlyingKind } {
  if (blockVpn && lookup.asn != null && isDatacenterAsn(lookup.asn)) {
    return { kind: "vpn_suspected" };
  }
  if (!lookup.country || !allowedSet.includes(lookup.country)) {
    return { kind: "wrong_country" };
  }
  return { kind: "allowed" };
}

export function evaluateGeoAccess(input: GeoDecisionInput): GeoDecision {
  const {
    ip,
    lookup,
    dbAvailable,
    allowedCountries,
    tenantDefaultCountry,
    mode,
    blockVpn,
    currentAttempts,
    threshold,
    alreadyLocked,
  } = input;

  const allowNoCount = (outcome: GeoOutcome): GeoDecision => ({
    outcome,
    allowed: true,
    shouldCount: false,
    shouldLock: false,
    shouldResetCounter: false,
    remainingAttempts: null,
    agentMessage: null,
  });

  // (1) Geo lock is off/unconfigured at the tenant level.
  if (mode === "off" || mode === null || mode === undefined) {
    return allowNoCount("allowed");
  }

  // (2) Fail open for unknown/private/CGNAT source addresses.
  if (isExemptIp(ip)) {
    return allowNoCount("unknown_ip");
  }

  // (3) Fail open if the geo database is unavailable or produced no
  // lookup (e.g. corrupt/missing mmdb — see enforce.ts's loud-failure
  // path, which still records an AuditLog + attention-queue item even
  // though this function allows).
  if (!dbAvailable || !lookup) {
    return allowNoCount("db_unavailable");
  }

  const allowedSet = resolveAllowedSet(allowedCountries, tenantDefaultCountry);

  // (4) Nothing configured to check against — never enforce.
  if (allowedSet.length === 0) {
    return allowNoCount("allowed");
  }

  // Monitor mode: allow always, but evaluate + report what enforce mode
  // would have done, so the owner can review GeoLoginEvent rows before
  // flipping to enforce. Deliberately ignores `alreadyLocked` — a lock is
  // an enforcement-mode side effect, and "allow always" in monitor mode
  // means always, including for an extension a prior enforce run locked.
  if (mode === "monitor") {
    const underlying = evaluateUnderlying(lookup, allowedSet, blockVpn);
    if (underlying.kind === "allowed") {
      return {
        outcome: "allowed",
        allowed: true,
        shouldCount: false,
        shouldLock: false,
        shouldResetCounter: true,
        remainingAttempts: null,
        agentMessage: null,
      };
    }
    return {
      outcome: "monitor_only",
      allowed: true,
      shouldCount: false,
      shouldLock: false,
      shouldResetCounter: false,
      remainingAttempts: null,
      agentMessage: null,
    };
  }

  // mode === "enforce" from here down.

  // (5) Already locked: the counter is frozen — no further counting no
  // matter what this attempt's country/ASN looks like, and the lock is
  // never cleared by a login, only by an explicit unlock. `outcome` is
  // set to whatever the underlying check says caused it (or falls back
  // to "wrong_country" as the representative reason if this particular
  // attempt would otherwise have passed — the extension is still locked
  // regardless; callers must gate on `allowed`, not on `outcome`).
  if (alreadyLocked) {
    const underlying = evaluateUnderlying(lookup, allowedSet, blockVpn);
    return {
      outcome: underlying.kind === "allowed" ? "wrong_country" : underlying.kind,
      allowed: false,
      shouldCount: false,
      shouldLock: false,
      shouldResetCounter: false,
      remainingAttempts: 0,
      agentMessage: LOCKED_MESSAGE,
    };
  }

  const underlying = evaluateUnderlying(lookup, allowedSet, blockVpn);

  // (9) Clean pass: allow and reset the strike counter.
  if (underlying.kind === "allowed") {
    return {
      outcome: "allowed",
      allowed: true,
      shouldCount: false,
      shouldLock: false,
      shouldResetCounter: true,
      remainingAttempts: null,
      agentMessage: null,
    };
  }

  // (7)/(8) A strike: country mismatch, or (only when geoBlockVpn is on)
  // a datacenter/VPN ASN.
  const newAttempts = currentAttempts + 1;
  const shouldLock = newAttempts >= threshold;
  const remainingAttempts = shouldLock ? 0 : threshold - newAttempts;

  const agentMessage = shouldLock
    ? LOCKED_MESSAGE
    : underlying.kind === "vpn_suspected"
      ? vpnSuspectedMessage(remainingAttempts)
      : wrongCountryMessage(allowedSet, lookup.country, remainingAttempts);

  return {
    outcome: underlying.kind,
    allowed: false,
    shouldCount: true,
    shouldLock,
    shouldResetCounter: false,
    remainingAttempts,
    agentMessage,
  };
}
