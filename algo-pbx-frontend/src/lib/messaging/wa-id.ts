// Relative, not "@/lib/phone-normalize": vitest.config.mts declares no path
// alias, and this module is imported by a unit test (wa-id.test.ts) that
// must resolve without Next.js's tsconfig-paths resolution.
import { normalizeToE164 } from "../phone-normalize";

// WhatsApp identity <-> E.164 conversion.
//
// WhatsApp's own identifiers are E.164 WITHOUT the leading '+':
//   wa_id : "971501234567"
//   jid   : "971501234567@c.us"   (OpenWA / whatsapp-web.js)
//           "971501234567@s.whatsapp.net" (Baileys-style)
//   group : "9715...-1600000000@g.us"  <- NOT a person, must be rejected
//
// Passing a bare "971501234567" straight to normalizeToE164() is the bug
// this module exists to prevent: libphonenumber parses it with the default
// country (AE) and can produce a *different*, wrong number for
// non-UAE-prefixed inputs. Always prefix '+' first. Contact.numberE164 in
// prisma/schema.prisma carries the same warning.

/** True for a JID that identifies a group, broadcast or status feed rather
 * than a single person. Ingest drops these — there is no Contact for them. */
export function isGroupOrBroadcastJid(jid: string): boolean {
  const s = jid.trim().toLowerCase();
  return s.endsWith("@g.us") || s.endsWith("@broadcast") || s === "status@broadcast";
}

/**
 * Convert a WhatsApp wa_id or JID to E.164 ("+971501234567"), or null if it
 * isn't a parseable individual number.
 */
export function waIdToE164(waIdOrJid: string): string | null {
  const raw = (waIdOrJid ?? "").trim();
  if (!raw) return null;
  if (isGroupOrBroadcastJid(raw)) return null;

  // Strip the "@server" suffix and any ":device" agent suffix
  // ("971501234567:12@s.whatsapp.net" is a valid multi-device JID).
  const local = raw.split("@")[0].split(":")[0];
  if (!/^\d{6,20}$/.test(local)) return null;

  return normalizeToE164(`+${local}`);
}

/** Inverse: the bare-digits form providers want as a destination. Returns
 * null for anything that isn't already E.164-with-plus. */
export function e164ToWaId(e164: string): string | null {
  const m = /^\+(\d{6,20})$/.exec((e164 ?? "").trim());
  return m ? m[1] : null;
}
