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
      return session;
    },
  },
} satisfies NextAuthConfig;
