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
    // geoLockedAt != null (W5, plan §3.3) is filtered out here, not in
    // renderPjsipConf itself — that function stays pure "data in, config
    // text out" with no knowledge of the geo-lock feature at all; this is
    // the one place that decides WHICH extensions are fed into it, per the
    // plan's explicit instruction not to touch renderPjsipConf or the AMI
    // reload mechanism. A geo-locked extension therefore has no PJSIP
    // endpoint stanza at all after the next regeneration — an
    // already-registered device is deregistered, not merely refused its
    // next credential fetch (see GET /api/me/sip-credentials's separate,
    // faster-acting 403 for the DB-level half of this enforcement).
    .filter((e) => e.sipSecret && (e.kind === "webrtc" || e.kind === "hardware") && !e.geoLockedAt)
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

/**
 * Re-provisions pjsip_dynamic.conf and hot-reloads it, specifically
 * because a geo-lock transition just happened (an extension's
 * `geoLockedAt` was just set by src/lib/geo/enforce.ts, or just cleared by
 * a platform owner's unlock-approval route — W6, not built yet as of this
 * writing). This is NOT a separate provisioning path: it is the exact same
 * `regeneratePjsipConfigAndReload()` every extension create/update/delete
 * already calls, which (as of the geo-lock feature, see the filter added
 * above) already excludes any extension with `geoLockedAt` set. It exists
 * under its own name purely so a lock/unlock call site's intent reads
 * clearly ("re-provision BECAUSE a lock changed"), and so W6's unlock
 * route doesn't need to know that this is literally the same regeneration
 * extension edits trigger.
 *
 * `tenantId` is accepted but currently unused: D1 (plan §1, restated in
 * this file's own header comment) is "one pooled Asterisk stack, one
 * pjsip_dynamic.conf" until a later wave namespaces PJSIP endpoint ids per
 * tenant, so regeneration is always global. The parameter exists so
 * call sites can already pass a tenantId without a future signature
 * change once that namespacing lands.
 */
export async function reprovisionPjsipExcludingLocked(tenantId?: string): Promise<void> {
  void tenantId;
  await regeneratePjsipConfigAndReload();
}
