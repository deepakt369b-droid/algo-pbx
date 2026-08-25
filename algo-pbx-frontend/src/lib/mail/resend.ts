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
  await resend.emails.send({
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
}

// Minimal HTML-escaping for the one interpolated field (name) that isn't
// already a validated URL — this is an email body, not a browser DOM, but
// there's no reason to skip the discipline.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
