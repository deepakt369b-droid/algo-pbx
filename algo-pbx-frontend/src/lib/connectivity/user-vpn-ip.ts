// Pure IPv4 allocator for per-user WireGuard tunnel addresses (owner-page
// enchanted-sphinx plan, W3). Deliberately generic (any /24 CIDR string,
// any list of already-taken IPs) rather than re-deriving the tenant-gateway
// addressing scheme in src/lib/platform/subnet.ts — that module's
// `subnetCidr()`/`tunnelServerIp()`/`gatewayTunnelIp()` fix the tenant
// gateway's own .1 (server) and .10 (gateway) addresses within the tenant's
// 10.8.n.0/24; this allocator is handed that same CIDR (via
// `subnetCidr(tenant.tunnelSubnetIndex)`) by the caller and only decides
// which HOST address inside it is free for the next user profile, starting
// above the addresses that module's own convention reserves.
//
// Never throws — an exhausted range or malformed CIDR is a `null` return,
// left for the caller (the VPN route) to turn into a readable 400/409.

const HOST_RANGE_START = 20; // leaves .1 (server) and .2-.19 for gateways/future infra
const HOST_RANGE_END = 254; // .255 is the broadcast address

function parseIPv4Cidr(cidr: string): { octets: [number, number, number]; prefix: number } | null {
  const match = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\/(\d{1,2})$/);
  if (!match) return null;
  const [, a, b, c, prefixStr] = match;
  const prefix = Number(prefixStr);
  if (prefix !== 24) return null; // this deployment's only CIDR shape (see subnet.ts)
  const octets = [Number(a), Number(b), Number(c)] as [number, number, number];
  if (octets.some((o) => o < 0 || o > 255)) return null;
  return { octets, prefix };
}

/**
 * Returns the next free host IP in `cidr` (a "/24" string, e.g.
 * "10.8.3.0/24") that is not in `takenIps`, scanning from
 * `HOST_RANGE_START` to `HOST_RANGE_END`. Returns `null` when the CIDR is
 * malformed/unsupported or the range is exhausted.
 */
export function nextUserVpnIp(cidr: string, takenIps: readonly string[]): string | null {
  const parsed = parseIPv4Cidr(cidr);
  if (!parsed) return null;

  const taken = new Set(takenIps);
  const [a, b, c] = parsed.octets;
  for (let host = HOST_RANGE_START; host <= HOST_RANGE_END; host++) {
    const ip = `${a}.${b}.${c}.${host}`;
    if (!taken.has(ip)) return ip;
  }
  return null;
}
