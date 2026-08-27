import { randomInt } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAmiClient } from "@/lib/ami-client";
import { requireSession } from "@/lib/auth-guard";
import { findChannelsToRedirect } from "@/lib/conference-orchestration";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/calls/conference { targetNumber } — Phase G ad-hoc 3-way
// conference. Server-side orchestration, not something the softphone does
// itself — browser WebRTC alone can't mix three parties' audio, only
// Asterisk's ConfBridge can (see pbx_configs/confbridge.conf).
//
// Flow: (1) find the calling agent's live channel + its bridged peer via
// AMI CoreShowChannels (reusing the sendAndCollect multi-event collector
// from the Foundation phase), (2) AMI Redirect both into a fresh
// [conference] dialplan extension (the "conference id" IS that extension
// number — see extensions.conf), (3) AMI Originate the third party into
// the same extension. All three legs land in the same ConfBridge room.
//
// ⚠️ Confidence: MEDIUM-LOW overall, flagged explicitly rather than
// asserted as working — see findChannelsToRedirect's BridgeId caveat, and
// the real risk that redirecting a DTLS-SRTP WebRTC channel triggers a
// media renegotiation glitch Asterisk/sip.js handle imperfectly. Needs live
// testing before being trusted for real call-center use.
// Was `z.string().min(3)` — no character restriction at all, and this
// value is fed straight into an AMI Originate action's Channel field
// (`PJSIP/${targetNumber}@dinstar-trunk`). ami-client.ts's frameAction()
// now rejects any field containing CR/LF as a wire-layer backstop, but
// this route requiring only digits and a leading '+' in the first place
// means a malformed value is rejected with a clear 400 here rather than
// relying on that backstop — and it rules out other AMI-field-breaking
// characters (spaces, commas, semicolons) that CRLF-rejection alone
// wouldn't catch.
const ConferenceSchema = z.object({
  targetNumber: z.string().regex(/^\+?\d{3,15}$/, "targetNumber must be digits only (optionally leading +)"),
});

const INTERNAL_EXTENSION = /^\d{3,4}$/;
const CONFERENCE_CONTEXT = "conference";

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const agentExtension = session.user.extension;
  if (!agentExtension) {
    return NextResponse.json({ error: "No extension linked to this account" }, { status: 400 });
  }

  const body = await req.json();
  const parsed = ConferenceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { targetNumber } = parsed.data;

  const ami = getAmiClient();
  try {
    await ami.connect();

    const { events } = await ami.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");
    const channels = events
      .filter((e) => e.Event === "CoreShowChannel")
      .map((e) => ({ channel: e.Channel, bridgeId: e.BridgeId }));

    const toRedirect = findChannelsToRedirect(channels, agentExtension);
    if (toRedirect.length === 0) {
      return NextResponse.json({ error: "No active call found for this extension" }, { status: 404 });
    }

    // The conference id is just a dialplan extension in the [conference]
    // context — a random 4-digit number is plenty of collision-avoidance
    // for an ad-hoc, short-lived room (not a persistent, reusable one).
    const conferenceId = String(randomInt(1000, 10000));

    for (const channel of toRedirect) {
      await ami.send({
        Action: "Redirect",
        Channel: channel,
        Context: CONFERENCE_CONTEXT,
        Exten: conferenceId,
        Priority: "1",
      });
    }

    // SECURITY (Loop B2): an external third party must NOT be Originated
    // straight at `PJSIP/<n>@dinstar-trunk` — an AMI Originate with an
    // explicit Channel bypasses the endpoint's `context=` and therefore
    // every from-agent-* protection: the LOCAL/NATIONAL/INTERNATIONAL dial
    // tier, the hard-blocked satellite/premium prefixes, the emergency
    // block, and the mandatory DNC_CHECK(). Route it through a Local
    // channel executing the agent's own dial-permission context instead,
    // exactly as /api/crm/click-to-call does — if the dialplan blocks the
    // number, the Local channel hangs up and never reaches the conference.
    let targetChannel: string;
    if (INTERNAL_EXTENSION.test(targetNumber)) {
      targetChannel = `PJSIP/${targetNumber}`;
    } else {
      const record = await db.extension.findUnique({
        where: { number: agentExtension },
        select: { dialPermission: true },
      });
      const tier = (record?.dialPermission ?? "LOCAL").toLowerCase();
      targetChannel = `Local/${targetNumber.replace(/^\+/, "")}@from-agent-${tier}/n`;
    }

    await ami.send({
      Action: "Originate",
      Channel: targetChannel,
      Context: CONFERENCE_CONTEXT,
      Exten: conferenceId,
      Priority: "1",
      Async: "true",
      CallerID: `AlgoCallCenter <${agentExtension}>`,
    });

    await db.auditLog.create({
      data: {
        action: "conference.originate",
        actorId: session.user.id,
        targetId: conferenceId,
        metadata: { agentExtension, targetNumber, redirectedChannels: toRedirect },
      },
    });

    return NextResponse.json({ conferenceId, redirectedChannels: toRedirect });
  } catch {
    // Was `err.message` — leaked internals (AMI host/port on a connection
    // failure) to a plain AGENT session, the least-privileged caller of
    // this route. Full detail is still in server logs via the AMI
    // client's own error, just not echoed to the client.
    return NextResponse.json({ error: "Conference orchestration failed." }, { status: 502 });
  }
}
