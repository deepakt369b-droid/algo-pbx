import { normalizeToE164 } from "@/lib/phone-normalize";

// Same "displayName ?? numberE164" fallback rule already used by
// src/components/chat/conversation-list.tsx and src/app/admin/sms/page.tsx
// (both via a Prisma `include: { contact: true }` join on Conversation).
// CallDetailRecord has no such relation — `callerNumber` is a raw string
// captured off an Asterisk CDR event, not a foreign key — so resolving a
// display name for a CDR row means normalizing that raw number to E.164 and
// looking it up against a Contact map built separately (see
// src/app/api/cdr/route.ts, which builds the map this function reads).
// Extracted as a pure function, independent of Prisma/React, so it's
// unit-testable without a database or a rendered component.

export interface ContactLike {
  numberE164: string;
  displayName: string | null;
}

/** Builds a `numberE164 -> displayName` lookup from a flat Contact list. */
export function buildContactDisplayMap(contacts: ContactLike[]): Map<string, string | null> {
  return new Map(contacts.map((c) => [c.numberE164, c.displayName]));
}

/**
 * Resolves a raw (not-necessarily-E.164) phone number to its Contact's
 * display name, falling back to the raw number itself when there's no
 * matching Contact, no display name set on the match, or the raw number
 * can't be parsed as a phone number at all (e.g. "unknown", an internal
 * extension, or a malformed CDR field per cdr-mapper.ts's "probable, not
 * proven" caller-ID assumptions).
 */
export function resolveContactDisplayName(
  rawNumber: string,
  contactsByE164: Map<string, string | null>
): string {
  const normalized = normalizeToE164(rawNumber);
  if (!normalized || !contactsByE164.has(normalized)) return rawNumber;
  // A matching Contact exists but has no displayName set: fall back to its
  // normalized E.164 form (the convention's "numberE164" half), not the raw
  // CDR string, so this agrees exactly with conversation-list.tsx's rule.
  return contactsByE164.get(normalized) ?? normalized;
}
