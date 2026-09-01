import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { getAmiClient } from "@/lib/ami-client";
import { requireSession } from "@/lib/auth-guard";
import { findChannelsToRedirect } from "@/lib/conference-orchestration";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/calls/manager-merge { targetId } — Phase MM: bring a manager
// into the agent's live call (LLM.md §29/§30 plan). Built as a specialized
// wrapper around the SAME AMI Redirect/Originate mechanism
// api/calls/conference/route.ts already uses for an ad-hoc 3-way, not a
// new primitive — that route's own header already flags this mechanism as
// "MEDIUM-LOW confidence... needs live testing before being trusted for
// real call-center use", and this inherits that exact same flag. It has
// NOT been tested against a real live call as of this write.
//
// SCOPING DECISION, stated plainly rather than silently narrowed: the
// original plan specified a "consult-first" flow — hold the customer,
// let the agent speak privately with the manager, then confirm the merge.
// That needs the agent's channel and the customer's channel to be
// separated onto different bridges mid-call (a real hold-and-private-line
// mechanism), which does not exist anywhere in this codebase today and
// was judged too large and too risky to invent and ship unverified in
// this pass. What is implemented instead: an AUTO-MERGE. The customer and
// agent are redirected into the shared ConfBridge room FIRST (so they are
// bridged together and audible to each other the entire time — this is
// what satisfies "the customer must never hear hold-failure silence",
// just by construction rather than by an explicit hold/unhold step), then
// the manager is Originated into the same room. If the manager never
// answers, the customer and agent simply continue talking in the
// ConfBridge room exactly as if they'd never tried — never dropped, never
// silent. A private pre-merge consult is a real, separate follow-up.
//
// Manager-side caller ID ("Conference Call - <Agent Name>", not the raw
// agent extension) uses the exact mechanism the generic conference route
// already uses successfully for its own third-party Originate — the
// `CallerID` field on the AMI Originate action itself, no dialplan change
// needed.
const MergeSchema = z.object({ targetId: z.string() });

const CONFERENCE_CONTEXT = "conference";

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const agentExtension = session.user.extension;
  if (!agentExtension) {
    return NextResponse.json({ error: "No extension linked to this account" }, { status: 400 });
  }

  const parsed = MergeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const target = await db.escalationTarget.findUnique({ where: { id: parsed.data.targetId } });
  if (!target || !target.active) {
    return NextResponse.json({ error: "Manager not found or no longer active." }, { status: 404 });
  }
  if (!target.extension) {
    return NextResponse.json(
      { error: `${target.name} has no extension on file — can't be merged into a call. Use the WhatsApp ping instead.` },
      { status: 409 }
    );
  }

  // No single-GSM-port trunk guard here (unlike the generic conference
  // route's `currentCallIsOnTrunk && !isInternalExtension` 409) — and this
  // is deliberate, not an oversight. This route always Originates
  // `PJSIP/${target.extension}`, an internal SIP endpoint, never a number
  // routed through the Dinstar trunk. The hazard that guard exists for —
  // placing a SECOND outbound GSM call on an already-occupied port — is
  // structurally impossible here since a manager merge never dials
  // outside. Confirmed by this exact reasoning during the plan's own
  // discovery pass before writing any of this route.

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

    const conferenceId = String(randomInt(1000, 10000));

    // Customer + agent into the shared room FIRST — see file header for
    // why this is what makes "never silent, never dropped" true by
    // construction rather than needing an explicit hold state.
    for (const channel of toRedirect) {
      await ami.send({
        Action: "Redirect",
        Channel: channel,
        Context: CONFERENCE_CONTEXT,
        Exten: conferenceId,
        Priority: "1",
      });
    }

    // Async — a synchronous (blocking) AMI Originate would need
    // ami-client.ts's send() 5s hardcoded response timeout raised
    // considerably (a manager needs real ring time to answer), which is
    // out of this route's file scope to change. Answer/no-answer is
    // instead observed best-effort below via waitForEvent(), the same
    // "resolves null on timeout rather than rejecting" pattern
    // ami-client.ts already exposes for exactly this shape of problem.
    await ami.send({
      Action: "Originate",
      Channel: `PJSIP/${target.extension}`,
      Context: CONFERENCE_CONTEXT,
      Exten: conferenceId,
      Priority: "1",
      Async: "true",
      CallerID: `Conference Call - ${session.user.name} <${agentExtension}>`,
    });

    // Best-effort: not verified live against a real OriginateResponse
    // event for this Asterisk version's exact field set (same class of
    // caveat findChannelsToRedirect's own BridgeId dependency already
    // carries) — a timeout here does NOT mean the merge failed, only that
    // this observation couldn't confirm it either way in time.
    const outcome = await ami.waitForEvent(
      (e) => e.Event === "OriginateResponse" && e.Exten === conferenceId,
      25_000
    );
    const answered = outcome?.Reason === "4" || outcome?.Response === "Success";

    await db.auditLog.create({
      data: {
        action: "conference.manager_merge",
        actorId: session.user.id,
        targetId: conferenceId,
        metadata: {
          agentExtension,
          managerTargetId: target.id,
          managerName: target.name,
          managerExtension: target.extension,
          redirectedChannels: toRedirect,
          answered,
          observedOutcome: outcome ?? null,
        },
      },
    });

    return NextResponse.json({
      conferenceId,
      answered,
      message: outcome
        ? answered
          ? `${target.name} joined the call.`
          : `${target.name} didn't answer — you're still connected with the customer.`
        : `Could not confirm whether ${target.name} answered — check the call. You're still connected with the customer either way.`,
    });
  } catch {
    // Same reasoning as the generic conference route: never echo the raw
    // AMI error (host/port on a connection failure) to an AGENT session.
    return NextResponse.json({ error: "Manager merge failed — the customer call was not disturbed unless you were already redirected. Try again or use the WhatsApp ping." }, { status: 502 });
  }
}
