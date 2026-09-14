import { randomBytes, randomInt } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireStaffSession } from "@/lib/auth-guard";
import { regeneratePjsipConfigAndReload } from "@/lib/pjsip-provision";
import { regenerateVoicemailConfigAndReload } from "@/lib/voicemail-provision";
import { withApiErrorHandler } from "@/lib/api-handler";
import { assertSeatAvailable, SeatLimitError } from "@/lib/platform/seat-guard";

export const dynamic = "force-dynamic";

export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  // sipSecret is deliberately excluded — even from staff — on every listing
  // request. It's disclosed exactly once, in the POST response body below,
  // at creation time. An agent's own copy comes from
  // GET /api/me/sip-credentials, scoped to their own session only.
  // (Using an explicit `select` rather than Prisma's `omit` — this client
  // generation's types reject `omit` with `never`, apparently needing a
  // preview flag this project doesn't have enabled; `select` needs none.)
  const extensions = await db.extension.findMany({
    select: {
      id: true,
      number: true,
      kind: true,
      // "HUMAN" | "AI" — read-only here. Included so callers like the AI
      // agent editor's escalation-target picker (LLM.md §34.2) can filter
      // to HUMAN extensions client-side without a second endpoint; this
      // route already returns every tenant extension regardless of type.
      agentType: true,
      status: true,
      dialPermission: true,
      lastSeenAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      user: { select: { id: true, name: true, email: true, role: true } },
      // W6 (plan §3.3) — read-only on the tenant-admin plane. The
      // allocation itself is owner-only (see /api/extensions/[number]'s
      // guardrail against writing geoAllowedCountries here); this tab only
      // ever displays it and the current lock state.
      geoAllowedCountries: true,
      geoLockedAt: true,
      geoLockedReason: true,
    },
  });
  return NextResponse.json({ extensions });
});

// POST /api/extensions — provisioning. Phase A: generates a real PJSIP
// digest secret, regenerates pjsip_dynamic.conf from every provisioned
// extension, and triggers an AMI `pjsip reload` — closing the gap this
// route's comment used to describe (DB-only writes with no effect on
// Asterisk). See src/lib/pjsip-provision.ts and pjsip-config.ts.
const CreateExtensionSchema = z.object({
  // Tightened from \d{3,6} 2026-08-29: pbx_configs/extensions.conf's
  // [from-agent-local] only ever matches `_1XXX`/`_2XXX` for internal
  // dialing (confirmed by reading the dialplan directly). A provisioned
  // number outside that shape — "100", "10001" — would register and take
  // calls fine, but be UNDIALABLE by any other internal extension, and
  // src/lib/transfer-guard.ts's isInternalExtension() would misclassify it
  // as "external" and refuse transfers to it with a confusing message.
  // Matching the dialplan's actual pattern here closes that gap at
  // provisioning time rather than leaving it to be discovered per-symptom.
  number: z.string().regex(/^[12]\d{3}$/, "extension must be a 4-digit number starting with 1 or 2"),
  kind: z.enum(["webrtc", "hardware"]).default("webrtc"),
  // Loop C2 — defaults to the Prisma column's own default (LOCAL) when
  // omitted, matching Zod's own optional-with-default semantics.
  dialPermission: z.enum(["LOCAL", "NATIONAL", "INTERNATIONAL"]).default("LOCAL"),
});

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const body = await req.json();
  const parsed = CreateExtensionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Seat guard (hybrid AI + human plan) — this route provisions an Extension
  // unconditionally, so the check runs on every request rather than being
  // gated on a flag (contrast with /api/admin/users's conditional check).
  try {
    await assertSeatAvailable(guard.session.user.tenantId);
  } catch (err) {
    if (err instanceof SeatLimitError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  // A digest-usable secret, NOT the same concept as a user's bcrypt-hashed
  // web password (see prisma/schema.prisma's Extension.sipSecret comment).
  // 24 random bytes / hex-encoded = 48 chars, well beyond typical PJSIP
  // digest secret length limits without being unwieldy.
  const sipSecret = randomBytes(24).toString("hex");
  // 4-digit numeric PIN for VoicemailMain() access (Phase E) — short by
  // design, since it's entered over a phone keypad, not typed.
  const voicemailPin = String(randomInt(1000, 10000));

  const extension = await db.extension.create({
    // No `tenantId` — the TenantClient extension force-injects it at
    // runtime (see crm/activity.ts's comment on the same pattern); the
    // double-cast satisfies the compiler about that runtime guarantee.
    data: { ...parsed.data, sipSecret, voicemailPin } as unknown as Prisma.ExtensionUncheckedCreateInput,
  });

  try {
    await regeneratePjsipConfigAndReload();
    await regenerateVoicemailConfigAndReload();
  } catch (err) {
    // The DB row now exists but Asterisk doesn't know about it yet — not
    // ideal, but failing the whole request would leave the admin with no
    // record the extension was created at all. Surface the failure so the
    // caller knows to retry the reload (e.g. re-save from the admin UI)
    // rather than assuming the endpoint is live.
    return NextResponse.json(
      {
        extension: { ...extension, sipSecret: undefined, voicemailPin: undefined },
        sipSecret, // one-time disclosure — see GET's comment above
        voicemailPin,
        warning: `Extension saved, but reloading Asterisk failed: ${err instanceof Error ? err.message : "unknown error"}. It will not be able to register until this is retried.`,
      },
      { status: 201 }
    );
  }

  return NextResponse.json(
    { extension: { ...extension, sipSecret: undefined, voicemailPin: undefined }, sipSecret, voicemailPin },
    { status: 201 }
  );
});
