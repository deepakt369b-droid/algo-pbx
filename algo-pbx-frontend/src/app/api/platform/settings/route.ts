import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { setSetting } from "@/lib/settings/service";
import { verifyCloudflareToken } from "@/lib/domain/cloudflare";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// PUT /api/platform/settings — write a platform-global AppSetting
// (tenantId = null).
//
// Owner-only, reasoned and audited. The Cloudflare token in particular is a
// credential that can rewrite DNS for every tenant's workspace at once, so it
// is treated as a consequential change rather than a preference.
//
// The value is never echoed back — the UI displays a suffix only, from the
// existing settings service. A "show me what I saved" affordance on a secret
// is a credential-exfiltration path wearing a helpful hat.

const ALLOWED_PLATFORM_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "VM_PUBLIC_DOMAIN",
  "PROVISIONING_PER_TENANT_SUBNET_ENABLED",
] as const;

const BodySchema = z.object({
  key: z.enum(ALLOWED_PLATFORM_KEYS),
  value: z.string().max(4000),
  reason: z.string(),
});

export const PUT = withApiErrorHandler(async function PUT(req: NextRequest) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { key, value } = parsed.data;

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, "settings.update");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Verify the Cloudflare token BEFORE storing it. Storing an invalid token
  // and discovering it at certificate-renewal time means finding out during
  // an outage, which is the worst possible moment. verifyCloudflareToken
  // throws on rejection rather than returning a result.
  if (key === "CLOUDFLARE_API_TOKEN" && value) {
    try {
      await verifyCloudflareToken(value);
    } catch (err) {
      return NextResponse.json(
        {
          error: `Cloudflare rejected that token: ${err instanceof Error ? err.message : "unknown reason"}`,
        },
        { status: 400 }
      );
    }
  }

  // tenantId null = platform-global; the settings service already implements
  // tenant-override-then-platform-default precedence.
  //
  // `updatedById` is a plain nullable String column, not a foreign key, so a
  // PlatformUser id is storable — but it is ambiguous on its own (nothing in
  // the column says which plane the id belongs to). The authoritative record
  // of who changed a platform setting is the PlatformAuditLog row written
  // just below; this value is a convenience for the settings UI's "updated
  // by" line.
  await setSetting(key, value, guard.session.user.id, null);

  await recordPlatformAudit({
    action: "settings.update",
    platformUserId: guard.session.user.id,
    reason,
    metadata: {
      key,
      scope: "platform",
      // The value itself is never recorded. An audit log that captured the
      // credential would just be a second place it leaks from.
      valueRecorded: false,
      cleared: value === "",
    },
  });

  return NextResponse.json({ ok: true, key });
});
