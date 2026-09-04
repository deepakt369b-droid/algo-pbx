import { writeFile } from "node:fs/promises";
import { unsafeGlobalDb } from "@/lib/db";
import { getAmiClient } from "@/lib/ami-client";
import { renderPjsipConf, type ExtensionForPjsip } from "@/lib/pjsip-config";

// Wave 2a multi-tenant migration: Extension is tenant-scoped
// (src/lib/tenancy/scope-rules.ts), but this function deliberately still
// reads across ALL tenants via `unsafeGlobalDb` — a legitimate, reviewed
// exception, not an oversight. D1 (plan §1 locked decisions) is "one pooled
// stack": there is exactly ONE shared Asterisk instance and ONE
// pjsip_dynamic.conf file until wave 6 namespaces PJSIP endpoint ids
// (`t<n>-1001`). Scoping this read to a single tenant would silently drop
// every OTHER tenant's extensions out of the config file Asterisk actually
// loads — the opposite of what tenant isolation is for. Today there is
// exactly one real tenant in production, so this is a no-op change in
// practice; it becomes load-bearing once wave 6 lands, which is also where
// this function gains a tenant/namespace argument. Not attempted here per
// this task's explicit brief.

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
  const extensions = await unsafeGlobalDb.extension.findMany();

  const forPjsip: ExtensionForPjsip[] = extensions
    .filter((e) => e.sipSecret && (e.kind === "webrtc" || e.kind === "hardware"))
    .map((e) => ({ number: e.number, kind: e.kind as "webrtc" | "hardware", sipSecret: e.sipSecret!, dialPermission: e.dialPermission }));

  const rendered = renderPjsipConf(forPjsip);
  await writeFile(CONF_PATH, rendered, "utf8");

  const ami = getAmiClient();
  await ami.connect();
  // This Asterisk 20 build (from-source) has NO `pjsip reload` CLI command
  // — only `module reload res_pjsip.so`. `pjsip reload` returns
  // "No such command", which send() historically swallowed as success:
  // the actual root cause of three sessions' worth of "reload doesn't
  // apply" debugging (LLM.md §15/§16). Requires the `command` manager
  // privilege — see pbx_configs/manager.conf.
  await ami.send({ Action: "Command", Command: "module reload res_pjsip.so" });

  // Read-back verification — confirm every rendered endpoint actually
  // exists now; if not, the caller surfaces a warning telling the operator
  // a full `docker compose restart asterisk` is required.
  const check = await ami.send({ Action: "Command", Command: "pjsip show endpoints" });
  const output = String(check.Output ?? check.output ?? "");
  const missing = forPjsip.map((e) => e.number).filter((n) => !new RegExp(`Endpoint:\\s+${n}\\b`).test(output));
  if (missing.length > 0) {
    throw new Error(
      `pjsip_dynamic.conf was written and 'pjsip reload' returned OK, but ${missing.length} endpoint(s) did not load (${missing.join(", ")}). This Asterisk build sometimes needs a full restart to pick up #included config — run: docker compose restart asterisk`
    );
  }
}
