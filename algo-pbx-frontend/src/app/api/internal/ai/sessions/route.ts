import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withApiErrorHandler } from "@/lib/api-handler";
import { isAuthorizedInternalAiRequest } from "@/app/api/internal/ai/_auth";
import { recordAiSession } from "@/lib/ai/sessions";
import type { AiSessionReportRequest } from "@/lib/ai/types";

export const dynamic = "force-dynamic";

const TranscriptEntrySchema = z.object({
  role: z.enum(["agent", "caller"]),
  text: z.string(),
  at: z.string(),
});

// handoffExtensionId (AiCallSession.handoffExtensionId, schema.prisma) is a
// plain descriptive string with no FK to Extension by design — it may hold
// either an internal extension's number or an external E.164 number dialed
// out over the GSM trunk (LLM.md §34.2's escalation design supports both
// target kinds), so this route can't validate it against any single table.
// What it CAN and must enforce: the field only makes sense paired with
// outcome "handed_off" — a non-null value under any other outcome is
// malformed data from the sidecar, not a valid report of something that
// happened, and was previously accepted silently.
const SessionReportSchema = z
  .object({
    agentId: z.string(),
    cdrUniqueId: z.string(),
    transcript: z.array(TranscriptEntrySchema),
    summary: z.string().optional(),
    latencyMsP50: z.number().optional(),
    latencyMsP95: z.number().optional(),
    costTokensInput: z.number().optional(),
    costTokensOutput: z.number().optional(),
    outcome: z.enum(["completed", "handed_off", "dropped", "error"]),
    handoffExtensionId: z.string().nullable().optional(),
  })
  .refine((data) => !data.handoffExtensionId || data.outcome === "handed_off", {
    message: "handoffExtensionId may only be set when outcome is \"handed_off\".",
    path: ["handoffExtensionId"],
  });

// POST /api/internal/ai/sessions — the sidecar (W4) reports what happened
// on a call. See src/lib/ai/sessions.ts (recordAiSession) for the actual
// AiCallSession + CRM Activity write logic, kept in a plain function so
// it's testable without going through this HTTP layer.
export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  if (!isAuthorizedInternalAiRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = SessionReportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const input: AiSessionReportRequest = {
    ...parsed.data,
    handoffExtensionId: parsed.data.handoffExtensionId ?? null,
  };

  await recordAiSession(input);

  return NextResponse.json({ ok: true }, { status: 201 });
});
