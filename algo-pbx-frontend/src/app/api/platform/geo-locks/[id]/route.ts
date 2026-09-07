import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";
import { regeneratePjsipConfigAndReload } from "@/lib/pjsip-provision";

export const dynamic = "force-dynamic";

// POST /api/platform/geo-locks/[id] — the one action that restores (or
// refuses to restore) a geo-locked extension. Owner-only, same tier as
// billing overrides and dialplan cuts — see requirePlatformOwner()'s own
// comment for why.
//
// [id] is prefixed to disambiguate the queue's two disjoint row kinds (see
// geo-locks-list.tsx's header comment) with ONE route rather than two,
// since both ultimately do the same thing — clear a lock — just from a
// different starting row:
//   "request:<ExtensionUnlockRequestId>" — a tenant admin filed a request.
//     approve  -> clears the lock AND resolves the request APPROVED.
//     deny     -> resolves the request DENIED; the extension is untouched.
//   "extension:<ExtensionId>" — the extension is locked and nobody has
//     asked yet (attention-queue's "silent" lock case). Only "approve" is
//     meaningful here (there is no request to deny); "deny" against this
//     shape is rejected as a 400 rather than silently accepted as a no-op.
//
// Approving is wrapped in one transaction per the brief: the extension
// update, the request resolution (if any) and the audit row all commit
// together, or none do. PJSIP re-provisioning happens AFTER that
// transaction commits, via regeneratePjsipConfigAndReload() — the SAME
// function every existing extension-edit route (POST/PATCH/DELETE
// /api/extensions) already calls to push a change to the running Asterisk.
// W5's enforcement chain was still landing in parallel with this file and
// had not yet published a narrower "reprovision this one tenant" helper by
// the time this route was written; regeneratePjsipConfigAndReload()
// operates on the current one-pooled-stack architecture (plan §1 D1 — see
// its own file comment) and is exactly what every other Extension mutation
// in this codebase already relies on to bring Asterisk's live config back
// in sync, so this route calls it plainly rather than inventing a second
// mechanism or blocking on a cross-node dependency.
const BodySchema = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string(),
});

export const POST = withApiErrorHandler(async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { decision } = parsed.data;

  let reason: string;
  try {
    reason = requireReason(
      parsed.data.reason,
      decision === "approve" ? "geo.extension_unlock" : "geo.unlock_denied"
    );
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const raw = decodeURIComponent(params.id);
  const sep = raw.indexOf(":");
  const [prefix, rawId] = sep === -1 ? [null, null] : [raw.slice(0, sep), raw.slice(sep + 1)];

  if (prefix === "request") {
    const request = await db.extensionUnlockRequest.findUnique({
      where: { id: rawId! },
      include: { extension: { select: { id: true, number: true, tenantId: true } } },
    });
    if (!request) return NextResponse.json({ error: "Unlock request not found" }, { status: 404 });
    if (request.status !== "PENDING") {
      return NextResponse.json(
        { error: `This request was already ${request.status.toLowerCase()}.` },
        { status: 409 }
      );
    }

    if (decision === "deny") {
      await db.$transaction(async (tx) => {
        await tx.extensionUnlockRequest.update({
          where: { id: request.id },
          data: {
            status: "DENIED",
            resolvedByPlatformUserId: guard.session.user.id,
            resolutionNote: reason,
            resolvedAt: new Date(),
          },
        });
        await recordPlatformAudit(
          {
            action: "geo.unlock_denied",
            platformUserId: guard.session.user.id,
            tenantId: request.tenantId,
            reason,
            metadata: { extensionId: request.extension.id, extensionNumber: request.extension.number, requestId: request.id },
          },
          tx
        );
      });
      return NextResponse.json({ ok: true, status: "DENIED" });
    }

    // approve
    await db.$transaction(async (tx) => {
      await tx.extension.update({
        where: { id: request.extension.id },
        data: {
          geoLockedAt: null,
          geoLockedReason: null,
          geoFailedAttempts: 0,
          geoUnlockedAt: new Date(),
          geoUnlockedByPlatformUserId: guard.session.user.id,
        },
      });
      await tx.extensionUnlockRequest.update({
        where: { id: request.id },
        data: {
          status: "APPROVED",
          resolvedByPlatformUserId: guard.session.user.id,
          resolutionNote: reason,
          resolvedAt: new Date(),
        },
      });
      await recordPlatformAudit(
        {
          action: "geo.extension_unlock",
          platformUserId: guard.session.user.id,
          tenantId: request.tenantId,
          reason,
          metadata: { extensionId: request.extension.id, extensionNumber: request.extension.number, requestId: request.id },
        },
        tx
      );
    });
  } else if (prefix === "extension") {
    if (decision === "deny") {
      return NextResponse.json(
        { error: "There is no request to deny for an extension with no open unlock request." },
        { status: 400 }
      );
    }

    const extension = await db.extension.findUnique({
      where: { id: rawId! },
      select: { id: true, number: true, tenantId: true, geoLockedAt: true },
    });
    if (!extension) return NextResponse.json({ error: "Extension not found" }, { status: 404 });
    if (!extension.geoLockedAt) {
      return NextResponse.json({ error: "This extension is not currently locked." }, { status: 409 });
    }

    await db.$transaction(async (tx) => {
      await tx.extension.update({
        where: { id: extension.id },
        data: {
          geoLockedAt: null,
          geoLockedReason: null,
          geoFailedAttempts: 0,
          geoUnlockedAt: new Date(),
          geoUnlockedByPlatformUserId: guard.session.user.id,
        },
      });
      await recordPlatformAudit(
        {
          action: "geo.extension_unlock",
          platformUserId: guard.session.user.id,
          tenantId: extension.tenantId,
          reason,
          metadata: { extensionId: extension.id, extensionNumber: extension.number, direct: true },
        },
        tx
      );
    });
  } else {
    return NextResponse.json({ error: "Malformed id — expected \"request:<id>\" or \"extension:<id>\"." }, { status: 400 });
  }

  // Same reprovisioning call every existing Extension-mutating route makes
  // (POST/PATCH/DELETE /api/extensions) — see this file's header comment.
  // Failure here mirrors those routes' own handling: the DB is already
  // correct, so the caller is told the config push needs a retry rather
  // than the whole approval being rolled back.
  try {
    await regeneratePjsipConfigAndReload();
  } catch (err) {
    return NextResponse.json({
      ok: true,
      warning: `The lock was cleared in the database, but reloading Asterisk failed: ${
        err instanceof Error ? err.message : "unknown error"
      }. The extension may not be able to register until this is retried.`,
    });
  }

  return NextResponse.json({ ok: true });
});
