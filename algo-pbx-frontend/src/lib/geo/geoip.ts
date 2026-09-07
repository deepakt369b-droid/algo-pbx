// Singleton mmdb reader (plan §3.3, node W5). This file is new — W4
// (geo-decision.ts, geo-block-cookie.ts, datacenter-asns.ts) does not
// create it; it owns the pure decision logic only, deliberately with zero
// fs/network imports, and expects a caller like this one to supply the
// actual `GeoLookup`.
//
// Loads GeoLite2-Country.mmdb + GeoLite2-ASN.mmdb from GEOIP_DB_DIR (node
// W7's docker-compose volume, mounted read-only at /app/geoip in
// production, refreshed by pbx_configs/geoip/geoip-refresh.sh from
// sapics/ip-location-db — see that script's header for the source/licence
// detail). Every export below MUST degrade to "database unavailable"
// rather than throw when the files are missing; a lookup failure becoming
// an unhandled exception on the login path would turn a missing volume
// mount into an outage that locks out every agent at once — exactly the
// failure mode plan §3.3's "fail open, loudly" section warns against.
//
// USES THE UNTYPED `maxmind` PACKAGE, NOT `@maxmind/geoip2-node` —
// discovered by actually downloading sapics' real files and testing this
// module against them before deploy (their typed `.country()`/`.asn()`
// wrapper does a case-sensitive check that the mmdb's self-declared
// `databaseType` metadata string contains "Country"/"ASN" verbatim; every
// sapics build — combined and per-IP-version alike — declares its own
// generic type string instead, e.g. "country ipvAll" or "asn ipv4", never
// MaxMind's own capitalized convention, so `@maxmind/geoip2-node`'s typed
// methods throw `BadMethodCallError` on 100% of sapics' files regardless
// of which variant is downloaded). `maxmind`'s lower-level `Reader.get()`
// has no such check — it hands back the mmdb's raw decoded record
// whatever its type string says, which is what every export below reads
// (`SapicsCountryRecord`/`SapicsAsnRecord` below describe the actual
// shape observed from a real downloaded file, not MaxMind's official
// GeoIP2 schema — sapics' country builds are a flat `{country_code}`,
// not MaxMind's nested `{country: {iso_code}}`).
//
// Verified for real before this rewrite: downloaded both files fresh from
// https://github.com/sapics/ip-location-db/releases/download/latest/,
// opened them with `maxmind`'s `Reader`, and confirmed correct results —
// 8.8.8.8 -> US / ASN 15169 Google, a real Indian ISP range (Airtel,
// 122.160.0.0/11) -> IN, a real Pakistani ISP range (PTCL, 39.32.0.0/11)
// -> PK, an AWS range -> ASN 16509 Amazon, and RFC1918/garbage input ->
// null with no throw.
//
// Not unit tested with a committed fixture (plan's node table, W5
// section): sapics' files are ~8-12MB each and change twice weekly, so a
// checked-in binary fixture would rot; geo-decision.test.ts covers the
// pure logic that consumes this module's output instead. A real-IP smoke
// test against production's actual mmdb files is scripts/geoip-probe.ts's
// job.

import { readFileSync, statSync } from "node:fs";
import { Reader, type AsnResponse, type Response } from "maxmind";
import type { GeoLookup } from "./geo-decision";

// The actual record shapes sapics/ip-location-db's mmdb files decode to —
// see the header comment above for how this was determined empirically
// rather than assumed from MaxMind's own (different) GeoIP2 schema.
//
// The country reader is typed `Reader<Response>` (mmdb-lib's own type
// constraint requires a member of that union — `Response` itself is a
// legal member, so this satisfies the compiler) and its `.get()` result
// is cast to `SapicsCountryRecord` below, because sapics' country files
// decode to a flat `{country_code}` record that matches NONE of
// mmdb-lib's official GeoIP2 response shapes (they all model MaxMind's
// nested `{country: {iso_code}}` schema). The cast is safe because it
// reflects the real, verified-by-hand shape of the actual file — not a
// guess — see the header comment's verification note.
//
// The ASN reader genuinely IS shaped like mmdb-lib's own `AsnResponse`
// (`autonomous_system_number`/`autonomous_system_organization`), so no
// cast is needed there — used as-is.
interface SapicsCountryRecord {
  readonly country_code?: string;
}
type SapicsAsnRecord = AsnResponse;

const DEFAULT_DB_DIR = "/app/geoip";

// Re-stat the mmdb files at most this often. geoipupdate refreshes them at
// most twice a week (plan §3.3: "MaxMind publishes Tue/Fri") — statting on
// every single login/sip-credentials request would be a pointless syscall
// on the hottest path in the app for a file that changes a couple of times
// a month.
const RELOAD_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function dbDir(): string {
  return process.env.GEOIP_DB_DIR || DEFAULT_DB_DIR;
}

type LoadedReaders = {
  country: Reader<Response> | null;
  asn: Reader<SapicsAsnRecord> | null;
  countryMtimeMs: number | null;
  asnMtimeMs: number | null;
};

// Module-level singleton — deliberately not per-request. Reopening an mmdb
// file on every login would be wasteful; the file only needs re-reading
// when geoipupdate actually replaces it, which the mtime check below
// detects.
let readers: LoadedReaders = { country: null, asn: null, countryMtimeMs: null, asnMtimeMs: null };
let lastCheckedAt = 0;
// Serializes concurrent (re)load attempts so a burst of simultaneous
// requests right after boot (or right after a reload interval elapses)
// doesn't open the same file N times in parallel.
let loadInFlight: Promise<void> | null = null;

function safeStatMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// Synchronous by design (matches mmdb-lib's `Reader` constructor, which
// takes an in-memory Buffer, not a path — there is no async file-open API
// on this path once the buffer is read). `loadIfNeeded()` below still
// exposes an async surface because callers already await it; only the
// actual file I/O + reader construction changed shape.
function safeOpen<T extends Response>(path: string): Reader<T> | null {
  try {
    const buf = readFileSync(path);
    return new Reader<T>(buf);
  } catch {
    // Missing file, corrupt file, permission error — all treated the same:
    // "this database is not available right now." Never throws out of
    // this module.
    return null;
  }
}

async function loadIfNeeded(): Promise<void> {
  const now = Date.now();
  if (now - lastCheckedAt < RELOAD_CHECK_INTERVAL_MS && (readers.country || readers.asn)) {
    return;
  }
  if (loadInFlight) {
    await loadInFlight;
    return;
  }

  loadInFlight = (async () => {
    lastCheckedAt = Date.now();
    const dir = dbDir();
    const countryPath = `${dir}/GeoLite2-Country.mmdb`;
    const asnPath = `${dir}/GeoLite2-ASN.mmdb`;

    const countryMtimeMs = safeStatMtimeMs(countryPath);
    const asnMtimeMs = safeStatMtimeMs(asnPath);

    const countryChanged = countryMtimeMs !== readers.countryMtimeMs;
    const asnChanged = asnMtimeMs !== readers.asnMtimeMs;

    const country = countryChanged
      ? countryMtimeMs !== null
        ? safeOpen<Response>(countryPath)
        : null
      : readers.country;
    const asn = asnChanged ? (asnMtimeMs !== null ? safeOpen<SapicsAsnRecord>(asnPath) : null) : readers.asn;

    readers = { country, asn, countryMtimeMs, asnMtimeMs };
  })();

  try {
    await loadInFlight;
  } finally {
    loadInFlight = null;
  }
}

/** True only if BOTH the country and ASN databases loaded successfully.
 * Callers (enforce.ts) treat a `false` here as `dbAvailable: false` for
 * evaluateGeoAccess() — a partial load (e.g. ASN missing but country
 * present) is still treated as fully unavailable, since geoBlockVpn
 * enforcement silently degrading to "never flags a VPN" would be a worse
 * surprise than "geo is entirely off until both files exist." */
export async function isGeoDatabaseAvailableAsync(): Promise<boolean> {
  await loadIfNeeded();
  return readers.country !== null && readers.asn !== null;
}

/** Synchronous, best-effort variant for call sites that can't await a
 * reload check (there are currently none on the hot path — enforce.ts
 * always awaits lookupIp() first, which itself awaits loadIfNeeded()).
 * Reflects whatever was loaded as of the last check, without forcing one. */
export function isGeoDatabaseAvailable(): boolean {
  return readers.country !== null && readers.asn !== null;
}

/**
 * IP -> { country, asn, asnOrg }. Returns `null` on ANY failure: missing
 * files, a corrupt read, or the IP simply not being found in either
 * database (MaxMind's AddressNotFoundError, and any other exception the
 * underlying `maxmind` package or geoip2-node might throw for a malformed
 * address). Never throws — this runs inline in src/auth.ts's authorize()
 * and GET /api/me/sip-credentials, both of which must keep working even
 * when geo lookup is completely broken.
 */
export async function lookupIp(ip: string): Promise<GeoLookup | null> {
  await loadIfNeeded();

  if (!readers.country && !readers.asn) return null;

  let country: string | null = null;
  let asn: number | null = null;
  let asnOrg: string | null = null;

  if (readers.country) {
    try {
      // `.get()` returns `null` for "not found" (private ranges, unassigned
      // space, garbage input) rather than throwing — confirmed against a
      // real downloaded file, see the header comment — but the try/catch
      // stays as defence-in-depth against a future mmdb-lib version that
      // throws on a malformed address instead.
      // Cast to the real observed shape — see the header comment and the
      // type alias's own comment for why `Reader<Response>`'s declared
      // type doesn't match what sapics' files actually decode to.
      const result = readers.country.get(ip) as SapicsCountryRecord | null;
      country = result?.country_code ?? null;
    } catch {
      // Not found / invalid address for this DB — leave country null and
      // keep going; the ASN lookup below is independent.
    }
  }

  if (readers.asn) {
    try {
      const result = readers.asn.get(ip);
      asn = result?.autonomous_system_number ?? null;
      asnOrg = result?.autonomous_system_organization ?? null;
    } catch {
      // Same reasoning as above.
    }
  }

  if (!readers.country && !readers.asn) return null;
  if (country === null && asn === null) return null;

  return { country, asn, asnOrg };
}

// Test-only reset — no test file imports this today (this module is
// deliberately not unit tested per the plan, see the header comment), but
// exporting a reset avoids a future test file having no way to clear the
// module-level singleton between cases.
export function __resetGeoipStateForTests(): void {
  readers = { country: null, asn: null, countryMtimeMs: null, asnMtimeMs: null };
  lastCheckedAt = 0;
  loadInFlight = null;
}
