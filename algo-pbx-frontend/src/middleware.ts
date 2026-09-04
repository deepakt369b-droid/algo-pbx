import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/auth.config";
import platformAuthConfig from "@/lib/platform-auth.config";

// THIS FILE MUST LIVE HERE (src/middleware.ts), not at the frontend package
// root. Root-caused, not empirical: `next build` computes
// `rootDir = path.join(pagesDir || appDir, "..")` (node_modules/next/dist/
// build/index.js) and does ONE non-recursive scan of that single directory
// for a `middleware.{js,ts,jsx,tsx,mjs}` file — there is no dual root+src
// fallback check at build time. Since this app's appDir is `src/app`,
// rootDir resolves to `src/`, so `middleware.ts` at the package root is
// silently never discovered (confirmed via an empty
// `.next/server/middleware-manifest.json`), while `src/middleware.ts` is.
// If `src/app` is ever flattened back to a top-level `app/`, this file must
// move to the package root with it, or it will silently stop being loaded
// again with no build error.

// Builds its own Edge-safe NextAuth instance from the shared, provider-less
// authConfig — never import from "@/auth" here, that file pulls in Prisma
// and bcryptjs (see auth.config.ts's comment / edge-compatibility.mdx).
const { auth } = NextAuth(authConfig);

// Second, independent Edge-safe instance for the platform plane (D2), from
// its own provider-less config — never import from "@/lib/platform-auth"
// here, same reasoning (Prisma/bcryptjs pull, see that file's comment).
// This is genuinely a SECOND NextAuth() call, not a config swap on the
// first — the two must resolve completely separate session cookies
// (platform-auth.config.ts's PLATFORM_SESSION_COOKIE vs. next-auth's
// tenant-side default), and NextAuth() bakes the cookie name in at
// construction.
const { auth: platformAuthEdge } = NextAuth(platformAuthConfig);

// Builds an absolute URL from the REAL incoming request instead of
// `req.nextUrl.origin` — see this file's header comment above for why:
// Next.js's compiled Edge runtime can "seal" a request's own `nextUrl` to
// a hardcoded `localhost:3000` for certain requests (confirmed via direct
// curl against POST /api/auth/callback/credentials, see handoff.md
// 2026-08-26), and this bug hits `/api/auth/[...nextauth]/route.ts`'s own
// redirect Location header the same way. Since that class of bug lives in
// `nextUrl` specifically, reading the actual `x-forwarded-host`/`host`
// header (set by the reverse proxy — Caddy in production, or the browser
// directly in dev) sidesteps it entirely rather than hoping a `dynamic`/
// `trustHost` fix upstream also happens to cover middleware's own copy of
// the same object.
function absoluteUrl(path: string, req: Parameters<Parameters<typeof auth>[0]>[0]): URL {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return new URL(path, `${proto}://${host}`);
}

// Unchanged tenant-side logic — do not modify these branches (a separate
// wave-2a agent may also be touching auth machinery elsewhere; this file's
// existing tenant behavior is left exactly as it was).
const tenantMiddleware = auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  const isAdminRoute = pathname.startsWith("/admin");
  const isAgentRoute = pathname.startsWith("/agent");
  const isRegisterRoute = pathname.startsWith("/register");

  if (!isAdminRoute && !isAgentRoute && !isRegisterRoute) {
    return NextResponse.next();
  }

  // The TEMP diagnostic that logged host headers on every unauthenticated
  // request is removed: the AGENT-login bounce it was added to investigate
  // (handoff.md 2026-08-26) is confirmed fixed on the production VPS —
  // agents sign in and reach /agent normally — and absoluteUrl() above is
  // the permanent fix.

  if (!session?.user) {
    const loginUrl = absoluteUrl("/login", req);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAdminRoute && session.user.role !== "ADMIN" && session.user.role !== "SUPERVISOR") {
    return NextResponse.redirect(absoluteUrl("/agent", req));
  }

  // Agent registration hard gate. ONLY AGENT is gated — the bootstrap
  // admin (scripts/create-admin-user.mjs) has no invite and no profile
  // at all, so gating ADMIN/SUPERVISOR would lock the only admin out of
  // the panel on first login. session.user.profileComplete is recomputed
  // live on every request by src/auth.ts's jwt callback (same mechanism
  // as `disabled`), so an agent who finishes registration — or has it
  // overridden by an admin — sees this lift on their very next request.
  //
  // This is real but not the ONLY enforcement: middleware's matcher
  // below excludes /api entirely (by design, see its comment), so a page
  // redirect here is a UX convenience, not the security boundary — the
  // actual boundary is GET /api/me/sip-credentials refusing to hand out
  // SIP credentials to an incomplete profile, since without those the
  // softphone cannot register and the agent cannot take calls regardless
  // of what page loads.
  if (isAgentRoute && session.user.role === "AGENT" && !session.user.profileComplete) {
    return NextResponse.redirect(absoluteUrl("/register", req));
  }

  // Once complete, /register itself redirects away — no reason for a
  // fully registered agent to land back on the form.
  if (isRegisterRoute && (session.user.role !== "AGENT" || session.user.profileComplete)) {
    return NextResponse.redirect(absoluteUrl("/agent", req));
  }

  return NextResponse.next();
});

// Platform-plane branch (wave 3, D2). Point 4 of the wave-3 brief chose to
// extend this single middleware.ts rather than add a second middleware
// file — Next.js only ever loads one middleware.ts (see this file's own
// header comment on why even ITS location is load-bearing), so a second
// file is not an option; the alternative would have been relying purely on
// requirePlatformSession()/layout-level checks with zero page-redirect
// convenience, which is a worse UX for no isolation benefit — the API
// routes under /api/platform/** already self-guard via
// requirePlatformSession() regardless (matcher below excludes /api
// entirely, same as the tenant side), so this redirect is defense-in-depth
// for page navigations only, exactly like the tenant branch above.
const platformMiddleware = platformAuthEdge((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // /platform/login must stay reachable with no session, or a
  // logged-out operator could never reach the form to sign in.
  if (pathname === "/platform/login") {
    return NextResponse.next();
  }

  if (!session?.user) {
    const loginUrl = absoluteUrl("/platform/login", req);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

// Single default export dispatching by path prefix to whichever of the two
// independently-wrapped middleware functions applies. Both
// tenantMiddleware and platformMiddleware have the identical Next.js
// middleware signature (auth()'s wrapper preserves it), so this is a plain
// prefix dispatch, not a merge of the two auth mechanisms — the tenant
// branch never runs for /platform/* requests and vice versa, keeping the
// two session/cookie spaces fully separate all the way through this file.
export default function middleware(...args: Parameters<typeof tenantMiddleware>) {
  const [req] = args;
  if (req.nextUrl.pathname.startsWith("/platform")) {
    return platformMiddleware(...args);
  }
  return tenantMiddleware(...args);
}

export const config = {
  // Auth-only matcher. CSP is now a static header in next.config.mjs (with
  // 'unsafe-inline' so Next.js's RSC hydration inline scripts can run), so
  // /login and /setup no longer need to pass through middleware just for
  // headers. /api and static assets are still excluded. /platform is
  // deliberately NOT excluded here (unlike /login/setup) — the platform
  // branch above needs to run on every /platform/* page navigation,
  // including /platform/login itself, so it can make that one path's
  // "allow with no session" decision itself rather than being kept out of
  // middleware entirely.
  matcher: ["/((?!api/|api$|_next/static|_next/image|favicon.ico|login|setup).*)"],
};
