import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCountries, type CountryCode } from "libphonenumber-js";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// PATCH /api/platform/tenants/[id]/extensions/[extensionId]/geo — the
// per-extension country allocation (plan §3.3: "Owner-only allocation,
// never set by a tenant admin" — see Extension.geoAllowedCountries's own
// schema comment). This is the ONLY route in the codebase permitted to
// write that column; the tenant-admin extension PATCH
// (/api/extensions/[number]) explicitly rejects it.
const VALID_COUNTRY_CODES: ReadonlySet<string> = new Set<CountryCode>(getCountries());

const BodySchema = z.object({
  geoAllowedCountries: z.array(z.string().length(2)).max(250),
  reason: z.string(),
});

export const PATCH = withApiErrorHandler(async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; extensionId: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const body = parsed.data;

  const unknown = body.geoAllowedCountries.filter((c) => !VALID_COUNTRY_CODES.has(c));
  if (unknown.length > 0) {
    return NextResponse.json({ error: `Unknown country code(s): ${unknown.join(", ")}` }, { status: 400 });
  }

  let reason: string;
  try {
    reason = requireReason(body.reason, "tenant.extension_geo_update");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const extension = await db.extension.findUnique({
    where: { id: params.extensionId },
    select: { id: true, tenantId: true, number: true, geoAllowedCountries: true },
  });
  if (!extension || extension.tenantId !== params.id) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  const before = extension.geoAllowedCountries;
  const deduped = Array.from(new Set(body.geoAllowedCountries));

  const updated = await db.$transaction(async (tx) => {
    const e = await tx.extension.update({
      where: { id: extension.id },
      data: { geoAllowedCountries: deduped },
    });
    await recordPlatformAudit(
      {
        action: "tenant.extension_geo_update",
        platformUserId: guard.session.user.id,
        tenantId: params.id,
        reason,
        metadata: {
          extensionId: extension.id,
          extensionNumber: extension.number,
          before,
          after: deduped,
        },
      },
      tx
    );
    return e;
  });

  return NextResponse.json({
    extension: { id: updated.id, geoAllowedCountries: updated.geoAllowedCountries },
  });
});
