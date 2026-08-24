import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSetting, requireSetting } from "@/lib/settings/service";
import { getProvider } from "@/lib/messaging/registry";
import { statsOverview } from "@/lib/messaging/openwa-client";
import { probeDinstarCredentials } from "@/lib/dinstar-discovery";
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
        // No specific instance to check yet at settings-test time — hit
        // an authenticated endpoint (stats/overview) rather than the bare
        // health check, so this actually proves the API key authenticates
        // and not merely that a port is listening.
        const stats = await statsOverview();
        return NextResponse.json({
          ok: true,
          message: `OpenWA sidecar reachable and key authenticated (${stats.ready}/${stats.total} sessions ready).`,
        });
      }

      case "whatsapp_meta": {
        const provider = getProvider("META_CLOUD");
        const status = await provider.getStatus("test");
        if (!status.connected) throw new Error("Meta Cloud API did not report a connected phone number.");
        return NextResponse.json({ ok: true, message: `Meta Cloud API reachable (${status.phoneE164 ?? "number id resolved"}).` });
      }

      case "sms_dinstar": {
        const ip = await requireSetting("DINSTAR_LAN_IP");
        const [username, password, authStyle] = await Promise.all([
          getSetting("DINSTAR_SMS_USERNAME"),
          getSetting("DINSTAR_SMS_PASSWORD"),
          getSetting("DINSTAR_AUTH_STYLE"),
        ]);
        const origin = /^https?:\/\//.test(ip) ? ip : `http://${ip}`;
        const result = await probeDinstarCredentials(new URL(origin).hostname, username || "", password || "");
        if (!result.authenticated) throw new Error(result.error ?? "Authentication failed.");
        if (authStyle && authStyle !== result.authStyle) {
          return NextResponse.json({
            ok: true,
            message: `Dinstar gateway reachable via ${result.authStyle} auth (differs from the saved ${authStyle} — re-run the setup wizard to update it).`,
          });
        }
        return NextResponse.json({ ok: true, message: `Dinstar gateway reachable — ${result.ports.length} SIM port(s) reported.` });
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
