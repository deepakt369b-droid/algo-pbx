import { NextResponse } from "next/server";
import { platformAuth } from "@/lib/platform-auth";
import { unsafeGlobalDb as db } from "@/lib/db";

// Mirrors src/lib/auth-guard.ts's exact discriminated-union shape
// ({ session } | { response }) for the platform plane. Deliberately does
// NOT return a tenant-scoped db the way wave 2a's guards do — a platform
// session has no single tenant; a route that needs one tenant's data goes
// through src/lib/support-grant.ts's grant mechanism instead, on top of
// whichever tenant id the route/URL names.

export interface PlatformSessionUser {
  id: string;
  email: string;
  name: string;
  role: "PLATFORM_OWNER" | "PLATFORM_SUPPORT";
}

export interface PlatformSession {
  user: PlatformSessionUser;
}

function hasShape(session: unknown): session is PlatformSession {
  const s = session as { user?: Partial<PlatformSessionUser> } | null | undefined;
  return Boolean(s?.user?.id && s.user.email && s.user.role);
}

export async function requirePlatformSession(): Promise<
  { session: PlatformSession } | { response: NextResponse }
> {
  const raw = await platformAuth();
  if (!hasShape(raw)) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const session = raw as unknown as PlatformSession;

  // Live re-check, same reasoning as src/auth.ts's Node jwt callback
  // re-reading User.disabled on every request rather than trusting a
  // possibly-stale JWT claim: a platform session sits closer to "root" than
  // any tenant session (it's the account that can grant itself access to
  // every tenant's data), so a disabled/deleted PlatformUser must lose
  // access on its very next request, not up to platform-auth.config.ts's
  // 4h session ceiling later. One extra query per request is an accepted
  // cost here — this console is low-traffic by nature (a handful of
  // operators), unlike the agent-facing routes that pattern was originally
  // sized for.
  const dbUser = await db.platformUser.findUnique({
    where: { id: session.user.id },
    select: { disabled: true },
  });
  if (!dbUser || dbUser.disabled) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  return { session };
}

// Stricter than requirePlatformSession(): PLATFORM_OWNER only. Mirrors
// auth-guard.ts's requireAdminSession() pattern. Per plan §3: OWNER's
// provisioning/billing/suspend/offboard actions don't require a support
// grant (they're not "reading tenant call content"), but they ARE
// OWNER-only — a PLATFORM_SUPPORT account should never reach them even with
// a valid session.
export async function requirePlatformOwner(): Promise<
  { session: PlatformSession } | { response: NextResponse }
> {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard;
  if (guard.session.user.role !== "PLATFORM_OWNER") {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return guard;
}
