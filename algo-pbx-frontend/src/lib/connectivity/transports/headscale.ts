import { getSetting } from "@/lib/settings/service";
import type { ProbeContext, TransportModule } from "./types";

// Opt-in Headscale API probe (W2 — connectivity plan §3.2), replacing the
// pre-registry `checkHeadscaleNodeOnline()` stub that returned `null`
// unconditionally. That stub's own comment explained the real
// constraint: headscale's admin API is configured Unix-socket-only
// inside the `headscale` container, reachable only via `docker exec`,
// which `web` deliberately has no Docker socket to perform (a socket is
// a container-escape primitive — see this task's own audit finding).
//
// The opt-in path this module adds does NOT require a Docker socket: it
// assumes the owner has separately exposed headscale's HTTP API (≥0.23
// supports this, published on loopback only per the plan) with an API
// key, and told this app about both via settings. Nothing changes for a
// deployment that hasn't done that — see `probe()` below, the unset-key
// path is byte-for-byte the old "UNKNOWN, not checked" behavior.

const DEFAULT_HEADSCALE_API_URL = "http://headscale:8080";

interface HeadscaleNode {
  id?: string;
  name?: string;
  nodeKey?: string;
  node_key?: string;
  online?: boolean;
  lastSeen?: string;
  last_seen?: string;
}

/** Headscale's node-list response has changed field casing across
 * versions (nodeKey vs. node_key, lastSeen vs. last_seen) — normalized
 * here so the rest of this module doesn't need to know which one a given
 * server returned. Exported for the test file. */
export function findNodeByKey(nodes: HeadscaleNode[], nodeKey: string): HeadscaleNode | undefined {
  return nodes.find((n) => (n.nodeKey ?? n.node_key) === nodeKey);
}

async function fetchHeadscaleNodes(apiUrl: string, apiKey: string): Promise<HeadscaleNode[]> {
  const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/v1/node`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`Headscale API returned ${res.status}`);
  }
  const body = (await res.json()) as { nodes?: HeadscaleNode[] };
  return body.nodes ?? [];
}

export const headscaleTransport: TransportModule = {
  kind: "HEADSCALE",

  // No stored config blob for this transport today — a Headscale-
  // transport site's join happens via the runbook's pre-auth-key CLI
  // flow (see components/connectivity/runbook.tsx), not a pasted config.
  validateConfig() {
    return { ok: true };
  },

  async probe(site, _ctx: ProbeContext) {
    const fallback = {
      status: "UNKNOWN" as const,
      lastHandshakeAt: site.lastHandshakeAt,
      lastReachableAt: site.lastReachableAt,
      alertType: null,
    };

    const apiKey = await getSetting("HEADSCALE_API_KEY", site.tenantId);
    if (!apiKey) {
      // Exactly today's behavior — zero regression, no new attack
      // surface unless the owner turns this on by setting the key.
      return { ...fallback, note: "Not checked — no Headscale API key configured" };
    }

    if (!site.headscaleNodeKey) {
      return { ...fallback, note: "Not checked — this site has no headscaleNodeKey recorded yet" };
    }

    const apiUrl = (await getSetting("HEADSCALE_API_URL", site.tenantId)) ?? DEFAULT_HEADSCALE_API_URL;

    // Never throws past this point — any failure (network error, bad
    // key, unreachable API, malformed response) falls back to UNKNOWN,
    // matching the "never silently report UP/DOWN without a real check
    // behind it" convention this whole module replaces.
    try {
      const nodes = await fetchHeadscaleNodes(apiUrl, apiKey);
      const node = findNodeByKey(nodes, site.headscaleNodeKey);
      if (!node) {
        return { ...fallback, note: `Not checked — no node matching headscaleNodeKey was found via the Headscale API` };
      }
      const online = Boolean(node.online);
      return {
        status: online ? "UP" : "DOWN",
        lastHandshakeAt: site.lastHandshakeAt,
        lastReachableAt: online ? new Date() : site.lastReachableAt,
        alertType: online ? null : "headscale.node_offline",
      };
    } catch (err) {
      return { ...fallback, note: `Headscale API check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
