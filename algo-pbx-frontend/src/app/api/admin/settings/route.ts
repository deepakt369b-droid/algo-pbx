import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";
import { db } from "@/lib/db";
import { getSettingDef, SETTINGS_REGISTRY } from "@/lib/settings/schema";
import { getSetting, getSettingMeta, setSetting } from "@/lib/settings/service";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/admin/settings — every registered setting's DISPLAY state
// (section, label, whether a value exists, last 4 chars if secret,
// updatedAt). NEVER the value itself for a secret field — the whole
// point of this route is that an admin can confirm "yes, a key is
// configured" without that key ever round-tripping back through the
// browser after it was first typed in.
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const results = await Promise.all(
    SETTINGS_REGISTRY.map(async (def) => {
      const meta = await getSettingMeta(def.key);
      return {
        key: def.key,
        section: def.section,
        label: def.label,
        help: def.help,
        secret: def.secret,
        hasValue: meta.hasValue,
        // Non-secret values ARE safe to echo back (they're not
        // credentials — e.g. INVITE_FROM_EMAIL, OTP_CHANNEL) so the UI
        // can show the actual current value rather than just "configured".
        value: def.secret ? null : meta.hasValue ? ((await getSetting(def.key)) ?? null) : null,
        lastFour: def.secret ? meta.lastFour : null,
        updatedAt: meta.updatedAt,
      };
    })
  );

  return NextResponse.json({ settings: results });
});

// PATCH /api/admin/settings { key, value } — value is validated against
// the registry's Zod validator before being encrypted and stored. An
// EMPTY string for a secret field means "leave unchanged", never
// "clear" — a save that doesn't touch a field must not wipe it. To
// actually clear a value, an admin must be explicit (not exposed in the
// UI today — deleting a row is a DB-admin action, not a routine one).
const PatchSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

export const PATCH = withApiErrorHandler(async function PATCH(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const def = getSettingDef(parsed.data.key);
  if (!def) return NextResponse.json({ error: `Unknown setting "${parsed.data.key}"` }, { status: 400 });

  if (parsed.data.value === "") {
    // Leave-unchanged no-op — not an error, just nothing to do.
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const validation = def.validator.safeParse(parsed.data.value);
  if (!validation.success) {
    return NextResponse.json({ error: `Invalid value for ${def.label}`, details: validation.error.flatten() }, { status: 400 });
  }

  await setSetting(def.key, parsed.data.value, guard.session.user.id);

  // Never log the value, secret or not — see AppSetting's schema comment.
  await db.auditLog.create({
    data: { action: "settings.update", actorId: guard.session.user.id, targetId: def.key, metadata: { key: def.key, section: def.section } },
  });

  return NextResponse.json({ ok: true });
});
