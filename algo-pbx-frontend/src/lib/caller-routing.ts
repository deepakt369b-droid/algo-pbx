// Caller-ID routing: which rule (if any) applies to an inbound caller number.
// Independently designed (2026-09-14 Tel-Agent gap analysis) — no
// third-party code reused; see prisma/schema.prisma's CallerRoutingRule
// header for the full design rationale.
//
// Pure and DB-free so it's unit-testable without Postgres, and reusable by
// the admin UI for a "which rule would this number hit" preview — the
// AUTHORITATIVE decision at call time is func_odbc.conf's
// [CALLER_ROUTING_ACTION] SQL (`ORDER BY LENGTH(pattern) DESC LIMIT 1`),
// which this function's matching rule is written to agree with exactly:
// longest-prefix-wins, where an exact match is just the degenerate case of
// a full-length "prefix".

export interface CallerRoutingRuleLike {
  pattern: string;
  action: "PASS" | "BLOCK" | "AI";
}

/** True if `pattern` (an E.164 number, or a prefix ending in "*") matches
 * `callerNumber`. Case-insensitive (phone numbers aren't case-sensitive, but
 * a stray "X" placeholder or similar shouldn't silently fail to match). */
function patternMatches(pattern: string, callerNumber: string): boolean {
  const p = pattern.trim().toLowerCase();
  const n = callerNumber.trim().toLowerCase();
  if (p.endsWith("*")) {
    return n.startsWith(p.slice(0, -1));
  }
  return n === p;
}

/** The rule that applies to `callerNumber`, or null if none do. When more
 * than one rule matches (e.g. "+9715*" and "+971501234567" both match the
 * same number), the LONGEST pattern wins — the most specific rule an admin
 * wrote is the one that governs, same convention this schema already uses
 * elsewhere (dialplan ODBC lookups). Ties (same length) are broken by
 * whichever comes first in `rules`, since two rules of equal length matching
 * the same number is already prevented by the DB's tenant+pattern unique
 * constraint for identical patterns, and a genuine same-length ambiguity
 * (e.g. two different 8-char prefixes) is rare enough not to warrant a
 * documented tie-break rule of its own. */
export function matchCallerRule<T extends CallerRoutingRuleLike>(callerNumber: string, rules: readonly T[]): T | null {
  let best: T | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, callerNumber)) continue;
    if (!best || rule.pattern.length > best.pattern.length) {
      best = rule;
    }
  }
  return best;
}
