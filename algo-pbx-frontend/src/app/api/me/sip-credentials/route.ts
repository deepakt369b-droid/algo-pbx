import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getClientIp } from "@/lib/rate-limit";
import { enforceGeoAccess } from "@/lib/geo/enforce";

export const dynamic = "force-dynamic";

// GET /api/me/sip-credentials — returns ONLY the calling user's own SIP
// digest credentials (extension number + secret + voicemail PIN), never
// anyone else's. This exists specifically to fix a real security/
// correctness bug: before Phase A, sip-context.tsx read
// NEXT_PUBLIC_SIP_EXTENSION/PASSWORD — build-time env vars baked into the
// client bundle, identical for every visitor and readable by anyone loading
// the page. That made "admin creates multiple agent users" structurally
// impossible: every agent would register as the same extension. This route
// is fetched once from an authenticated session instead, over HTTPS, and
// the secrets are never logged or placed in a JWT claim (JWTs are
// client-readable).
//
// voicemailPin (Phase E) rides on this same "my own credentials" endpoint
// rather than a separate route — it's the identical pattern (a secret the
// caller's own session, and only that session, is entitled to), and a
// second nearly-identical route would just be duplication.
const GEO_LOCKED_MESSAGE =
  "This extension is locked for a location-policy violation. Your administrator must request an unlock.";

export async function GET(request: Request) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  // THE decisive enforcement point for the agent-registration hard gate
  // (see src/middleware.ts's comment on why a page redirect alone isn't
  // enough: middleware's matcher excludes /api entirely). Without SIP
  // credentials, src/contexts/sip-context.tsx's softphone cannot
  // register at all — so refusing them here is what actually prevents
  // an unregistered/unverified AGENT from taking a single call,
  // independent of whatever the browser does. Staff roles are never
  // gated (see profileComplete's own doc comment for why).
  if (session.user.role === "AGENT" && !session.user.profileComplete) {
    return NextResponse.json(
      { error: "Complete your registration and verify your phone number before signing in to the softphone." },
      { status: 403 }
    );
  }

  // geoLockedAt/id pulled into this SAME query (W5, plan §3.3) rather than
  // a second round-trip — this route already fetches the extension row for
  // every caller.
  const extension = await db.extension.findUnique({
    where: { userId: session.user.id },
    select: { id: true, number: true, sipSecret: true, voicemailPin: true, geoLockedAt: true },
  });

  if (!extension?.sipSecret) {
    return NextResponse.json(
      { error: "No SIP extension is linked to this account yet — contact an admin." },
      { status: 404 }
    );
  }

  // THE second decisive enforcement point (plan §3.3's node table names
  // this route as "the actual boundary" alongside src/middleware.ts:94's
  // own comment) — this is what makes a geo lock bite for telephony
  // without touching Asterisk directly at this layer; PJSIP endpoint
  // removal (src/lib/pjsip-provision.ts's reprovisionPjsipExcludingLocked,
  // called from src/lib/geo/enforce.ts on the strike that locks) is the
  // separate mechanism that cuts an already-registered device.
  //
  // Fast path: already locked -> refuse immediately, no need to spend an
  // mmdb lookup + DB writes re-deciding something already decided.
  if (extension.geoLockedAt) {
    return NextResponse.json({ error: GEO_LOCKED_MESSAGE }, { status: 403 });
  }

  // NOT yet locked -> still re-run the full, live decision on every call,
  // not just at login. The JWT session lives up to 8h (auth.config.ts);
  // login-time geo checks alone would miss an agent who signs in cleanly
  // and then switches a VPN on mid-shift. This is the one enforcement
  // point that actually re-checks that.
  const ip = getClientIp(request.headers);
  const decision = await enforceGeoAccess(db, {
    tenantId: session.user.tenantId,
    extensionId: extension.id,
    email: session.user.email ?? "",
    userId: session.user.id,
    ip,
  });

  if (!decision.allowed) {
    // Mirrors src/auth.ts's "auth.signin_blocked_geo" audit shape, with
    // telephonyAffected: true here (unlike the login-time write) — this IS
    // the telephony credential fetch; refusing it directly stops the
    // softphone from registering, not just the browser session.
    await db.auditLog.create({
      data: {
        action: "auth.signin_blocked_geo",
        actorId: session.user.id,
        tenantId: session.user.tenantId,
        metadata: {
          outcome: decision.outcome,
          remainingAttempts: decision.remainingAttempts,
          telephonyAffected: true,
          source: "sip-credentials",
        },
      },
    });
    return NextResponse.json({ error: decision.agentMessage ?? GEO_LOCKED_MESSAGE }, { status: 403 });
  }

  return NextResponse.json({
    extension: extension.number,
    sipSecret: extension.sipSecret,
    voicemailPin: extension.voicemailPin,
  });
}
