import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/auth.config";

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

export default auth((req) => {
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

export const config = {
  // Auth-only matcher. CSP is now a static header in next.config.mjs (with
  // 'unsafe-inline' so Next.js's RSC hydration inline scripts can run), so
  // /login and /setup no longer need to pass through middleware just for
  // headers. /api and static assets are still excluded.
  matcher: ["/((?!api/|api$|_next/static|_next/image|favicon.ico|login|setup).*)"],
};
