import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSetting } from "@/lib/settings/service";
import { encryptSetting, decryptSetting, SettingsEncryptionError } from "@/lib/settings/crypto";
import { getAmiClient } from "@/lib/ami-client";
import { statsOverview } from "@/lib/messaging/openwa-client";
import { basicAuthHeader } from "@/lib/messaging/http";

export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "warn" | "fail" | "unknown";

interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  docsHref?: string;
  checkedAt: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
  ]);
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
        const origin = /^https?:\/\//.test(ip) ? ip : `http://${ip}`;
        const res = await withTimeout(
          fetch(`${new URL(origin).origin}/goip_get_status.html`, {
            headers: { Authorization: basicAuthHeader(username || "", password || "") },
            signal: AbortSignal.timeout(8000),
          }),
          9000
        );
        if (!res.ok) throw new Error(`Gateway responded ${res.status}`);
        const body = (await res.json().catch(() => null)) as { status?: Array<{ port?: number; type?: string }> } | null;
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

  const overall: CheckStatus = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : checks.some((c) => c.status === "unknown")
        ? "unknown"
        : "ok";

  return NextResponse.json({ checks, overall });
}
