import type { NextAuthConfig } from "next-auth";

type StaffRole = "AGENT" | "SUPERVISOR" | "ADMIN";

// Edge-compatible half of the Auth.js config (pattern confirmed against
// nextauthjs/next-auth docs/pages/guides/edge-compatibility.mdx). Deliberately
// has NO providers with a Prisma/bcrypt `authorize` callback — middleware.ts
// runs in the Edge runtime, and neither Prisma's Node engine nor bcryptjs's
// native-ish hashing work there. This file only carries what middleware
// actually needs: the pages config and the callbacks used to shape the JWT.
//
// src/auth.ts extends this with the real Credentials provider for use in
// Node.js route handlers / server components, where Prisma + bcrypt are fine.
export default {
  // Explicit, not left to Auth.js's AUTH_TRUST_HOST env-var auto-detection:
  // that heuristic did not reliably pick up the incoming request's real
  // Host header in this deployment (VirtualBox NAT, no reverse proxy) —
  // the default redirect callback's `baseUrl` fell back to the library's
  // hardcoded "http://localhost:3000", so a real credentials sign-in from
  // http://127.0.0.1:3000 got redirected to a bare http://localhost:3000
  // (different origin -> browser drops the just-set session cookie ->
  // immediate bounce back to /login). Confirmed via direct curl against
  // /api/auth/callback/credentials: Location header was localhost:3000
  // even with AUTH_URL/AUTH_TRUST_HOST both correctly set in the
  // container's environment. Setting this explicitly is Auth.js's own
  // documented fix for exactly this failure mode.
  trustHost: true,
  session: {
    strategy: "jwt",
    // Was unset, i.e. NextAuth's default of 30 days. Combined with there
    // previously being no revocation mechanism at all, a terminated or
    // compromised agent's session stayed valid for up to a month with
    // literally no way to cut it off. 8 hours is a full call-center shift
    // — long enough not to interrupt agents mid-shift, short enough that a
    // revoked/expired account's blast radius from this mechanism alone
    // (before src/auth.ts's live disabled-check even comes into play) is
    // bounded to well under a day.
    maxAge: 8 * 60 * 60,
  },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.role = user.role;
        token.extension = user.extension;
        // Wave 2a (plan §1/§2): only set on the initial sign-in leg here —
        // this edge-safe base callback has no DB access, so it can't
        // re-verify it live. src/auth.ts's Node-side override is the one
        // that re-reads it from Postgres on every subsequent request.
        token.tenantId = user.tenantId;
      }
      return token;
    },
    session: ({ session, token }) => {
      // Casts, not the augmented JWT type, because next-auth's JWT type
      // isn't reachable for augmentation from this package's dependency
      // layout — see src/types/next-auth.d.ts's comment for why.
      session.user.id = token.sub!;
      session.user.role = token.role as StaffRole;
      session.user.extension = token.extension as string | null;
      // Default false here (this edge-safe callback has no DB access to
      // check the real value) — src/auth.ts's Node-side override is what
      // actually sets this from a live query and is what every API route
      // relies on via requireSession()/requireStaffSession(). A session
      // resolved only through this base config (e.g. inside edge
      // middleware) is never treated as authoritative for anything
      // beyond "is someone signed in" page-redirect purposes.
      session.user.disabled = (token.disabled as boolean | undefined) ?? false;
      // Same reasoning as `disabled` above — this edge-safe base callback
      // has no DB access, so it can't compute real completeness. Default
      // TRUE (not gated) here deliberately: this flag's actual, live
      // value always comes from src/auth.ts's Node-side jwt override
      // (which runs on every real page/API request in this app, same as
      // `disabled`), so by the time middleware.ts reads it the token
      // already carries the correct value. Defaulting true here only
      // matters as a fallback for the token's very first, pre-Node-
      // override shape, and defaulting to "gate everyone" there would be
      // the wrong failure mode for ADMIN/SUPERVISOR sessions, which
      // src/middleware.ts never gates on this flag regardless.
      session.user.profileComplete = (token.profileComplete as boolean | undefined) ?? true;
      // Wave 2a (plan §1/§2) — same "edge-safe base has no DB access"
      // caveat as `disabled`/`profileComplete` above: this is only ever
      // authoritative once src/auth.ts's Node-side jwt override has run
      // (every real page/API request). No safe default exists here the
      // way `false`/`true` work for booleans — an empty string is not a
      // valid tenantId, so a session resolved only through this base
      // config (e.g. inside edge middleware, before the Node override has
      // had a chance to run) carries it as empty and MUST NOT be treated
      // as authoritative for tenantDb() by anything that reads it before
      // the Node-side override fires.
      session.user.tenantId = (token.tenantId as string | undefined) ?? "";
      return session;
    },
  },
} satisfies NextAuthConfig;
