import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { requireSetting } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

const GENERATED_DIR = process.env.GENERATED_CONFIG_DIR || "/generated";

// A bare IP address is never a valid ACME/DNS-01 target — reject it here
// rather than writing a Caddyfile that will only fail later, opaquely,
// inside Caddy's own logs. Real domain names ARE validated by the
// settings registry's own Zod validator (src/lib/settings/schema.ts) at
// PATCH time, but requireSetting() below can also resolve VM_PUBLIC_DOMAIN
// from its process.env fallback (e.g. still "127.0.0.1" from a fresh
// .env, never explicitly saved through the UI) — that path bypasses the
// registry validator entirely, so this route needs its own guard too.
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// The public marketing/legal/docs site (website/, task "public website for
// saharatechs.com") lives at the apex domain, one level up from
// VM_PUBLIC_DOMAIN's own "pbx." subdomain — e.g. VM_PUBLIC_DOMAIN
// "pbx.saharatechs.com" -> apex "saharatechs.com". Derived rather than a
// second AppSetting because the two names are meant to always move
// together (same zone, same cert automation, same Cloudflare token) and a
// second independently-editable setting would let them drift out of sync
// with no validation catching it. Only fires when VM_PUBLIC_DOMAIN
// actually has that "pbx." prefix — an operator who set VM_PUBLIC_DOMAIN to
// something else entirely gets the exact same Caddyfile as before this
// feature existed, never a guessed apex block.
const PBX_SUBDOMAIN_RE = /^pbx\.(.+)$/;

function apexDomainFor(domain: string): string | null {
  const m = PBX_SUBDOMAIN_RE.exec(domain);
  return m ? m[1] : null;
}

function renderCaddyfile(domain: string): string {
  const apex = apexDomainFor(domain);

  const websiteBlock = apex
    ? `
# Public marketing/legal/docs site (website/) — static export served
# directly by Caddy, no app container involved. Requires website/out/ to
# exist on the host (built during deploy, see website/README or
# handoff.md's deploy sequence) BEFORE this config is applied, or Caddy
# will fail to start entirely (a missing file_server root is a fatal
# config-load error the same way a bad tls block is — see this file's own
# header history). www redirects to the bare apex; no separate cert
# needed for it beyond what Cloudflare DNS-01 already covers for the zone.
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

  return `# GENERATED FILE — DO NOT HAND-EDIT.
# Written by POST /api/admin/settings/domain/apply (Loop C4). Hand edits
# survive until the next Connect-domain action, then are silently
# overwritten. To change the safe plain-HTTP default this started from,
# edit the repo-root Caddyfile instead — see that file's own header.

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
${websiteBlock}
# Headscale (OpenVPN/Headscale/connectivity task, Node C) — the fallback
# connectivity control plane's own subdomain. Same Cloudflare DNS-01
# token as the block above (one Caddy instance, one cert store); a
# separate \`tls\` block because this is a different site host, not because
# it needs a different challenge method. Internal port 8080 matches
# headscale's config.yaml.template listen_addr — see docker-compose.yml's
# headscale service comment if that ever changes.
https://vpn.${domain} {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}

	encode zstd gzip

	reverse_proxy headscale:8080
}
`;
}

// POST /api/admin/settings/domain/apply — the action button distinct from
// the generic Save on the Domain & TLS section (Loop C4). Save only
// persists VM_PUBLIC_DOMAIN/CLOUDFLARE_API_TOKEN to AppSetting (via the
// existing generic PATCH /api/admin/settings) — it does NOT, by itself,
// change anything a running container actually uses, since Caddy reads
// these from pbx_configs/generated/{caddy.env,Caddyfile} at container-
// CREATE/mount time, not from this app's database. This route is what
// actually writes those files and asks `cert-sync` (which holds the only
// Docker-socket access in this stack — see docker-compose.yml's comment
// on that service) to recreate the `caddy` container so the new value
// takes effect.
//
// Real bug found deploying this (2026-08-27): the original Caddyfile
// unconditionally required a valid Cloudflare token to even START —
// Caddy treats a failed TLS-automation provisioning as fatal to the
// whole config, not per-site, so an empty/invalid token crash-looped the
// ENTIRE reverse proxy, not just HTTPS. Fixed by making the repo-root
// Caddyfile a safe plain-HTTP-only default (see its header) that this
// route's generated Caddyfile only ever UPGRADES from, never the only
// thing standing between a fresh deploy and a working web UI.
//
// GAP, stated plainly rather than silently worked around (Node C,
// OpenVPN/Headscale/connectivity task): this route has never created or
// managed a Cloudflare A record for VM_PUBLIC_DOMAIN itself — it only
// proves domain ownership for ACME via the `dns cloudflare` DNS-01
// challenge (a TXT record Caddy manages internally), which doesn't
// require an A record to exist at all. The main domain's own A record
// was presumably added by hand in the Cloudflare dashboard at initial
// setup. There is therefore no existing DNS-upsert mechanism to extend
// for vpn.<domain> either — it needs the SAME manual step (a grey-cloud/
// DNS-only A record pointing vpn.<domain> at this VPS's public IP)
// before Caddy can issue it a cert, documented in the connectivity
// page's runbook (Node E) rather than automated here. Building a real
// Cloudflare DNS API write path is a separate, larger feature decision
// (new credentials scope, error handling, a genuinely destructive
// operation on the operator's DNS zone) than this task's stated scope —
// flagged for the coordinator/operator to decide, not improvised.
export async function POST() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  let domain: string;
  let token: string;
  try {
    domain = await requireSetting("VM_PUBLIC_DOMAIN");
    token = await requireSetting("CLOUDFLARE_API_TOKEN");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Domain or token not configured." }, { status: 400 });
  }

  if (IPV4_RE.test(domain)) {
    return NextResponse.json(
      { error: `"${domain}" is an IP address, not a domain name — Let's Encrypt/Cloudflare DNS-01 cannot issue a certificate for it. Enter and Save a real domain first.` },
      { status: 400 }
    );
  }

  const envContent = `VM_PUBLIC_DOMAIN=${domain}\nCLOUDFLARE_API_TOKEN=${token}\n`;

  try {
    await writeFile(path.join(GENERATED_DIR, "caddy.env"), envContent, "utf8");
    await writeFile(path.join(GENERATED_DIR, "Caddyfile"), renderCaddyfile(domain), "utf8");
    // Empty marker file — cert-sync's poll loop only checks for its
    // existence, never reads its content.
    await writeFile(path.join(GENERATED_DIR, ".caddy-restart-requested"), "", "utf8");
  } catch (err) {
    return NextResponse.json(
      { error: `Could not write the generated config (${err instanceof Error ? err.message : "unknown error"}) — check the "web" service's /generated volume mount.` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: `Wrote caddy.env + Caddyfile for ${domain} and requested a caddy container recreate. cert-sync polls every ~30s — check /admin/system or "docker logs algo-caddy" shortly to confirm the certificate was issued.`,
  });
}
