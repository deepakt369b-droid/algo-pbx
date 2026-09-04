import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
// Legitimate direct unsafeGlobalDb use (see that export's own doc comment
// in src/lib/db.ts): login runs BEFORE any tenant is known — you need an
// unscoped read of User (keyed by email, which stays globally unique per
// plan §1) to find out which tenant this credential belongs to in the
// first place. Nothing here reads/writes any OTHER tenant's data as a
// side effect of that lookup.
import { unsafeGlobalDb } from "@/lib/db";
import authConfig from "@/auth.config";
import { checkLoginRateLimit, clearLoginAttempts, recordLoginFailure, getClientIp } from "@/lib/rate-limit";
import { isProfileComplete } from "@/lib/registration";
import { OTP_VERIFIED_COOKIE, verifyOtpVerifiedToken } from "@/lib/two-factor";

/** Auth.js hands authorize() a standard Web API Request, not a
 * NextRequest — no `.cookies` convenience, just a raw Cookie header to
 * parse. Minimal parser, only needs exact-name lookup. */
function readCookie(request: Request | undefined, name: string): string | undefined {
  const header = request?.headers?.get?.("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

// Full (Node.js-only) Auth.js instance — do NOT import this from
// middleware.ts. It pulls in Prisma and bcryptjs, neither of which run in
// the Edge runtime; middleware builds its own edge-safe instance directly
// from auth.config.ts instead. See that file's comment for why the split
// exists, and nextauthjs/next-auth docs/pages/guides/edge-compatibility.mdx
// for the upstream-documented pattern this follows.
//
// Credentials `authorize` pattern confirmed against
// nextauthjs/next-auth docs/pages/getting-started/authentication/credentials.mdx.

const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

// Fail fast at boot, not on the first request. NextAuth reads AUTH_SECRET
// from the environment implicitly and, if it's unset, degrades to
// unpredictable/insecure JWT signing behavior rather than refusing to
// start — the previous behavior here. An unset secret in production is a
// deployment misconfiguration serious enough to warrant crashing the
// process on boot rather than silently serving broken auth.
//
// EXCLUDES the production BUILD phase, not just development — this file
// is imported by every page during `next build`'s page-data-collection
// step, which runs with NODE_ENV=production internally regardless of the
// ambient environment. docker-compose.yml (correctly) supplies
// AUTH_SECRET only at container RUNTIME, not as a Docker build arg —
// secrets generally shouldn't be baked into an image layer — so without
// this exclusion, `docker compose build` would fail this check on every
// single build, unable to ever produce an image at all. This is the same
// class of "build time vs. runtime" confusion as the NEXT_PUBLIC_SIP_*
// bug fixed via GET /api/config/public; discovered by actually running
// `npm run build` end-to-end rather than only type-checking.
// process.env.NEXT_PHASE, not an import-time constant, is how Next.js
// itself signals this — see PHASE_PRODUCTION_BUILD's own doc comment in
// next/constants.
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD
) {
  const secret = process.env.AUTH_SECRET ?? "";
  // Loop B1c: a *presence* check alone let the literal `change-me` from the
  // committed .env.example through — booting with a publicly-known JWT
  // signing key, from which any authenticated user can forge an ADMIN
  // session (compounded by the jwt callback not re-reading `role`, now
  // fixed below). Reject the known placeholder and anything with too little
  // entropy. `openssl rand -base64 33` yields 44 chars.
  const PLACEHOLDERS = new Set(["change-me", "changeme", "secret", "REPLACE_ME", "your-secret-here"]);
  if (!secret || PLACEHOLDERS.has(secret) || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET is missing, a known placeholder, or too short (need >=32 random chars). Generate one with `openssl rand -base64 33`."
    );
  }
}

// A fixed, valid bcrypt hash with no corresponding plaintext — compared
// against on every login attempt for an email that doesn't exist, so the
// unknown-user path costs the same ~200ms bcrypt.compare() the real-user
// path does. Before this, an unknown email returned `null` immediately
// (auth.ts used to `if (!user) return null;` with no compare at all),
// which is trivially distinguishable by response timing — a textbook user-
// enumeration oracle. The hash below is bcrypt("no-such-user-dummy-hash", 12);
// its plaintext is never used anywhere and doesn't need to be secret.
const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Q9E3JJ7bTf2BzJhLmyxwaMH.87UbG";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { type: "email", label: "Email" },
        password: { type: "password", label: "Password" },
      },
      authorize: async (rawCredentials, request) => {
        const parsed = CredentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        // Loop B1: take the proxy-appended (last) X-Forwarded-For entry,
        // not the client-controlled first one. Plus recordLoginFailure now
        // also maintains an email-only aggregate bucket a forged header
        // cannot evade.
        const ip = getClientIp(request?.headers);

        const rateLimit = await checkLoginRateLimit(email, ip);
        if (!rateLimit.allowed) {
          // Auth.js's CredentialsSignin error carries no detail to the
          // client by design (see login-form.tsx's generic message) — the
          // lockout state itself is intentionally not distinguishable from
          // "wrong password" in the UI, only in server logs, so a lockout
          // can't be used to enumerate which accounts exist either.
          return null;
        }

        const user = await unsafeGlobalDb.user.findUnique({
          where: { email },
          include: { extension: true },
        });

        // Constant-time-ish path: always run a bcrypt.compare, whether or
        // not the user exists and whether or not they've completed their
        // invite (passwordHash null — see Invite's schema comment). Using
        // DUMMY_HASH in both of those cases keeps the timing profile
        // identical to a real wrong-password attempt.
        const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
        const validPassword = await bcrypt.compare(password, hashToCompare);

        if (!user || !user.passwordHash || !validPassword) {
          await recordLoginFailure(email, ip, user?.id);
          return null;
        }

        if (user.disabled) {
          // Deliberately still record this as a generic failure rather than
          // a distinguishable "account disabled" response — see the
          // rate-limit comment above for the same enumeration-avoidance
          // reasoning.
          await recordLoginFailure(email, ip, user.id);
          return null;
        }

        // 2FA gate (Workstream 6): a correct password is necessary but,
        // for a user with a verified phone, no longer SUFFICIENT — an
        // otp_verified cookie (set by POST /api/auth-2fa/pre-login when
        // the device is already trusted, or by POST /api/auth-2fa/verify
        // after a fresh OTP round-trip) must also be present and valid
        // for THIS user id. login-form.tsx always calls pre-login before
        // ever reaching this signIn() call, so a legitimate flow always
        // has one; a request that skips straight to signIn() with just a
        // password does not, and is rejected here — same generic failure
        // shape as every other rejection path in this function. Users
        // with no verified phone (registration incomplete) are exempt —
        // pre-login itself already fails open for them, see that route's
        // comment for why an agent must be able to sign in to REACH
        // registration in the first place.
        // phoneVerifiedByAdminId set = an admin override, not a real OTP
        // round-trip — exempt from the 2FA cookie requirement for the
        // same reason POST /api/auth-2fa/pre-login exempts it: an
        // admin-provisioned agent (POST /api/admin/users with a
        // password) may exist before any WhatsApp instance is CONNECTED
        // to challenge them over, which would otherwise make their very
        // first login impossible.
        if (user.phoneE164 && user.phoneVerifiedAt && !user.phoneVerifiedByAdminId) {
          const cookieToken = readCookie(request, OTP_VERIFIED_COOKIE);
          if (!verifyOtpVerifiedToken(cookieToken, user.id)) {
            await recordLoginFailure(email, ip, user.id);
            return null;
          }
        }

        await clearLoginAttempts(email, ip);

        // Sign-in visibility (agent-registration plan, Workstream 4) —
        // every successful sign-in is audit-logged so the admin panel's
        // /admin/sign-ins feed has something to show. "New device" is a
        // simple heuristic: has this exact user-agent string signed in
        // from this user before, per the AuditLog history? Not
        // cryptographically rigorous (a spoofed UA defeats it), but this
        // flag is a supervisor-visibility signal, not the login-2FA
        // trusted-device mechanism (TrustedDevice, separate and stronger
        // — see /api/auth/verify-2fa).
        const userAgent = request?.headers?.get?.("user-agent") ?? "unknown";
        const seenBefore = await unsafeGlobalDb.auditLog.findFirst({
          where: {
            action: "auth.signin",
            actorId: user.id,
            tenantId: user.tenantId,
            metadata: { path: ["userAgent"], equals: userAgent },
          },
          select: { id: true },
        });
        // Written via unsafeGlobalDb (login has no tenantDb() yet — the
        // tenant is only just now known, from `user` above), so tenantId
        // is supplied explicitly here rather than by a scoped client.
        await unsafeGlobalDb.auditLog.create({
          data: {
            action: "auth.signin",
            actorId: user.id,
            tenantId: user.tenantId,
            metadata: { ip, userAgent, newDevice: !seenBefore },
          },
        });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          extension: user.extension?.number ?? null,
          disabled: user.disabled,
          profileComplete: isProfileComplete(user),
          // Wave 2a (plan §1/§2): tenant is derived from the user row, not
          // from the request host — see the plan's "email uniqueness
          // decision" for why (tenant is a property of WHO you are, not
          // WHERE you signed in). unsafeGlobalDb.user.findUnique above doesn't select
          // tenantId explicitly, but it's a plain scalar column on User
          // returned by the default field set.
          tenantId: user.tenantId,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Overrides auth.config.ts's edge-safe jwt callback with a Node-side
    // version that also does a LIVE Postgres read of User.disabled on
    // every request (not just at sign-in). This is the actual fix for "a
    // terminated or compromised account stays valid until the JWT
    // expires" — auth.config.ts's session.maxAge (now 8h, was the 30-day
    // default) bounds the worst case, but a supervisor disabling an agent
    // mid-shift needs that to take effect on the AGENT'S NEXT REQUEST, not
    // up to 8 hours later. The tradeoff accepted here is one extra DB
    // query per authenticated request — acceptable for a call-center-sized
    // user base; revisit with a cache/short-TTL check if this ever needs
    // to scale to a user count where that query becomes a bottleneck.
    jwt: async ({ token, user }) => {
      if (user) {
        token.role = user.role;
        token.extension = user.extension;
        token.disabled = user.disabled;
        token.profileComplete = user.profileComplete ?? false;
        // Wave 2a (plan §1/§2): set on the initial sign-in leg; the
        // live-reread branch below refreshes it on every subsequent
        // request the same way it refreshes role/extension.
        token.tenantId = user.tenantId;
        return token;
      }
      if (token.sub) {
        const dbUser = await unsafeGlobalDb.user.findUnique({
          where: { id: token.sub },
          select: {
            disabled: true, name: true, address: true, phoneE164: true,
            phoneVerifiedAt: true, passwordChangedAt: true,
            // Loop B2b: re-read role/extension live, same as `disabled`.
            // Without this a demotion (SUPERVISOR -> AGENT) or an extension
            // reassignment did not take effect until the JWT expired (up to
            // 8h) — the demoted user kept minting SIP secrets and creating
            // accounts, and the old extension holder kept passing
            // canAccessRecording()/canAccessMailbox() for the new owner.
            role: true,
            extension: { select: { number: true } },
            // Wave 2a: re-read live for the same reason as role/extension
            // above. In practice a User's tenantId is not expected to
            // change post-creation (no reassignment UI exists), but
            // re-reading it live costs nothing extra on a query this
            // route already makes every request, and it means a future
            // "move user to another tenant" admin action (should one ever
            // ship) takes effect on the user's very next request rather
            // than needing them to sign out and back in.
            tenantId: true,
          },
        });
        // A deleted user (dbUser === null) is treated the same as
        // disabled — there is no user-delete route today (only disable),
        // but this fails safe if one is ever added without updating this
        // check.
        //
        // Loop C3 — a password reset (self-service or admin-triggered)
        // must kill every OTHER outstanding session on its next request,
        // not just future logins (the whole point of a reset after a
        // suspected compromise). Reuses the exact same `disabled`
        // enforcement path every guard already checks (auth-guard.ts,
        // middleware.ts) rather than adding a second live-check
        // everywhere: a token issued BEFORE the most recent
        // passwordChangedAt is treated as disabled, same as a real
        // account revocation. next-auth stamps `iat` (unix seconds) on
        // every JWT automatically.
        const passwordChangedAfterToken =
          dbUser?.passwordChangedAt != null && typeof token.iat === "number" && dbUser.passwordChangedAt.getTime() > token.iat * 1000;
        token.disabled = (dbUser?.disabled ?? true) || passwordChangedAfterToken;
        if (dbUser) {
          token.role = dbUser.role;
          token.extension = dbUser.extension?.number ?? null;
          token.tenantId = dbUser.tenantId;
        }
        // Recomputed live on every request, same as `disabled` — an
        // agent who completes registration mid-session (or has it
        // overridden by an admin) sees the gate lift on their very next
        // request rather than needing to sign out and back in.
        token.profileComplete = dbUser ? isProfileComplete(dbUser) : false;
      }
      return token;
    },
  },
});
