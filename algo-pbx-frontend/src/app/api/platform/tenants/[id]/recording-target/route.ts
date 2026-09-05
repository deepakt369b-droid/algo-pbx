import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";
import {
  TargetConfigSchema,
  encodeTargetConfig,
  decodeTargetConfig,
  redact,
  validateTargetConfig,
} from "@/lib/recordings/delivery/targets";
import { createTransport } from "@/lib/recordings/delivery/transport";

export const dynamic = "force-dynamic";

// Per-tenant recording storage target.
//
// The rule that shapes this route: a target is NEVER enabled by the same
// request that configures it. Configuring stores the credentials disabled;
// enabling is a second, explicit action that first runs a live connectivity
// test. Turning on a delivery path in one step is how customer call audio
// starts flowing to a mistyped bucket before anyone has confirmed the
// bucket is theirs.
//
// Credentials are encrypted at rest and never returned — GET responds with a
// redacted view only.

const PutSchema = z.object({
  config: TargetConfigSchema,
  verifyBeforePurge: z.boolean().default(true),
  reason: z.string(),
});

const PatchSchema = z.object({
  enabled: z.boolean(),
  reason: z.string(),
});

export const GET = withApiErrorHandler(async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const target = await db.recordingStorageTarget.findUnique({ where: { tenantId: params.id } });
  if (!target) return NextResponse.json({ target: null });

  return NextResponse.json({
    target: {
      id: target.id,
      kind: target.kind,
      enabled: target.enabled,
      verifyBeforePurge: target.verifyBeforePurge,
      lastVerifiedAt: target.lastVerifiedAt,
      // Redacted. There is no endpoint anywhere that returns the credential.
      config: target.configEncrypted ? redact(decodeTargetConfig(target.configEncrypted)) : null,
    },
  });
});

export const PUT = withApiErrorHandler(async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid target configuration" }, { status: 400 });
  }
  const { config, verifyBeforePurge } = parsed.data;

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, "recording_target.update");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const combos = validateTargetConfig(config);
  if (!combos.ok) return NextResponse.json({ error: combos.error }, { status: 400 });

  const tenant = await db.tenant.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const saved = await db.$transaction(async (tx) => {
    const t = await tx.recordingStorageTarget.upsert({
      where: { tenantId: params.id },
      create: {
        tenantId: params.id,
        kind: config.kind,
        configEncrypted: encodeTargetConfig(config),
        verifyBeforePurge,
        // Never enabled by this request. See the header.
        enabled: false,
      },
      update: {
        kind: config.kind,
        configEncrypted: encodeTargetConfig(config),
        verifyBeforePurge,
        enabled: false,
      },
    });

    await recordPlatformAudit(
      {
        action: "recording_target.update",
        platformUserId: guard.session.user.id,
        tenantId: params.id,
        reason,
        metadata: {
          kind: config.kind,
          verifyBeforePurge,
          // The credential is never written to the audit log — that would
          // just be a second place it leaks from.
          credentialsRecorded: false,
          enabledByThisRequest: false,
        },
      },
      tx
    );

    return t;
  });

  return NextResponse.json({
    target: { id: saved.id, kind: saved.kind, enabled: saved.enabled },
    notice: "Saved and left disabled. Run a connection test, then enable delivery explicitly.",
  });
});

// PATCH — enable or disable delivery. Enabling runs a real connection test
// first and refuses if it fails, so delivery never starts against a target
// nobody has proven reachable.
export const PATCH = withApiErrorHandler(async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, "recording_target.update");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const target = await db.recordingStorageTarget.findUnique({ where: { tenantId: params.id } });
  if (!target) return NextResponse.json({ error: "No storage target configured." }, { status: 404 });

  if (parsed.data.enabled) {
    if (!target.configEncrypted) {
      return NextResponse.json({ error: "Target has no configuration to test." }, { status: 400 });
    }
    const transport = createTransport(decodeTargetConfig(target.configEncrypted));
    try {
      const test = await transport.test();
      if (!test.ok) {
        return NextResponse.json(
          { error: `Connection test failed, so delivery was not enabled: ${test.error ?? "unknown error"}` },
          { status: 400 }
        );
      }
    } finally {
      await transport.close();
    }
  }

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.recordingStorageTarget.update({
      where: { tenantId: params.id },
      data: {
        enabled: parsed.data.enabled,
        ...(parsed.data.enabled ? { lastVerifiedAt: new Date() } : {}),
      },
    });
    await recordPlatformAudit(
      {
        action: "recording_target.update",
        platformUserId: guard.session.user.id,
        tenantId: params.id,
        reason,
        metadata: { enabled: parsed.data.enabled, connectionTested: parsed.data.enabled },
      },
      tx
    );
    return t;
  });

  return NextResponse.json({ target: { id: updated.id, enabled: updated.enabled } });
});
