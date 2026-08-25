import { NextResponse } from "next/server";
import { getAmiClient } from "@/lib/ami-client";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/channels — live channel list, so the supervisor intervention UI
// (intervention-controls.tsx) can offer a picker instead of requiring
// `asterisk -rx "core show channels"` on the CLI, per LLM.md's documented
// gap. Built on the same sendAndCollect collector as wallboard/queues.
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
        application: e.Application,
      }));
    return NextResponse.json({ channels });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AMI query failed" },
      { status: 502 }
    );
  }
}
