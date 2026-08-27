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

// Loop B1: the app is only ever reached through Caddy (docker-compose binds
// `web` to 127.0.0.1 and the firewall REJECTs :3000 from outside — see
// scripts/setup-firewall.sh). Caddy APPENDS the real peer address to any
// inbound X-Forwarded-For, so the LAST entry is the address Caddy actually
// saw — not the first, which is fully attacker-controlled. Taking `[0]`
// was the bug that made the lockout bypassable with a forged header.
export function getClientIp(headers: Headers | undefined): string {
  const xff = headers?.get?.("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const real = headers?.get?.("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const WINDOW_RESET_MS = 60 * 60 * 1000; // stale attempt counters older than this are treated as fresh

// Loop B1: the `(email, ip)` bucket is defeated by rotating a forged
// X-Forwarded-For. This second bucket is keyed on the email ALONE (ip
// column = the sentinel below), so it accumulates across every source
// address. Threshold is higher — a shared office NAT legitimately produces
// several failures/hour — but it is a hard ceiling an IP-rotating attacker
// cannot evade. A locked account here means "someone is brute-forcing
// this login"; a real user is told to wait or use password reset.
const AGGREGATE_IP_SENTINEL = "__any__";
const AGGREGATE_MAX_ATTEMPTS = 20;
const AGGREGATE_LOCKOUT_MS = 30 * 60 * 1000;

export interface RateLimitResult {
  allowed: boolean;
  lockedUntil?: Date;
}

async function checkBucket(email: string, ip: string): Promise<RateLimitResult> {
  const row = await db.loginAttempt.findUnique({ where: { email_ip: { email, ip } } });
  if (!row) return { allowed: true };
  if (row.lockedUntil && row.lockedUntil > new Date()) {
    return { allowed: false, lockedUntil: row.lockedUntil };
  }
  return { allowed: true };
}

export async function checkLoginRateLimit(email: string, ip: string): Promise<RateLimitResult> {
  const [perIp, aggregate] = await Promise.all([
    checkBucket(email, ip),
    checkBucket(email, AGGREGATE_IP_SENTINEL),
  ]);
  if (!perIp.allowed) return perIp;
  if (!aggregate.allowed) return aggregate;
  return { allowed: true };
}

async function bumpBucket(email: string, ip: string, max: number, lockoutMs: number, userId?: string): Promise<void> {
  const existing = await db.loginAttempt.findUnique({ where: { email_ip: { email, ip } } });
  const stale = existing && Date.now() - existing.updatedAt.getTime() > WINDOW_RESET_MS;
  const nextAttempts = existing && !stale ? existing.attempts + 1 : 1;
  const lockedUntil = nextAttempts >= max ? new Date(Date.now() + lockoutMs) : null;
  await db.loginAttempt.upsert({
    where: { email_ip: { email, ip } },
    create: { email, ip, attempts: nextAttempts, lockedUntil, userId },
    update: { attempts: nextAttempts, lockedUntil, userId },
  });
}

export async function recordLoginFailure(email: string, ip: string, userId?: string): Promise<void> {
  await Promise.all([
    bumpBucket(email, ip, MAX_ATTEMPTS, LOCKOUT_MS, userId),
    bumpBucket(email, AGGREGATE_IP_SENTINEL, AGGREGATE_MAX_ATTEMPTS, AGGREGATE_LOCKOUT_MS, userId),
  ]);
}

export async function clearLoginAttempts(email: string, ip: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { email, ip: { in: [ip, AGGREGATE_IP_SENTINEL] } } });
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
