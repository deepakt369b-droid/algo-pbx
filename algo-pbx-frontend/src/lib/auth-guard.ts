import { NextResponse } from "next/server";
import { auth } from "@/auth";
import type { Session } from "next-auth";
import { tenantDb, type TenantClient } from "@/lib/db-tenant";

// middleware.ts's matcher deliberately excludes /api (see its comment) so
// that Server Actions and the NextAuth route handler itself aren't blocked.
// That means every admin-facing API route MUST check auth itself — the page
// redirect in /admin/* is not sufficient on its own, since these routes are
// directly reachable (e.g. `curl /api/extensions`) regardless of what the
// middleware does for page navigations.

// Shared by every guard below: session.user.disabled is populated by
// src/auth.ts's Node-side jwt callback from a LIVE Postgres read on every
// request (not just at sign-in) — see that file's comment for why. A
// disabled session is treated identically to no session at all, which is
// what actually makes account revocation take effect immediately instead
// of waiting up to session.maxAge (8h).
function isLive(session: Session | null): session is Session {
  return Boolean(session?.user) && session!.user.disabled !== true;
}

// Multi-tenant SaaS foundation, wave 2a (plan §2): every guard below now
// hands back a `db` alongside the `session` — a Prisma client already
// scoped to `session.user.tenantId` (src/lib/db-tenant.ts), not the raw
// `unsafeGlobalDb`. This is the whole enforcement mechanism: routes stop
// importing the global client and destructure this scoped one from the
// guard instead, so tenant isolation is structural (compiler-checked, via
// `unsafeGlobalDb`'s loud rename) rather than something a reviewer has to
// remember to check per route.
//
// TODO(plan §1 "Host-vs-user tenant mismatch"): the guards below trust
// session.user.tenantId as-is. They do NOT yet check it against the
// request's resolved host/subdomain tenant (tenant A's agent typing valid
// credentials at tenantb.algopbx.com must be denied and redirected to
// their own subdomain, not silently scoped to tenant B or tenant A). That
// check belongs in the Auth.js callback chain / src/middleware.ts (defence
// in depth), not here — deliberately out of scope for wave 2a, which is
// infrastructure-only. Whoever builds host-based tenant resolution
// (later in this plan, or wave 2b-2e if it turns out to be a prerequisite)
// must not forget this rule.

export async function requireStaffSession(): Promise<
  { session: Session; db: TenantClient } | { response: NextResponse }
> {
  const session = await auth();
  if (!isLive(session)) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (session.user.role !== "ADMIN" && session.user.role !== "SUPERVISOR") {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, db: tenantDb(session.user.tenantId) };
}

// Weaker than requireStaffSession(): any signed-in user, any role. For routes
// an AGENT needs to hit for themselves (e.g. PATCH-ing their own extension
// status) — the route itself still has to check *which* resource the caller
// may touch, this only confirms they're someone.
export async function requireSession(): Promise<
  { session: Session; db: TenantClient } | { response: NextResponse }
> {
  const session = await auth();
  if (!isLive(session)) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { session, db: tenantDb(session.user.tenantId) };
}

// Stricter than requireStaffSession(): ADMIN only, SUPERVISOR excluded. For
// actions a supervisor shouldn't be able to take on their own — same
// principle already applied to POST /api/admin/users restricting who may
// create SUPERVISOR/ADMIN accounts. Used by Phase D's hard-delete route:
// hiding a recording is a SUPERVISOR-level action, permanently destroying
// one is not.
export async function requireAdminSession(): Promise<
  { session: Session; db: TenantClient } | { response: NextResponse }
> {
  const session = await auth();
  if (!isLive(session)) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (session.user.role !== "ADMIN") {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, db: tenantDb(session.user.tenantId) };
}
