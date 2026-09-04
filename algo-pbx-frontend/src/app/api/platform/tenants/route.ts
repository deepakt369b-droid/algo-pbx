import { NextResponse } from "next/server";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/platform/tenants — list, any live platform session. Read-only
// listing metadata only (id/slug/name/status/billingStatus/plan/seats),
// never tenant call content — no support grant required, per plan §3's
// distinction (see platform-guard.ts's comment on requirePlatformSession
// vs. the grant mechanism).
//
// Deliberately NOT built here: POST (tenant create/provisioning). That's
// wave 7 in the plan, explicitly blocked until the CA signing-flow v2
// ships (the cert-issuance step in the provisioning pipeline currently
// requires a human running `easyrsa build-client-full` by hand — see
// plan §4's "Two blocking dependencies"). Building a create endpoint here
// without that would either silently omit the cert step or fake it, both
// worse than not having the route yet.
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const tenants = await db.tenant.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      plan: true,
      seats: true,
      billingStatus: true,
      paidUntil: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ tenants });
});
