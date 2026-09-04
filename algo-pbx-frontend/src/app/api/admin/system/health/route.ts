import https from "node:https";
import { statfs } from "node:fs/promises";
import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSetting } from "@/lib/settings/service";
import { encryptSetting, decryptSetting, SettingsEncryptionError } from "@/lib/settings/crypto";
import { getAmiClient } from "@/lib/ami-client";
import { statsOverview } from "@/lib/messaging/openwa-client";
import { basicAuthHeader } from "@/lib/messaging/http";
import { pinnedAgent } from "@/lib/messaging/dinstar-sms-provider";
import { classifyFetchError } from "@/lib/dinstar-discovery";
import { type HealthCheck, overallStatus } from "@/lib/health-check";

export const dynamic = "force-dynamic";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
  ]);
}

/** Both Dinstar checks below used to go through plain fetch() straight to
 * `http://<ip>/...` — which this device 302-redirects to its own
 * self-signed https://, so fetch() threw DEPTH_ZERO_SELF_SIGNED_CERT
 * before either check ever got a real answer (confirmed live 2026-08-31,
 * LLM.md §28 — this page showed "Failing" on both while the actual
 * gateway was reachable the whole time). Goes straight to https with the
 * same pinned certificate src/lib/messaging/dinstar-sms-provider.ts uses,
 * instead of relying on a redirect hop fetch() can't get past. Returns a
 * `{cause:{code}}`-shaped Error on connection failure so the existing
 * classifyFetchError() (written for fetch()'s error shape) still works
 * unchanged on a node:https error, which reports `.code` flat, not
 * nested under `.cause`. */
function pinnedHttpsGet(
  ip: string,
  path: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; text: string }> {
  return pinnedAgent().then(
    (agent) =>
      new Promise((resolve, reject) => {
        const host = (/^https?:\/\//.test(ip) ? new URL(ip).hostname : ip).replace(/:\d+$/, "");
        const req = https.request(
          { hostname: host, port: 443, path, method: "GET", headers, agent, timeout: timeoutMs },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          }
        );
        req.on("timeout", () => req.destroy(Object.assign(new Error("TimeoutError"), { name: "TimeoutError" })));
        req.on("error", (err: NodeJS.ErrnoException) => reject(Object.assign(err, { cause: { code: err.code } })));
        req.end();
      })
  );
}

// GET /api/admin/system/health — the authenticated, detailed counterpart
// to the unauthenticated GET /api/health (which the Docker healthcheck
// uses and stays a trivial DB-only probe on purpose). This is the "is the
// app actually usable" view: every dependency the product depends on,
// each with a plain-language hint and a link to the page that fixes it —
// turning "it says not ready" into a checklist instead of a mystery.
export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const now = () => new Date().toISOString();
  const checks: HealthCheck[] = [];

  const results = await Promise.allSettled([
    // postgres
    (async (): Promise<HealthCheck> => {
      try {
        await withTimeout(db.$queryRaw`SELECT 1`, 5000);
        return { id: "postgres", label: "Database", status: "ok", detail: "Reachable.", checkedAt: now() };
      } catch (err) {
        return {
          id: "postgres",
          label: "Database",
          status: "fail",
          detail: err instanceof Error ? err.message : "Unreachable.",
          hint: "Check the postgres container is running and DATABASE_URL is correct.",
          checkedAt: now(),
        };
      }
    })(),

    // settings_encryption
    (async (): Promise<HealthCheck> => {
      try {
        const probe = `health-check-${Date.now()}`;
        const roundTrip = decryptSetting(encryptSetting(probe));
        if (roundTrip !== probe) throw new Error("Round-trip mismatch.");
        return { id: "settings_encryption", label: "Settings Encryption", status: "ok", detail: "Round-trip verified.", checkedAt: now() };
      } catch (err) {
        return {
          id: "settings_encryption",
          label: "Settings Encryption",
          status: "fail",
          detail: err instanceof SettingsEncryptionError ? err.message : "Encryption check failed.",
          hint: "Set SETTINGS_ENCRYPTION_KEY (openssl rand -hex 32) before using runtime settings.",
          checkedAt: now(),
        };
      }
    })(),

    // asterisk_ami
    (async (): Promise<HealthCheck> => {
      try {
        const ami = getAmiClient();
        await withTimeout(ami.connect(), 5000);
        return { id: "asterisk_ami", label: "Asterisk (AMI)", status: "ok", detail: "Connected and authenticated.", checkedAt: now() };
      } catch (err) {
        return {
          id: "asterisk_ami",
          label: "Asterisk (AMI)",
          status: "fail",
          detail: err instanceof Error ? err.message : "Unreachable.",
          hint: "Calls, queue membership, and live channel views won't work until this is reachable.",
          checkedAt: now(),
        };
      }
    })(),

    // openwa
    (async (): Promise<HealthCheck> => {
      try {
        const stats = await withTimeout(statsOverview(), 5000);
        return {
          id: "openwa",
          label: "WhatsApp Sidecar (OpenWA)",
          status: "ok",
          detail: `${stats.ready}/${stats.total} sessions ready.`,
          checkedAt: now(),
        };
      } catch (err) {
        return {
          id: "openwa",
          label: "WhatsApp Sidecar (OpenWA)",
          status: "fail",
          detail: err instanceof Error ? err.message : "Unreachable.",
          hint: "Check the openwa container is running and OPENWA_API_KEY matches its API_MASTER_KEY.",
          docsHref: "/admin/whatsapp",
          checkedAt: now(),
        };
      }
    })(),

    // wa_instances
    (async (): Promise<HealthCheck> => {
      const [total, connected] = await Promise.all([
        db.waInstance.count(),
        db.waInstance.count({ where: { status: "CONNECTED" } }),
      ]);
      if (total === 0) {
        return {
          id: "wa_instances",
          label: "WhatsApp Numbers",
          status: "warn",
          detail: "No instances paired yet.",
          hint: "Pair at least one number so agents can receive WhatsApp messages and OTP delivery works.",
          docsHref: "/admin/whatsapp",
          checkedAt: now(),
        };
      }
      if (connected === 0) {
        return {
          id: "wa_instances",
          label: "WhatsApp Numbers",
          status: "warn",
          detail: `0/${total} connected.`,
          hint: "No connected instance means WhatsApp OTP delivery (the default login/registration channel) will fail.",
          docsHref: "/admin/whatsapp",
          checkedAt: now(),
        };
      }
      return { id: "wa_instances", label: "WhatsApp Numbers", status: "ok", detail: `${connected}/${total} connected.`, checkedAt: now() };
    })(),

    // dinstar
    (async (): Promise<HealthCheck> => {
      try {
        const ip = await getSetting("DINSTAR_LAN_IP");
        if (!ip) {
          return {
            id: "dinstar",
            label: "Dinstar Gateway",
            status: "warn",
            detail: "Not configured.",
            hint: "Set the gateway address in Settings, or run the Dinstar setup wizard.",
            docsHref: "/admin/settings",
            checkedAt: now(),
          };
        }
        const [username, password] = await Promise.all([getSetting("DINSTAR_SMS_USERNAME"), getSetting("DINSTAR_SMS_PASSWORD")]);
        const res = await withTimeout(
          pinnedHttpsGet(ip, "/goip_get_status.html", { Authorization: basicAuthHeader(username || "", password || "") }, 8000),
          9000
        );
        if (res.status < 200 || res.status >= 300) throw new Error(`Gateway responded ${res.status}`);
        const body = (() => {
          try {
            return JSON.parse(res.text) as { status?: Array<{ port?: number; type?: string }> };
          } catch {
            return null;
          }
        })();
        const ports = body?.status ?? [];
        const registered = ports.filter((p) => (p.type ?? "").toLowerCase().includes("regist")).length;
        return { id: "dinstar", label: "Dinstar Gateway", status: "ok", detail: `Reachable — ${registered}/${ports.length} SIM ports registered.`, checkedAt: now() };
      } catch (err) {
        return {
          id: "dinstar",
          label: "Dinstar Gateway",
          status: "fail",
          detail: err instanceof Error ? err.message : "Unreachable.",
          hint: "Check the gateway IP, credentials, and network route in Settings.",
          docsHref: "/admin/settings",
          checkedAt: now(),
        };
      }
    })(),

    // dinstar_route — a lower-level preflight than the "dinstar" check
    // above: raw, UNAUTHENTICATED reachability to the configured LAN IP
    // (or the office's default gateway subnet if nothing's configured
    // yet), so an operator running the setup wizard's scan can tell
    // "the network path itself is broken" apart from "credentials are
    // wrong" or "nothing's there" — the exact ambiguity that made the
    // Dinstar scan undiagnosable before dinstar-discovery.ts's error
    // classification existed. Deliberately does not require auth to
    // succeed; a 401/timeout/refused all count as "reached the host"
    // differently and are reported distinctly.
    (async (): Promise<HealthCheck> => {
      const ip = await getSetting("DINSTAR_LAN_IP");
      if (!ip) {
        return {
          id: "dinstar_route",
          label: "Dinstar Network Route",
          status: "unknown",
          detail: "No gateway IP configured yet — nothing to test a route to.",
          hint: "Run the Dinstar setup wizard's scan first, or set the IP manually in Settings.",
          docsHref: "/admin/dinstar",
          checkedAt: now(),
        };
      }
      try {
        await withTimeout(pinnedHttpsGet(ip, "/goip_get_status.html", {}, 5000), 5500);
        return { id: "dinstar_route", label: "Dinstar Network Route", status: "ok", detail: `Host at ${ip} responded.`, checkedAt: now() };
      } catch (err) {
        const reason = classifyFetchError(err);
        const hints: Record<string, string> = {
          timeout: "The host didn't respond in time — check the Tailscale subnet route is approved AND actually up (tailscale status), not just configured.",
          refused: "The host actively refused the connection — it's reachable, but nothing is listening on port 80 there. Double-check the IP.",
          "no-route": "This host has no network path to that address at all — the Tailscale route is very likely down or unapproved.",
          unknown: "Could not reach the host for an unclassified reason.",
        };
        return {
          id: "dinstar_route",
          label: "Dinstar Network Route",
          status: "fail",
          detail: `Could not reach ${ip} (${reason}).`,
          hint: hints[reason],
          docsHref: "/admin/dinstar",
          checkedAt: now(),
        };
      }
    })(),

    // disk_space (Loop D2) — recordings/voicemail have no cap on how much
    // they can grow (the prune job bounds long-term growth, but doesn't
    // help if the disk is ALREADY nearly full today) and a full disk takes
    // down the whole stack, Postgres included, since everything shares
    // one volume-backed filesystem. Warns before it's fatal rather than
    // the operator finding out when Postgres itself starts refusing
    // writes.
    (async (): Promise<HealthCheck> => {
      try {
        const stats = await statfs(process.env.RECORDINGS_DIR || "/recordings");
        const freeBytes = stats.bavail * stats.bsize;
        const totalBytes = stats.blocks * stats.bsize;
        const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 100;
        const freeGb = (freeBytes / 1024 ** 3).toFixed(1);
        if (freePercent < 10) {
          return {
            id: "disk_space",
            label: "Disk Space",
            status: "fail",
            detail: `Only ${freeGb} GB free (${freePercent.toFixed(1)}%).`,
            hint: "Run the retention prune job now (POST /api/admin/maintenance/prune) or free space manually — a full disk takes down the entire stack, including Postgres.",
            checkedAt: now(),
          };
        }
        if (freePercent < 25) {
          return { id: "disk_space", label: "Disk Space", status: "warn", detail: `${freeGb} GB free (${freePercent.toFixed(1)}%).`, checkedAt: now() };
        }
        return { id: "disk_space", label: "Disk Space", status: "ok", detail: `${freeGb} GB free (${freePercent.toFixed(1)}%).`, checkedAt: now() };
      } catch (err) {
        return {
          id: "disk_space",
          label: "Disk Space",
          status: "unknown",
          detail: err instanceof Error ? err.message : "Could not check.",
          checkedAt: now(),
        };
      }
    })(),

    // queue_members
    (async (): Promise<HealthCheck> => {
      const provisioned = await db.extension.findMany({ where: { sipSecret: { not: null } }, select: { number: true } });
      if (provisioned.length === 0) {
        return { id: "queue_members", label: "Queue Membership", status: "warn", detail: "No extensions provisioned yet.", checkedAt: now() };
      }
      try {
        const ami = getAmiClient();
        await withTimeout(ami.connect(), 5000);
        const { events } = await ami.sendAndCollect({ Action: "QueueStatus", Queue: "support_queue" }, "QueueStatusComplete", 8000);
        const live = new Set(
          events
            .filter((e) => e.Event === "QueueMember")
            .map((e) => /^PJSIP\/(\w+)/.exec(e.Interface ?? "")?.[1])
            .filter(Boolean)
        );
        const missing = provisioned.filter((e) => !live.has(e.number));
        if (missing.length > 0) {
          return {
            id: "queue_members",
            label: "Queue Membership",
            status: "warn",
            detail: `${missing.length} provisioned extension(s) not in support_queue: ${missing.map((m) => m.number).join(", ")}.`,
            hint: "These agents won't receive inbound calls. Disable and re-enable the account to re-add them, or wait for the next reconciliation.",
            docsHref: "/admin/users",
            checkedAt: now(),
          };
        }
        return { id: "queue_members", label: "Queue Membership", status: "ok", detail: `${provisioned.length}/${provisioned.length} in support_queue.`, checkedAt: now() };
      } catch (err) {
        return {
          id: "queue_members",
          label: "Queue Membership",
          status: "unknown",
          detail: err instanceof Error ? err.message : "Could not check.",
          hint: "Requires AMI to be reachable.",
          checkedAt: now(),
        };
      }
    })(),

    // turn
    (async (): Promise<HealthCheck> => {
      const secret = process.env.COTURN_AUTH_SECRET;
      const domain = process.env.VM_PUBLIC_DOMAIN;
      if (!secret || !domain) {
        return {
          id: "turn",
          label: "TURN (WebRTC)",
          status: "warn",
          detail: "COTURN_AUTH_SECRET or VM_PUBLIC_DOMAIN not set.",
          hint: "WebRTC calls behind strict NATs may fail to connect without TURN.",
          checkedAt: now(),
        };
      }
      return { id: "turn", label: "TURN (WebRTC)", status: "ok", detail: "Configured.", checkedAt: now() };
    })(),

    // email
    (async (): Promise<HealthCheck> => {
      const key = await getSetting("RESEND_API_KEY");
      if (!key) {
        return {
          id: "email",
          label: "Email (Resend)",
          status: "warn",
          detail: "Not configured.",
          hint: "Agent invite emails cannot be sent until this is set.",
          docsHref: "/admin/settings",
          checkedAt: now(),
        };
      }
      return { id: "email", label: "Email (Resend)", status: "ok", detail: "Configured.", checkedAt: now() };
    })(),

    // otp
    (async (): Promise<HealthCheck> => {
      const channel = (await getSetting("OTP_CHANNEL")) || "OPENWA";
      if (channel !== "OPENWA") {
        return { id: "otp", label: "OTP Delivery", status: "ok", detail: `Channel: ${channel}.`, checkedAt: now() };
      }
      const connected = await db.waInstance.findFirst({ where: { provider: "OPENWA", status: "CONNECTED", openwaSessionId: { not: null } } });
      if (!connected) {
        return {
          id: "otp",
          label: "OTP Delivery",
          status: "fail",
          detail: "No connected OpenWA instance available to send OTPs.",
          hint: "Pair a WhatsApp number in /admin/whatsapp, or set OTP_WA_INSTANCE_ID.",
          docsHref: "/admin/whatsapp",
          checkedAt: now(),
        };
      }
      return { id: "otp", label: "OTP Delivery", status: "ok", detail: `Via ${connected.label}.`, checkedAt: now() };
    })(),
  ]);

  for (const r of results) {
    if (r.status === "fulfilled") checks.push(r.value);
    else checks.push({ id: "unknown", label: "Unknown check", status: "unknown", detail: String(r.reason), checkedAt: now() });
  }

  return NextResponse.json({ checks, overall: overallStatus(checks) });
}
