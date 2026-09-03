import { getCountries } from "libphonenumber-js";

// Full ISO-3166 country list for the "default country" pickers on the
// Contacts and DNC bulk-import pages, which previously only offered
// India/UAE plus a manual 2-letter "Other" fallback — real coverage for
// any operator adding numbers outside those two countries. Same
// Intl.DisplayNames source src/lib/caller-id-format.ts already uses to turn
// libphonenumber's bare region code into a real name — no separate
// country-name dataset needed.
const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

export interface CountryOption {
  code: string;
  label: string;
}

// Pinned first — every agent seat is India-based and the GSM trunk is UAE,
// so these are what an operator picks 99% of the time; everything else
// follows alphabetically by display name rather than by ISO code.
const PINNED_FIRST = ["IN", "AE"];

export const COUNTRY_OPTIONS: CountryOption[] = (() => {
  const all: CountryOption[] = getCountries().map((code) => ({
    code,
    label: `${regionNames?.of(code) ?? code} (${code})`,
  }));
  const byCode = new Map(all.map((c) => [c.code, c]));
  const pinned = PINNED_FIRST.map((code) => byCode.get(code)).filter((c): c is CountryOption => !!c);
  const rest = all.filter((c) => !PINNED_FIRST.includes(c.code)).sort((a, b) => a.label.localeCompare(b.label));
  return [...pinned, ...rest];
})();
