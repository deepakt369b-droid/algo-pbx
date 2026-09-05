import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { unsafeGlobalDb as db } from "@/lib/db";
import platformAuthConfig from "@/lib/platform-auth.config";
import { checkSimpleRateLimit, getClientIp } from "@/lib/rate-limit";
import { verifyTotpCode } from "@/lib/platform-totp";

// Full (Node.js-only) Auth.js instance for the PLATFORM plane — separate
// and parallel to src/auth.ts, per D2. Never import this from
// src/middleware.ts's edge path; see platform-auth.config.ts's header
// comment for why (same reasoning as auth.config.ts / auth.ts's split).

// Same boot-time secret validation as src/auth.ts, duplicated rather than
// imported: this file is deliberately self-contained (not a modification
// of auth.ts, not coupled to it), and the check is cheap. Both instances
// happen to read the same AUTH_SECRET — that's fine: the cookie NAME is
// what keeps the two session spaces apart (see platform-auth.config.ts),
// not a distinct signing secret. A dedicated PLATFORM_AUTH_SECRET could be
// introduced later with zero migration cost (NextAuth config is per-file)
// if that separation is ever judged necessary.
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD
) {
  const secret = process.env.AUTH_SECRET ?? "";
  const PLACEHOLDERS = new Set(["change-me", "changeme", "secret", "REPLACE_ME", "your-secret-here"]);
  if (!secret || PLACEHOLDERS.has(secret) || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET is missing, a known placeholder, or too short (need >=32 random chars). Generate one with `openssl rand -base64 33`."
    );
  }
}

const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  // TOTP is a single-shot 6-digit code, not a delivered OTP — unlike the
  // tenant plane's WhatsApp 2FA (two-phase: pre-login, then a separate
  // verify step once a code has been SENT), the platform login form
  // collects password + TOTP code together in one submit, since the code
  // already lives in the operator's authenticator app before they ever
  // load the page.
  //
  // Optional/blank here on purpose: an account with no CONFIRMED secret yet
  // (freshly created by scripts/create-platform-user.mjs) has no code to
  // enter. authorize() below still hard-blocks that account from anywhere
  // but /platform/setup — this schema just has to not reject the blank
  // field the login form submits on that first attempt.
  code: z.union([z.string().regex(/^\d{6}$/), z.literal("")]).optional().default(""),
});

// Same user-enumeration-timing defense as src/auth.ts's DUMMY_HASH — a
// fixed valid bcrypt hash with no corresponding plaintext, compared
// against on every login for an email that doesn't exist so that path
// costs the same bcrypt.compare() time as a real wrong-password attempt.
const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Q9E3JJ7bTf2BzJhLmyxwaMH.87UbG";

export const {
  handlers: platformHandlers,
  auth: platformAuth,
  signIn: platformSignIn,
  signOut: platformSignOut,
} = NextAuth({
  ...platformAuthConfig,
  providers: [
    Credentials({
      credentials: {
        email: { type: "email", label: "Email" },
        password: { type: "password", label: "Password" },
        code: { type: "text", label: "Authenticator code" },
      },
      authorize: async (rawCredentials, request) => {
        const parsed = CredentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;
        const { email, password, code } = parsed.data;
        const ip = getClientIp(request?.headers);

        // Separate rate-limit keyspace from tenant logins — plan's
        // "separate rate limits" requirement. src/lib/rate-limit.ts's
        // primary limiter (checkLoginRateLimit / LoginAttempt table) is
        // DB-backed but its schema requires a tenantId (LoginAttempt is a
        // customer-owned model per wave 1's schema), which a platform login
        // attempt fundamentally doesn't have — there is no tenant to
        // attribute a platform-plane login attempt to. Rather than force a
        // fake tenantId into that table (which would pollute a real
        // tenant's rate-limit rows, or require inventing a sentinel tenant
        // just for this), this reuses rate-limit.ts's OTHER exported
        // limiter, checkSimpleRateLimit() — already designed for exactly
        // "a separate keyspace, no DB table" via its `key` parameter — with
        // a `platform-login:` prefix so it can never collide with any
        // other caller's bucket. Documented tradeoff (same one
        // checkSimpleRateLimit's own comment already accepts for its other
        // callers): in-process, resets on restart. Acceptable here — this
        // console has a handful of operators, not thousands of agents, and
        // it sits behind mandatory TOTP besides.
        const perIpOk = checkSimpleRateLimit(`platform-login:${email}:${ip}`, 5, 15 * 60 * 1000);
        const aggregateOk = checkSimpleRateLimit(`platform-login-agg:${email}`, 20, 30 * 60 * 1000);
        if (!perIpOk || !aggregateOk) return null;

        const user = await db.platformUser.findUnique({ where: { email } });

        const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
        const validPassword = await bcrypt.compare(password, hashToCompare);
        if (!user || !validPassword) return null;
        if (user.disabled) return null;

        // Mandatory TOTP from day one (plan §"Platform auth requirements"),
        // but enforced two different ways depending on enrollment state:
        //
        // - Already enrolled (totpConfirmedAt set): a code is REQUIRED and
        //   must verify, exactly as before. Wrong/missing code -> no session.
        // - Not yet enrolled (fresh account from
        //   scripts/create-platform-user.mjs, or a script-issued password
        //   reset that cleared the old secret): password alone is enough to
        //   establish a session, but requirePlatformSession()
        //   (platform-guard.ts) refuses that session everywhere except
        //   /platform/setup until enrollment (and any forced password
        //   change) actually completes in-browser. This is NOT "let them
        //   into the console and prompt setup afterward" — it's "let them
        //   into the one screen that can complete setup, nothing else".
        if (user.totpConfirmedAt) {
          if (!user.totpSecret || !verifyTotpCode(user.totpSecret, code)) return null;
        }

        // Mirrors src/auth.ts's "every successful sign-in is audited"
        // convention, on the platform's own audit table.
        await db.platformAuditLog.create({
          data: {
            action: "platform.login",
            platformUserId: user.id,
            metadata: { ip },
          },
        });

        // lastLoginAt surfaces in the platform users list. The audit table
        // already holds every login, but "when did this account last sign
        // in" should be answerable at a glance rather than by querying an
        // audit log — a long-dormant account with standing access to every
        // tenant is exactly what an operator should notice and disable, and
        // a fact nobody can see easily is a fact nobody acts on.
        await db.platformUser.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        // Cast, not a `declare module "next-auth"` User augmentation — see
        // platform-auth.config.ts's comment on why a second global
        // augmentation for the platform plane isn't used here. Without
        // this cast, the ambient tenant-plane augmentation in
        // src/types/next-auth.d.ts (which requires `extension`,
        // `disabled`, etc. on next-auth's User type) applies globally to
        // BOTH NextAuth() instances — declaration merging isn't
        // per-instance — and rejects this object at compile time even
        // though it's exactly what the platform plane's own jwt/session
        // callbacks (platform-auth.config.ts) expect and use.
        return { id: user.id, email: user.email, name: user.name, role: user.role } as unknown as import("next-auth").User;
      },
    }),
  ],
});
