import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth-guard";
import { getAmiClient } from "@/lib/ami-client";
import { watchEscalationOutcome } from "@/lib/escalation";
import { getProvider } from "@/lib/messaging/registry";

export const dynamic = "force-dynamic";

const Schema = z.object({ targetId: z.string().min(1) });

// POST /api/agent/escalate { targetId } — the server-side half of a
// manager escalation. The client (escalation-picker.tsx) fires this
// alongside its own blindTransfer() SIP REFER; this route doesn't
// initiate or need to know about that transfer at all — it just WATCHES
// for the resulting DialEnd on the target's extension (if it has one) and
// records + reacts to the outcome. A phoneE164-only target (no internal
// extension — an external manager number reached only via the Dinstar
// trunk) has no PJSIP channel to watch, so outcome stays UNKNOWN and this
// route only logs the attempt; the transfer itself still happens via the
// client's blindTransfer(), unaffected by whether this route can observe it.
export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const target = await db.escalationTarget.findUnique({ where: { id: parsed.data.targetId } });
  if (!target || !target.active) {
    return NextResponse.json({ error: "That escalation target is not available." }, { status: 404 });
  }

  let outcome: "ANSWERED" | "BUSY" | "NO_ANSWER" | "FAILED" | "UNKNOWN" = "UNKNOWN";
  if (target.extension) {
    try {
      const ami = getAmiClient();
      await ami.connect();
      outcome = await watchEscalationOutcome(ami, target.extension);
    } catch {
      // AMI unreachable — the transfer itself (client-side blindTransfer)
      // is independent of this observation and may still have succeeded;
      // don't fail the whole request over a monitoring-layer problem.
      outcome = "UNKNOWN";
    }
  }

  let waNotified = false;
  let waError: string | undefined;
  if (outcome === "BUSY" || outcome === "NO_ANSWER" || outcome === "FAILED") {
    if (target.phoneE164) {
      try {
        const instance = await db.waInstance.findFirst({
          where: { provider: "OPENWA", status: "CONNECTED", openwaSessionId: { not: null } },
          select: { openwaSessionId: true },
        });
        if (!instance?.openwaSessionId) {
          waError = "No connected WhatsApp instance available to send the notification.";
        } else {
          const result = await getProvider("OPENWA").sendText({
            instanceId: instance.openwaSessionId,
            toE164: target.phoneE164,
            text: `Missed escalation call from ${session.user.name ?? session.user.email} at ${new Date().toLocaleString()}.`,
          });
          waNotified = result.status !== "failed";
          if (!waNotified) waError = result.error ?? "Send failed.";
        }
      } catch (err) {
        // Failing soft is deliberate — a WhatsApp ping failure must never
        // block logging the escalation attempt itself.
        waError = err instanceof Error ? err.message : "WhatsApp notification failed.";
      }
    } else {
      waError = "This target has no WhatsApp number configured.";
    }
  }

  // No `tenantId` — force-injected at runtime by the tenant-scoped `db`.
  const attempt = await db.escalationAttempt.create({
    data: {
      agentId: session.user.id,
      targetId: target.id,
      targetName: target.name,
      outcome,
      waNotified,
      waError,
      resolvedAt: new Date(),
    } as unknown as Prisma.EscalationAttemptUncheckedCreateInput,
  });

  return NextResponse.json({ outcome, attemptId: attempt.id, waNotified, waError });
}
