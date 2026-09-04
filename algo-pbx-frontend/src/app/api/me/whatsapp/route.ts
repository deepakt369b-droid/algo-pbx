import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/me/whatsapp — the agent-facing counterpart to
// /admin/whatsapp/page.tsx's own comment (and chat-panel.tsx's) that
// agents "see a read-only connection status in their own chat panel" —
// no such route or UI element actually existed until now. Returns only
// the calling agent's OWN assigned WaInstance (via
// WaInstance.assignedUserId, the one-agent-per-SIM-port ownership added
// alongside the admin provisioning form), never any other agent's, and
// exposes no control — pairing/logout stay exclusively admin-only per the
// hard product requirement documented throughout src/app/admin/whatsapp.
export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const instance = await db.waInstance.findUnique({
    where: { assignedUserId: guard.session.user.id },
    select: { label: true, simPort: true, phoneE164: true, status: true, pushName: true, lastError: true },
  });

  if (!instance) {
    return NextResponse.json({ assigned: false });
  }

  return NextResponse.json({ assigned: true, ...instance });
}
