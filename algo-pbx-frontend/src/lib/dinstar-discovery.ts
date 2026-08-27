import { basicAuthHeader } from "@/lib/messaging/http";

// Subnet discovery + credential probing for the Dinstar UC2000 setup
// wizard (/admin/dinstar). Pure/testable pieces here; the API routes
// (api/admin/dinstar/**) are thin wrappers that add auth + persistence.

/** RFC1918 private ranges + the CGNAT range (100.64.0.0/10, which is also
 * the range Tailscale allocates from by default) — the only address
 * spaces this scanner will ever probe. A public CIDR is refused outright:
 * this route sends real HTTP requests to every host in the range, and
 * that is not something to ever point at the internet, deliberately or
 * by a typo. */
const ALLOWED_RANGES: Array<{ base: number; mask: number }> = [
  { base: ipToInt("10.0.0.0"), mask: 8 },
  { base: ipToInt("172.16.0.0"), mask: 12 },
  { base: ipToInt("192.168.0.0"), mask: 16 },
  { base: ipToInt("100.64.0.0"), mask: 10 },
];

export function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Not a valid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export interface ParsedCidr {
  network: number;
  prefixLength: number;
  hostCount: number;
}

const MAX_HOSTS_PER_SCAN = 254;

export function parseCidr(cidr: string): ParsedCidr {
  const [ipPart, prefixPart] = cidr.split("/");
  const prefixLength = Number(prefixPart);
  if (!ipPart || Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`Not a valid CIDR: ${cidr}`);
  }
  const ip = ipToInt(ipPart);
  const hostBits = 32 - prefixLength;
  const hostCount = hostBits >= 30 ? 2 ** hostBits : Math.max(2 ** hostBits - 2, 0);
  if (hostCount > MAX_HOSTS_PER_SCAN) {
    throw new Error(`CIDR too large to scan (${hostCount} hosts, max ${MAX_HOSTS_PER_SCAN}). Use at least a /24.`);
  }
  const mask = hostBits === 32 ? 0 : (0xffffffff << hostBits) >>> 0;
  const network = (ip & mask) >>> 0;
  return { network, prefixLength, hostCount };
}

/** Refuses anything outside RFC1918 + CGNAT/Tailscale ranges — the
 * non-negotiable guardrail named in the plan: this scanner must never be
 * pointable at a public CIDR. */
export function assertScannableCidr(cidr: string): ParsedCidr {
  const parsed = parseCidr(cidr);
  const inRange = ALLOWED_RANGES.some((r) => {
    const rangeMask = r.mask === 0 ? 0 : (0xffffffff << (32 - r.mask)) >>> 0;
    return (parsed.network & rangeMask) >>> 0 === (r.base & rangeMask) >>> 0;
  });
  if (!inRange) {
    throw new Error(
      `${cidr} is outside the allowed scan ranges (RFC1918 private networks or the 100.64.0.0/10 CGNAT/Tailscale range). Public networks are never scanned.`
    );
  }
  return parsed;
}

/** Loop B4: validate a single `host` (bare IPv4, optionally `:port`) the
 * same way assertScannableCidr validates a range — the probe route took
 * `z.string().min(1)` and interpolated it straight into a URL, so `/` or
 * `?` in the value controlled the request path (SSRF to cloud metadata,
 * host.docker.internal, etc.). Returns the normalized `ip[:port]`. */
export function assertProbeableHost(host: string): string {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(host.trim());
  if (!m) {
    throw new Error(`"${host}" is not a bare IPv4 address (optionally :port). Hostnames, paths and query strings are not allowed.`);
  }
  const ip = m[1];
  const port = m[2] ? Number(m[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw new Error(`Invalid port in "${host}".`);
  }
  const ipInt = ipToInt(ip); // throws on out-of-range octet
  const inRange = ALLOWED_RANGES.some((r) => {
    const rangeMask = r.mask === 0 ? 0 : (0xffffffff << (32 - r.mask)) >>> 0;
    return (ipInt & rangeMask) >>> 0 === (r.base & rangeMask) >>> 0;
  });
  if (!inRange) {
    throw new Error(`${ip} is outside the allowed ranges (RFC1918 or 100.64.0.0/10). The Dinstar gateway is always on a private/Tailscale network.`);
  }
  return port !== undefined ? `${ip}:${port}` : ip;
}

export function hostsInCidr(cidr: string): string[] {
  const { network, prefixLength, hostCount } = assertScannableCidr(cidr);
  const hostBits = 32 - prefixLength;
  if (hostBits === 0) return [intToIp(network)];
  const hosts: string[] = [];
  // Skip network (.0) and broadcast (.255) addresses for a normal subnet;
  // a /31 or /32 has no such reservation and hostCount already reflects that.
  const start = hostBits >= 2 ? 1 : 0;
  for (let i = start; i < start + hostCount; i++) {
    hosts.push(intToIp((network + i) >>> 0));
  }
  return hosts;
}

export interface DiscoveredHost {
  ip: string;
  fingerprint: "dinstar" | "unknown-http";
  authStyle: "basic" | "query" | "unknown";
}

// RFC1918 LAN timeout stays tight (a device on the same subnet answers in
// single-digit ms); the CGNAT/Tailscale range gets much more headroom
// since that traffic may cross a WireGuard subnet-router hop and, under
// NAT failure between peers, fall back to a DERP relay — both add real
// latency a same-LAN timeout would wrongly read as "no device here".
const CONNECT_TIMEOUT_MS_LAN = 800;
const CONNECT_TIMEOUT_MS_TAILSCALE = 3000;
const CONCURRENCY = 32;
const TAILSCALE_RANGE = { base: ipToInt("100.64.0.0"), mask: 10 };

function isTailscaleRangeIp(ip: string): boolean {
  const rangeMask = (0xffffffff << (32 - TAILSCALE_RANGE.mask)) >>> 0;
  return (ipToInt(ip) & rangeMask) >>> 0 === (TAILSCALE_RANGE.base & rangeMask) >>> 0;
}

/** Why a host produced no result — kept distinct so the wizard can tell an
 * operator "254/254 timed out, check the Tailscale route" instead of a
 * flat, undiagnosable "no devices found". Every failure previously
 * collapsed into a bare `catch { return null }`, indistinguishable from
 * "not a Dinstar". */
export type ProbeFailureReason = "timeout" | "refused" | "no-route" | "unknown";

export function classifyFetchError(err: unknown): ProbeFailureReason {
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
  if (code === "ECONNREFUSED") return "refused";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EHOSTDOWN") return "no-route";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  return "unknown";
}

interface ProbeHostResult {
  found: DiscoveredHost | null;
  reason: ProbeFailureReason | null;
}

async function probeHost(ip: string): Promise<ProbeHostResult> {
  const timeoutMs = isTailscaleRangeIp(ip) ? CONNECT_TIMEOUT_MS_TAILSCALE : CONNECT_TIMEOUT_MS_LAN;
  try {
    const res = await fetch(`http://${ip}/goip_get_status.html`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const authHeader = res.headers.get("www-authenticate") ?? "";
    if (res.status === 401 && /basic/i.test(authHeader)) {
      return { found: { ip, fingerprint: "dinstar", authStyle: "basic" }, reason: null };
    }
    if (res.ok) {
      const text = await res.text().catch(() => "");
      if (text.includes("\"status\"") || text.includes("gsm_remain_credit")) {
        return { found: { ip, fingerprint: "dinstar", authStyle: "unknown" }, reason: null };
      }
      return { found: { ip, fingerprint: "unknown-http", authStyle: "unknown" }, reason: null };
    }
    return { found: null, reason: "unknown" };
  } catch (err) {
    return { found: null, reason: classifyFetchError(err) };
  }
}

export interface DiscoveryResult {
  hosts: DiscoveredHost[];
  scannedCount: number;
  /** Count of non-matching hosts by why they didn't match — lets the UI
   * distinguish "254/254 timed out" (probable network/routing problem)
   * from "254/254 refused" (network's fine, nothing Dinstar-shaped there)
   * instead of a single opaque empty result. */
  reasonCounts: Record<ProbeFailureReason, number>;
}

/** Bounded-concurrency scan of every host in `cidr`, returning hosts that
 * answered on HTTP with a Dinstar-shaped fingerprint plus a breakdown of
 * why every other host didn't match. Runs in ~10-20s for a /24 at
 * CONCURRENCY=32 on a LAN; longer over a Tailscale-range CIDR per the
 * wider per-host timeout above. */
export async function discoverDinstarHosts(cidr: string): Promise<DiscoveryResult> {
  const hosts = hostsInCidr(cidr);
  const found: DiscoveredHost[] = [];
  const reasonCounts: Record<ProbeFailureReason, number> = { timeout: 0, refused: 0, "no-route": 0, unknown: 0 };

  let index = 0;
  async function worker() {
    while (index < hosts.length) {
      const ip = hosts[index++];
      const result = await probeHost(ip);
      if (result.found) {
        found.push(result.found);
      } else if (result.reason) {
        reasonCounts[result.reason]++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, hosts.length) }, worker));

  return {
    hosts: found.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip)),
    scannedCount: hosts.length,
    reasonCounts,
  };
}

export interface DinstarPort {
  port: number;
  type: string | null;
  simPresent: boolean;
}

export interface ProbeResult {
  reachable: boolean;
  authenticated: boolean;
  authStyle: "basic" | "query" | null;
  ports: DinstarPort[];
  error?: string;
}

/** Tries both known Dinstar UC2000 firmware auth styles — Basic auth
 * header, and a `?username=&password=` query-string fallback some
 * firmware variants use instead — and records WHICH one worked, so that
 * fact only ever needs discovering once (persisted as the
 * DINSTAR_AUTH_STYLE setting by the apply route). */
export async function probeDinstarCredentials(ip: string, username: string, password: string): Promise<ProbeResult> {
  const basicAttempt = await tryFetch(`http://${ip}/goip_get_status.html`, {
    headers: { Authorization: basicAuthHeader(username, password) },
  });
  if (basicAttempt.ok) {
    return { reachable: true, authenticated: true, authStyle: "basic", ports: parsePorts(basicAttempt.body) };
  }

  const queryAttempt = await tryFetch(
    `http://${ip}/goip_get_status.html?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
  );
  if (queryAttempt.ok) {
    return { reachable: true, authenticated: true, authStyle: "query", ports: parsePorts(queryAttempt.body) };
  }

  const reachable = basicAttempt.reachable || queryAttempt.reachable;
  return {
    reachable,
    authenticated: false,
    authStyle: null,
    ports: [],
    error: reachable ? "Reached the gateway, but neither Basic auth nor query-string auth was accepted — check the username/password." : "Could not reach the gateway at this address.",
  };
}

async function tryFetch(url: string, init: RequestInit = {}): Promise<{ reachable: boolean; ok: boolean; body: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    const body = await res.text().catch(() => "");
    return { reachable: true, ok: res.ok, body };
  } catch {
    return { reachable: false, ok: false, body: "" };
  }
}

function parsePorts(body: string): DinstarPort[] {
  try {
    const parsed = JSON.parse(body) as { status?: Array<{ port?: number; type?: string; sim?: string }> };
    return (parsed.status ?? []).map((p) => ({
      port: p.port ?? 0,
      type: p.type ?? null,
      simPresent: (p.sim ?? "").toLowerCase() !== "no sim" && (p.sim ?? "") !== "",
    }));
  } catch {
    return [];
  }
}
