// Thin Cloudflare API wrapper — the single implementation of "is this
// token/domain pair good" and "write the A record", used by both
// /api/admin/settings/test's domain_tls case and the /admin/domain wizard
// (Loop C4 follow-up). Previously settings/test/route.ts had its own
// inline verify+zone-lookup fetches; that logic is now here so there is
// one implementation, not two that can drift.

const CF_API = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message: string }[];
  result?: T;
}

/** Loop E2: Cloudflare puts the real reason in `errors[].message` / a
 * numeric `code` (1000 "Invalid API Token", 9109 "Unauthorized to access
 * requested resource", …). The old code threw a hardcoded string and
 * discarded all of it, so an operator with a valid-but-mis-scoped or
 * whitespace-damaged token had no way to tell what was wrong. */
function cfErrorText(data: CfEnvelope<unknown>, fallback: string): string {
  const parts = (data.errors ?? []).map((e) => (e.code ? `[${e.code}] ${e.message}` : e.message)).filter(Boolean);
  return parts.length ? `${fallback} — Cloudflare says: ${parts.join("; ")}` : fallback;
}

async function cfFetch<T>(path: string, token: string, init?: RequestInit): Promise<CfEnvelope<T>> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
  if (!data) throw new CloudflareError(`Cloudflare returned a non-JSON response (HTTP ${res.status}).`);
  return data;
}

export async function verifyCloudflareToken(token: string): Promise<void> {
  const data = await cfFetch<{ status?: string }>("/user/tokens/verify", token);
  if (!data.success) {
    throw new CloudflareError(cfErrorText(data, "Cloudflare rejected this token"));
  }
  if (data.result?.status && data.result.status !== "active") {
    throw new CloudflareError(`This token exists but its status is "${data.result.status}", not "active" — check it hasn't been disabled or hasn't started its validity window yet.`);
  }
}

export interface CloudflareZone {
  id: string;
  name: string;
}

/** Finds the zone covering `domain` among zones this token can see. Throws
 * with a distinct message for "token can't list zones at all" (wrong
 * permission) vs. "listed fine, but no zone matches" (wrong zone scope). */
export async function findZoneForDomain(token: string, domain: string): Promise<CloudflareZone> {
  // Loop E2: query candidate apex names directly instead of paging the
  // whole zone list (`per_page=50` with no pagination silently missed the
  // zone for accounts with >50 zones). For "pbx.example.co.uk" this tries
  // "pbx.example.co.uk", "example.co.uk", "co.uk".
  const labels = domain.split(".");
  const candidates = labels.map((_, i) => labels.slice(i).join(".")).filter((c) => c.includes("."));

  for (const name of candidates) {
    const data = await cfFetch<CloudflareZone[]>(`/zones?name=${encodeURIComponent(name)}`, token);
    if (!data.success) {
      throw new CloudflareError(
        cfErrorText(data, "Token is valid but listing zones failed — it likely lacks the Zone:Zone:Read permission (the \"Edit zone DNS\" template scoped to your zone includes it)")
      );
    }
    const zone = (data.result ?? []).find((z) => z.name === name);
    if (zone) return zone;
  }
  throw new CloudflareError(
    `Token is valid, but no zone covering "${domain}" is visible to it. Check the domain's nameservers actually point at Cloudflare, and that the token's zone scope includes this zone.`
  );
}

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

export async function findARecord(token: string, zoneId: string, domain: string): Promise<CfDnsRecord | null> {
  const data = await cfFetch<CfDnsRecord[]>(`/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(domain)}`, token);
  if (!data.success) throw new CloudflareError("Could not list DNS records for this zone.");
  return data.result?.[0] ?? null;
}

/** Always writes proxied:false ("grey cloud"). Cloudflare's proxy does not
 * forward 8089 (Asterisk WSS), 3478/5349 (Coturn), so orange-clouding this
 * record would silently break WebRTC signaling and media — this is not a
 * caller-configurable option. */
export async function upsertARecord(token: string, zoneId: string, domain: string, ip: string): Promise<void> {
  const existing = await findARecord(token, zoneId, domain);
  const body = JSON.stringify({ type: "A", name: domain, content: ip, ttl: 300, proxied: false });
  const data = existing
    ? await cfFetch<CfDnsRecord>(`/zones/${zoneId}/dns_records/${existing.id}`, token, { method: "PUT", body })
    : await cfFetch<CfDnsRecord>(`/zones/${zoneId}/dns_records`, token, { method: "POST", body });
  if (!data.success) {
    const message = data.errors?.map((e) => e.message).join("; ") || "Cloudflare rejected the A record write.";
    throw new CloudflareError(message);
  }
}
