// Single source of truth for the tenant workspace domain.
//
// Every tenant's workspace URL is `<slug>.<TENANT_BASE_DOMAIN>`. This value
// is referenced by the provisioning wizard's `allocate_subdomain` step, the
// tenant-detail identity card, the wildcard TLS probe in platform settings,
// and the doc comments on `prisma/schema.prisma`'s Tenant.slug and
// `src/lib/tenant/slug.ts`. It exists as a named constant precisely so that
// changing it is a one-line edit rather than a repo-wide string hunt —
// scattered domain literals are exactly how a half-migrated domain rename
// leaves a tenant pointing at a hostname nobody serves.
//
// Ownership confirmed by the owner (2026-09-05). Note that owning the name
// is not the same as serving it: as of this file's creation there is no
// Caddyfile block, no DNS record, no issued certificate and no environment
// variable for it anywhere in this repo. The wildcard DNS record and the
// wildcard certificate are both genuinely new work.
export const TENANT_BASE_DOMAIN = "algopbx.com";

// The ONE DNS record that has to exist for every tenant workspace to
// resolve. Created manually by the owner, once, grey-cloud (proxying breaks
// the WSS path agents depend on). Provisioning never creates per-tenant DNS
// records and never calls cloudflare.ts's upsertARecord — it only VERIFIES
// that this wildcard resolves, so onboarding a tenant is zero DNS work.
export const WILDCARD_DNS_RECORD = `*.${TENANT_BASE_DOMAIN}`;

// Tenant #1 (us) predates the wildcard and keeps its own custom domain, so
// the host→tenant resolver must handle both shapes from day one — see the
// approved plan §6's migration note. This is the documented exception, not
// a special case to be quietly generalised later.
export const LEGACY_TENANT_ONE_DOMAIN = "saharatechs.com";
export const LEGACY_TENANT_ONE_SLUG = "saharatechs";

/** The workspace hostname for a tenant. Tenant #1 keeps its custom domain;
 * everyone else lives under the wildcard. Pure — no DB, no env. */
export function workspaceHost(slug: string): string {
  if (slug === LEGACY_TENANT_ONE_SLUG) return `pbx.${LEGACY_TENANT_ONE_DOMAIN}`;
  return `${slug}.${TENANT_BASE_DOMAIN}`;
}

/** The full https URL an operator can click from the tenant detail page. */
export function workspaceUrl(slug: string): string {
  return `https://${workspaceHost(slug)}`;
}

/** True when this tenant is the documented custom-domain exception, so the
 * UI can label it rather than silently showing a hostname that doesn't match
 * the pattern every other row follows. */
export function isLegacyCustomDomainTenant(slug: string): boolean {
  return slug === LEGACY_TENANT_ONE_SLUG;
}
