import { Resend } from "resend";
import { getSetting, onSettingChanged, requireSetting } from "@/lib/settings/service";

// First mail dependency in the project. Used ONLY to deliver the one-time
// agent-invite link (src/app/api/admin/users/route.ts's POST handler) —
// there is deliberately no other mail-sending code path, and no
// self-service password-reset flow that could also use this. If
// RESEND_API_KEY is unset (in settings AND .env), this fails loudly
// rather than silently pretending the email sent — an admin needs to
// know the invite never went out, not discover it when the agent says
// they never got one.
//
// The client is cached across calls (Resend's own SDK guidance) but that
// means it must be explicitly rebuilt when the API key changes via
// /admin/settings — otherwise a rotated key would silently not take
// effect until the process restarts, exactly the bug this whole
// settings feature exists to fix. onSettingChanged() registers that
// invalidation.

let client: Resend | null = null;
let cachedKey: string | null = null;

onSettingChanged(["RESEND_API_KEY"], () => {
  client = null;
  cachedKey = null;
});

async function getClient(): Promise<Resend> {
  const apiKey = await requireSetting("RESEND_API_KEY");
  if (!client || cachedKey !== apiKey) {
    client = new Resend(apiKey);
    cachedKey = apiKey;
  }
  return client;
}

export async function sendInviteEmail(to: string, name: string, inviteUrl: string): Promise<void> {
  const from = (await getSetting("INVITE_FROM_EMAIL")) || "invites@algopbx.local";
  const resend = await getClient();
  const { error } = await resend.emails.send({
    from,
    to,
    subject: "You've been added to Algo PBX",
    html: `
      <p>Hi ${escapeHtml(name)},</p>
      <p>An administrator has created your Algo PBX agent account. Set your password to finish setting up your account:</p>
      <p><a href="${inviteUrl}">${inviteUrl}</a></p>
      <p>This link is single-use and expires in 24 hours. Your username is fixed to this email address and cannot
      be changed by you — contact an administrator if it needs to change.</p>
    `,
  });
  throwOnResendError(error);
}

// Loop C3 — admin-triggered password reset. Reuses the exact same
// Invite/tokenHash mechanism and consumption route (POST /api/invite,
// src/app/invite/[token]/page.tsx) as onboarding — a password reset IS
// "set your password once via a single-use link," the same operation the
// invite flow already performs, just triggered later in an account's
// life instead of at creation. Only the email copy differs.
export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
  const from = (await getSetting("INVITE_FROM_EMAIL")) || "invites@algopbx.local";
  const resend = await getClient();
  const { error } = await resend.emails.send({
    from,
    to,
    subject: "Reset your Algo PBX password",
    html: `
      <p>Hi ${escapeHtml(name)},</p>
      <p>An administrator has requested a password reset for your Algo PBX account. Set a new password here:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>This link is single-use and expires in 24 hours. If you didn't expect this, contact an administrator —
      your current password still works until you use this link.</p>
    `,
  });
  throwOnResendError(error);
}

// Dinstar gateway critical-event alert (Diagnostic -> Syslog forwarding,
// see api/gateway-events and lib/dinstar/gateway-alerts.ts). Unlike the
// two senders above, this one is genuinely optional: GATEWAY_ALERT_EMAIL
// has no `default`, so an unconfigured deployment just never calls this —
// the ingest route checks that first and falls back to in-app-only
// (the dedicated gateway alert banner on /admin/system, deliberately NOT
// the existing top-bar HealthPill, which is a different, already-failing
// indicator for an unrelated reason — see that banner component's own
// header comment).
export async function sendGatewayAlertEmail(to: string, alert: { type: string; message: string; port: number | null }): Promise<void> {
  const from = (await getSetting("INVITE_FROM_EMAIL")) || "invites@algopbx.local";
  const resend = await getClient();
  const { error } = await resend.emails.send({
    from,
    to,
    subject: `Algo PBX — gateway alert: ${alert.type}`,
    html: `
      <p>The Dinstar gateway reported a critical event.</p>
      <p><strong>Type:</strong> ${escapeHtml(alert.type)}<br/>
      ${alert.port !== null ? `<strong>Port:</strong> ${alert.port}<br/>` : ""}
      <strong>Message:</strong> ${escapeHtml(alert.message)}</p>
      <p>See the "Gateway events" panel on <code>/admin/system</code> for the full log.</p>
    `,
  });
  throwOnResendError(error);
}

// The Resend SDK does NOT throw on an API-level failure (invalid key,
// unverified sending domain, rejected recipient) — it resolves with
// { data: null, error: {...} }. Callers that ignore the return value
// therefore treat every failure as a success. Convert it back into a
// thrown error so the /admin/settings "Test connection" check and the
// invite/reset warnings surface the real reason.
function throwOnResendError(error: { name?: string; message?: string } | null): void {
  if (error) {
    throw new Error(`Resend rejected the send: ${error.message ?? error.name ?? "unknown error"}`);
  }
}

// Minimal HTML-escaping for the one interpolated field (name) that isn't
// already a validated URL — this is an email body, not a browser DOM, but
// there's no reason to skip the discipline.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
