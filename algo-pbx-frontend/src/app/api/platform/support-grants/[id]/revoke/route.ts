import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { revokeGrant, isGrantLive } from "@/lib/support-grant";

export const dynamic = "force-dynamic";

// POST /api/platform/support-grants/[id]/revoke — end a support grant early.
//
// requirePlatformSession(), not requirePlatformOwner(), and deliberately any
// platform user rather than only the grant's holder: giving up access is
// never the dangerous direction, and an operator who finishes an
// investigation at 2am should be able to close their own window without
// waking an owner. Making revocation harder than granting would push people
// toward simply letting grants expire, which is the outcome the time-boxing
// exists to avoid.
//
// revokeGrant() writes to BOTH audit trails in one transaction — the tenant
// saw us enter, so the tenant sees us leave.
export const POST = withApiErrorHandler(async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const grant = await db.supportGrant.findUnique({
    where: { id: params.id },
    select: { id: true, expiresAt: true, revokedAt: true },
  });
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  if (!isGrantLive(grant)) {
    // Already revoked or already expired. Not an error worth failing loudly
    // over — the desired end state is the actual end state — but reported
    // distinctly so the UI does not claim it just did something.
    return NextResponse.json(
      { revoked: false, reason: grant.revokedAt ? "Already revoked." : "Already expired." },
      { status: 409 }
    );
  }

  await revokeGrant(grant.id, guard.session.user.id);
  return NextResponse.json({ revoked: true });
});
