// Tenant slug validation — multi-tenant SaaS foundation, wave 1 (plan §1/§4).
//
// A tenant's slug becomes THREE identifiers at once, each with its own
// constraint, so this validator enforces the intersection of all three:
//   1. A DNS label under the wildcard cert: <slug>.algopbx.com (plan §6).
//      DNS labels are lowercase-safe, digit/hyphen allowed, max 63 chars,
//      may not start or end with a hyphen.
//   2. The Postgres-unique Tenant.slug column (uniqueness enforced by the
//      DB, not here — this module only checks FORMAT).
//   3. The OpenVPN GatewaySite.name / ccd/ filename / cert CN, built as
//      `cust-<slug>-gw-1` (plan §4), which MUST satisfy bridge-watch.sh's
//      SAFE_NAME_RE: ^[A-Za-z0-9_-]{1,64}$. Our lowercase-alnum-hyphen
//      charset is already a strict subset of that, so satisfying (1) and a
//      length cap automatically satisfies (3) too.
//
// Reserved words (plan §1): this plan itself creates /platform, whose
// natural address is platform.algopbx.com — a tenant registering the slug
// "platform" would collide with our own owner console. Same reasoning for
// every other platform-level or infrastructure hostname below.
//
// Treat this list as APPEND-ONLY — add to it before shipping any new
// platform-level hostname, never remove an entry after the fact (plan §1).
export const RESERVED_TENANT_SLUGS: readonly string[] = [
  "platform",
  "api",
  "www",
  "admin",
  "app",
  "status",
  "mail",
  "support",
  "auth",
  "billing",
];

const RESERVED_SET = new Set(RESERVED_TENANT_SLUGS);

// Lowercase letters, digits, hyphens only — a strict subset of both a DNS
// label's charset and bridge-watch.sh's SAFE_NAME_RE. No leading/trailing
// hyphen (DNS labels forbid it), max 63 chars (the DNS label limit, tighter
// than SAFE_NAME_RE's 64).
const SLUG_CHARSET_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type SlugValidationResult =
  | { ok: true; slug: string }
  | { ok: false; error: string };

/** Validates a candidate tenant slug's FORMAT (not its uniqueness — that is
 * a DB check, done by the caller against Tenant.slug). Never throws. */
export function validateTenantSlug(input: string): SlugValidationResult {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "Slug is required." };
  }

  // Case is significant to the check below (reserved words + charset are
  // both lowercase-only) — surface a clear, distinct error for "would be
  // valid if lowercased" rather than lumping it in with "bad characters".
  if (input !== input.toLowerCase()) {
    return { ok: false, error: "Slug must be lowercase." };
  }

  if (input.length > 63) {
    return { ok: false, error: "Slug must be 63 characters or fewer (DNS label limit)." };
  }

  if (!SLUG_CHARSET_RE.test(input)) {
    return {
      ok: false,
      error:
        "Slug must contain only lowercase letters, digits, and hyphens, and may not start or end with a hyphen.",
    };
  }

  if (RESERVED_SET.has(input)) {
    return { ok: false, error: `"${input}" is a reserved slug and cannot be used by a tenant.` };
  }

  return { ok: true, slug: input };
}

/** Convenience boolean wrapper for call sites that just need a yes/no
 * (e.g. a form's live-validate-as-you-type state). */
export function isValidTenantSlug(input: string): boolean {
  return validateTenantSlug(input).ok;
}
