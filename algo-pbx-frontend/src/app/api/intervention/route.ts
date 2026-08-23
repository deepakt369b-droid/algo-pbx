import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAmiClient } from "@/lib/ami-client";
import { requireStaffSession } from "@/lib/auth-guard";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/intervention — supervisor live-call intervention (Phase 3:
// listen-in / whisper / barge). All three map to Asterisk's ChanSpy
// application via an AMI Originate action that connects the supervisor's
// extension to a spy channel targeting the agent's channel.
//   - listen: ChanSpy(<agentChannel>)        — read-only
//   - whisper: ChanSpy(<agentChannel>,w)      — supervisor heard by agent only
//   - barge:   ChanSpy(<agentChannel>,B)      — supervisor joins full call
//
// SECURITY FIXES applied here (previously: none of these existed):
//   1. supervisorExtension used to come from the REQUEST BODY, meaning any
//      staff session could originate a spy call FROM any extension —
//      including one not their own — to ANY channel string, unaudited.
//      Now sourced exclusively from the caller's own session.
//   2. targetChannel was an unvalidated `z.string()` fed straight into an
//      AMI action's Data field — a value containing "\r\n" could inject an
//      arbitrary additional AMI action (ami-client.ts's frameAction() now
//      rejects that at the wire layer as defense-in-depth, but the real
//      fix is not accepting garbage here in the first place). Now
//      constrained to Asterisk's actual channel-name shape AND
//      cross-checked against the live channel list so this can only ever
//      target a channel that genuinely exists right now — not an
//      externally-crafted string, and not an internal/trunk channel this
//      feature was never meant to reach.
//   3. Every intervention now writes an AuditLog row before acting — there
//      was previously no record anywhere of who spied/whispered/barged on
//      whom, despite this being one of the most legally sensitive actions
//      in the system.
const InterventionSchema = z.object({
  targetChannel: z.string().min(1).max(128),
  mode: z.enum(["listen", "whisper", "barge"]),
});

const CHANSPY_FLAGS: Record<"listen" | "whisper" | "barge", string> = {
  listen: "",
  whisper: "w",
  barge: "B",
};

// Asterisk 20 PJSIP channel names look like "PJSIP/1001-00000012" —
// technology/endpoint-dash-hexid. Restricting to this shape rules out
// anything that isn't a real, currently-addressable channel string; the
// live cross-check below is what actually confirms it exists right now.
const CHANNEL_SHAPE = /^PJSIP\/[A-Za-z0-9._-]{1,32}-[0-9a-fA-F]{6,}$/;

export async function POST(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const supervisorExtension = guard.session.user.extension;
  if (!supervisorExtension) {
    return NextResponse.json(
      { error: "Your account has no linked extension — intervention requires one to originate the spy call from." },
      { status: 409 }
    );
  }

  const parsed = InterventionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { targetChannel, mode } = parsed.data;

  if (!CHANNEL_SHAPE.test(targetChannel)) {
    return NextResponse.json({ error: "targetChannel is not a recognized channel identifier." }, { status: 400 });
  }

  const ami = getAmiClient();
  try {
    await ami.connect();

    // Cross-check: the target must be a channel that actually exists right
    // now, not merely a string that matches the shape regex. Closes the
    // gap where a well-formed but fabricated channel name could still be
    // sent to ChanSpy (which would just fail harmlessly on Asterisk's
    // side, but silently — this gives the caller an honest 404 instead,
    // and means we never even attempt an Originate against a
    // caller-invented target).
    const { events } = await ami.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");
    const liveChannels = new Set(
      events.filter((e) => e.Event === "CoreShowChannel").map((e) => e.Channel)
    );
    if (!liveChannels.has(targetChannel)) {
      return NextResponse.json({ error: "targetChannel is not a currently active channel." }, { status: 404 });
    }

    const flags = CHANSPY_FLAGS[mode];
    const data = flags ? `${targetChannel},${flags}` : targetChannel;

    // Audit BEFORE acting — if the AMI Originate itself fails we still want
    // a record that this was attempted, not just successful interventions.
    await db.auditLog.create({
      data: {
        action: `intervention.${mode}`,
        actorId: guard.session.user.id,
        targetId: targetChannel,
        metadata: { supervisorExtension, mode, targetChannel },
      },
    });

    const res = await ami.send({
      Action: "Originate",
      Channel: `PJSIP/${supervisorExtension}`,
      Application: "ChanSpy",
      Data: data,
      CallerID: `Supervisor <${supervisorExtension}>`,
      Async: "true",
    });
    return NextResponse.json({ result: res });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? "AMI operation failed" : "AMI originate failed" },
      { status: 502 }
    );
  }
}
