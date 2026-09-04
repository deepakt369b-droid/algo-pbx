import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAmiClient } from "@/lib/ami-client";
import { requireApiKey } from "@/lib/api-key-auth";
import { checkSimpleRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /api/crm/click-to-call { extension, destination } — lets an
// external CRM trigger an outbound call from its own UI: originates the
// agent's extension, which on answer is bridged to `destination` via the
// Dinstar trunk. Same AMI Originate pattern as
// src/app/api/calls/conference/route.ts, and the same tightened,
// digits-only Zod validation that route now uses — this value reaches an
// AMI action's Channel field, so it is constrained the same way for the
// same CRLF-injection reason (see ami-client.ts's frameAction() comment).
const ClickToCallSchema = z.object({
  extension: z.string().regex(/^\d{3,6}$/, "extension must be 3-6 digits"),
  destination: z.string().regex(/^\+?\d{3,15}$/, "destination must be digits only (optionally leading +)"),
});

export async function POST(request: NextRequest) {
  const guard = await requireApiKey(request);
  if ("response" in guard) return guard.response;
  const { db } = guard;
  if (!checkSimpleRateLimit(`crm:${guard.apiKey.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = ClickToCallSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });

  const { extension, destination } = parsed.data;

  // AMI Originate's Context/Exten/Priority bypass the endpoint's own
  // configured `context=` entirely (unlike a normal Dial()) — it has to
  // be told explicitly which of the Loop C2 dial-permission tiers to
  // originate into. Falls back to the most restrictive tier
  // (from-agent-local) if the extension isn't found, matching
  // Extension.dialPermission's own DB default — fail closed, not open.
  // findFirst, not findUnique — `number` alone is no longer a unique key by
  // itself (it's `@@unique([tenantId, number])` now, plan §1); within this
  // API key's own tenant-scoped client it's effectively unique.
  const record = await db.extension.findFirst({ where: { number: extension }, select: { dialPermission: true } });
  const context = `from-agent-${(record?.dialPermission ?? "LOCAL").toLowerCase()}`;

  const ami = getAmiClient();
  try {
    await ami.connect();
    const res = await ami.send({
      Action: "Originate",
      Channel: `PJSIP/${extension}`,
      Context: context,
      Exten: destination.replace(/^\+/, ""),
      Priority: "1",
      Async: "true",
      CallerID: `CRM Click-to-Call <${extension}>`,
    });
    return NextResponse.json({ result: res });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? "AMI originate failed" : "AMI error" }, { status: 502 });
  }
}
