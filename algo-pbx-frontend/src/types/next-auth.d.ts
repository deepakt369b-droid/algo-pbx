import type { DefaultSession } from "next-auth";

// Module augmentation for the custom fields added in src/auth.ts's
// jwt/session callbacks — without this, session.user.role etc. are `any`.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "AGENT" | "SUPERVISOR" | "ADMIN";
      extension: string | null;
      // Populated by src/auth.ts's Node-side jwt/session callback override
      // (NOT auth.config.ts's edge-safe base version, which cannot reach
      // Postgres) via a live DB read of User.disabled on every request —
      // see auth.ts's comment for the full revocation-latency rationale.
      // src/lib/auth-guard.ts treats a disabled session identically to no
      // session at all. Defaults to false when absent (e.g. a session
      // resolved only through the edge-safe config, before the Node
      // override has had a chance to run).
      disabled: boolean;
      // Same live-recompute pattern as `disabled` (src/auth.ts's Node jwt
      // override, re-checked on every request) — true once name, address,
      // a verified phoneE164 all exist (src/lib/registration.ts's
      // isProfileComplete()). src/middleware.ts redirects an AGENT session
      // with this false to /register; ADMIN/SUPERVISOR are never gated on
      // it. Defaults true here for the same "don't gate on an
      // uncomputed value" reason `disabled` defaults false.
      profileComplete: boolean;
      // Multi-tenant SaaS foundation, wave 2a (plan §1/§2). Populated the
      // same live-recompute way as `disabled`/`role` — src/auth.ts's
      // Node-side jwt callback override re-reads it from Postgres on every
      // request, not just at sign-in, so a tenant reassignment (should one
      // ever happen) takes effect immediately rather than waiting out the
      // JWT's maxAge. This is what src/lib/auth-guard.ts's guards hand to
      // `tenantDb()` to build the scoped Prisma client every route uses.
      // No default-empty-string fallback here on purpose: a session with
      // no live-verified tenantId must not silently resolve to "" and get
      // treated as some real tenant's id downstream.
      tenantId: string;
    } & DefaultSession["user"];
  }

  interface User {
    role: "AGENT" | "SUPERVISOR" | "ADMIN";
    extension: string | null;
    disabled?: boolean;
    profileComplete?: boolean;
    tenantId?: string;
  }
}

// NOTE: deliberately no `declare module "next-auth/jwt" { interface JWT ... }`
// augmentation here. next-auth's own jwt.d.ts is just `export * from
// "@auth/core/jwt"`, and @auth/core isn't hoisted to top-level node_modules
// (it lives nested at next-auth/node_modules/@auth/core) — so an augmentation
// written here never resolves to the same module identity NextAuthConfig's
// callback types actually reference, and silently fails to merge (token.role
// stays typed as `unknown` via JWT's Record<string, unknown> base). Confirmed
// by testing; not worth fighting. src/auth.config.ts casts explicitly at the
// one read site instead (see its session() callback).
