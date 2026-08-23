import { writeFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { getAmiClient } from "@/lib/ami-client";
import { renderPjsipConf, type ExtensionForPjsip } from "@/lib/pjsip-config";

// Orchestration around the pure, tested renderPjsipConf (pjsip-config.ts):
// reads every provisioned Extension, renders pjsip_dynamic.conf, writes it
// to the path shared with the asterisk container (see docker-compose.yml's
// comment on the two services mounting the same host file), then tells
// Asterisk to pick it up via AMI's `pjsip reload` Command action.
//
// Deliberately not unit tested — it's pure glue over three side effects
// (DB read, file write, AMI action) with nothing decision-worthy of its
// own, and none of those three are available in this environment anyway.
// If this function grows real logic (retries, partial-failure handling),
// that logic should move into a separately tested pure function.
const CONF_PATH = process.env.PJSIP_DYNAMIC_CONF_PATH || "/pjsip_dynamic.conf";

export async function regeneratePjsipConfigAndReload(): Promise<void> {
  const extensions = await db.extension.findMany();

  const forPjsip: ExtensionForPjsip[] = extensions
    .filter((e) => e.sipSecret && (e.kind === "webrtc" || e.kind === "hardware"))
    .map((e) => ({ number: e.number, kind: e.kind as "webrtc" | "hardware", sipSecret: e.sipSecret! }));

  const rendered = renderPjsipConf(forPjsip);
  await writeFile(CONF_PATH, rendered, "utf8");

  const ami = getAmiClient();
  await ami.connect();
  // "pjsip reload" is a CLI command run through AMI's generic Command
  // action — Asterisk's dedicated `Action: Reload` doesn't take a PJSIP-
  // specific module reload the same way `pjsip reload` does from the CLI.
  // ⚠️ Whether Asterisk picks up an #include'd file's changes on a plain
  // "pjsip reload" without a full module unload/load is UNVERIFIED against
  // a live instance — flagged in LLM.md.
  await ami.send({ Action: "Command", Command: "pjsip reload" });
}
