import { NextResponse } from "next/server";
import { getAmiClient } from "@/lib/ami-client";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { getQueueSnapshots } from "@/lib/queue-status";
import type { WallboardSnapshot } from "@/types";

// Hits Postgres/AMI at request time — must not be statically prerendered at build time.
export const dynamic = "force-dynamic";

// GET /api/wallboard — top-level numbers for the supervisor wallboard
// (Phase 3). Uses sendAndCollect (src/lib/ami-client.ts) to gather every
// CoreShowChannel event up to CoreShowChannelsComplete.
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const ami = getAmiClient();
  let activeCalls = 0;
  let amiConnected = true;

  try {
    await ami.connect();
    const { events } = await ami.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");
    const channelEvents = events.filter((e) => e.Event === "CoreShowChannel");

    // CoreShowChannels enumerates CHANNELS, not calls — a normal two-party
    // call is two channels (caller leg + callee leg), so a raw channel
    // count roughly doubles the true call count. Asterisk's per-channel
    // events group both legs of a call under a shared Linkedid; count
    // distinct Linkedids instead of channels. NOTE: whether CoreShowChannel
    // actually carries a `Linkedid` field is unverified against a live
    // Asterisk instance (no AMI docs page confirms it for this specific
    // event) — fall back to per-channel counting if it's absent, which at
    // least degrades to the old (wrong but conservative) behavior rather
    // than silently under-counting.
    const linkedIds = new Set(channelEvents.map((e) => e.Linkedid ?? e.Uniqueid ?? e.Channel));
    activeCalls = linkedIds.size;
  } catch {
    amiConnected = false;
  }

  const [agentsOnline, queues] = await Promise.all([
    db.extension.count({ where: { status: "AVAILABLE" } }),
    db.queue.findMany({ include: { members: true } }),
  ]);

  // Was hardcoded here (waiting: 0, longestWaitSec: 0, every member shown
  // as AVAILABLE) even though GET /api/queues, right next to this route,
  // already computed the real numbers from the same AMI QueueStatus
  // action — supervisors were making staffing decisions from invented
  // data. Now shares that exact computation via
  // src/lib/queue-status.ts's getQueueSnapshots().
  const queueSnapshots = amiConnected
    ? await getQueueSnapshots(ami, queues)
    : queues.map((q) => ({
        name: q.name,
        strategy: q.strategy,
        waiting: 0,
        longestWaitSec: 0,
        members: q.members.map((m) => ({ extension: m.extension, status: "OFFLINE" as const })),
      }));

  const snapshot: WallboardSnapshot = {
    activeCalls,
    agentsOnline,
    queues: queueSnapshots,
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json({ ...snapshot, amiConnected });
}
