/**
 * Moves recordings from the flat `recordings/<uniqueId>.wav` layout to
 * `recordings/<tenantId>/<uniqueId>.wav`, and rewrites Recording.filePath.
 *
 *   npm run migrate-recordings-layout            # dry run (default)
 *   npm run migrate-recordings-layout -- --apply
 *
 * DRY RUN BY DEFAULT, deliberately. This moves customer call recordings —
 * personal data under UAE PDPL, and in some cases the only record of a
 * disputed conversation. A script that starts moving files the moment it is
 * invoked is the wrong shape for that.
 *
 * Safety properties:
 *   - Copy-then-verify-then-unlink, never a bare rename. A rename across a
 *     filesystem boundary can partially fail; a verified copy cannot leave a
 *     truncated file as the only surviving version.
 *   - The database row is updated only AFTER the new file is verified on disk.
 *     Crashing mid-run therefore leaves rows pointing at files that exist.
 *   - Idempotent: a row already in the new layout is skipped, so a re-run
 *     after a crash resumes rather than redoing.
 *   - Readers accept both layouts throughout (see src/lib/recordings/layout.ts),
 *     so the app keeps serving audio while this runs.
 */
import { readFile, writeFile, unlink, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const apply = process.argv.includes("--apply");

const ROOT = path.resolve(process.env.RECORDINGS_DIR || "/recordings");

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  console.log(`Recordings root: ${ROOT}`);
  console.log(apply ? "MODE: APPLY — files will be moved.\n" : "MODE: DRY RUN — nothing will change.\n");

  const recordings = await db.recording.findMany({
    select: { id: true, tenantId: true, filePath: true },
    orderBy: { createdAt: "asc" },
  });

  let moved = 0;
  let already = 0;
  let missing = 0;
  let failed = 0;

  for (const rec of recordings) {
    // Already migrated: filePath contains a directory separator.
    if (rec.filePath.includes("/") || rec.filePath.includes("\\")) {
      already++;
      continue;
    }

    const from = path.resolve(ROOT, rec.filePath);
    // Refuse anything that escapes the root, rather than trusting a stored
    // value that predates the current guards.
    if (from !== ROOT && !from.startsWith(ROOT + path.sep)) {
      console.error(`SKIP ${rec.id}: "${rec.filePath}" resolves outside the recordings root.`);
      failed++;
      continue;
    }

    const relative = path.posix.join(rec.tenantId, rec.filePath);
    const to = path.resolve(ROOT, rec.tenantId, rec.filePath);

    try {
      await stat(from);
    } catch {
      // The row references a file that is not on disk. Reported, not
      // "fixed": deleting the row would destroy the only record that the
      // recording ever existed, which is exactly the wrong call to make
      // automatically.
      console.warn(`MISSING ${rec.id}: no file at ${from} (row left untouched).`);
      missing++;
      continue;
    }

    if (!apply) {
      console.log(`WOULD MOVE ${rec.filePath} -> ${relative}`);
      moved++;
      continue;
    }

    try {
      const body = await readFile(from);
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, body);

      // Verify before removing the original. Same principle the delivery
      // pipeline uses: never delete the only copy on the strength of a write
      // call returning.
      const readBack = await readFile(to);
      if (sha256(readBack) !== sha256(body) || readBack.length !== body.length) {
        console.error(`FAILED ${rec.id}: copy at ${to} does not match the original. Original kept.`);
        failed++;
        continue;
      }

      // Database first, then unlink: a crash here leaves a duplicate file,
      // which is harmless. The reverse order could leave a row pointing at
      // nothing.
      await db.recording.update({ where: { id: rec.id }, data: { filePath: relative } });
      await unlink(from);

      moved++;
      if (moved % 100 === 0) console.log(`  … ${moved} moved`);
    } catch (err) {
      console.error(`FAILED ${rec.id}:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log("\n--- summary ---");
  console.log(`total rows         : ${recordings.length}`);
  console.log(`${apply ? "moved" : "would move"}         : ${moved}`);
  console.log(`already migrated   : ${already}`);
  console.log(`file missing       : ${missing}`);
  console.log(`failed             : ${failed}`);

  if (!apply && moved > 0) {
    console.log("\nRe-run with --apply to perform the move.");
  }
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
