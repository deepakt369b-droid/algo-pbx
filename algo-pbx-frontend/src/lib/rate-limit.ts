// DB-backed rate limiting / lockout — there was previously no defense at
// all against unlimited online password guessing (grep for
// ratelimit|throttle|lockout|failedAttempts across src/ returned zero
// hits before this file). Backed by Postgres (LoginAttempt) rather than an
// in-memory Map so it survives a container restart and works correctly
// with multiple `web` replicas, and rather than adding Redis, which this
// stack has no other use for.
//
// Bucketed by (identifier, ip) — not identifier alone — so a single
// leaked/guessable account can't be used to fingerprint-limit an attacker
// away from other accounts, and a single IP hammering many different
// emails is still tracked and eventually locked per-pair. This is a
// pragmatic middle ground, not a substitute for a real WAF/edge rate
// limiter in front of the app if traffic volume ever justifies one.

import { db } from "@/lib/db";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const WINDOW_RESET_MS = 60 * 60 * 1000; // stale attempt counters older than this are treated as fresh

export interface RateLimitResult {
  allowed: boolean;
  lockedUntil?: Date;
}

export async function checkLoginRateLimit(email: string, ip: string): Promise<RateLimitResult> {
  const row = await db.loginAttempt.findUnique({ where: { email_ip: { email, ip } } });
  if (!row) return { allowed: true };

  if (row.lockedUntil && row.lockedUntil > new Date()) {
    return { allowed: false, lockedUntil: row.lockedUntil };
  }

  // Stale window — treat as a fresh bucket rather than accumulating
  // forever; a legitimate user who mistyped a password once last month
  // shouldn't be one attempt away from lockout today.
  if (Date.now() - row.updatedAt.getTime() > WINDOW_RESET_MS) {
    return { allowed: true };
  }

  return { allowed: true };
}

export async function recordLoginFailure(email: string, ip: string, userId?: string): Promise<void> {
  const existing = await db.loginAttempt.findUnique({ where: { email_ip: { email, ip } } });
  const stale = existing && Date.now() - existing.updatedAt.getTime() > WINDOW_RESET_MS;
  const nextAttempts = existing && !stale ? existing.attempts + 1 : 1;
  const lockedUntil = nextAttempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null;

  await db.loginAttempt.upsert({
    where: { email_ip: { email, ip } },
    create: { email, ip, attempts: nextAttempts, lockedUntil, userId },
    update: { attempts: nextAttempts, lockedUntil, userId },
  });
}

export async function clearLoginAttempts(email: string, ip: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { email, ip } });
}

// Generic per-key limiter for non-login write endpoints (e.g. admin invite
// sends, MCP write-tool calls, webhook-triggered API usage) that don't
// warrant their own table. Not persisted — an in-process token count is an
// acceptable tradeoff here since these are lower-value targets than the
// login endpoint and a restart simply resets to "fully allowed", not a
// vulnerability the way it would be for login.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkSimpleRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}
