import { randomBytes, randomInt } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { regeneratePjsipConfigAndReload } from "@/lib/pjsip-provision";
import { regenerateVoicemailConfigAndReload } from "@/lib/voicemail-provision";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

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
      status: true,
      lastSeenAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      user: { select: { id: true, name: true, email: true, role: true } },
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
  number: z.string().regex(/^\d{3,6}$/),
  kind: z.enum(["webrtc", "hardware"]).default("webrtc"),
});

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const body = await req.json();
  const parsed = CreateExtensionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
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
    data: { ...parsed.data, sipSecret, voicemailPin },
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
