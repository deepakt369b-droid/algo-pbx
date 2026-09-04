#!/usr/bin/env -S node --enable-source-maps
// Multi-tenant SaaS foundation — rehearsal runbook (2026-09-04).
//
// D3 (plan, locked decision): "Rehearse on a restored production snapshot."
// This script assumes DATABASE_URL (read from env, same as everything else
// in this app — see .env / docker-compose.yml) already points at a
// RESTORED SNAPSHOT. It does NOT verify that for you — there is no reliable
// way to distinguish "a snapshot restore" from "prod" from inside a script
// connected to it — so the --confirm-snapshot flag exists as a deliberate
// speed bump: you must read the line below and mean it before this script
// touches anything.
//
//   npx tsx scripts/rehearse-tenancy-migration.ts --confirm-snapshot
//
// What it does, in order:
//   1. Snapshots per-table row counts ("before"), via snapshot-table-counts.ts.
//   2. Runs `prisma migrate deploy` — applies migration step 1 (additive:
//      Tenant/PlatformUser/SupportGrant/PlatformAuditLog + nullable
//      tenantId columns). Verifies the deploy output actually names the new
//      migration — a bare "No pending migrations" here is a FAILURE, not a
//      pass (a lesson this repo has re-learned more than once — see
//      LLM.md).
//   3. Runs the batched backfill (migrate-backfill-tenancy.ts).
//   4. Snapshots per-table row counts again ("after").
//   5. Reports and hard-fails on:
//        - any table whose before/after row count differs (must be IDENTICAL
//          — backfilling a column can never change row counts; a mismatch
//          means something else wrote to this DB mid-rehearsal and the
//          rehearsal is invalid);
//        - any table with a remaining `tenantId IS NULL` row (orphan count
//          — must be exactly ZERO, hard requirement per plan §1);
//   6. Reports total wall-clock duration (sizes the announced prod
//      maintenance window).
//   7. Prints a clear PASS/FAIL summary a human can read to sign off,
//      matching the plan's Requirement A acceptance evidence list. On PASS,
//      also prints the promotion steps for step 3
//      (step3_constrain.sql.template) — deliberately NOT auto-applied here;
//      per the plan's working agreement, wave 1's gate is owner sign-off
//      AFTER this evidence, and step 3 is the constraining/destructive half.
//
// This script does NOT run the Playwright acceptance suite or the real-call
// check — those are separate, documented steps (see e2e/tenancy-acceptance.*
// and the plan's Requirement A section); this script is the DB-migration
// half of the evidence only.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { TENANCY_TABLES } from "./lib/tenancy-tables";
import type { TableCountSnapshot } from "./snapshot-table-counts";

const TENANT_SAHARA_SLUG = "sahara";

function runNode(args: string[], label: string): string {
  console.log(`\n=== ${label} ===`);
  try {
    const output = execFileSync("npx", ["tsx", ...args], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    console.log(output);
    return output;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    console.error(e.stdout ?? "");
    console.error(e.stderr ?? e.message ?? String(err));
    throw new Error(`${label} failed — see output above.`);
  }
}

function runPrismaMigrateDeploy(): void {
  console.log("\n=== prisma migrate deploy ===");
  let output: string;
  try {
    output = execFileSync("npx", ["prisma", "migrate", "deploy"], {
      encoding: "utf8",
      env: process.env,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    console.error(e.stdout ?? "");
    console.error(e.stderr ?? e.message ?? String(err));
    throw new Error("prisma migrate deploy failed — see output above.");
  }
  console.log(output);

  // Same lesson this repo has recorded before (see the header comment of
  // prior hand-authored migrations): a deploy that reports "No pending
  // migrations" when we expect one to apply is a FAILURE, not a pass —
  // it usually means the migration folder wasn't picked up, or was already
  // (silently) marked applied. Fail loudly rather than silently continuing.
  if (/no pending migrations/i.test(output) && !/add_tenancy/i.test(output)) {
    throw new Error(
      'prisma migrate deploy reported "No pending migrations" without applying the tenancy migration — this is a FAILURE, not a pass. Confirm prisma/migrations/20260904100000_add_tenancy is present and not already marked applied on this DB.',
    );
  }
}

async function loadSnapshot(path: string): Promise<TableCountSnapshot> {
  return JSON.parse(readFileSync(path, "utf8")) as TableCountSnapshot;
}

async function countOrphans(db: PrismaClient, table: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "${table}" WHERE "tenantId" IS NULL`,
  );
  return Number(rows[0]?.count ?? BigInt(0));
}

async function main() {
  const confirmed = process.argv.includes("--confirm-snapshot");
  if (!confirmed) {
    console.error(
      "Refusing to run: pass --confirm-snapshot to confirm DATABASE_URL points at a RESTORED SNAPSHOT, not production.\n" +
        "  npx tsx scripts/rehearse-tenancy-migration.ts --confirm-snapshot",
    );
    process.exitCode = 1;
    return;
  }

  const overallStart = Date.now();
  const beforePath = "tenancy-row-counts-before.json";
  const afterPath = "tenancy-row-counts-after.json";

  try {
    // 1. Before snapshot.
    runNode(["scripts/snapshot-table-counts.ts", beforePath], "Row-count snapshot (BEFORE)");

    // 2. Migration step 1.
    runPrismaMigrateDeploy();

    // 3. Backfill (step 2).
    runNode(["scripts/migrate-backfill-tenancy.ts"], "Batched backfill (step 2)");

    // 4. After snapshot.
    runNode(["scripts/snapshot-table-counts.ts", afterPath], "Row-count snapshot (AFTER)");

    // 5. Compare.
    const before = await loadSnapshot(beforePath);
    const after = await loadSnapshot(afterPath);

    const mismatches: string[] = [];
    for (const table of Object.keys(before.counts)) {
      const b = before.counts[table];
      const a = after.counts[table];
      if (b !== a) {
        mismatches.push(`${table}: before=${b} after=${a}`);
      }
    }

    const db = new PrismaClient();
    const orphanReport: string[] = [];
    try {
      const tenant = await db.tenant.findUnique({ where: { slug: TENANT_SAHARA_SLUG } });
      for (const table of TENANCY_TABLES) {
        const orphans = await countOrphans(db, table);
        if (orphans > 0) orphanReport.push(`${table}: ${orphans} orphan(s)`);
      }

      const durationSec = ((Date.now() - overallStart) / 1000).toFixed(1);

      console.log("\n===================== REHEARSAL SUMMARY =====================");
      console.log(`Tenant #1 (slug "${TENANT_SAHARA_SLUG}"): ${tenant ? `found, id=${tenant.id}` : "NOT FOUND"}`);
      console.log(`Tables checked: ${TENANCY_TABLES.length}`);
      console.log(`Row-count mismatches (before vs after): ${mismatches.length}`);
      for (const m of mismatches) console.log(`  MISMATCH: ${m}`);
      console.log(`Orphan rows (tenantId IS NULL) remaining: ${orphanReport.length === 0 ? 0 : orphanReport.length + " table(s) affected"}`);
      for (const o of orphanReport) console.log(`  ORPHANS: ${o}`);
      console.log(`Total wall-clock duration: ${durationSec}s`);

      const pass = tenant !== null && mismatches.length === 0 && orphanReport.length === 0;
      console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
      console.log("===============================================================\n");

      if (pass) {
        console.log(
          "Zero orphans, row counts identical, tenant #1 present. Safe to bring this evidence to owner sign-off\n" +
            "(plan: \"Wave 1's gate is owner sign-off after rehearsal evidence\").\n\n" +
            "Once signed off, promote step 3 (constraining migration) per the header comment in\n" +
            "prisma/migrations/20260904100000_add_tenancy/step3_constrain.sql.template — it is deliberately\n" +
            "NOT applied by this script.\n",
        );
      } else {
        process.exitCode = 1;
      }
    } finally {
      await db.$disconnect();
    }
  } finally {
    // Leave the before/after JSON files (tenancy-row-counts-before.json /
    // -after.json) in place — they ARE the row-count evidence the plan
    // requires be reported at sign-off. Deliberately not deleted here.
  }
}

main().catch((err) => {
  console.error("\nRehearsal FAILED:", err);
  process.exitCode = 1;
});
