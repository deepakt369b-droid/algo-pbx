import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { requireSetting, getSetting } from "@/lib/settings/service";
import { applyDomainConfig } from "@/lib/domain/caddyfile";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";
import { TENANT_BASE_DOMAIN } from "@/lib/platform/domain-constants";

export const dynamic = "force-dynamic";

// POST /api/platform/settings/domain/apply — the platform-plane counterpart
// of the tenant-admin Connect-domain action, so moving Domain & TLS to this
// console does not remove the capability from the product.
//
// Saving the domain and token persists them; it does not change what Caddy
// serves. Caddy reads the generated files at container-create time, so this
// action is what makes a saved value real.
//
// The tenant wildcard is opt-in and defaults off. A wildcard block whose
// DNS-01 challenge cannot complete is fatal to Caddy's ENTIRE config, not
// just to that site — it would crash-loop the reverse proxy and take the
// working production site down with it. So enabling it is a separate,
// explicit decision made after the one-time wildcard DNS record exists.

const BodySchema = z.object({
  includeTenantWildcard: z.boolean().default(false),
  reason: z.string(),
});

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, "settings.update");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  let domain: string;
  let token: string;
  try {
    domain = await requireSetting("VM_PUBLIC_DOMAIN");
    token = await requireSetting("CLOUDFLARE_API_TOKEN");
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Domain or Cloudflare token is not configured." },
      { status: 400 }
    );
  }

  // Belt and braces on the dangerous option: refuse the wildcard unless the
  // operator has ALSO recorded that the wildcard DNS record exists. Two
  // independent confirmations for the one setting that can take the whole
  // proxy down.
  const wildcardAcknowledged = (await getSetting("WILDCARD_DNS_RECORD_CONFIRMED")) === "true";
  if (parsed.data.includeTenantWildcard && !wildcardAcknowledged) {
    return NextResponse.json(
      {
        error:
          `Refusing to emit the *.${TENANT_BASE_DOMAIN} block: the wildcard DNS record has not been confirmed. ` +
          `If its DNS-01 challenge fails, Caddy treats it as fatal to the entire config and the whole reverse proxy ` +
          `crash-loops — taking the working production site with it. Create the record, confirm it in Platform Settings, then retry.`,
      },
      { status: 409 }
    );
  }

  const result = await applyDomainConfig({
    domain,
    token,
    includeTenantWildcard: parsed.data.includeTenantWildcard,
  });

  await recordPlatformAudit({
    action: "settings.update",
    platformUserId: guard.session.user.id,
    reason,
    metadata: {
      key: "domain.apply",
      domain,
      includeTenantWildcard: parsed.data.includeTenantWildcard,
      ok: result.ok,
    },
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, message: result.message });
});
