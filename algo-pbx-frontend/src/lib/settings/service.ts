import { db } from "@/lib/db";
import { decryptSetting, encryptSetting } from "./crypto";
import { getSettingDef } from "./schema";

// Runtime settings resolution: database row -> process.env[envFallback]
// -> registry default -> undefined. This is what lets every provider
// (Resend, OpenWA, Meta Cloud, Dinstar, Firebase, CRM webhooks) become
// admin-configurable from /admin/settings without breaking an existing
// .env-based deployment that has never opened that page — the env value
// keeps working exactly as before until a DB row exists to override it.
//
// Cached in an in-process Map, invalidated by key on every write. This
// is correct for the single-container deployment this app ships as
// (docker-compose.yml has no `web` replica count > 1). A multi-replica
// deployment would need this cache either dropped or moved to a shared
// store (e.g. Redis) — a stale replica serving a rotated API key after
// another replica accepted the change would be a confusing, hard-to-spot
// failure. Flagged here rather than silently assumed away.
const cache = new Map<string, string | undefined>();

const DISABLE_SETTINGS_CACHE = process.env.DISABLE_SETTINGS_CACHE === "true";
if (process.env.NODE_ENV === "production" && !DISABLE_SETTINGS_CACHE) {
  console.warn(
    "settings/service: in-process settings cache is active. This is safe for a single 'web' replica, " +
      "but will stale across multiple replicas. Set DISABLE_SETTINGS_CACHE=true or move the cache to a shared store (e.g. Redis) before scaling horizontally."
  );
}

export async function getSetting(key: string): Promise<string | undefined> {
  if (!DISABLE_SETTINGS_CACHE && cache.has(key)) return cache.get(key);

  const row = await db.appSetting.findUnique({ where: { key } });
  if (row) {
    const value = decryptSetting(row.valueEncrypted);
    if (!DISABLE_SETTINGS_CACHE) cache.set(key, value);
    return value;
  }

  const def = getSettingDef(key);
  const value = (def?.envFallback ? process.env[def.envFallback] : undefined) ?? def?.default;
  if (!DISABLE_SETTINGS_CACHE) cache.set(key, value);
  return value;
}

/** Throws if the resolved value is missing — for call sites that have no
 * sensible fallback behavior (e.g. a provider that simply cannot send
 * anything without a key). Mirrors the fail-loud pattern already used by
 * src/lib/mail/resend.ts and src/lib/firebase/admin.ts before this
 * change, now generalized. */
export async function requireSetting(key: string): Promise<string> {
  const value = await getSetting(key);
  if (!value) {
    const def = getSettingDef(key);
    throw new Error(`Setting "${key}" (${def?.label ?? key}) is not configured. Set it in /admin/settings.`);
  }
  return value;
}

export async function setSetting(key: string, value: string, updatedById: string): Promise<void> {
  const valueEncrypted = encryptSetting(value);
  await db.appSetting.upsert({
    where: { key },
    create: { key, valueEncrypted, updatedById },
    update: { valueEncrypted, updatedById },
  });
  cache.delete(key);
  invalidateResetHooks(key);
}

/** True only if a DB row exists for this key — distinct from getSetting()
 * returning a value, since that can come from an env fallback or default
 * with no row present at all. Used by the settings UI to show "using
 * environment default" vs. "configured" per field. */
export async function hasSettingRow(key: string): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key }, select: { id: true } });
  return Boolean(row);
}

export async function getSettingMeta(key: string): Promise<{ hasValue: boolean; lastFour: string | null; updatedAt: Date | null }> {
  const row = await db.appSetting.findUnique({ where: { key } });
  if (!row) {
    const value = await getSetting(key);
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
