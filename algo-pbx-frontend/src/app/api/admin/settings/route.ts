import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSettingDef, SETTINGS_REGISTRY, tenantVisibleSettings } from "@/lib/settings/schema";
import { getSetting, getSettingMeta, setSetting } from "@/lib/settings/service";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// Multi-tenant SaaS foundation, wave 2d: every getSetting/getSettingMeta/
// setSetting call below deliberately omits `tenantId`, resolving the
// platform-default row exactly as before this wave — settings/service.ts's
// signature is backward compatible for exactly this reason. Most of this
// registry (Resend, Firebase, Cloudflare, OpenWA/Meta WhatsApp, OTP, domain/
// TLS, retention, CRM webhook secret) is genuinely platform-wide
// infrastructure config, not a per-tenant concern.
//
// The "sms_dinstar" section (DINSTAR_LAN_IP, DINSTAR_SIP_PORT,
// DINSTAR_SMS_USERNAME/PASSWORD, DINSTAR_AUTH_STYLE, DINSTAR_TLS_CERT_PEM,
// DINSTAR_WEBUI_USERNAME/PASSWORD) is the one candidate flagged in this
// wave's task brief (plan §8 gap analysis) as arguably per-tenant — a
// second tenant with its own GSM trunk would need its own Dinstar
// credentials, not the platform default this route currently writes/reads.
// Left as platform-global here deliberately: re-scoping specific settings
// to a tenant override is explicitly a later wave's job (5/6), not this
// one, which only needed to make this route compile against the new
// optional-tenantId signature.

// GET /api/admin/settings — every registered setting's DISPLAY state
// (section, label, whether a value exists, last 4 chars if secret,
// updatedAt). NEVER the value itself for a secret field — the whole
// point of this route is that an admin can confirm "yes, a key is
// configured" without that key ever round-tripping back through the
// browser after it was first typed in.
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  // Domain & TLS moved to the platform console (plan §6): one Cloudflare
  // token and one wildcard certificate serve every tenant, so those keys are
  // no longer a tenant admin's to see or set. They stay in the registry for
  // their env fallback and validator — only their visibility changes here.
  const results = await Promise.all(
    tenantVisibleSettings(SETTINGS_REGISTRY).map(async (def) => {
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
  const { db } = guard;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const def = getSettingDef(parsed.data.key);
  if (!def) return NextResponse.json({ error: `Unknown setting "${parsed.data.key}"` }, { status: 400 });

  // Enforced here, not merely hidden in the UI. Removing a field from a page
  // does not stop a PATCH, and CLOUDFLARE_API_TOKEN in particular can rewrite
  // DNS for every tenant workspace — it must not be settable by a tenant
  // admin through a hand-made request.
  if (def.platformOnly) {
    return NextResponse.json(
      { error: `"${def.key}" is managed by the platform owner console and cannot be set here.` },
      { status: 403 }
    );
  }

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
  // No `tenantId` — force-injected at runtime by the tenant-scoped `db`.
  await db.auditLog.create({
    data: { action: "settings.update", actorId: guard.session.user.id, targetId: def.key, metadata: { key: def.key, section: def.section } } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return NextResponse.json({ ok: true });
});
