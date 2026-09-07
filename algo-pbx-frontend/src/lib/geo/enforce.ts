// The side-effecting wrapper around W4's pure evaluateGeoAccess() (plan
// §3.3, node W5). geo-decision.ts deliberately has zero Prisma/fs/network
// imports so it stays unit-testable without a live Postgres connection or
// a real mmdb file; this module is what actually resolves an IP (geoip.ts),
// reads the tenant/extension's stored geo config, calls the pure decision,
// and performs the DB writes that decision implies.
//
// Called from TWO call sites with genuinely different Prisma clients
// available:
//   - src/auth.ts's authorize() — no tenant-scoped client exists yet (the
//     tenant is only just now known, from the `user` row `authorize()`
//     just loaded via unsafeGlobalDb — same "legitimate unsafeGlobalDb
//     exception" documented on that file's own import of it).
//   - GET /api/me/sip-credentials — already has a TenantClient from
//     requireSession() (src/lib/auth-guard.ts).
// `GeoEnforceDb` below is therefore a small, HAND-WRITTEN interface
// carrying only the exact calls this module makes, not a `Pick<>` of the
// real `PrismaClient` type — Prisma's `$extends()` return type
// (`TenantClient`, src/lib/db-tenant.ts) is generic over an internal
// `InternalArgs` type parameter that doesn't structurally unify with the
// concrete `PrismaClient` type's own delegate signatures (confirmed by
// `tsc`: a `Pick<PrismaClient, ...>` version of this type rejects a real
// `TenantClient` argument with a wall of generic-argument mismatches).
// A hand-written interface sidesteps that entirely: both `unsafeGlobalDb`
// and any `tenantDb(tenantId)` TenantClient satisfy it structurally
// (each's actual delegate methods are strictly more general — more
// permissive `args`, richer `Promise<...>` results — than what's declared
// here), so either can be passed in with no cast.

import type { Prisma } from "@prisma/client";

export interface GeoEnforceDb {
  tenant: {
    findUnique(args: {
      where: { id: string };
      select: { geoLockMode: true; geoDefaultCountry: true; geoBlockVpn: true; geoFailureThreshold: true };
    }): Promise<{
      geoLockMode: string | null;
      geoDefaultCountry: string | null;
      geoBlockVpn: boolean;
      geoFailureThreshold: number | null;
    } | null>;
  };
  extension: GeoEnforceExtensionDelegate;
  geoLoginEvent: {
    create(args: {
      data: {
        tenantId: string;
        extensionId: string;
        userId: string;
        email: string;
        ip: string;
        country: string | null;
        asn: number | null;
        asnOrg: string | null;
        outcome: string;
        counted: boolean;
      };
    }): Promise<unknown>;
  };
  auditLog: {
    create(args: {
      data: {
        action: string;
        actorId: string;
        tenantId: string;
        metadata: Prisma.InputJsonValue;
      };
    }): Promise<unknown>;
  };
  // Interactive transaction, same shape distinction as the rest of this
  // interface's header comment — a hand-written signature (not a Pick<> of
  // the real PrismaClient/TenantClient $transaction overload) so both
  // `unsafeGlobalDb` and any `tenantDb(tenantId)` TenantClient satisfy it
  // structurally with no cast. Only `extension` needs to be reachable
  // inside the callback: the read-decide-write sequence for
  // `geoFailedAttempts`/`geoLockedAt` (the one subject to the
  // read-then-write race this transaction exists to close) is the only
  // part of this module's DB work that reads a row and later writes back a
  // value derived from that read.
  $transaction<T>(fn: (tx: GeoEnforceTx) => Promise<T>): Promise<T>;
}

/** The subset of `GeoEnforceDb` reachable from inside `$transaction`'s callback. */
export interface GeoEnforceTx {
  extension: GeoEnforceExtensionDelegate;
}

interface GeoEnforceExtensionDelegate {
  findUnique(args: {
    where: { id: string };
    select: { geoAllowedCountries: true; geoFailedAttempts: true; geoLockedAt: true };
  }): Promise<{ geoAllowedCountries: string[]; geoFailedAttempts: number; geoLockedAt: Date | null } | null>;
  update(args: {
    where: { id: string };
    data: {
      // A plain number for the two absolute writes (reset-to-zero on a
      // clean pass; nothing else ever sets an absolute value here). The
      // strike-counting write uses `{ increment: 1 }` instead — see
      // enforceGeoAccess()'s own comment on why an absolute
      // `currentAttempts + 1` is a read-then-write race between two
      // concurrent evaluations of the same extension.
      geoFailedAttempts?: number | { increment: number };
      geoLastFailureAt?: Date;
      geoLastFailureCountry?: string | null;
      geoLastFailureIp?: string;
      geoLastFailureAsn?: number | null;
      geoLockedAt?: Date;
      geoLockedReason?: string;
    };
  }): Promise<unknown>;
}

import { evaluateGeoAccess, type GeoDecision } from "./geo-decision";
import { isGeoDatabaseAvailableAsync, lookupIp } from "./geoip";
import { reprovisionPjsipExcludingLocked } from "@/lib/pjsip-provision";

export type GeoEnforceInput = {
  tenantId: string;
  /** The Extension row this login/request is for. Per-extension is the
   * whole shape of this feature (Extension carries geoAllowedCountries /
   * geoFailedAttempts / geoLockedAt) — a user with no linked Extension at
   * all (most ADMIN/SUPERVISOR accounts) is simply out of scope for this
   * mechanism; callers must not invoke enforceGeoAccess() for such a user
   * (see src/auth.ts's call site for the guard). */
  extensionId: string;
  email: string;
  /** Always a real, already-authenticated user id at both call sites
   * (src/auth.ts's authorize() only reaches this after a valid password —
   * and, where required, 2FA cookie — check; GET /api/me/sip-credentials
   * only reaches this behind requireSession()). Not nullable: AuditLog.actorId
   * is a required column, and there is no legitimate call shape where this
   * function runs for an unauthenticated caller. */
  userId: string;
  ip: string;
};

const DEFAULT_THRESHOLD = 6;

// Best-effort, in-memory rate limit for the "geo is configured but the
// database is unavailable" AuditLog row — NOT for GeoLoginEvent (every
// evaluation gets one of those regardless; that table's whole purpose is a
// complete evidence trail) and not for the lock/unlock semantics
// themselves. Without this, every single login attempt while a volume
// mount is broken would write its own AuditLog row — one per agent per
// login, potentially hundreds an hour. A per-tenant, per-process, one-hour
// window is a deliberately simple bound: it resets on redeploy/restart,
// which is acceptable for a "loud, not silent" signal rather than a
// precise audit record (GeoLoginEvent already is the precise one).
const dbUnavailableAuditedAt = new Map<string, number>();
const DB_UNAVAILABLE_AUDIT_INTERVAL_MS = 60 * 60 * 1000;

function shouldWriteDbUnavailableAudit(tenantId: string, now: number): boolean {
  const last = dbUnavailableAuditedAt.get(tenantId);
  if (last !== undefined && now - last < DB_UNAVAILABLE_AUDIT_INTERVAL_MS) return false;
  dbUnavailableAuditedAt.set(tenantId, now);
  return true;
}

function lockedReasonFor(decision: GeoDecision, country: string | null): string {
  if (decision.outcome === "vpn_suspected") {
    return "Repeated sign-in attempts from a hosting/VPN-range ASN.";
  }
  return `Repeated sign-in attempts from an unexpected country${country ? ` (${country})` : ""}.`;
}

/**
 * Resolves the geo lookup, evaluates W4's pure decision, and persists
 * every side effect it implies: geoFailedAttempts increment/reset,
 * geoLockedAt/geoLockedReason on the strike that crosses the threshold, a
 * GeoLoginEvent row for this evaluation (always — the evidence trail the
 * owner reads before unlocking, plan §3.3), and — when this call is the
 * one that newly locks the extension — a re-provision of pjsip_dynamic.conf
 * excluding it (enforcement point 3) plus a `"geo.extension_locked"`
 * AuditLog row. Returns the `GeoDecision` unchanged so the caller decides
 * the actual HTTP/redirect response.
 *
 * Never throws for an ordinary "geo database unavailable" condition — see
 * evaluateGeoAccess()'s own `db_unavailable` branch, which fails OPEN. A
 * genuine DB error reading Tenant/Extension (Postgres down) is NOT caught
 * here; that is a wider outage than this feature is responsible for
 * degrading gracefully around, and the caller's own error handling (route
 * handler / authorize()'s surrounding try, if any) applies as normal.
 */
function dbUnavailableDecision(): GeoDecision {
  return {
    outcome: "db_unavailable",
    allowed: true,
    shouldCount: false,
    shouldLock: false,
    shouldResetCounter: false,
    remainingAttempts: null,
    agentMessage: null,
  };
}

export async function enforceGeoAccess(db: GeoEnforceDb, input: GeoEnforceInput): Promise<GeoDecision> {
  const tenant = await db.tenant.findUnique({
    where: { id: input.tenantId },
    select: { geoLockMode: true, geoDefaultCountry: true, geoBlockVpn: true, geoFailureThreshold: true },
  });

  // Caller resolved the tenant just before calling this — a null here
  // means a race (tenant deleted mid-request) or a caller bug. Fail open
  // rather than throw out of the auth/credential path.
  if (!tenant) {
    return dbUnavailableDecision();
  }

  const mode = tenant.geoLockMode as "off" | "monitor" | "enforce" | null;
  const dbAvailable = await isGeoDatabaseAvailableAsync();
  // Only spend a real lookup when the database is actually loaded and the
  // tenant has geo configured at all — an "off" tenant (the overwhelming
  // majority until H3 flips anyone to monitor/enforce) should not pay for
  // an mmdb read on every login.
  const lookup = dbAvailable && mode !== "off" && mode !== null ? await lookupIp(input.ip) : null;

  const threshold = tenant.geoFailureThreshold ?? DEFAULT_THRESHOLD;
  const now = new Date();

  // --- The read-decide-write sequence for this extension's counter runs
  // inside one transaction (same style as POST /api/platform/geo-locks/[id]
  // wrapping its own read-check-then-conditionally-write sequence) so two
  // concurrent evaluations of the SAME extension (e.g. a login racing a
  // GET /api/me/sip-credentials re-check moments later) serialize rather
  // than both reading the same stale `geoFailedAttempts` and each writing
  // their own `N + 1` — which would silently under-count real strikes.
  // The strike-counting write itself additionally uses an atomic
  // `{ increment: 1 }` rather than a computed absolute number, which is
  // what actually removes the race at the SQL level for that specific
  // field regardless of transaction isolation; the transaction wrapper
  // keeps the increment and any same-evaluation lock write committing
  // together. The "reset to 0" and "set geoLockedAt" writes stay absolute
  // sets — an increment doesn't mean anything for a reset or a lock flag.
  const { decision, extensionMissing } = await db.$transaction(async (tx) => {
    const extension = await tx.extension.findUnique({
      where: { id: input.extensionId },
      select: { geoAllowedCountries: true, geoFailedAttempts: true, geoLockedAt: true },
    });

    // Extension deleted mid-request, or a caller bug — same fail-open
    // reasoning as the missing-tenant branch above.
    if (!extension) {
      return { decision: null, extensionMissing: true as const };
    }

    const decision = evaluateGeoAccess({
      ip: input.ip,
      lookup,
      dbAvailable: dbAvailable && lookup !== null,
      allowedCountries: extension.geoAllowedCountries,
      tenantDefaultCountry: tenant.geoDefaultCountry,
      mode,
      blockVpn: tenant.geoBlockVpn,
      currentAttempts: extension.geoFailedAttempts,
      threshold,
      alreadyLocked: extension.geoLockedAt != null,
    });

    // --- Persist the extension-side effects the decision implies. Skipped
    // entirely in monitor mode: monitor is purely observational (plan
    // §3.3) and must touch nothing on Extension, only ever write the
    // GeoLoginEvent evidence row below. Without this guard, a clean pass
    // in monitor mode (evaluateGeoAccess() returns `shouldResetCounter:
    // true` even in monitor — see geo-decision.ts) would zero out real
    // strike history accrued from an earlier enforce-mode run, destroying
    // the evidence an operator needs to judge whether it's safe to flip
    // back to enforce.
    if (
      mode !== "monitor" &&
      (decision.shouldResetCounter || decision.shouldCount || decision.shouldLock)
    ) {
      const data: {
        geoFailedAttempts?: number | { increment: number };
        geoLastFailureAt?: Date;
        geoLastFailureCountry?: string | null;
        geoLastFailureIp?: string;
        geoLastFailureAsn?: number | null;
        geoLockedAt?: Date;
        geoLockedReason?: string;
      } = {};

      if (decision.shouldResetCounter) {
        data.geoFailedAttempts = 0;
      } else if (decision.shouldCount) {
        data.geoFailedAttempts = { increment: 1 };
        data.geoLastFailureAt = now;
        data.geoLastFailureCountry = lookup?.country ?? null;
        data.geoLastFailureIp = input.ip;
        data.geoLastFailureAsn = lookup?.asn ?? null;
      }

      if (decision.shouldLock) {
        data.geoLockedAt = now;
        data.geoLockedReason = lockedReasonFor(decision, lookup?.country ?? null);
      }

      await tx.extension.update({ where: { id: input.extensionId }, data });
    }

    return { decision, extensionMissing: false as const };
  });

  if (extensionMissing || !decision) {
    return dbUnavailableDecision();
  }

  // --- The evidence trail. Written for EVERY evaluation, including plain
  // allows — plan §3.3: "the last 50 GeoLoginEvent rows as the evidence an
  // operator reads before deciding" only works if allowed attempts are in
  // there too, otherwise a locked extension's history looks like nothing
  // but strikes with no context for what "normal" looked like.
  await db.geoLoginEvent.create({
    data: {
      tenantId: input.tenantId,
      extensionId: input.extensionId,
      userId: input.userId,
      email: input.email,
      ip: input.ip,
      country: lookup?.country ?? null,
      asn: lookup?.asn ?? null,
      asnOrg: lookup?.asnOrg ?? null,
      outcome: decision.outcome,
      counted: decision.shouldCount,
    },
  });

  // --- Fail open, LOUDLY (plan §3.3): a tenant that has actually
  // configured geo enforcement, on a request where the mmdb database
  // turned out to be unavailable, gets a rate-limited AuditLog row (see
  // this module's own rate-limit comment above) rather than nothing at
  // all. An "off" tenant (mode null/"off") never enforces regardless of
  // database state, so there is nothing worth flagging for it.
  if ((mode === "monitor" || mode === "enforce") && !dbAvailable) {
    if (shouldWriteDbUnavailableAudit(input.tenantId, now.getTime())) {
      await db.auditLog.create({
        data: {
          action: "geo.database_unavailable",
          actorId: input.userId,
          tenantId: input.tenantId,
          metadata: {
            mode,
            note: "Geo-lock is configured but the GeoIP database is unavailable — enforcement is OFF.",
            telephonyAffected: false,
          },
        },
      });
    }
  }

  // --- Enforcement point 3: an extension that just transitioned into
  // being locked must stop being reachable as a registered PJSIP endpoint,
  // not only fail its next credential fetch — see
  // src/lib/pjsip-provision.ts's reprovisionPjsipExcludingLocked() for why
  // this is the exact same regeneration path extension edits already use,
  // not a new one. Also the single source of truth for the
  // "geo.extension_locked" audit row, so it fires identically whichever
  // call site (login vs. the live sip-credentials recheck) is the one that
  // actually crosses the threshold.
  if (decision.shouldLock) {
    await db.auditLog.create({
      data: {
        action: "geo.extension_locked",
        actorId: input.userId,
        tenantId: input.tenantId,
        metadata: {
          extensionId: input.extensionId,
          country: lookup?.country ?? null,
          ip: input.ip,
          asn: lookup?.asn ?? null,
          outcome: decision.outcome,
          telephonyAffected: true,
        },
      },
    });
    // Best-effort: a PJSIP reload failure (AMI down, a stale config that
    // needs a full container restart — see regeneratePjsipConfigAndReload()'s
    // own comment on this Asterisk build's reload quirks) must not turn
    // into an unhandled exception out of authorize()/sip-credentials and
    // break the login/credential-fetch response the caller is about to
    // send. The extension is still locked at the database level (the
    // decisive fact for both GET /api/me/sip-credentials's 403 and any
    // future login attempt) even if the live PJSIP endpoint removal itself
    // has to wait for the next successful regeneration or a manual restart.
    await reprovisionPjsipExcludingLocked(input.tenantId).catch((err) => {
      console.error("enforceGeoAccess: PJSIP re-provision after geo-lock failed", err);
    });
  }

  return decision;
}
