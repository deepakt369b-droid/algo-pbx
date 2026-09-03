import { timingSafeEqual } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSetting } from "@/lib/settings/service";
import { isExpired } from "@/lib/retention";
import { parseVoicemailMessageMetadata } from "@/lib/voicemail-spool";

export const dynamic = "force-dynamic";

// Loop D2 — before this, recordings and voicemail grew on disk forever:
// a disk-fill risk that takes the whole stack down (Postgres included,
// same volume), and a data-minimization gap under UAE PDPL. Two
// authorized callers, same split as api/cdr/route.ts and the SMS poller:
// an interactive admin session, or a shared bearer secret for unattended
// cron. Crontab line (adjust the interval to taste — nightly is plenty):
//   0 3 * * * curl -s -X POST -H "Authorization: Bearer $PRUNE_SECRET" http://web:3000/api/admin/maintenance/prune
function isAuthorizedCronRequest(req: NextRequest): boolean {
  const expected = process.env.PRUNE_SECRET;
  if (!expected) return false; // fail closed if the secret was never configured
  const provided = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function pruneRecordings(retentionDays: number, actorId: string): Promise<{ deleted: number; unlinkFailures: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const expired = await db.recording.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true, filePath: true, cdrId: true } });

  const dir = path.resolve(process.env.RECORDINGS_DIR || "/recordings");
  let unlinkFailures = 0;

  for (const rec of expired) {
    // Audit BEFORE delete, same ordering as the manual hard-delete route
    // — the trail survives even if the delete or unlink fails partway.
    await db.auditLog.create({
      data: { action: "recording.pruned", actorId, targetId: rec.id, metadata: { filePath: rec.filePath, cdrId: rec.cdrId, retentionDays } },
    });
    await db.recording.delete({ where: { id: rec.id } });

    const filePath = path.resolve(dir, rec.filePath);
    if (!filePath.startsWith(dir + path.sep)) continue; // defense in depth, same guard as the manual route
    await unlink(filePath).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // already gone — harmless
      unlinkFailures++;
      await db.auditLog.create({
        data: { action: "recording.pruned.unlink_failed", actorId, targetId: rec.id, metadata: { filePath: rec.filePath, error: err instanceof Error ? err.message : String(err) } },
      });
    });
  }

  return { deleted: expired.length, unlinkFailures };
}

async function pruneVoicemail(retentionDays: number, actorId: string): Promise<{ deleted: number; unlinkFailures: number }> {
  const root = path.resolve(process.env.VOICEMAIL_DIR || "/voicemail", "default");
  let deleted = 0;
  let unlinkFailures = 0;

  let mailboxes: string[];
  try {
    mailboxes = await readdir(root);
  } catch {
    return { deleted: 0, unlinkFailures: 0 }; // no spool directory yet — nothing to prune
  }

  for (const mailbox of mailboxes) {
    const inbox = path.join(root, mailbox, "INBOX");
    let files: string[];
    try {
      files = await readdir(inbox);
    } catch {
      continue; // this mailbox has no INBOX yet (no messages ever received)
    }

    for (const file of files.filter((f) => f.endsWith(".txt"))) {
      const txtPath = path.join(inbox, file);
      const wavPath = path.join(inbox, file.replace(/\.txt$/, ".wav"));
      const metadata = await readFile(txtPath, "utf8").then(parseVoicemailMessageMetadata).catch(() => null);
      if (!metadata?.origtime) continue; // can't determine age — leave it, don't guess

      if (!isExpired(new Date(metadata.origtime * 1000), retentionDays)) continue;

      await db.auditLog.create({
        data: { action: "voicemail.pruned", actorId, metadata: { mailbox, file, retentionDays } },
      });
      deleted++;
      const results = await Promise.allSettled([unlink(txtPath), unlink(wavPath)]);
      const hardFailure = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected" && (r.reason as NodeJS.ErrnoException)?.code !== "ENOENT"
      );
      if (hardFailure) {
        unlinkFailures++;
        await db.auditLog.create({
          data: { action: "voicemail.pruned.unlink_failed", actorId, metadata: { mailbox, file, error: (hardFailure.reason as Error).message } },
        });
      }
    }
  }

  return { deleted, unlinkFailures };
}

// Dinstar gateway syslog events (GatewayEvent) — a fixed 30-day retention
// per the feature's own plan, not a tunable AppSetting like
// RECORDING_RETENTION_DAYS: these rows carry no per-deployment sizing
// concern recordings/voicemail have (no filesystem, just narrow indexed
// DB rows), and the plan's PDPL note (see COMPLIANCE.md) treats 30 days as
// the stated data-minimization mitigation, not an operator-adjustable
// knob. Bulk-deleted with a single summary AuditLog row rather than one
// per event — these can arrive in the thousands, unlike recordings.
const GATEWAY_EVENT_RETENTION_DAYS = 30;

async function pruneGatewayEvents(actorId: string): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - GATEWAY_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await db.gatewayEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } });
  if (result.count > 0) {
    await db.auditLog.create({
      data: { action: "gateway_event.pruned", actorId, metadata: { deleted: result.count, retentionDays: GATEWAY_EVENT_RETENTION_DAYS } },
    });
  }
  return { deleted: result.count };
}

export async function POST(request: NextRequest) {
  let actorId: string;
  if (isAuthorizedCronRequest(request)) {
    // AuditLog.actorId is a real, enforced foreign key to User — there is
    // no "system" account concept in this schema, so a cron-triggered run
    // attributes its audit rows to the earliest-created ADMIN account
    // rather than inventing one. Good enough for "who to hold accountable
    // for this automated action" without a schema change; revisit if a
    // real system-actor concept is ever added.
    const systemActor = await db.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!systemActor) {
      return NextResponse.json({ error: "No ADMIN account exists yet to attribute this run to." }, { status: 500 });
    }
    actorId = systemActor.id;
  } else {
    const guard = await requireAdminSession();
    if ("response" in guard) return guard.response;
    actorId = guard.session.user.id;
  }

  const retentionDaysRaw = (await getSetting("RECORDING_RETENTION_DAYS")) || "90";
  const retentionDays = Number(retentionDaysRaw);
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    return NextResponse.json({ error: `Invalid RECORDING_RETENTION_DAYS value: ${retentionDaysRaw}` }, { status: 500 });
  }

  // Gateway events run on their own fixed retention regardless of the
  // recordings/voicemail setting above — an operator disabling
  // RECORDING_RETENTION_DAYS (0 = pruning disabled) has no bearing on the
  // PDPL data-minimization commitment for gateway syslog data.
  const gatewayEvents = await pruneGatewayEvents(actorId);

  if (retentionDays === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "Recording/voicemail retention is set to 0 (pruning disabled).", gatewayEvents });
  }

  const [recordings, voicemail] = await Promise.all([
    pruneRecordings(retentionDays, actorId),
    pruneVoicemail(retentionDays, actorId),
  ]);

  return NextResponse.json({ ok: true, retentionDays, recordings, voicemail, gatewayEvents });
}
