// The default "libphonenumber-js" entry point ships MIN metadata, which
// has no number-type data at all (parsed.getType() is always undefined) —
// confirmed while building this: /max (all metadata, incl. per-country
// number-range types) is required for the "Mobile"/"Landline" half of the
// C1 spec to ever populate. phone-normalize.ts doesn't need type data so
// it stays on the smaller default import; this is the one call site that does.
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

// Feature C1 (2026-08-31) — "never a bare number" for an unknown caller.
// libphonenumber-js gives country + (where determinable) number type for
// ANY parseable number, no lookup/network call required — it does NOT do
// carrier lookup for arbitrary numbers (that needs a paid HLR/carrier API,
// out of scope here — phoneinfoga is explicitly reference-only per the
// operator and never wired into the runtime path). This function states
// that limitation by construction: it only ever renders what the library
// can actually supply, never a fabricated carrier name.
//
// Intl.DisplayNames (Node 18+/all modern browsers) turns libphonenumber's
// bare ISO region code ("AE") into a real name ("United Arab Emirates") —
// no separate country-name dataset needed.
const regionNames = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

// libphonenumber-js's NumberType values, mapped to the short label the
// operator's spec uses ("Mobile"), for the ones distinguishable enough to
// be worth surfacing. Anything else (or undetermined) is simply omitted —
// stating the type only when the library is actually confident about it.
const TYPE_LABELS: Partial<Record<string, string>> = {
  MOBILE: "Mobile",
  FIXED_LINE: "Landline",
  FIXED_LINE_OR_MOBILE: "Mobile/Landline",
  VOIP: "VoIP",
  TOLL_FREE: "Toll-free",
  PREMIUM_RATE: "Premium",
  PERSONAL_NUMBER: "Personal",
};

/**
 * Formats a phone number for display when there is no Contact match (no
 * displayName to fall back to). Returns:
 *   - "Unknown — +971501234567 (United Arab Emirates · Mobile)" when the
 *     number parses and both country and type are determinable
 *   - "Unknown — +971501234567 (United Arab Emirates)" when only country is
 *   - "Unknown — <raw>" when the string can't be parsed as a phone number
 *     at all (e.g. a bare SIP URI fragment) — never silently drops the
 *     number itself.
 * `raw` may be null (no caller-ID at all), matching sip-context.tsx's
 * incomingCallerId typing.
 */
export function formatUnknownCaller(raw: string | null | undefined): string {
  if (!raw) return "Unknown";

  const parsed = parsePhoneNumberFromString(raw, "AE");
  if (!parsed || !parsed.isValid()) return `Unknown — ${raw}`;

  const countryLabel = parsed.country ? (regionNames?.of(parsed.country) ?? parsed.country) : null;
  const typeLabel = TYPE_LABELS[parsed.getType() ?? ""] ?? null;

  const meta = [countryLabel, typeLabel].filter(Boolean).join(" · ");
  return meta ? `Unknown — ${parsed.number} (${meta})` : `Unknown — ${parsed.number}`;
}
