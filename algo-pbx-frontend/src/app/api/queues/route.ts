import { NextResponse } from "next/server";
import { getAmiClient } from "@/lib/ami-client";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { getQueueSnapshots } from "@/lib/queue-status";
import type { QueueSnapshot } from "@/types";

export const dynamic = "force-dynamic";

// GET /api/queues — live snapshot, combining AMI's real-time QueueStatus
// action with the queue/member config we own in Postgres (name, strategy).
// The actual per-queue AMI computation lives in
// src/lib/queue-status.ts's getQueueSnapshots() — shared with
// GET /api/wallboard so the two can't silently disagree.
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const queues = await db.queue.findMany({ include: { members: true } });
  const ami = getAmiClient();

  let amiConnected = true;
  try {
    await ami.connect();
  } catch {
    amiConnected = false;
  }

  const snapshots: QueueSnapshot[] = amiConnected
    ? await getQueueSnapshots(ami, queues)
    : queues.map((q) => ({
        name: q.name,
        strategy: q.strategy,
        waiting: 0,
        longestWaitSec: 0,
        members: q.members.map((m) => ({ extension: m.extension, status: "OFFLINE" as const })),
      }));

  return NextResponse.json({ queues: snapshots, amiConnected });
}
