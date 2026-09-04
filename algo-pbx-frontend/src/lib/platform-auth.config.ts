import type { NextAuthConfig } from "next-auth";

// Edge-compatible half of a SEPARATE, PARALLEL Auth.js instance for the
// platform plane (D2 — plan §"Platform auth requirements"). This is NOT a
// modification of src/auth.config.ts; it is its own file, its own cookie,
// its own login page, deliberately never imported by tenant code.
//
// Same edge/node split reasoning as src/auth.config.ts: middleware.ts runs
// in the Edge runtime and can't load Prisma's Node engine or bcryptjs, so
// this file carries only what an edge-safe NextAuth instance needs — no
// Credentials provider, no DB, no bcrypt. src/lib/platform-auth.ts extends
// this with the real provider for use in Node route handlers.

/** Separate session cookie name — the whole point of D2's "own cookie"
 * requirement. Must never collide with next-auth's tenant-side default
 * (`authjs.session-token` in v5, unprefixed in dev / `__Secure-` prefixed
 * in prod) so a browser can hold a live tenant session and a live platform
 * session at the same time without either overwriting the other, and so a
 * platform JWT is never presented as a tenant session cookie or vice versa. */
export const PLATFORM_SESSION_COOKIE = "algopbx-platform-session";

export default {
  trustHost: true,
  // Distinct from next-auth's default `/api/auth` — the tenant instance
  // (src/auth.ts) already owns that path via
  // src/app/api/auth/[...nextauth]/route.ts. Route handler for THIS
  // instance lives at src/app/api/platform-auth/[...nextauth]/route.ts.
  // Every next-auth/react call site for the platform plane (signIn() in
  // src/app/platform/login/login-form.tsx) must pass
  // `basePath: "/api/platform-auth"` explicitly — its default client only
  // knows about `/api/auth`.
  basePath: "/api/platform-auth",
  session: {
    strategy: "jwt",
    // Shorter than the tenant session's 8h (auth.config.ts) — this console
    // reaches every tenant's data via a support grant; a stolen platform
    // session is a much higher-value target than a stolen agent session.
    maxAge: 4 * 60 * 60,
  },
  pages: { signIn: "/platform/login" },
  cookies: {
    sessionToken: {
      name: PLATFORM_SESSION_COOKIE,
    },
  },
  // No providers here — see file header comment. platform-auth.ts adds the
  // real Credentials provider (password + mandatory TOTP) Node-side.
  providers: [],
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        // Cast, not a `declare module "next-auth"` augmentation: this repo
        // already augments next-auth's `Session`/`User` types once, for the
        // TENANT plane's Role union ("AGENT"|"SUPERVISOR"|"ADMIN") — see
        // src/types/next-auth.d.ts. A second global augmentation for the
        // platform plane's incompatible PlatformRole union
        // ("PLATFORM_OWNER"|"PLATFORM_SUPPORT") would conflict with that
        // declaration merge (same `Session.user.role` property, two
        // incompatible literal types). Casting locally at the two call
        // sites that need it (here, and platform-guard.ts) avoids that
        // collision entirely — same "cast, don't fight the types" approach
        // src/auth.config.ts's own comment already documents for the JWT
        // type specifically.
        token.role = (user as unknown as { role: string }).role;
      }
      return token;
    },
    session: ({ session, token }) => {
      session.user.id = token.sub!;
      (session.user as unknown as { role: string }).role = token.role as string;
      return session;
    },
  },
} satisfies NextAuthConfig;
