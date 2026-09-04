import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/messaging/sms-access-requests — the admin dashboard's
// pending-approvals list (src/app/admin/sms/page.tsx polls this every 5s,
// same pattern as src/components/wallboard.tsx — this codebase has no
// websocket/SSE infra, so a fast poll is the "notification" for the
// request/approve/decline/revoke workflow, not a literal push).
export async function GET(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const status = request.nextUrl.searchParams.get("status");
  const where = status ? { status: status as "PENDING" | "APPROVED" | "DECLINED" | "REVOKED" } : {};

  const requests = await db.smsAccessRequest.findMany({
    where,
    include: {
      message: { select: { id: true, conversationId: true, createdAt: true } },
      requestedBy: { select: { id: true, name: true, email: true } },
      decidedBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ requests });
}
