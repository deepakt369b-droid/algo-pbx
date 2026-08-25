import { writeFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { getAmiClient } from "@/lib/ami-client";
import { renderVoicemailConf, type VoicemailEntry } from "@/lib/voicemail-config";

// Orchestration around the pure, tested renderVoicemailConf
// (voicemail-config.ts), mirroring src/lib/pjsip-provision.ts's shape
// exactly — same rationale for not unit-testing this file (pure glue over
// DB read + file write + AMI action, none of which are available here).
const CONF_PATH = process.env.VOICEMAIL_DYNAMIC_CONF_PATH || "/voicemail_dynamic.conf";

export async function regenerateVoicemailConfigAndReload(): Promise<void> {
  const extensions = await db.extension.findMany({
    where: { voicemailPin: { not: null } },
    include: { user: { select: { name: true, email: true } } },
  });

  const entries: VoicemailEntry[] = extensions.map((e) => ({
    number: e.number,
    pin: e.voicemailPin!,
    name: e.user?.name ?? null,
    email: e.user?.email,
  }));

  const rendered = renderVoicemailConf(entries);
  await writeFile(CONF_PATH, rendered, "utf8");

  const ami = getAmiClient();
  await ami.connect();
  // Same pattern/caveat as pjsip-provision.ts's "pjsip reload": whether
  // Asterisk picks up the #include'd voicemail_dynamic.conf on a plain
  // module reload (vs. needing app_voicemail fully unloaded/reloaded) is
  // UNVERIFIED against a live instance.
  await ami.send({ Action: "Command", Command: "module reload app_voicemail.so" });
}
