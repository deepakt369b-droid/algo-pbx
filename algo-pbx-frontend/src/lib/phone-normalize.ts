import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

// Single source of truth for "what counts as the same phone number" on the
// APP side (DNC CRUD, the pre-dial guard in sip-context.tsx). The DIALPLAN
// side (pbx_configs/extensions.conf's DNC_CHECK lookup, func_odbc.conf) is a
// separate, cruder implementation — Asterisk's dialplan can't call this TS
// function, so it does a direct string match on the dialed digits (plus a
// same-with-leading-"+" fallback). The two are NOT guaranteed to agree for
// every input shape; this is a documented duplication/maintenance risk, not
// an oversight — see extensions.conf's comment on the DNC_CHECK block.
//
// Default country is AE (UAE) since the Dinstar GSM trunk this app dials
// out through is UAE-based (ALGO_PBX_MASTER_DOC.md) — a bare national-format
// number typed by an agent is assumed to be a UAE number unless it already
// carries a country code / leading "+".
const DEFAULT_COUNTRY = "AE";

/** Returns the E.164 form (e.g. "+971501234567") of a phone number, or null
 * if it can't be parsed as a plausible number at all. Never throws.
 *
 * `defaultCountry` overrides DEFAULT_COUNTRY (AE) for callers whose bare
 * national-format numbers should be assumed to belong to a different
 * country — e.g. src/app/api/register/route.ts passes "IN" since agents
 * are India-based and typing a 10-digit local number there should not be
 * parsed as if it were a UAE number. A number that already carries a
 * country code / leading "+" is unaffected either way. */
export function normalizeToE164(raw: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;

  return parsed.number; // libphonenumber-js's `.number` is always E.164
}
