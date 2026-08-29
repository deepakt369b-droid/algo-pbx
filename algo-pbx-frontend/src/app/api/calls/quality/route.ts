import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// POST /api/calls/quality — receives periodic WebRTC stats samples from
// the agent's own browser during an active call (see
// src/lib/webrtc-stats.ts and src/contexts/sip-context.tsx's 5s polling
// loop). Before this route existed there was no telemetry anywhere for
// jitter/loss/RTT — an agent reporting "the audio was bad" was
// undiagnosable. requireSession only (not staff): any authenticated agent
// reports on their own calls; there is no cross-user data here to protect
// beyond normal auth.
const QualitySampleSchema = z.object({
  callId: z.string().min(1).max(256),
  jitterMs: z.number().nullable().optional(),
  packetsLost: z.number().int().nullable().optional(),
  packetsReceived: z.number().int().nullable().optional(),
  roundTripTimeMs: z.number().nullable().optional(),
  jitterBufferDelayMs: z.number().nullable().optional(),
  mosEstimate: z.number().nullable().optional(),
  packetsSent: z.number().int().nullable().optional(),
  audioLevel: z.number().nullable().optional(),
  totalAudioEnergy: z.number().nullable().optional(),
});

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const parsed = QualitySampleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  await db.callQualitySample.create({
    data: {
      callId: parsed.data.callId,
      extension: guard.session.user.extension ?? null,
      jitterMs: parsed.data.jitterMs ?? null,
      packetsLost: parsed.data.packetsLost ?? null,
      packetsReceived: parsed.data.packetsReceived ?? null,
      roundTripTimeMs: parsed.data.roundTripTimeMs ?? null,
      jitterBufferDelayMs: parsed.data.jitterBufferDelayMs ?? null,
      mosEstimate: parsed.data.mosEstimate ?? null,
      packetsSent: parsed.data.packetsSent ?? null,
      audioLevel: parsed.data.audioLevel ?? null,
      totalAudioEnergy: parsed.data.totalAudioEnergy ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}
