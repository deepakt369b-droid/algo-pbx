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

// WILDCARD_DNS_RECORD_CONFIRMED added per plan §1: "WILDCARD_DNS_RECORD_CONFIRMED
// is settable by nothing, so settings/domain/apply is permanently
// unreachable" — that route (see its own header comment) refuses to emit the
// tenant wildcard Caddy block unless this flag reads "true". It exists
// because a failed DNS-01 challenge for a WILDCARD record is fatal to
// Caddy's ENTIRE config, not just to that one site block — an invalid or
// premature confirmation here can crash-loop the reverse proxy and take the
// whole platform down with it, not just one tenant. That is why, uniquely
// among these four keys, PlatformSettingsForm requires the operator to type
// a fixed confirmation phrase (not just supply a reason) before this one
// specific value is written — see that component's own comment.
const ALLOWED_PLATFORM_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "VM_PUBLIC_DOMAIN",
  "PROVISIONING_PER_TENANT_SUBNET_ENABLED",
  "WILDCARD_DNS_RECORD_CONFIRMED",
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

  // This flag is a bare boolean-as-string, not free text — "true" to confirm,
  // empty to clear/un-confirm. Anything else is refused rather than stored
  // and silently treated as falsy by whatever reads it later.
  if (key === "WILDCARD_DNS_RECORD_CONFIRMED" && value !== "true" && value !== "") {
    return NextResponse.json(
      { error: 'WILDCARD_DNS_RECORD_CONFIRMED must be "true" or empty (to clear it).' },
      { status: 400 }
    );
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
