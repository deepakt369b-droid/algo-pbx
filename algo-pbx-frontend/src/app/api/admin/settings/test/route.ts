import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSetting, requireSetting } from "@/lib/settings/service";
import { getProvider } from "@/lib/messaging/registry";
import { basicAuthHeader } from "@/lib/messaging/http";
import { verifyFirebasePhoneToken } from "@/lib/firebase/admin";
import { sendInviteEmail } from "@/lib/mail/resend";

export const dynamic = "force-dynamic";

// POST /api/admin/settings/test { section } — turns "I typed a key in"
// into "the key works", per-section. Every branch is deliberately
// conservative about what it proves: a 200 from a status/health endpoint
// is evidence the credential authenticates, not a guarantee message
// delivery will succeed for every recipient.
const Schema = z.object({
  section: z.enum(["email", "whatsapp_openwa", "whatsapp_meta", "sms_dinstar", "firebase"]),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  try {
    switch (parsed.data.section) {
      case "email": {
        // Sends a real (tiny) email to the admin's own address — the
        // most honest test available, since Resend's API can accept a
        // key that later fails to actually deliver.
        await sendInviteEmail(guard.session.user.email!, "Settings Test", `${process.env.AUTH_URL ?? ""}/admin/settings`);
        return NextResponse.json({ ok: true, message: `Test email sent to ${guard.session.user.email}.` });
      }

      case "whatsapp_openwa": {
        // No specific instance to check yet at settings-test time — just
        // confirm the base URL + API key can reach the sidecar at all.
        const base = (await getSetting("OPENWA_BASE_URL")) || "http://openwa:2785";
        const key = await getSetting("OPENWA_API_KEY");
        const res = await fetch(`${base.replace(/\/+$/, "")}/api/health`, {
          headers: key ? { api_key: key } : {},
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`OpenWA responded ${res.status}`);
        return NextResponse.json({ ok: true, message: "OpenWA sidecar reachable." });
      }

      case "whatsapp_meta": {
        const provider = getProvider("META_CLOUD");
        const status = await provider.getStatus("test");
        if (!status.connected) throw new Error("Meta Cloud API did not report a connected phone number.");
        return NextResponse.json({ ok: true, message: `Meta Cloud API reachable (${status.phoneE164 ?? "number id resolved"}).` });
      }

      case "sms_dinstar": {
        const ip = await requireSetting("DINSTAR_LAN_IP");
        const [username, password] = await Promise.all([getSetting("DINSTAR_SMS_USERNAME"), getSetting("DINSTAR_SMS_PASSWORD")]);
        const origin = /^https?:\/\//.test(ip) ? ip : `http://${ip}`;
        const res = await fetch(`${new URL(origin).origin}/goip_get_status.html`, {
          headers: { Authorization: basicAuthHeader(username || "", password || "") },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Dinstar gateway responded ${res.status}`);
        return NextResponse.json({ ok: true, message: "Dinstar gateway reachable." });
      }

      case "firebase": {
        // There is no real token to verify at settings-test time (that
        // only exists after an actual client-side phone verification) —
        // the useful signal here is whether the service account JSON
        // parses and Firebase Admin can initialize from it at all,
        // which verifyFirebasePhoneToken() does before it ever gets to
        // token verification. An obviously-invalid token still proves
        // initialization succeeded if the failure is about the TOKEN,
        // not the credential.
        try {
          await verifyFirebasePhoneToken("settings-test-invalid-token");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("not configured")) throw err;
          // Any other error (invalid token format, etc.) means Firebase
          // Admin DID initialize successfully from the service account.
          return NextResponse.json({ ok: true, message: "Firebase service account is valid and Admin SDK initialized." });
        }
        throw new Error("Unexpected success verifying a deliberately invalid token.");
      }
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Test failed" }, { status: 502 });
  }
}
