// Seat enforcement for the hybrid AI + human plan (contracts.md §"Seats").
//
// A "seat" is one `Extension` row, regardless of `agentType` — a HUMAN
// extension and an AI agent's extension consume the same capacity, so an
// AI-heavy tenant can't provision past `Tenant.seats` any more than an
// all-human one could. `Tenant.seats` is the plain integer column (default 4
// as of the schema in this plan); the plan/catalog seat CEILING
// (plan-catalog.ts) is a separate, higher-level check on what a plan allows
// a tenant to be assigned, not what's currently in use.
//
// Deliberately takes an injectable reader (mirrors `recordPlatformAudit`'s
// `tx` parameter in audit.ts) so this is unit-testable without a real
// Prisma client, while every real call site just calls
// `assertSeatAvailable(tenantId)` and gets `unsafeGlobalDb` for free.

import { unsafeGlobalDb as db } from "@/lib/db";
import type { SeatUsage } from "@/lib/ai/types";

/** Narrow slice of a Prisma client this module needs — declared with method
 * syntax (not property-function syntax) so TypeScript's bivariant method
 * checking lets both the real `PrismaClient` and a plain test double satisfy
 * it under `strictFunctionTypes`, same reasoning as `PlatformAuditWriter` in
 * audit.ts. */
export interface SeatGuardReader {
  tenant: {
    findUnique(args: { where: { id: string }; select: { seats: true } }): Promise<{ seats: number } | null>;
  };
  extension: {
    count(args: { where: { tenantId: string } }): Promise<number>;
  };
}

/** Thrown by `assertSeatAvailable` when a tenant has no free seat left.
 * Route handlers catch this and map it to a 409 — the same
 * throw-a-typed-Error-subclass-and-let-the-route-map-it convention as
 * `MissingReasonError` in `src/lib/platform/audit.ts`. */
export class SeatLimitError extends Error {
  readonly tenantId: string;
  readonly seatsTotal: number;

  constructor(tenantId: string, seatsTotal: number) {
    super(
      `No seats available for this tenant: the plan allows ${seatsTotal} seat${seatsTotal === 1 ? "" : "s"} and all are in use. ` +
        `Free one up or upgrade the plan before adding another extension.`
    );
    this.name = "SeatLimitError";
    this.tenantId = tenantId;
    this.seatsTotal = seatsTotal;
  }
}

/** Read-side seat usage for a tenant — HUMAN + AI extensions both count
 * (contracts.md's `SeatUsage`, consumed by W7's seat meter). */
export async function getSeatUsage(tenantId: string, reader: SeatGuardReader = db): Promise<SeatUsage> {
  const tenant = await reader.tenant.findUnique({ where: { id: tenantId }, select: { seats: true } });
  const seatsTotal = tenant?.seats ?? 0;
  const seatsUsed = await reader.extension.count({ where: { tenantId } });
  return { seatsTotal, seatsUsed, seatsAvailable: Math.max(seatsTotal - seatsUsed, 0) };
}

/** Throws `SeatLimitError` if `tenantId` has no seat left to provision
 * another `Extension` (either kind) into. Callers run this BEFORE creating
 * the extension row — it does not itself reserve a seat, so callers still
 * need normal DB-level atomicity if they care about a race between the
 * check and the create (none of today's call sites run under enough
 * concurrency for that to matter in practice). */
export async function assertSeatAvailable(tenantId: string, reader: SeatGuardReader = db): Promise<void> {
  const usage = await getSeatUsage(tenantId, reader);
  if (usage.seatsUsed >= usage.seatsTotal) {
    throw new SeatLimitError(tenantId, usage.seatsTotal);
  }
}
