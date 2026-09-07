// One-time-per-run fetch-and-bake generator for src/lib/geo/datacenter-asns.ts.
//
// WHY THIS EXISTS: geo-decision.ts imports DATACENTER_ASNS as a synchronous,
// pure, in-memory Set — it is deliberately NOT read from disk at request
// time (unlike the two GeoLite2-format .mmdb files in src/lib/geo/geoip.ts,
// which the `geoip-refresh` docker-compose service DOES refresh live onto a
// volume). Making datacenter-asns.ts a runtime-fetched file would add a
// network dependency and an async code path to every login/sip-credentials
// request for a dataset that only needs to change every few months. So
// instead: this script bakes the current upstream list into a plain TS
// source file, checked into git like any other code change.
//
// SOURCE: X4BNet/lists_vpn (MIT licensed, https://github.com/X4BNet/lists_vpn),
// specifically `input/datacenter/ASN.txt` on the `main` branch — a
// community-curated, CI-rebuilt-on-every-PR list of ASNs known to be
// datacenter/hosting/VPN-exit networks. One `AS<number> # <org comment>`
// per line. This is the file X4BNet's own GitHub Actions build
// (.github/workflows/build-list.yml) consumes to produce their published
// CIDR lists — i.e. it's the authoritative input, not a derived artifact.
//
// USAGE (run from algo-pbx-frontend/):
//   npx tsx scripts/update-datacenter-asns.ts
//
// Re-run this PERIODICALLY (quarterly is reasonable — there is no
// automation for it; X4BNet's list changes continuously but the
// marginal value of re-baking more than a few times a year is low for
// this stack's threat model). It only ever touches
// src/lib/geo/datacenter-asns.ts's generated Set literal — the file's
// header comment, the isDatacenterOrgName() keyword matcher, and both
// exported function bodies are hand-written and preserved verbatim by
// this script (it splices in only the Set contents).
//
// This script makes a live network call — it is NOT run in CI or as part
// of `npm run build`/`test`, only manually by whoever maintains this list.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_URL =
  "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/input/datacenter/ASN.txt";

const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/lib/geo/datacenter-asns.ts",
);

const LINE_RE = /^AS(\d+)\s*(?:#\s*(.*))?$/;

async function main(): Promise<void> {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL}: HTTP ${res.status}`);
  }
  const body = await res.text();

  const entries: Array<{ asn: number; comment: string }> = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const asn = Number(match[1]);
    if (!Number.isFinite(asn)) continue;
    entries.push({ asn, comment: (match[2] || "").trim() });
  }

  if (entries.length === 0) {
    throw new Error("Parsed zero ASN entries — refusing to overwrite datacenter-asns.ts with an empty list (upstream format may have changed).");
  }

  entries.sort((a, b) => a.asn - b.asn);

  const setBody = entries
    .map(({ asn, comment }) => (comment ? `  ${asn}, // ${comment}` : `  ${asn},`))
    .join("\n");

  const generatedAt = new Date().toISOString().slice(0, 10);

  const fileContents = `// Known hosting/cloud/VPN-fronting ASNs — the only IP-based signal this
// stack has for "this login came from a datacenter/VPN, not a residential
// or mobile connection" (plan §3.3, W4). Deliberately NOT exhaustive: a
// residential-proxy VPN defeats this exactly the way a country-matching
// VPN defeats the primary country check (see geo-decision.ts's header
// comment). This list only needs to catch the common, well-known cases —
// AWS/GCP/Azure/DigitalOcean/Hetzner/OVH-class providers and the
// datacenter ASNs most consumer VPN providers front through.
//
// GENERATED FILE (Set contents only) — do not hand-edit the DATACENTER_ASNS
// literal below. Regenerate it by running, from algo-pbx-frontend/:
//
//   npx tsx scripts/update-datacenter-asns.ts
//
// Source: X4BNet/lists_vpn (MIT licence), input/datacenter/ASN.txt on the
// \`main\` branch — https://github.com/X4BNet/lists_vpn. That file is a
// community-curated, CI-rebuilt list of known datacenter/hosting/VPN-exit
// ASNs; see scripts/update-datacenter-asns.ts's header for the full
// rationale for baking it in rather than fetching it at runtime.
//
// Last regenerated: ${generatedAt} (${entries.length} ASNs as of that date).
// Re-run the generator quarterly (or whenever a known gap is reported) —
// there is no automated schedule for this file, unlike the GeoLite2-format
// .mmdb files in this same directory, which the \`geoip-refresh\`
// docker-compose service does refresh automatically.
export const DATACENTER_ASNS: Set<number> = new Set<number>([
${setBody}
]);

export function isDatacenterAsn(asn: number): boolean {
  return DATACENTER_ASNS.has(asn);
}

const DATACENTER_ORG_KEYWORDS = /hosting|vpn|cloud|datacenter|data center|server|colo|proxy/i;

export function isDatacenterOrgName(org: string): boolean {
  if (!org) return false;
  return DATACENTER_ORG_KEYWORDS.test(org);
}
`;

  await writeFile(OUTPUT_PATH, fileContents, "utf8");
  console.log(`Wrote ${entries.length} ASNs to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
