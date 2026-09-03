// Copyable fallback-runbook commands for the /admin/connectivity page
// (Node E) — headscale's own CLI is reached via `docker exec` against the
// Unix socket in pbx_configs/headscale/config.yaml.template, not a
// published API port (see docker-compose.yml's headscale service
// comment), so these are commands an operator runs on the VPS's own
// shell, not something this app executes itself. Pure string builders,
// no I/O — DB-free, unit-testable, matching this repo's convention for
// every other pure lib file.

/** `docker exec` command to create a headscale namespace/user for one
 * customer site. Headscale calls this a "user" as of 0.23; kept the
 * function name namespace-flavored since that's the operator-facing
 * concept the task described ("namespace per customer"). */
export function createNamespaceCommand(siteName: string): string {
  return `docker exec algo-headscale headscale users create ${siteName}`;
}

/** Pre-auth key for one site/user — reusable=false, single-node join,
 * expires in 24h so a copied-but-unused key doesn't stay valid
 * indefinitely. */
export function createPreAuthKeyCommand(siteName: string): string {
  return `docker exec algo-headscale headscale preauthkeys create --user ${siteName} --expiration 24h`;
}

/** The client-side command the operator runs ON the gateway (or whatever
 * device is joining) once a pre-auth key exists. `domain` is the app's
 * own public domain — vpn.<domain> is where headscale's control plane is
 * reverse-proxied (see the Caddyfile-render extension in
 * src/app/api/admin/settings/domain/apply/route.ts). */
export function clientJoinCommand(domain: string, preAuthKey: string): string {
  return `tailscale up --login-server https://vpn.${domain} --authkey ${preAuthKey}`;
}

/** List currently registered nodes — the poller (Node F) uses headscale's
 * own machinery for live status, but this is the same command an operator
 * would run by hand to sanity-check during the runbook's fallback-switch
 * step. */
export function listNodesCommand(): string {
  return "docker exec algo-headscale headscale nodes list";
}
