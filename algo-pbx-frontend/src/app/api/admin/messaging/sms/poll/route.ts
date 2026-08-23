import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { getProvider } from "@/lib/messaging/registry";
import { ingestInboundEvent } from "@/lib/messaging/ingest";

export const dynamic = "force-dynamic";

// POST /api/admin/messaging/sms/poll — the Dinstar UC2000 has no
// documented outbound webhook (see dinstar-sms-provider.ts's header), so
// inbound SMS is pulled rather than pushed. This route drives that pull.
// Admin-session-gated for interactive use from /admin/sms's "Check for new
// SMS" button; for unattended polling, hit it on a schedule with a cron
// job authenticated the same way (an admin session cookie won't work from
// cron — run this via a scheduled admin-authenticated request, or extend
// this route with the same bearer-secret pattern api/cdr/route.ts uses for
// its own server-to-server ingest if unattended polling is needed before a
// human is available to click the button. Left as an explicit follow-up
// rather than guessed at, since the choice has real security tradeoffs.)
export async function POST() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const provider = getProvider("DINSTAR_SMS");
  if (!provider.pollInbound) {
    return NextResponse.json({ error: "Configured provider does not support polling." }, { status: 501 });
  }

  try {
    const events = await provider.pollInbound("all");
    let ingested = 0;
    for (const event of events) {
      // instanceRef here is the 1-indexed SIM port ("1".."4") reported by
      // DinstarSmsProvider.parseInbound — resolve to the WaInstance row
      // paired on that port, if one exists.
      const waInstance = event.instanceRef
        ? await db.waInstance.findUnique({ where: { simPort: Number(event.instanceRef) } })
        : null;
      await ingestInboundEvent(event, "SMS", waInstance?.id ?? null);
      ingested += 1;
    }
    return NextResponse.json({ ok: true, ingested });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Poll failed" }, { status: 502 });
  }
}
