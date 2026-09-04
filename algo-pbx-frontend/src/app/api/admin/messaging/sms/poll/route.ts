import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb } from "@/lib/db";
import { tenantDb } from "@/lib/db-tenant";
import { requireAdminSession } from "@/lib/auth-guard";
import { getProvider } from "@/lib/messaging/registry";
import { ingestInboundEvent } from "@/lib/messaging/ingest";

export const dynamic = "force-dynamic";

// This route now has two authorized callers, same split as api/cdr/route.ts:
// an interactive admin session (the "Check for new SMS" button in
// /admin/sms) OR a shared bearer secret for unattended cron polling — the
// Dinstar UC2000 has no outbound webhook (dinstar-sms-provider.ts's
// header), so without a cron path inbound SMS only ever arrived when a
// human clicked a button, which is itself a "system isn't ready" symptom.
// Crontab line (adjust the interval to taste):
//   * * * * * curl -s -X POST -H "Authorization: Bearer $SMS_POLL_SECRET" http://web:3000/api/admin/messaging/sms/poll
function isAuthorizedCronRequest(req: NextRequest): boolean {
  const expected = process.env.SMS_POLL_SECRET;
  if (!expected) return false; // fail closed if the secret was never configured
  const provided = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    const guard = await requireAdminSession();
    if ("response" in guard) return guard.response;
  }

  const provider = getProvider("DINSTAR_SMS");
  if (!provider.pollInbound) {
    return NextResponse.json({ error: "Configured provider does not support polling." }, { status: 501 });
  }

  try {
    const events = await provider.pollInbound("all");
    let ingested = 0;
    let skipped = 0;
    for (const event of events) {
      // instanceRef here is the 1-indexed SIM port ("1".."4") reported by
      // DinstarSmsProvider.parseInbound — resolve to the WaInstance row
      // paired on that port, if one exists. This lookup is deliberately
      // unscoped (unsafeGlobalDb): the single physical Dinstar gateway is
      // shared infrastructure with no tenant context of its own — the
      // WaInstance row paired to a given SIM port is the ONLY source of
      // which tenant this SMS belongs to, so it must be resolved before a
      // tenant-scoped client can even be built. This mirrors the openwa
      // webhook's tenant-resolution design (see that route) exactly.
      // findFirst, not findUnique — simPort alone is no longer a unique key
      // by itself (it's `@@unique([tenantId, simPort])` now, plan §1), and
      // there is by definition no tenantId to scope by yet at this point.
      const waInstance = event.instanceRef
        ? await unsafeGlobalDb.waInstance.findFirst({ where: { simPort: Number(event.instanceRef) } })
        : null;
      if (!waInstance) {
        // No paired WaInstance for this SIM port means no tenant can be
        // attributed — skip rather than guess (e.g. the admin session's own
        // tenant, which may not be the port's actual owner).
        skipped += 1;
        continue;
      }
      await ingestInboundEvent(tenantDb(waInstance.tenantId), event, "SMS", waInstance.id);
      ingested += 1;
    }
    return NextResponse.json({ ok: true, ingested, skipped });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Poll failed" }, { status: 502 });
  }
}
