import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

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
export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  // THE decisive enforcement point for the agent-registration hard gate
  // (see src/middleware.ts's comment on why a page redirect alone isn't
  // enough: middleware's matcher excludes /api entirely). Without SIP
  // credentials, src/contexts/sip-context.tsx's softphone cannot
  // register at all — so refusing them here is what actually prevents
  // an unregistered/unverified AGENT from taking a single call,
  // independent of whatever the browser does. Staff roles are never
  // gated (see profileComplete's own doc comment for why).
  if (guard.session.user.role === "AGENT" && !guard.session.user.profileComplete) {
    return NextResponse.json(
      { error: "Complete your registration and verify your phone number before signing in to the softphone." },
      { status: 403 }
    );
  }

  const extension = await db.extension.findUnique({
    where: { userId: guard.session.user.id },
    select: { number: true, sipSecret: true, voicemailPin: true },
  });

  if (!extension?.sipSecret) {
    return NextResponse.json(
      { error: "No SIP extension is linked to this account yet — contact an admin." },
      { status: 404 }
    );
  }

  return NextResponse.json({
    extension: extension.number,
    sipSecret: extension.sipSecret,
    voicemailPin: extension.voicemailPin,
  });
}
