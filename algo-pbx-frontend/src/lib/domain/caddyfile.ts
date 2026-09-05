import { writeFile } from "node:fs/promises";
import path from "node:path";
import { TENANT_BASE_DOMAIN } from "@/lib/platform/domain-constants";

// Caddyfile generation, extracted from POST /api/admin/settings/domain/apply
// so the platform console can apply domain config without the tenant-admin
// guard. The rendering logic is unchanged — this is a move, not a rewrite,
// deliberately: it is the config that keeps production TLS working, and
// "while I'm here" improvements to it are how a working reverse proxy stops
// working.
//
// One thing IS new: an optional wildcard block for tenant workspaces
// (*.<TENANT_BASE_DOMAIN>), and it is opt-in for a specific, documented
// reason — see renderCaddyfile's comment on the wildcard.

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const PBX_SUBDOMAIN_RE = /^pbx\.(.+)$/;

export function apexDomainFor(domain: string): string | null {
  const m = PBX_SUBDOMAIN_RE.exec(domain);
  return m ? m[1] : null;
}

export function isIpAddress(domain: string): boolean {
  return IPV4_RE.test(domain);
}

export interface RenderOptions {
  domain: string;
  /**
   * Emit the `*.<TENANT_BASE_DOMAIN>` block that serves tenant workspaces.
   *
   * OFF BY DEFAULT, and that is load-bearing rather than cautious. This
   * route's own history records the lesson: Caddy treats a failed
   * TLS-automation provisioning as fatal to the WHOLE config, not to the one
   * site — so a wildcard block whose DNS-01 challenge cannot complete (no
   * wildcard record, wrong zone, token lacking scope on that zone) does not
   * merely fail to serve tenant workspaces. It crash-loops the entire reverse
   * proxy, taking the existing, working production site down with it.
   *
   * So the operator turns this on deliberately, after the one-time wildcard
   * DNS record exists, and not as a side effect of saving a domain.
   */
  includeTenantWildcard?: boolean;
}

export function renderCaddyfile({ domain, includeTenantWildcard = false }: RenderOptions): string {
  const apex = apexDomainFor(domain);

  const websiteBlock = apex
    ? `
# Public marketing/legal/docs site (website/) — static export served
# directly by Caddy, no app container involved. Requires website/out/ to
# exist on the host BEFORE this config is applied, or Caddy will fail to
# start entirely (a missing file_server root is a fatal config-load error
# the same way a bad tls block is).
http://${apex} {
	redir https://${apex}{uri} permanent
}

https://${apex} {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}

	encode zstd gzip

	root * /srv/website
	file_server
}

https://www.${apex} {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}

	redir https://${apex}{uri} permanent
}
`
    : "";

  const wildcardBlock = includeTenantWildcard
    ? `
# Tenant workspaces — one wildcard certificate covers every tenant, so
# onboarding a customer needs no Caddy change and no new certificate.
#
# DANGER: if the DNS-01 challenge for this wildcard cannot complete, Caddy
# treats it as fatal to this ENTIRE config and the whole reverse proxy
# crash-loops — not just tenant workspaces. Requires the one-time
# *.${TENANT_BASE_DOMAIN} DNS record and a Cloudflare token scoped to that
# zone. This block is only emitted when the operator has explicitly enabled
# it in Platform Settings.
https://*.${TENANT_BASE_DOMAIN} {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}

	encode zstd gzip

	reverse_proxy web:3000
}
`
    : "";

  return `# GENERATED FILE — DO NOT HAND-EDIT.
# Written by the domain apply action (src/lib/domain/caddyfile.ts). Hand
# edits survive until the next apply, then are silently overwritten. To
# change the safe plain-HTTP default this started from, edit the repo-root
# Caddyfile instead — see that file's own header.

http://${domain} {
	redir https://${domain}{uri} permanent
}

https://${domain} {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}

	encode zstd gzip

	reverse_proxy web:3000
}
${websiteBlock}${wildcardBlock}
# Headscale — the fallback connectivity control plane's own subdomain.
# Same Cloudflare DNS-01 token as the block above (one Caddy instance, one
# cert store); a separate \`tls\` block because this is a different site
# host, not because it needs a different challenge method.
https://vpn.${domain} {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}

	encode zstd gzip

	reverse_proxy headscale:8080
}
`;
}

export type ApplyResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Writes the generated config and asks cert-sync to recreate Caddy.
 *
 * Caddy reads these from pbx_configs/generated/{caddy.env,Caddyfile} at
 * container-create time, not from this app's database — so persisting the
 * settings alone changes nothing about what is actually served. This function
 * is what makes a saved domain real.
 */
export async function applyDomainConfig(opts: {
  domain: string;
  token: string;
  includeTenantWildcard?: boolean;
  generatedDir?: string;
}): Promise<ApplyResult> {
  const dir = opts.generatedDir || process.env.GENERATED_CONFIG_DIR || "/generated";

  if (isIpAddress(opts.domain)) {
    return {
      ok: false,
      error: `"${opts.domain}" is an IP address, not a domain name — Let's Encrypt/Cloudflare DNS-01 cannot issue a certificate for it.`,
    };
  }

  try {
    await writeFile(
      path.join(dir, "caddy.env"),
      `VM_PUBLIC_DOMAIN=${opts.domain}\nCLOUDFLARE_API_TOKEN=${opts.token}\n`,
      "utf8"
    );
    await writeFile(
      path.join(dir, "Caddyfile"),
      renderCaddyfile({ domain: opts.domain, includeTenantWildcard: opts.includeTenantWildcard }),
      "utf8"
    );
    // Empty marker file — cert-sync's poll loop only checks for its
    // existence, never reads its content.
    await writeFile(path.join(dir, ".caddy-restart-requested"), "", "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `Could not write the generated config (${err instanceof Error ? err.message : "unknown error"}) — check the "web" service's /generated volume mount.`,
    };
  }

  return {
    ok: true,
    message:
      `Wrote caddy.env + Caddyfile for ${opts.domain}` +
      (opts.includeTenantWildcard ? ` including the *.${TENANT_BASE_DOMAIN} wildcard` : "") +
      `, and requested a caddy container recreate. cert-sync polls every ~30s — check "docker logs algo-caddy" shortly to confirm the certificate was issued.`,
  };
}
