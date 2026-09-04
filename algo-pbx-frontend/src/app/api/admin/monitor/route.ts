import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getAmiClient } from "@/lib/ami-client";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// /api/admin/monitor — admin/supervisor live-call QA monitoring.
//
// LISTEN-ONLY. This originates the staff member's own extension into
// ChanSpy(<channel>,q) — quiet (no beep to the monitored party), no whisper,
// no barge. Whisper/barge already live behind the separate, more sensitive
// /api/intervention route; this endpoint deliberately cannot do them.
//
// Every monitor session is written to AuditLog BEFORE the Originate — silent
// monitoring with no record of who listened to whom is a legal exposure.

const CHANNEL_SHAPE = /^PJSIP\/[A-Za-z0-9._-]{1,32}-[0-9a-fA-F]{6,}$/;

// GET — the live channel list, so the UI can offer a picker.
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const ami = getAmiClient();
  try {
    await ami.connect();
    const { events } = await ami.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");
    const channels = events
      .filter((e) => e.Event === "CoreShowChannel")
      .map((e) => ({
        channel: e.Channel,
        state: e.ChannelStateDesc,
        callerIdNum: e.CallerIDNum,
        callerIdName: e.CallerIDName,
        connectedLineNum: e.ConnectedLineNum,
        application: e.Application,
        duration: e.Duration,
      }));
    return NextResponse.json({ channels });
  } catch {
    return NextResponse.json({ error: "AMI query failed" }, { status: 502 });
  }
}

const MonitorSchema = z.object({
  targetChannel: z.string().min(1).max(128),
});

export async function POST(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const monitorExtension = session.user.extension;
  if (!monitorExtension) {
    return NextResponse.json(
      { error: "Your account has no linked extension — monitoring originates the listen call from it." },
      { status: 409 },
    );
  }

  const parsed = MonitorSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { targetChannel } = parsed.data;
  if (!CHANNEL_SHAPE.test(targetChannel)) {
    return NextResponse.json({ error: "targetChannel is not a recognized channel identifier." }, { status: 400 });
  }

  const ami = getAmiClient();
  try {
    await ami.connect();

    // The target must be a channel that actually exists right now — not a
    // well-formed but fabricated string. Same cross-check as /api/intervention.
    const { events } = await ami.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");
    const live = new Set(events.filter((e) => e.Event === "CoreShowChannel").map((e) => e.Channel));
    if (!live.has(targetChannel)) {
      return NextResponse.json({ error: "targetChannel is not a currently active channel." }, { status: 404 });
    }

    await db.auditLog.create({
      data: {
        action: "monitor.listen",
        actorId: session.user.id,
        targetId: targetChannel,
        metadata: { monitorExtension, targetChannel } as Prisma.InputJsonValue,
      } as unknown as Prisma.AuditLogUncheckedCreateInput,
    });

    const res = await ami.send({
      Action: "Originate",
      Channel: `PJSIP/${monitorExtension}`,
      Application: "ChanSpy",
      Data: `${targetChannel},q`,
      CallerID: `Monitor <${monitorExtension}>`,
      Async: "true",
    });
    return NextResponse.json({ result: res });
  } catch {
    return NextResponse.json({ error: "AMI operation failed" }, { status: 502 });
  }
}
