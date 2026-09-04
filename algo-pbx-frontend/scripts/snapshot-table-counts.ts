#!/usr/bin/env -S node --enable-source-maps
// Multi-tenant SaaS foundation — rehearsal evidence tooling (2026-09-04).
//
// Snapshots a per-table row count for every customer-owned table (plus the
// platform-global ones, for completeness) and writes it to a JSON file.
// Run this TWICE against the same rehearsal DB:
//   1. BEFORE running any migration ("before" snapshot) — the restored
//      snapshot's pristine row counts.
//   2. AFTER migration step 1 + the backfill script have both completed
//      ("after" snapshot).
// rehearse-tenancy-migration.ts diffs the two and requires every count to
// be IDENTICAL (backfilling a column never changes row counts — a mismatch
// means something else touched the DB mid-rehearsal and the rehearsal is
// invalid).
//
// Usage:
//   npx tsx scripts/snapshot-table-counts.ts [output-file.json]
//
// Default output file: tenancy-row-counts-<ISO timestamp>.json in the
// current working directory.

import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PLATFORM_GLOBAL_TABLES, TENANCY_TABLES } from "./lib/tenancy-tables";

export interface TableCountSnapshot {
  takenAt: string;
  counts: Record<string, number>;
}

async function countRows(db: PrismaClient, table: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*)::bigint AS count FROM "${table}"`);
  return Number(rows[0]?.count ?? BigInt(0));
}

export async function snapshotTableCounts(db: PrismaClient): Promise<TableCountSnapshot> {
  const tables = [...TENANCY_TABLES, ...PLATFORM_GLOBAL_TABLES];
  const counts: Record<string, number> = {};

  for (const table of tables) {
    counts[table] = await countRows(db, table);
  }

  return { takenAt: new Date().toISOString(), counts };
}

async function main() {
  const outputPath = process.argv[2] ?? `tenancy-row-counts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const db = new PrismaClient();

  try {
    const snapshot = await snapshotTableCounts(db);
    writeFileSync(outputPath, JSON.stringify(snapshot, null, 2) + "\n");

    console.log(`Wrote row-count snapshot for ${Object.keys(snapshot.counts).length} table(s) to ${outputPath}`);
    for (const [table, count] of Object.entries(snapshot.counts)) {
      console.log(`  ${table}: ${count}`);
    }
  } finally {
    await db.$disconnect();
  }
}

// Always run as a CLI entrypoint. rehearse-tenancy-migration.ts deliberately
// invokes this as a SEPARATE subprocess (via tsx), not an in-process import
// — simpler and more portable than cross-platform "am I the entrypoint"
// detection, and keeps each script independently runnable/testable exactly
// as documented in its own usage comment.
main().catch((err) => {
  console.error("snapshot-table-counts failed:", err);
  process.exitCode = 1;
});
