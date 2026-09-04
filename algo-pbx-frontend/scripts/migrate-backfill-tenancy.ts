#!/usr/bin/env -S node --enable-source-maps
// Multi-tenant SaaS foundation — WAVE 1, STEP 2 of 3 (2026-09-04).
//
// Backfills the nullable "tenantId" column added by
// prisma/migrations/20260904100000_add_tenancy/migration.sql (step 1) on
// every customer-owned table, pointing every existing row at tenant #1
// (slug "sahara" — our current single deployment). Run this AFTER step 1's
// `prisma migrate deploy` and BEFORE step 3 (step3_constrain.sql.template,
// promoted to a real migration once this script reports zero remaining
// nulls — see that file's header).
//
// Per-table, BATCHED (not one 30-table transaction): a single mega-
// transaction would hold locks across the entire backfill duration on a
// live DB. Each batch is its own short UPDATE. IDEMPOTENT and safely
// RE-RUNNABLE if interrupted: every batch is `WHERE "tenantId" IS NULL`, so
// a re-run after a crash/Ctrl-C simply continues where it left off — no
// row is ever double-counted or skipped.
//
// Usage:
//   npx tsx scripts/migrate-backfill-tenancy.ts [tenantId] [--batch-size=5000]
//
// If [tenantId] is omitted, the script reads it from the DB itself — the
// row inserted by migration step 1 (slug "sahara"). Passing it explicitly
// is supported for a rehearsal DB where a different tenant #1 id was
// generated, or for test runs against a scratch DB.

import { PrismaClient } from "@prisma/client";
import { TENANCY_TABLES } from "./lib/tenancy-tables";

const DEFAULT_BATCH_SIZE = 5000;
const TENANT_SAHARA_SLUG = "sahara";

// Every customer-owned table that got a nullable "tenantId" column in step
// 1 — same list as step3_constrain.sql.template's orphan assertion, kept in
// sync via scripts/lib/tenancy-tables.ts (a table missing from any of the
// three is a bug). "AppSetting" stays nullable forever in the final schema,
// but is still backfilled to tenant #1 here — an existing row with no
// tenant IS tenant #1's data today.
const TABLES: readonly string[] = TENANCY_TABLES;

function parseArgs(argv: string[]): { tenantId: string | undefined; batchSize: number } {
  let tenantId: string | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;

  for (const arg of argv) {
    if (arg.startsWith("--batch-size=")) {
      const n = Number(arg.slice("--batch-size=".length));
      if (Number.isFinite(n) && n > 0) batchSize = Math.floor(n);
    } else if (!arg.startsWith("--")) {
      tenantId = arg;
    }
  }

  return { tenantId, batchSize };
}

async function resolveTenantId(db: PrismaClient, explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;

  const tenant = await db.tenant.findUnique({ where: { slug: TENANT_SAHARA_SLUG } });
  if (!tenant) {
    throw new Error(
      `No tenant with slug "${TENANT_SAHARA_SLUG}" found. Pass a tenant id explicitly, or confirm migration step 1 has run.`,
    );
  }
  return tenant.id;
}

async function countNull(db: PrismaClient, table: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "${table}" WHERE "tenantId" IS NULL`,
  );
  return Number(rows[0]?.count ?? BigInt(0));
}

/** Backfills one table in batches. Returns the total number of rows
 * updated. Idempotent: re-running after an interruption just does fewer
 * batches, since already-backfilled rows no longer match `IS NULL`. */
async function backfillTable(
  db: PrismaClient,
  table: string,
  tenantId: string,
  batchSize: number,
): Promise<number> {
  const startedAt = Date.now();
  const initialRemaining = await countNull(db, table);

  if (initialRemaining === 0) {
    console.log(`[${table}] already fully backfilled (0 rows to do) — skipping.`);
    return 0;
  }

  console.log(`[${table}] ${initialRemaining} row(s) to backfill, batch size ${batchSize}...`);

  let totalDone = 0;
  for (;;) {
    // Batch via a subquery-limited UPDATE — Postgres has no UPDATE ... LIMIT
    // directly, so scope the update to a ctid subquery of at most
    // `batchSize` matching rows. Every batch is its own short statement/
    // implicit transaction, not one long-held lock across the whole table.
    const affected = await db.$executeRawUnsafe(
      `UPDATE "${table}" SET "tenantId" = $1
       WHERE ctid IN (
         SELECT ctid FROM "${table}" WHERE "tenantId" IS NULL LIMIT $2
       )`,
      tenantId,
      batchSize,
    );

    totalDone += affected;
    if (affected === 0) break;

    const remaining = await countNull(db, table);
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[${table}] +${affected} done (total ${totalDone}/${initialRemaining}), ${remaining} remaining, ${elapsedSec}s elapsed`,
    );

    if (remaining === 0) break;
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[${table}] DONE — ${totalDone} row(s) backfilled in ${elapsedSec}s.`);
  return totalDone;
}

async function main() {
  const { tenantId: explicitTenantId, batchSize } = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();

  try {
    const tenantId = await resolveTenantId(db, explicitTenantId);
    console.log(`Backfilling tenantId="${tenantId}" across ${TABLES.length} table(s)...`);

    const overallStart = Date.now();
    let grandTotal = 0;

    for (const table of TABLES) {
      grandTotal += await backfillTable(db, table, tenantId, batchSize);
    }

    const overallElapsedSec = ((Date.now() - overallStart) / 1000).toFixed(1);
    console.log(
      `\nBackfill complete: ${grandTotal} row(s) updated across ${TABLES.length} table(s) in ${overallElapsedSec}s.`,
    );

    // Final sanity pass — report any table that STILL has nulls (should
    // never happen given the loop above runs to remaining === 0, but this
    // is the same assertion step 3's migration re-checks before
    // constraining, so surface it here too rather than only at deploy time).
    let anyRemaining = false;
    for (const table of TABLES) {
      const remaining = await countNull(db, table);
      if (remaining > 0) {
        anyRemaining = true;
        console.error(`[${table}] STILL HAS ${remaining} row(s) with tenantId IS NULL.`);
      }
    }

    if (anyRemaining) {
      console.error("\nBackfill finished with orphans remaining — re-run this script before promoting step 3.");
      process.exitCode = 1;
    } else {
      console.log("Zero orphans remaining on every table. Safe to promote step 3 (see step3_constrain.sql.template).");
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("migrate-backfill-tenancy failed:", err);
  process.exitCode = 1;
});
