// Pooled-stack allocation arithmetic (approved plan §4, D1 "One pooled
// stack, namespaced"). Every identifier a tenant gets at provisioning time
// derives from one integer — its `tunnelSubnetIndex` — and this module is the
// only place those derivations live. The tenant-detail identity card renders
// them so support never has to grep config files to answer "what is this
// customer's subnet / cert CN / dialplan prefix".
//
// Pure by construction: no DB, no env, no filesystem. The caller fetches the
// used indexes and passes them in.

import { LEGACY_TENANT_ONE_SLUG } from "./domain-constants";

/** Tenant #1 (us) was seeded at index 0, on the single 10.8.0.0/24 that
 * predates this whole scheme. New tenants therefore start at 1. */
export const LEGACY_TENANT_ONE_SUBNET_INDEX = 0;

/** The /16 the per-tenant /24s are carved out of, once the OpenVPN server is
 * widened. Deployed reality today is still a single 10.8.0.0/24 — see
 * `provisioning-machine.ts` and the owner-only widening flag for why that
 * matters and how it is gated. */
export const TUNNEL_SUPERNET = "10.8.0.0/16";

/** Highest index the second octet can express. 10.8.255.0/24 is the last. */
export const MAX_SUBNET_INDEX = 255;

export class SubnetExhaustedError extends Error {
  constructor() {
    super(
      `No tunnel subnet index remains: 10.8.<n>.0/24 only spans n=0..${MAX_SUBNET_INDEX}, ` +
        `and indexes are never reused. Widening beyond /16 is a network redesign, not a config change.`
    );
    this.name = "SubnetExhaustedError";
  }
}

/**
 * Allocates the next tunnel subnet index.
 *
 * Deliberately `max(used) + 1`, NOT "smallest gap". The schema comment on
 * `Tenant.tunnelSubnetIndex` states the rule and the reason: indexes are
 * "unique, never reused even after offboarding, so a stale gateway can never
 * land in a live tenant's subnet". Filling a gap left by an offboarded tenant
 * would hand a fresh customer the exact /24 that a revoked-but-still-deployed
 * gateway is configured to dial into — a cross-tenant network path created by
 * an allocator being clever. The unique constraint in Postgres stops a
 * duplicate; only this policy stops a *reuse*.
 *
 * `used` may contain duplicates, negatives or holes; only the maximum matters.
 */
export function allocateSubnetIndex(used: readonly number[]): number {
  const valid = used.filter((n) => Number.isInteger(n) && n >= 0);
  const next = valid.length === 0 ? LEGACY_TENANT_ONE_SUBNET_INDEX + 1 : Math.max(...valid) + 1;
  if (next > MAX_SUBNET_INDEX) throw new SubnetExhaustedError();
  return next;
}

function assertIndex(n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_SUBNET_INDEX) {
    throw new RangeError(`Invalid tunnel subnet index: ${n}. Must be an integer 0..${MAX_SUBNET_INDEX}.`);
  }
}

/** The tenant's own /24. Tenant n owns 10.8.n.0/24. */
export function subnetCidr(n: number): string {
  assertIndex(n);
  return `10.8.${n}.0/24`;
}

/** The OpenVPN server's address inside that tenant's /24 — the source the
 * gateway sends syslog to, and the ping target for a tunnel-up check. */
export function tunnelServerIp(n: number): string {
  assertIndex(n);
  return `10.8.${n}.1`;
}

/** The tenant gateway's fixed tunnel address, written into its `ccd` entry as
 * `ifconfig-push`. Matches the deployed convention (.10) that tenant #1's
 * cust-demo-gw-1 already uses, rather than inventing a second one. */
export function gatewayTunnelIp(n: number): string {
  assertIndex(n);
  return `10.8.${n}.10`;
}

/**
 * The OpenVPN client certificate CN for a tenant's gateway.
 *
 * This one string is simultaneously the cert CN, the `ccd/` filename, and
 * `GatewaySite.name` — `pbx_configs/openvpn/README.md` is explicit that the
 * server matches ccd filenames against the CN presented at connect time, so
 * these three cannot drift by even a character. That is also why
 * `GatewaySite.name` is globally unique rather than unique-per-tenant.
 *
 * Must satisfy bridge-watch.sh's SAFE_NAME_RE (^[A-Za-z0-9_-]{1,64}$); a slug
 * that passed `validateTenantSlug` already does, since that charset is a
 * strict subset.
 */
export function certCn(slug: string, gatewayNumber = 1): string {
  if (!Number.isInteger(gatewayNumber) || gatewayNumber < 1) {
    throw new RangeError(`Gateway number must be a positive integer, got ${gatewayNumber}.`);
  }
  return `cust-${slug}-gw-${gatewayNumber}`;
}

/** Prefix for this tenant's Asterisk identities: PJSIP endpoints become
 * `t<n>-<ext>`, queues `t<n>-<queue>`, dialplan contexts `from-agent-t<n>` /
 * `from-dinstar-t<n>` (plan §4 step 9). Display-only until wave 6 actually
 * namespaces Asterisk — the console shows it so the mapping is legible before
 * the rename happens. */
export function telephonyNamespace(n: number): string {
  assertIndex(n);
  return `t${n}-`;
}

export function pjsipEndpointName(n: number, extension: string): string {
  return `${telephonyNamespace(n)}${extension}`;
}

export function dialplanContexts(n: number): { fromAgent: string; fromDinstar: string } {
  const ns = telephonyNamespace(n).replace(/-$/, "");
  return { fromAgent: `from-agent-${ns}`, fromDinstar: `from-dinstar-${ns}` };
}

/** True for the tenant that predates this scheme and still lives on the
 * original shared 10.8.0.0/24 with a custom domain. The UI labels it rather
 * than pretending it follows the pattern. */
export function isLegacyPooledTenant(slug: string, n: number | null): boolean {
  return slug === LEGACY_TENANT_ONE_SLUG || n === LEGACY_TENANT_ONE_SUBNET_INDEX;
}
