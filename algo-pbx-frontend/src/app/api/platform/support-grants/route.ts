import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformSession } from "@/lib/platform-guard";
import { createSupportGrant } from "@/lib/support-grant";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const CreateGrantSchema = z.object({
  tenantId: z.string().min(1),
  // Server-side trim+non-empty check happens again inside
  // createSupportGrant() itself — this schema-level .min(1) only rejects
  // the trivially-empty-string case early; whitespace-only reasons are
  // caught by support-grant.ts's own `.trim()` check (single source of
  // truth for "what counts as empty").
  reason: z.string().min(1),
  durationMinutes: z.number().finite(),
});

// POST /api/platform/support-grants — create a time-boxed, reasoned grant
// to read one tenant's data.
//
// Both PLATFORM_OWNER and PLATFORM_SUPPORT can call this — requirePlatformSession()
// only, not requirePlatformOwner(). Per plan §3: "PLATFORM_OWNER... cannot
// read tenant call content by default" — provisioning/billing/suspend/
// offboard are OWNER-only-no-grant-needed actions (not built in this
// file), but actually READING a tenant's data is gated behind a grant for
// EITHER role. An OWNER wanting to look at a tenant's calls goes through
// this same endpoint, the same as PLATFORM_SUPPORT would — there is no
// bypass for OWNER here, by design.
//
// `reason` is mandatory and rejected if empty/whitespace (enforced twice:
// zod's .min(1) here, and support-grant.ts's own .trim() check — the
// latter is authoritative since a string of only spaces passes zod's
// length check but should still be rejected).
export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const body = await req.json().catch(() => null);
  const parsed = CreateGrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { tenantId, reason, durationMinutes } = parsed.data;

  if (!reason.trim()) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }

  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  try {
    const grant = await createSupportGrant({
      tenantId,
      platformUserId: guard.session.user.id,
      reason,
      durationMinutes,
    });
    return NextResponse.json({ grant }, { status: 201 });
  } catch (err) {
    // createSupportGrant() throws its own descriptive Error for the
    // empty-reason case (defense in depth against this route's own check
    // above); withApiErrorHandler would otherwise flatten it to a generic
    // 500. Surface it as a 400 instead, since it's a client input problem.
    const message = err instanceof Error ? err.message : "Could not create support grant";
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
