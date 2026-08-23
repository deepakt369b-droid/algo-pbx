import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// POST/GET /api/admin/api-keys — mint and list machine-to-machine API keys
// for the CRM integration surface (/api/crm/**). Same one-time-disclosure
// discipline as everything else sensitive in this codebase (Invite,
// Extension.sipSecret, McpApproval): the raw key is returned exactly once,
// only its SHA-256 hash is ever stored.
const CreateSchema = z.object({
  label: z.string().min(1).max(100),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const key = randomBytes(32).toString("hex");
  const keyHash = createHash("sha256").update(key).digest("hex");

  const apiKey = await db.apiKey.create({
    data: { keyHash, label: parsed.data.label, createdById: guard.session.user.id },
  });

  await db.auditLog.create({
    data: { action: "api_key.create", actorId: guard.session.user.id, targetId: apiKey.id, metadata: { label: apiKey.label } },
  });

  return NextResponse.json({ key, id: apiKey.id, label: apiKey.label }, { status: 201 });
}

export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const keys = await db.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, createdById: true, lastUsedAt: true, revokedAt: true, createdAt: true },
  });
  return NextResponse.json({ keys });
}
