import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/gateway-events — read side of the Dinstar gateway syslog
// panel (/admin/system's "Gateway events" panel). Staff-only, same as the
// rest of the admin diagnostics surface. Served off the receivedAt index
// GatewayEvent already carries.
const QuerySchema = z.object({
  category: z.enum(["GSM", "SIP", "VPN", "SYSTEM", "RAW"]).optional(),
  severity: z.enum(["EMERG", "ALERT", "CRIT", "ERROR", "WARNING", "NOTICE", "INFO", "DEBUG"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    category: searchParams.get("category") ?? undefined,
    severity: searchParams.get("severity") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query", details: parsed.error.flatten() }, { status: 400 });
  }
  const { category, severity, limit } = parsed.data;

  const [events, lastCritical] = await Promise.all([
    db.gatewayEvent.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(severity ? { severity } : {}),
      },
      orderBy: { receivedAt: "desc" },
      take: limit,
    }),
    // "Last error" summary line — the actual diagnostic payoff of this
    // whole feature: what the gateway itself last reported going wrong,
    // without SSHing in to scrape logs.
    db.gatewayEvent.findFirst({
      where: { severity: { in: ["EMERG", "ALERT", "CRIT", "ERROR"] } },
      orderBy: { receivedAt: "desc" },
    }),
  ]);

  return NextResponse.json({ events, lastCritical });
}
