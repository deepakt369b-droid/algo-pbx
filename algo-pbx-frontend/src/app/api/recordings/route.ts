import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/recordings — Phase D listing endpoint.
//   - Staff (ADMIN/SUPERVISOR): every recording, including hidden ones
//     (hiding is agent-facing only — staff visibility is never affected).
//   - AGENT: only recordings from calls they own (CallDetailRecord.agentExtension
//     === their own session.user.extension) AND not hidden. This mirrors
//     src/lib/recording-access.ts's canAccessRecording() logic exactly —
//     kept as a direct Prisma query rather than fetching everything and
//     filtering in memory with that function, since this is a listing
//     query, not a single-resource check, but the *rule* is identical by
//     construction: an agent can never see a recording this query wouldn't
//     also grant them at the byte-serving layer.
export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const isStaff = session.user.role === "ADMIN" || session.user.role === "SUPERVISOR";

  const recordings = await db.recording.findMany({
    where: isStaff
      ? {}
      : {
          hiddenFromAgentAt: null,
          cdr: { agentExtension: session.user.extension ?? "__no-extension__" },
        },
    include: {
      cdr: {
        select: {
          uniqueId: true,
          callerNumber: true,
          destination: true,
          direction: true,
          startedAt: true,
          durationSec: true,
          agentExtension: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    recordings: recordings.map((r) => ({
      id: r.id,
      hiddenFromAgentAt: r.hiddenFromAgentAt,
      createdAt: r.createdAt,
      cdr: r.cdr,
      // Same URL shape cdr-table.tsx already uses for staff playback —
      // this route's own auth (byte-serving side) enforces who can
      // actually stream it.
      recordingUrl: `/api/recordings/${r.cdr.uniqueId}`,
    })),
  });
}
