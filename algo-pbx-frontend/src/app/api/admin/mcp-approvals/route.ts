import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { unsafeGlobalDb } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// POST/GET /api/admin/mcp-approvals — mints and lists the single-use
// approval tokens the internal MCP server (mcp-server/) requires for any
// write tool. Admin-only: an admin runs this from the dashboard (or curls
// it directly on the deployment VM) and hands the raw token to whoever is
// operating the MCP server for that one action.
//
// The raw token is returned ONLY in this POST response, never stored —
// mcp-server/approval.ts stores and checks only its SHA-256 hash, the same
// one-time-disclosure pattern as Invite.tokenHash and Extension.sipSecret's
// GET /api/me/sip-credentials.
const MintSchema = z.object({
  scope: z.string().min(1).max(100).default("pjsip.reload"),
  // Minting an unscoped ("*") approval requires this explicit flag — never
  // the default, so a hurried admin can't accidentally hand out a token
  // that authorizes every write tool including restart_container.
  unscoped: z.boolean().default(false),
  ttlMinutes: z.number().int().min(1).max(60).default(10),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const parsed = MintSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const scope = parsed.data.unscoped ? "*" : parsed.data.scope;
  const expiresAt = new Date(Date.now() + parsed.data.ttlMinutes * 60 * 1000);

  // McpApproval is deliberately platform-global (no tenantId column) —
  // src/lib/tenancy/scope-rules.ts's PLATFORM_GLOBAL_MODELS — so it must be
  // reached via unsafeGlobalDb, never the tenant-scoped `db`.
  const approval = await unsafeGlobalDb.mcpApproval.create({
    data: {
      tokenHash,
      mintedByAdminId: guard.session.user.id,
      scope,
      expiresAt,
    },
  });

  // No `tenantId` — force-injected at runtime by the tenant-scoped `db`.
  await db.auditLog.create({
    data: {
      action: "mcp_approval.mint",
      actorId: guard.session.user.id,
      targetId: approval.id,
      metadata: { scope, expiresAt: expiresAt.toISOString() },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  // The raw token — this is the ONLY response that will ever contain it.
  return NextResponse.json({ token, scope, expiresAt, approvalId: approval.id }, { status: 201 });
}

export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  // Platform-global — see the comment in POST above.
  const approvals = await unsafeGlobalDb.mcpApproval.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      scope: true,
      mintedByAdminId: true,
      expiresAt: true,
      consumedAt: true,
      createdAt: true,
      // tokenHash intentionally excluded — no operational need to ever
      // display it, and no reason to give an attacker with read access to
      // this endpoint a head start on anything.
    },
  });
  return NextResponse.json({ approvals });
}
