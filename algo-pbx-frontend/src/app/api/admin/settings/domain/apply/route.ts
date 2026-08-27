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

function renderCaddyfile(domain: string): string {
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
