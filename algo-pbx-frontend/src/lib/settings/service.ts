import { unsafeGlobalDb } from "@/lib/db";
import { decryptSetting, encryptSetting } from "./crypto";
import { getSettingDef } from "./schema";

// Runtime settings resolution: database row -> process.env[envFallback]
// -> registry default -> undefined. This is what lets every provider
// (Resend, OpenWA, Meta Cloud, Dinstar, Firebase, CRM webhooks) become
// admin-configurable from /admin/settings without breaking an existing
// .env-based deployment that has never opened that page — the env value
// keeps working exactly as before until a DB row exists to override it.
//
// Wave 2a multi-tenant migration: AppSetting is the one model
// `src/lib/tenancy/scope-rules.ts` calls out as NULLABLE_TENANT_MODELS —
// `tenantId = null` is a PLATFORM DEFAULT row, a real tenantId is that
// tenant's override (see that file's header comment for the full design,
// and the plan's §7 "AppSetting" gap-analysis entry). This file is where the
// PRECEDENCE half of that design lives (scope-rules.ts's Prisma extension
// deliberately does not attempt it — a WHERE clause can't express "prefer
// row A over row B"): every exported function here now takes an OPTIONAL
// `tenantId` parameter and, when given one, resolves the tenant's own
// override row before falling back to the platform default row.
//
// Deliberately NOT converted to take a `TenantClient` (src/lib/db-tenant.ts)
// the way the DI-treated files in this wave were: getSetting()/setSetting()
// have on the order of 40 call sites across the codebase, most of which
// pass no tenant context at all today (platform-global settings — OpenWA,
// Firebase, Cloudflare — and call sites that haven't been swept for tenant
// awareness yet). Making `tenantId` OPTIONAL and reading via
// `unsafeGlobalDb` (by its real, loud name — a deliberate, reviewed
// exception per plan §2, not a silent bypass) keeps every one of those
// existing call sites compiling unchanged and behaving EXACTLY as before
// (today's rows all have `tenantId = null`, i.e. "platform default", so an
// omitted `tenantId` argument resolves precisely the row it always did).
// Callers that DO know their tenant (future wave, once route handlers are
// swept to pass `session.user.tenantId` through) get real per-tenant
// override behavior for free by passing it.
const cache = new Map<string, string | undefined>();

const DISABLE_SETTINGS_CACHE = process.env.DISABLE_SETTINGS_CACHE === "true";
if (process.env.NODE_ENV === "production" && !DISABLE_SETTINGS_CACHE) {
  console.warn(
    "settings/service: in-process settings cache is active. This is safe for a single 'web' replica, " +
      "but will stale across multiple replicas. Set DISABLE_SETTINGS_CACHE=true or move the cache to a shared store (e.g. Redis) before scaling horizontally."
  );
}

// Cache key must include tenantId (plan §8 "Settings cache" gap-analysis
// entry) — otherwise tenant A's override would be served to tenant B's
// request for the same key once cached.
function cacheKey(key: string, tenantId: string | null): string {
  return `${tenantId ?? "platform"}:${key}`;
}

/** Reads the tenant's own override row, falling back to the platform
 * default row (`tenantId IS NULL`) when there is no tenant override, or no
 * `tenantId` was given at all.
 *
 * Deliberately `findFirst`/`findUnique`-by-compound-key are NOT used for the
 * platform-default half: Prisma's generated `AppSettingTenantIdKeyCompoundUniqueInput`
 * types `tenantId` as a plain `string`, not `string | null` — a
 * `findUnique` can never search a compound unique with a null component
 * (Postgres's own NULL != NULL semantics mean a unique index doesn't
 * enforce, or let you look up, "the row with this NULL" the way it does for
 * a real value), which Prisma's types correctly refuse to let you try. The
 * tenant-override half DOES use the real compound-unique `findUnique`
 * (tenantId is always a real string there). Both are `unsafeGlobalDb` calls
 * addressed by hand — deliberately NOT auto-injected by a `TenantClient`
 * extension (scope-rules.ts's NULLABLE_TENANT_MODELS doc comment, point 2:
 * a unique-key lookup already spells out exactly which row it wants). */
async function findSettingRow(key: string, tenantId: string | null) {
  if (tenantId) {
    const tenantRow = await unsafeGlobalDb.appSetting.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });
    if (tenantRow) return tenantRow;
  }
  return unsafeGlobalDb.appSetting.findFirst({ where: { tenantId: null, key } });
}

export async function getSetting(key: string, tenantId: string | null = null): Promise<string | undefined> {
  const ck = cacheKey(key, tenantId);
  if (!DISABLE_SETTINGS_CACHE && cache.has(ck)) return cache.get(ck);

  const row = await findSettingRow(key, tenantId);
  if (row) {
    const value = decryptSetting(row.valueEncrypted);
    if (!DISABLE_SETTINGS_CACHE) cache.set(ck, value);
    return value;
  }

  const def = getSettingDef(key);
  const value = (def?.envFallback ? process.env[def.envFallback] : undefined) ?? def?.default;
  if (!DISABLE_SETTINGS_CACHE) cache.set(ck, value);
  return value;
}

/** Throws if the resolved value is missing — for call sites that have no
 * sensible fallback behavior (e.g. a provider that simply cannot send
 * anything without a key). Mirrors the fail-loud pattern already used by
 * src/lib/mail/resend.ts and src/lib/firebase/admin.ts before this
 * change, now generalized. */
export async function requireSetting(key: string, tenantId: string | null = null): Promise<string> {
  const value = await getSetting(key, tenantId);
  if (!value) {
    const def = getSettingDef(key);
    throw new Error(`Setting "${key}" (${def?.label ?? key}) is not configured. Set it in /admin/settings.`);
  }
  return value;
}

/** Writes the platform default row (`tenantId: null`) by default, or the
 * given tenant's own override row when `tenantId` is passed — never a
 * platform-default row on a tenant-scoped call (AppSetting's
 * NULLABLE_TENANT_MODELS write rule: a tenant may only ever create/modify
 * its OWN override, mirrored here by hand since this file bypasses the
 * `TenantClient` extension that would otherwise enforce it). */
export async function setSetting(
  key: string,
  value: string,
  updatedById: string,
  tenantId: string | null = null
): Promise<void> {
  // Loop E2: trim leading/trailing whitespace. A pasted API token
  // (Cloudflare, Resend, …) routinely picks up a trailing newline from a
  // copy, which then goes straight into an `Authorization: Bearer <token>`
  // header and is rejected by the provider with an opaque 401 — the
  // reported "Cloudflare rejected this token" with a valid key. Secrets in
  // this app are all single-token / single-value; none legitimately have
  // edge whitespace.
  const valueEncrypted = encryptSetting(value.trim());
  if (tenantId) {
    // Real tenantId: the compound unique is directly usable.
    await unsafeGlobalDb.appSetting.upsert({
      where: { tenantId_key: { tenantId, key } },
      create: { tenantId, key, valueEncrypted, updatedById },
      update: { valueEncrypted, updatedById },
    });
  } else {
    // Platform-default row (tenantId: null): the compound unique can't
    // express a null component (see findSettingRow()'s comment), so this
    // is a plain find-then-create/update instead of an atomic upsert. A
    // lost create-vs-create race here (two admins saving the same
    // platform-global key at the exact same instant) is a rare, low-stakes
    // edge case — the loser's write would hit a real unique-constraint
    // violation, which is safe to surface as a failed save and retry,
    // exactly as an upsert's own failure mode would be.
    const existing = await unsafeGlobalDb.appSetting.findFirst({ where: { tenantId: null, key } });
    if (existing) {
      await unsafeGlobalDb.appSetting.update({ where: { id: existing.id }, data: { valueEncrypted, updatedById } });
    } else {
      await unsafeGlobalDb.appSetting.create({ data: { tenantId: null, key, valueEncrypted, updatedById } });
    }
  }
  cache.delete(cacheKey(key, tenantId));
  invalidateResetHooks(key);
}

/** True only if a DB row exists for this key — distinct from getSetting()
 * returning a value, since that can come from an env fallback or default
 * with no row present at all. Used by the settings UI to show "using
 * environment default" vs. "configured" per field. */
export async function hasSettingRow(key: string, tenantId: string | null = null): Promise<boolean> {
  const row = await findSettingRow(key, tenantId);
  return Boolean(row);
}

export async function getSettingMeta(
  key: string,
  tenantId: string | null = null
): Promise<{ hasValue: boolean; lastFour: string | null; updatedAt: Date | null }> {
  const row = await findSettingRow(key, tenantId);
  if (!row) {
    const value = await getSetting(key, tenantId);
    return { hasValue: Boolean(value), lastFour: null, updatedAt: null };
  }
  const value = decryptSetting(row.valueEncrypted);
  return { hasValue: true, lastFour: value.slice(-4), updatedAt: row.updatedAt };
}

// --- Cached-client invalidation hooks ---
// A handful of consumers (Resend, Firebase Admin) build a client object
// once and hold it in module state rather than reading process.env fresh
// per call. Those need to be told explicitly when the setting backing
// them changes, or an admin's save in the UI would silently not take
// effect until the process restarts — exactly the bug this whole feature
// exists to fix, just one layer deeper. Each such module registers a
// reset callback here; setSetting() fires the ones relevant to the key
// that changed.
type ResetHook = () => void;
const resetHooks = new Map<string, ResetHook[]>();

export function onSettingChanged(keys: string[], hook: ResetHook): void {
  for (const key of keys) {
    const list = resetHooks.get(key) ?? [];
    list.push(hook);
    resetHooks.set(key, list);
  }
}

function invalidateResetHooks(key: string): void {
  for (const hook of resetHooks.get(key) ?? []) hook();
}
