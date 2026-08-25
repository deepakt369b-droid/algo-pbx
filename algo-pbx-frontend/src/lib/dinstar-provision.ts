import { writeFile } from "node:fs/promises";
import { getAmiClient } from "@/lib/ami-client";
import { renderDinstarConf } from "@/lib/dinstar-config";

// Mirrors src/lib/pjsip-provision.ts exactly: render -> write the
// shared-mount file -> AMI `pjsip reload`. See that file's header for why
// this is deliberately un-unit-tested glue.
const CONF_PATH = process.env.PJSIP_DINSTAR_CONF_PATH || "/pjsip_dinstar.conf";

export interface DinstarProvisionResult {
  written: boolean;
  reloaded: boolean;
  verified: boolean;
  error?: string;
}

/** Write the new IP, reload PJSIP, then verify Asterisk actually picked it
 * up by reading back the AOR. pjsip-provision.ts's own header already
 * flags that whether `pjsip reload` picks up an #include'd file's changes
 * is unverified against a live instance — this function is what turns
 * that uncertainty into an honest result instead of a false "success". */
export async function provisionDinstarConfig(ip: string): Promise<DinstarProvisionResult> {
  const rendered = renderDinstarConf(ip);
  try {
    await writeFile(CONF_PATH, rendered, "utf8");
  } catch (err) {
    return { written: false, reloaded: false, verified: false, error: err instanceof Error ? err.message : "Could not write config file." };
  }

  const ami = getAmiClient();
  try {
    await ami.connect();
    await ami.send({ Action: "Command", Command: "pjsip reload" });
  } catch (err) {
    return { written: true, reloaded: false, verified: false, error: err instanceof Error ? err.message : "AMI reload failed." };
  }

  try {
    const res = await ami.send({ Action: "Command", Command: "pjsip show aor dinstar-aor" });
    const output = res.Output ?? res.output ?? "";
    const verified = typeof output === "string" && output.includes(ip);
    return {
      written: true,
      reloaded: true,
      verified,
      error: verified ? undefined : `Reload sent, but "pjsip show aor dinstar-aor" does not show ${ip} yet — a full Asterisk restart may be required (asterisk -rx "core restart now").`,
    };
  } catch (err) {
    return { written: true, reloaded: true, verified: false, error: err instanceof Error ? err.message : "Could not verify the reload." };
  }
}
