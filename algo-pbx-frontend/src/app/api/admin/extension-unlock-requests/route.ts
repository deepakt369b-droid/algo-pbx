import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/extension-unlock-requests — the tenant-admin side of
// the geo-lock unlock queue (plan §3.3, node W6). Tenant-scoped `db`
// (requireAdminSession's TenantClient), never `unsafeGlobalDb` — this route
// must only ever see this tenant's own extensions and requests.
//
// There is deliberately no PATCH/approve verb anywhere in this file: a
// tenant admin can ask, never grant. Only a platform owner can resolve a
// request, via POST /api/platform/geo-locks/[id].

const CreateSchema = z.object({
  extensionId: z.string().min(1),
  reason: z.string().min(1),
});

export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const requests = await db.extensionUnlockRequest.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      extensionId: true,
      requestedReason: true,
      status: true,
      resolutionNote: true,
      createdAt: true,
      resolvedAt: true,
    },
  });

  return NextResponse.json({ requests });
});

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { extensionId, reason } = parsed.data;

  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    return NextResponse.json({ error: "A justification is required." }, { status: 400 });
  }

  const extension = await db.extension.findUnique({
    where: { id: extensionId },
    select: { id: true, geoLockedAt: true },
  });
  if (!extension) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }
  if (!extension.geoLockedAt) {
    return NextResponse.json({ error: "This extension is not currently locked." }, { status: 409 });
  }

  // One open (PENDING) request per extension. Checked here (defense in
  // depth is the platform-plane approve/deny route's own job, not this
  // one's) and enforced by a raw partial unique index at the DB layer too
  // (see the ExtensionUnlockRequest model's own comment in schema.prisma —
  // Prisma's schema language can't express a WHERE-qualified unique index,
  // so that index was added by hand in this model's migration).
  const existing = await db.extensionUnlockRequest.findFirst({
    where: { extensionId, status: "PENDING" },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "An unlock request for this extension is already pending" },
      { status: 409 }
    );
  }

  const request = await db.extensionUnlockRequest.create({
    data: {
      extensionId,
      requestedByUserId: session.user.id,
      requestedReason: trimmedReason,
      status: "PENDING",
      // No `tenantId` — the TenantClient extension force-injects it at
      // runtime, same pattern documented in POST /api/extensions.
    } as never,
  });

  return NextResponse.json({ request }, { status: 201 });
});
