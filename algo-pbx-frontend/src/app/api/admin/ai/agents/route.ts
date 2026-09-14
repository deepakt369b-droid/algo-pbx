import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { unsafeGlobalDb } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { assertSeatAvailable, getSeatUsage, SeatLimitError } from "@/lib/platform/seat-guard";
import { planHasFeature } from "@/lib/platform/plan-catalog";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/ai/agents — new for W7 (not pre-assigned to any node;
// the AI-agents admin UI needs somewhere to read/write AiAgent itself, and
// contracts.md's provider-credential routes are the only other AI admin
// routes that exist). Auth/tenant-scoping mirrors
// src/app/api/admin/ai/providers/route.ts exactly (requireAdminSession +
// tenant-scoped db).
//
// Every route here also re-checks `planHasFeature(plan, "aiAgents")` even
// though the UI is only supposed to show these controls on a qualifying
// plan — a tenant admin hand-crafting the request past a stale client
// bundle must not be able to provision an AI agent that was never sold to
// them.
const AGENT_LIST_SELECT = {
  id: true,
  name: true,
  language: true,
  pipelineMode: true,
  enabled: true,
  outboundEnabled: true,
  dinstarPort: true,
  extension: { select: { id: true, number: true } },
} as const;

async function tenantPlan(tenantId: string): Promise<string> {
  // Tenant is deliberately NOT in TENANT_SCOPED_MODELS (it's the scoping
  // root, not a child row) — same reasoning as admin/layout.tsx and
  // seat-guard.ts, which both go through unsafeGlobalDb for this exact
  // lookup rather than the tenant-scoped client.
  const tenant = await unsafeGlobalDb.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  return tenant?.plan ?? "standard";
}

export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  const [agents, plan, seatUsage] = await Promise.all([
    db.aiAgent.findMany({ orderBy: { createdAt: "desc" }, select: AGENT_LIST_SELECT }),
    tenantPlan(session.user.tenantId),
    getSeatUsage(session.user.tenantId),
  ]);

  return NextResponse.json({ agents, plan, planHasAiAgents: planHasFeature(plan, "aiAgents"), seatUsage });
});

// POST — the "quick create" step from the users page's Human|AI chooser:
// just a name + extension number. Everything else (prompt, greeting,
// provider/model legs, compliance fields) is filled in afterwards in the
// agent editor via PATCH /api/admin/ai/agents/[id] — an AiAgent row is
// created here with safe, inert defaults (outboundEnabled false,
// allowedDestinations empty, enabled true but no providers wired yet, so
// the sidecar has nothing to actually call out with).
const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  // Same shape as POST /api/extensions's `number` field — matches the
  // dialplan's actual internal-dialing pattern (_1XXX/_2XXX only).
  extensionNumber: z.string().regex(/^[12]\d{3}$/, "extension must be a 4-digit number starting with 1 or 2"),
  language: z.string().min(1).max(20).default("en"),
  // Follow-up to §34 (LLM.md, 2026-09-14): which Dinstar GSM port (1-4,
  // matching WaInstance.simPort's numbering) this agent should answer
  // inbound calls on. null/omitted = not assigned yet (internal-dial-only).
  dinstarPort: z.number().int().min(1).max(4).nullable().optional(),
});

const DEFAULT_GREETING =
  "Hello, you are speaking with an automated assistant. How can I help you today?";

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  const plan = await tenantPlan(session.user.tenantId);
  if (!planHasFeature(plan, "aiAgents")) {
    return NextResponse.json({ error: "AI agents are not included on this plan." }, { status: 403 });
  }

  const parsed = CreateAgentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
  }
  const { name, extensionNumber, language, dinstarPort } = parsed.data;

  // Seat guard (hybrid AI + human plan) — an AI agent's Extension counts
  // against the same seat pool as a HUMAN one (contracts.md "Seats").
  try {
    await assertSeatAvailable(session.user.tenantId);
  } catch (err) {
    if (err instanceof SeatLimitError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  const existing = await db.extension.findFirst({ where: { number: extensionNumber } });
  if (existing) {
    return NextResponse.json({ error: `Extension ${extensionNumber} is already in use.` }, { status: 409 });
  }


  // No sipSecret/voicemailPin, no PJSIP reload — AI extensions never
  // register over PJSIP; Asterisk reaches them over AudioSocket instead
  // (contracts.md "Extension.agentType"), so there is nothing here to
  // regenerate.
  let agent;
  try {
    agent = await db.aiAgent.create({
      data: {
        name,
        language,
        greeting: DEFAULT_GREETING,
        systemPrompt: "",
        pipelineMode: "CASCADE",
        // Ships DISABLED (schema default is true — overridden here), not
        // just with inert providers: the shared Asterisk instance's
        // AI_INBOUND_EXTENSION() has no per-tenant routing (post-
        // verification finding, 2026-09-14), so a second tenant enabling
        // an AI agent while another tenant's is already enabled would
        // route that tenant's callers to THIS agent. The PATCH route
        // enforces the same "only one tenant enabled at a time" guard when
        // an admin explicitly flips this on.
        enabled: false,
        outboundEnabled: false,
        allowedDestinations: [],
        dinstarPort: dinstarPort ?? null,
        extension: {
          create: {
            tenantId: session.user.tenantId,
            number: extensionNumber,
            agentType: "AI",
          },
        },
      } as unknown as Prisma.AiAgentUncheckedCreateInput,
      select: { ...AGENT_LIST_SELECT, greeting: true, systemPrompt: true },
    });
  } catch (err) {
    // Follow-up to §34 (LLM.md, 2026-09-14): a P2002 on
    // AiAgent_tenantId_dinstarPort_key means another agent on this tenant
    // already holds the requested GSM port — surface a clear, actionable
    // message instead of the raw Prisma constraint error (same pattern as
    // admin/contacts/[id]/route.ts's P2002 handling).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && dinstarPort) {
      return NextResponse.json(
        { error: `GSM port ${dinstarPort} is already assigned to another AI agent — unassign it there first.` },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : "Failed to create the AI agent.";
    return NextResponse.json({ error: message }, { status: 409 });
  }

  return NextResponse.json({ agent }, { status: 201 });
});
