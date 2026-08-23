import { db } from "../src/lib/db";

// Prisma-backed read tools. All read-only — GROUP BY/aggregation only,
// never a write. See mcp-server/README.md for the full tool list.

export async function getRecentCdrs(limit: number, since?: string) {
  const rows = await db.callDetailRecord.findMany({
    where: since ? { startedAt: { gte: new Date(since) } } : undefined,
    orderBy: { startedAt: "desc" },
    take: Math.max(1, Math.min(200, limit)),
    select: {
      uniqueId: true,
      callerNumber: true,
      destination: true,
      direction: true,
      disposition: true,
      startedAt: true,
      durationSec: true,
      agentExtension: true,
    },
  });
  return rows;
}

export async function getAgentStatus() {
  const rows = await db.extension.findMany({
    select: {
      number: true,
      kind: true,
      status: true,
      lastSeenAt: true,
      user: { select: { email: true, name: true } },
    },
    orderBy: { number: "asc" },
  });
  return rows;
}

// WebRTC/MOS quality (Workstream B's CallQualitySample table). If that
// model doesn't exist in a given deployment's generated Prisma client
// (e.g. this file is used against an older migration), this will throw at
// call time — the tool handler in index.ts catches and reports that
// clearly rather than crashing the server.
export async function getWebrtcCallQuality(callId: string, limit: number) {
  const rows = await db.callQualitySample.findMany({
    where: { callId },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(500, limit)),
  });
  return rows;
}

export async function getQueueMembers() {
  const rows = await db.queue.findMany({ include: { members: true } });
  return rows;
}
