import type { NextRequest } from "next/server";
import { db } from "@/lib/db";

// Shared filter parsing for every /api/admin/reports/* route. The Reports hub
// drives all of its charts from one <ReportFilters> control, which appends
// ?agentId=&from=&to= to every request. `from`/`to` are ISO date strings
// (yyyy-mm-dd or full ISO); `agentId` is a User.id (the agent whose work to
// scope to) or absent for "all agents".
export interface ReportFilters {
  agentId: string | null;
  from: Date;
  to: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseReportFilters(request: NextRequest): ReportFilters {
  const sp = request.nextUrl.searchParams;
  const agentId = sp.get("agentId")?.trim() || null;

  const rawFrom = sp.get("from");
  const rawTo = sp.get("to");
  const now = Date.now();

  let from = rawFrom ? new Date(rawFrom) : new Date(now - 30 * DAY_MS);
  if (Number.isNaN(from.getTime())) from = new Date(now - 30 * DAY_MS);

  let to = rawTo ? new Date(rawTo) : new Date(now);
  if (Number.isNaN(to.getTime())) to = new Date(now);
  // A bare yyyy-mm-dd parses to 00:00 UTC — push the upper bound to the end
  // of that day so a same-day from/to still contains that day's rows.
  if (rawTo && /^\d{4}-\d{2}-\d{2}$/.test(rawTo)) {
    to = new Date(to.getTime() + DAY_MS - 1);
  }

  return { agentId, from, to };
}

// CDR rows key the agent by the bare extension string (agentExtension), not a
// User FK — see agent-hours/route.ts's CAVEAT. To scope a CDR query to one
// agent we resolve their current Extension.number. Returns:
//   undefined  -> no agent filter (caller passed no agentId)
//   string     -> filter agentExtension = this
//   null       -> agent has no extension; caller should return zero rows
export async function resolveAgentExtension(
  agentId: string | null,
): Promise<string | null | undefined> {
  if (!agentId) return undefined;
  const ext = await db.extension.findUnique({
    where: { userId: agentId },
    select: { number: true },
  });
  return ext?.number ?? null;
}
