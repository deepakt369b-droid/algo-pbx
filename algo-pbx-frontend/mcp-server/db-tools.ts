// Prisma-backed read tools. All read-only — GROUP BY/aggregation only,
// never a write. See mcp-server/README.md for the full tool list.
//
// FLAGGED FOR OWNER REVIEW (wave 2e, multi-tenant SaaS foundation): every
// function below queries a tenant-scoped model (CallDetailRecord,
// Extension, CallQualitySample, Queue — all on
// src/lib/tenancy/scope-rules.ts's TENANT_SCOPED_MODELS) via unsafeGlobalDb,
// with NO tenantId filter anywhere in this file. That means an MCP client
// with access to this server can read CDRs, agent status, call-quality
// samples, and queue membership across EVERY tenant, not just one. This is
// the minimal compile fix (this file had no tenant/session concept before
// wave 1 either, since mcp-server runs standalone outside the Next.js
// request lifecycle — no session, no host, nothing to derive a tenantId
// from), NOT a judgment that this is safe. It was true before this wave
// too (there was only one tenant in practice), but wave 1 made "more than
// one tenant" a real possibility this server does not defend against.
// Before a second tenant ever goes live on a deployment that also runs
// this MCP server, an owner needs to decide: (a) restrict this server to
// single-tenant deployments only, (b) add a required tenantId parameter to
// every tool here and thread it through to a tenantDb(tenantId) call, or
// (c) accept this as an intentional operator-only/infra escape hatch
// (same category as unsafeGlobalDb's own doc comment describes) and
// document that decision explicitly. Not resolved here — flagging per this
// wave's task brief rather than silently picking one.
import { unsafeGlobalDb } from "../src/lib/db";

export async function getRecentCdrs(limit: number, since?: string) {
  const rows = await unsafeGlobalDb.callDetailRecord.findMany({
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
  const rows = await unsafeGlobalDb.extension.findMany({
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
  const rows = await unsafeGlobalDb.callQualitySample.findMany({
    where: { callId },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(500, limit)),
  });
  return rows;
}

export async function getQueueMembers() {
  const rows = await unsafeGlobalDb.queue.findMany({ include: { members: true } });
  return rows;
}
