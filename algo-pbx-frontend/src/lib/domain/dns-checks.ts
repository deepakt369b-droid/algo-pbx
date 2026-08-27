// Public-DNS lookups for the domain wizard, deliberately independent of
// any Cloudflare token — this is what lets the wizard show "nameservers
// already point at Cloudflare" before a token has even been created,
// breaking the token/zone chicken-and-egg (Cloudflare only assigns
// nameservers once a zone exists; creating a zone needs a broader
// account-scoped token than the single-zone DNS-edit token this app asks
// for). Resolvers are pinned to public recursive servers rather than
// Node's default (which inside a container often points at Docker's
// embedded DNS) so a stale local cache can't produce a false negative
// mid-propagation.
import dns from "node:dns";

const RESOLVERS = ["1.1.1.1", "8.8.8.8"];

function makeResolver(): dns.promises.Resolver {
  const resolver = new dns.promises.Resolver();
  resolver.setServers(RESOLVERS);
  return resolver;
}

const CLOUDFLARE_NS_SUFFIX = ".ns.cloudflare.com";

export interface NameserverCheck {
  onCloudflare: boolean;
  nameservers: string[];
}

export async function checkNameservers(domain: string): Promise<NameserverCheck> {
  try {
    const nameservers = await makeResolver().resolveNs(domain);
    return { onCloudflare: nameservers.some((ns) => ns.toLowerCase().endsWith(CLOUDFLARE_NS_SUFFIX)), nameservers };
  } catch {
    return { onCloudflare: false, nameservers: [] };
  }
}

export interface ARecordCheck {
  addresses: string[];
  matchesExpected: boolean | null; // null when expectedIp isn't known yet
}

export async function checkARecord(domain: string, expectedIp?: string): Promise<ARecordCheck> {
  try {
    const addresses = await makeResolver().resolve4(domain);
    return { addresses, matchesExpected: expectedIp ? addresses.includes(expectedIp) : null };
  } catch {
    return { addresses: [], matchesExpected: expectedIp ? false : null };
  }
}
