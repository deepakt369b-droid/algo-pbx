import { readFile } from "node:fs/promises";
import { unsafeGlobalDb as db } from "@/lib/db";
import { getAmiClient } from "@/lib/ami-client";
import { probeTls } from "@/lib/domain/cert-probe";
import { parseOpenVpnStatusLog } from "@/lib/dinstar/openvpn-status-parse";
import { type HealthCheck, overallStatus } from "@/lib/health-check";

// Platform-plane infrastructure health.
//
// Structurally the same Promise.allSettled shape as
// /api/admin/system/health, and it reuses that route's HealthCheck contract
// so the status-row rendering works unmodified. What differs is the SCOPE:
// that route answers "is this tenant's product usable"; this one answers "is
// the shared platform standing up" — the six dependencies every tenant
// depends on at once.
//
// The rule this file takes most seriously is that "unknown" is a real answer.
// Two of these checks genuinely cannot be measured from inside the web
// container, and both report `unknown` rather than guessing. A status
// indicator that renders green when it did not actually check is worse than
// no indicator, because it converts absence of information into a false
// all-clear that someone will act on.

const OPENVPN_STATUS_LOG_PATH = process.env.OPENVPN_STATUS_LOG_PATH || "/app/openvpn-status.log";

/** Beyond this, a status log is stale enough that the server is probably not
 * writing it — OpenVPN rewrites it on its status interval (60s by default). */
const OPENVPN_STATUS_STALE_MS = 10 * 60 * 1000;
/** No gateway syslog in this long means the feed has effectively stopped. */
const SYSLOG_QUIET_MS = 60 * 60 * 1000;

/** " Certificate valid to YYYY-MM-DD." — or an empty string if the cert's
 * date is absent or unparseable, so the detail line never reads
 * "Invalid Date". */
export function formatValidTo(validTo: string | undefined): string {
  if (!validTo) return "";
  const parsed = new Date(validTo);
  if (Number.isNaN(parsed.getTime())) return "";
  return ` Certificate valid to ${parsed.toISOString().slice(0, 10)}.`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
  ]);
}

export async function runPlatformHealthChecks(): Promise<{
  checks: HealthCheck[];
  overall: ReturnType<typeof overallStatus>;
}> {
  const now = () => new Date().toISOString();
  const checks: HealthCheck[] = [];

  const results = await Promise.allSettled([
    // --- postgres ---------------------------------------------------------
    (async (): Promise<HealthCheck> => {
      try {
        await withTimeout(db.$queryRaw`SELECT 1`, 5000);
        return { id: "postgres", label: "Postgres", status: "ok", detail: "Reachable.", checkedAt: now() };
      } catch (err) {
        return {
          id: "postgres",
          label: "Postgres",
          status: "fail",
          detail: err instanceof Error ? err.message : "Unreachable.",
          hint: "Every tenant is down until this is restored — it is the only datastore.",
          checkedAt: now(),
        };
      }
    })(),

    // --- asterisk ---------------------------------------------------------
    (async (): Promise<HealthCheck> => {
      try {
        const ami = getAmiClient();
        await withTimeout(ami.connect(), 5000);
        return {
          id: "asterisk",
          label: "Asterisk (AMI)",
          status: "ok",
          detail: "Connected and authenticated.",
          checkedAt: now(),
        };
      } catch (err) {
        return {
          id: "asterisk",
          label: "Asterisk (AMI)",
          status: "fail",
          detail: err instanceof Error ? err.message : "Unreachable.",
          hint: "AMI being down does not by itself stop calls in progress, but no tenant can manage queues or see live channels.",
          checkedAt: now(),
        };
      }
    })(),

    // --- openvpn server ---------------------------------------------------
    // Measured from the status log the server itself writes, which is the
    // same source the connectivity poller already trusts — no second
    // mechanism to keep in agreement.
    (async (): Promise<HealthCheck> => {
      try {
        const content = await withTimeout(readFile(OPENVPN_STATUS_LOG_PATH, "utf8"), 5000);
        const clients = parseOpenVpnStatusLog(content);
        const updatedAt = /^TIME,[^,]*,(\d+)/m.exec(content)?.[1];
        const ageMs = updatedAt ? Date.now() - Number(updatedAt) * 1000 : null;

        if (ageMs !== null && ageMs > OPENVPN_STATUS_STALE_MS) {
          return {
            id: "openvpn_server",
            label: "OpenVPN server",
            status: "warn",
            detail: `Status log last written ${Math.round(ageMs / 60000)} min ago — the server may not be running.`,
            hint: "Check `docker logs algo-openvpn-server`.",
            checkedAt: now(),
          };
        }

        return {
          id: "openvpn_server",
          label: "OpenVPN server",
          status: "ok",
          detail:
            clients.length === 0
              ? "Running. No gateway tunnels currently connected."
              : `Running. ${clients.length} gateway tunnel${clients.length === 1 ? "" : "s"} connected.`,
          checkedAt: now(),
        };
      } catch (err) {
        return {
          id: "openvpn_server",
          label: "OpenVPN server",
          status: "fail",
          detail:
            err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
              ? `No status log at ${OPENVPN_STATUS_LOG_PATH} — the server has never started, or the volume is not mounted.`
              : err instanceof Error
                ? err.message
                : "Could not read the OpenVPN status log.",
          hint: "Customer gateways reach us only over this tunnel. Note the G2 bring-up is still pending a `ufw allow 1194/udp` on the host.",
          checkedAt: now(),
        };
      }
    })(),

    // --- headscale --------------------------------------------------------
    // Deliberately unmeasurable from here. The connectivity poller documents
    // the same gap: checking a Headscale node's state needs the CLI inside
    // its own container, and this container has no Docker socket by design —
    // handing the web app a Docker socket to satisfy a status dot would be a
    // container-escape primitive traded for a green light.
    (async (): Promise<HealthCheck> => ({
      id: "headscale",
      label: "Headscale",
      status: "unknown",
      detail: "Not checked — requires `docker exec` into the Headscale container.",
      hint: "The web container has no Docker socket, by design. Verify from the host with `headscale nodes list`.",
      checkedAt: now(),
    }))(),

    // --- syslog listener --------------------------------------------------
    // An arrival proxy, and labelled as one. This measures whether gateway
    // events have RECENTLY ARRIVED, which is not the same as whether the
    // listener process is alive — a healthy listener with no gateway sending
    // to it looks identical. Given that zero packets have ever been observed
    // on this path, claiming anything stronger would be fiction.
    (async (): Promise<HealthCheck> => {
      const latest = await db.gatewayEvent.findFirst({
        orderBy: { receivedAt: "desc" },
        select: { receivedAt: true },
      });

      if (!latest) {
        return {
          id: "syslog_listener",
          label: "Gateway syslog feed",
          status: "unknown",
          detail: "No gateway event has ever been received.",
          hint: "Measures event arrival, not listener liveness. No syslog packet has ever been observed on this deployment — see handoff.md.",
          checkedAt: now(),
        };
      }

      const ageMs = Date.now() - latest.receivedAt.getTime();
      if (ageMs > SYSLOG_QUIET_MS) {
        return {
          id: "syslog_listener",
          label: "Gateway syslog feed",
          status: "warn",
          detail: `Last event ${Math.round(ageMs / 60000)} min ago.`,
          hint: "Measures event arrival, not listener liveness — a quiet gateway looks the same as a stopped listener.",
          checkedAt: now(),
        };
      }

      return {
        id: "syslog_listener",
        label: "Gateway syslog feed",
        status: "ok",
        detail: `Last event ${Math.round(ageMs / 60000)} min ago.`,
        checkedAt: now(),
      };
    })(),

    // --- caddy ------------------------------------------------------------
    // Probes the reverse proxy from inside the compose network by service
    // name, so a DNS or public-routing problem is not misreported as Caddy
    // being down — those are separate failures with separate fixes, and the
    // per-tenant reachability probe in Platform Settings is where they show.
    (async (): Promise<HealthCheck> => {
      const domain = process.env.VM_PUBLIC_DOMAIN;
      if (!domain) {
        return {
          id: "caddy",
          label: "Caddy (TLS)",
          status: "unknown",
          detail: "VM_PUBLIC_DOMAIN is not set — nothing to probe.",
          checkedAt: now(),
        };
      }
      try {
        const result = await withTimeout(probeTls("caddy", domain, 443, 5000), 6000);
        if (!result.ok) {
          return {
            id: "caddy",
            label: "Caddy (TLS)",
            status: "fail",
            detail: result.error ?? "TLS handshake failed.",
            hint: "No tenant can load the app over HTTPS while this is failing.",
            checkedAt: now(),
          };
        }
        return {
          id: "caddy",
          label: "Caddy (TLS)",
          status: "ok",
          // result.validTo is OpenSSL's own date string ("Dec  1 12:00:00
          // 2026 GMT"), which Date can fail to parse on some runtimes — fall
          // back to reporting reachability alone rather than "Invalid Date".
          detail: `Serving ${domain}.${formatValidTo(result.validTo)}`,
          checkedAt: now(),
        };
      } catch (err) {
        return {
          id: "caddy",
          label: "Caddy (TLS)",
          status: "fail",
          detail: err instanceof Error ? err.message : "Could not probe.",
          checkedAt: now(),
        };
      }
    })(),
  ]);

  for (const r of results) {
    if (r.status === "fulfilled") checks.push(r.value);
    else {
      checks.push({
        id: "unknown",
        label: "Unknown check",
        status: "unknown",
        detail: String(r.reason),
        checkedAt: now(),
      });
    }
  }

  return { checks, overall: overallStatus(checks) };
}
