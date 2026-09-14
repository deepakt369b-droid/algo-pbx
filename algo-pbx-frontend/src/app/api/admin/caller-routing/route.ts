import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/caller-routing — the caller-ID routing rules list
// (2026-09-14 Tel-Agent gap analysis; see prisma/schema.prisma's
// CallerRoutingRule header for the design). Admin-only, same guard as the
// rest of /admin — unlike DNC (staff can add a number to the blocklist),
// deciding "this caller always reaches a human" or "always blocked" is a
// tenant-policy decision, not a day-to-day agent action.

// No withApiErrorHandler wrapper here — same precedent as
// api/admin/ai/providers/route.ts's own no-arg GET: that wrapper's generic
// requires a NextRequest as the first argument, which only matters for a
// handler that actually reads one.
export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const rules = await db.callerRoutingRule.findMany({
    select: { id: true, pattern: true, action: true, note: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ rules });
}

// A bare E.164 number, or a prefix ending in "*" (e.g. "+9715*"). Validated
// loosely here (real shape, not full E.164 parsing) since normalizeToE164
// can't parse a "*"-terminated prefix — only an exact-number pattern goes
// through it; a prefix pattern is trusted as typed, same as the dialplan's
// own LIKE-based matching will treat it.
const PatternSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^\+?[0-9]+\*?$/, "Pattern must be digits, optionally starting with + and ending with *");

const CreateRuleSchema = z.object({
  pattern: PatternSchema,
  action: z.enum(["PASS", "BLOCK", "AI"]),
  note: z.string().max(200).optional(),
});

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = CreateRuleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Normalize an EXACT pattern to E.164 (same canonical form DNC already
  // uses) so a rule written as "0501234567" and one written as
  // "+971501234567" can't both exist as two different, silently-conflicting
  // rows. A prefix pattern (ends in "*") is stored as typed — it isn't a
  // single parseable number, and the dialplan's LIKE match works on the raw
  // digit string either way.
  let pattern = parsed.data.pattern;
  if (!pattern.endsWith("*")) {
    const normalized = normalizeToE164(pattern);
    if (!normalized) {
      return NextResponse.json({ error: `"${pattern}" doesn't look like a valid phone number.` }, { status: 400 });
    }
    pattern = normalized;
  }

  // tenantId included in `create` to satisfy the generated CreateInput type
  // — TenantClient force-overrides it at runtime regardless (same pattern
  // as api/dnc/route.ts's own identical comment).
  try {
    const rule = await db.callerRoutingRule.create({
      data: { tenantId: session.user.tenantId, pattern, action: parsed.data.action, note: parsed.data.note },
    });
    return NextResponse.json({ rule }, { status: 201 });
  } catch (err) {
    // @@unique([tenantId, pattern]) — same P2002-to-409 mapping convention
    // as admin/ai/agents/route.ts's dinstarPort collision handling.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: `A rule for "${pattern}" already exists.` }, { status: 409 });
    }
    throw err;
  }
});
