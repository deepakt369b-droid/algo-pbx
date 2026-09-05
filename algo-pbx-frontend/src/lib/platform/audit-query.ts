import { unsafeGlobalDb as db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

// Shared query construction for the audit viewer and its CSV export, so the
// two can never disagree about what a filter means. An export that quietly
// covered a different set than the screen it was exported from would be worse
// than no export — the whole value of the file is that it corroborates what
// someone saw.
//
// PlatformAuditLog has no relations to PlatformUser or Tenant (both ids are
// plain nullable columns, deliberately — a platform actor is not a tenant
// User, and an audit row must survive the row it refers to). So actor and
// tenant labels are resolved with two small lookups and joined in memory
// rather than by Prisma include.

export interface AuditFilters {
  action?: string;
  actorId?: string;
  tenantId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditRow {
  id: string;
  createdAt: Date;
  action: string;
  reason: string | null;
  metadata: Prisma.JsonValue;
  platformUserId: string | null;
  platformUserEmail: string | null;
  tenantId: string | null;
  tenantSlug: string | null;
}

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_EXPORT_ROWS = 50_000;

export function buildAuditWhere(f: AuditFilters): Prisma.PlatformAuditLogWhereInput {
  const where: Prisma.PlatformAuditLogWhereInput = {};
  if (f.action) where.action = f.action;
  if (f.actorId) where.platformUserId = f.actorId;
  if (f.tenantId) where.tenantId = f.tenantId;

  if (f.from || f.to) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (f.from) {
      const d = new Date(f.from);
      if (!Number.isNaN(d.getTime())) createdAt.gte = d;
    }
    if (f.to) {
      const d = new Date(f.to);
      if (!Number.isNaN(d.getTime())) {
        // An inclusive end date: a user filtering "to 5 September" means the
        // whole of that day, not midnight at its start.
        d.setUTCHours(23, 59, 59, 999);
        createdAt.lte = d;
      }
    }
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  }

  return where;
}

/** Attaches actor emails and tenant slugs to a page of rows. */
async function decorate(
  rows: Array<{
    id: string;
    createdAt: Date;
    action: string;
    reason: string | null;
    metadata: Prisma.JsonValue;
    platformUserId: string | null;
    tenantId: string | null;
  }>
): Promise<AuditRow[]> {
  const actorIds = [...new Set(rows.map((r) => r.platformUserId).filter((v): v is string => !!v))];
  const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((v): v is string => !!v))];

  const [actors, tenants] = await Promise.all([
    actorIds.length
      ? db.platformUser.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
      : Promise.resolve([]),
    tenantIds.length
      ? db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, slug: true } })
      : Promise.resolve([]),
  ]);

  const actorById = new Map(actors.map((a) => [a.id, a.email]));
  const slugById = new Map(tenants.map((t) => [t.id, t.slug]));

  return rows.map((r) => ({
    ...r,
    // A deleted actor or tenant still leaves its id on the row. Rendering the
    // raw id is better than an empty cell: it is still traceable, and it is
    // honest that the referenced record is gone.
    platformUserEmail: r.platformUserId ? (actorById.get(r.platformUserId) ?? r.platformUserId) : null,
    tenantSlug: r.tenantId ? (slugById.get(r.tenantId) ?? r.tenantId) : null,
  }));
}

export async function queryAuditPage(
  f: AuditFilters
): Promise<{ rows: AuditRow[]; nextCursor: string | null; total: number }> {
  const where = buildAuditWhere(f);
  const take = Math.min(Math.max(f.limit ?? DEFAULT_PAGE_SIZE, 1), 500);

  const [raw, total] = await Promise.all([
    db.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        createdAt: true,
        action: true,
        reason: true,
        metadata: true,
        platformUserId: true,
        tenantId: true,
      },
    }),
    db.platformAuditLog.count({ where }),
  ]);

  const hasMore = raw.length > take;
  const page = hasMore ? raw.slice(0, take) : raw;

  return {
    rows: await decorate(page),
    nextCursor: hasMore ? page[page.length - 1].id : null,
    total,
  };
}

/** Every matching row, for the CSV export. Capped — an unbounded export would
 * happily try to materialise the entire table into one response. */
export async function queryAuditForExport(f: AuditFilters): Promise<AuditRow[]> {
  const raw = await db.platformAuditLog.findMany({
    where: buildAuditWhere(f),
    orderBy: { createdAt: "desc" },
    take: MAX_EXPORT_ROWS,
    select: {
      id: true,
      createdAt: true,
      action: true,
      reason: true,
      metadata: true,
      platformUserId: true,
      tenantId: true,
    },
  });
  return decorate(raw);
}
