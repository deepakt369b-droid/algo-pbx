import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { emitEvent } from "@/lib/emit-event";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/cdr?agent=1001&from=2026-08-01&to=2026-08-22&limit=100
//
// Query params are now Zod-validated. Previously `new Date(from)` on a
// malformed value produced `Invalid Date`, which Prisma rejects with an
// unhandled throw -> unstyled 500, and `Number(limit)` on non-numeric
// input produced `NaN` -> `Math.min(NaN, 500)` -> `NaN` -> Prisma
// `take: NaN` (also a throw). This is the one route in the codebase that
// had a guard but no input validation.
const CdrQuerySchema = z.object({
  agent: z.string().regex(/^\d{3,6}$/).optional(),
  from: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
  to: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const GET = withApiErrorHandler(async function GET(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const { searchParams } = new URL(req.url);
  const parsed = CdrQuerySchema.safeParse({
    agent: searchParams.get("agent") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters", details: parsed.error.flatten() }, { status: 400 });
  }
  const { agent, from, to, limit } = parsed.data;

  const rows = await db.callDetailRecord.findMany({
    where: {
      agentExtension: agent,
      startedAt: {
        gte: from ? new Date(from) : undefined,
        lte: to ? new Date(to) : undefined,
      },
    },
    orderBy: { startedAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ rows });
});

// POST /api/cdr — ingestion endpoint. Caller: scripts/ami-cdr-listener.mjs,
// a standalone long-running process subscribed to AMI `Cdr` events (see that
// script and src/lib/cdr-mapper.ts for the event-to-payload mapping).
const CdrIngestSchema = z.object({
  uniqueId: z.string(),
  callerNumber: z.string(),
  destination: z.string(),
  direction: z.enum(["inbound", "outbound", "internal"]),
  disposition: z.string(),
  startedAt: z.coerce.date(),
  answeredAt: z.coerce.date().optional(),
  endedAt: z.coerce.date().optional(),
  durationSec: z.number().int().nonnegative().default(0),
  billsecSec: z.number().int().nonnegative().default(0),
  // A relative API path (e.g. "/api/recordings/<uniqueid>"), not an
  // absolute URL — z.string().url() would reject that and did until this
  // was caught wiring up the CDR listener. Playback is same-origin (see
  // that route's file-header comment), so relative is correct, not a
  // shortcut.
  recordingUrl: z.string().optional(),
  queueName: z.string().optional(),
  agentExtension: z.string().optional(),
});

// This endpoint is called server-to-server by an AMI event listener process,
// not by a logged-in browser — there's no session cookie to check. Guarded
// instead by a shared bearer secret (CDR_INGEST_SECRET), constant-time
// compared to avoid a timing side-channel on the comparison itself.
function isAuthorizedIngestRequest(req: NextRequest): boolean {
  const expected = process.env.CDR_INGEST_SECRET;
  if (!expected) return false; // fail closed if the secret was never configured
  const provided = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  if (!isAuthorizedIngestRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = CdrIngestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const row = await db.callDetailRecord.upsert({
    where: { uniqueId: parsed.data.uniqueId },
    create: parsed.data,
    update: parsed.data,
  });

  // Phase D: a Recording row is what src/lib/recording-access.ts's
  // canAccessRecording() and the byte-serving route key off — without one,
  // an otherwise-legitimate recording would be un-hideable and (for
  // AGENTs) unreachable, since that route requires a Recording to exist to
  // grant access at all. filePath mirrors MixMonitor's naming in
  // pbx_configs/extensions.conf (`${UNIQUEID}.wav`), not parsed.data.recordingUrl
  // itself (that's the API path, not the on-disk filename).
  //
  // No unique constraint on cdrId (so upsert isn't usable here) — a call
  // could in principle have more than one recording in a future phase
  // (attended transfer/conference consult legs), so findFirst+create
  // instead of assuming one-per-call at the schema level. Re-ingestion of
  // the same CDR (an upsert on uniqueId above) intentionally does NOT
  // create a duplicate Recording — checked first.
  if (parsed.data.recordingUrl) {
    const existing = await db.recording.findFirst({ where: { cdrId: row.id } });
    if (!existing) {
      await db.recording.create({ data: { cdrId: row.id, filePath: `${parsed.data.uniqueId}.wav` } });
    }
  }

  // Not awaited — see emit-event.ts's header. A CRM webhook endpoint being
  // slow or down must never add latency to CDR ingestion, which is on the
  // hot path of every single call ending.
  void emitEvent("call.ended", {
    uniqueId: row.uniqueId,
    callerNumber: row.callerNumber,
    destination: row.destination,
    direction: row.direction,
    disposition: row.disposition,
    durationSec: row.durationSec,
    agentExtension: row.agentExtension,
  });

  return NextResponse.json({ row }, { status: 201 });
});
