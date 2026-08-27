# Deploying Algo PBX

Target: a plain Linux VM running Docker + Docker Compose. This doc covers
`git clone` through a working first login — service credentials (Resend,
WhatsApp, SMS, Firebase) are configured afterward, in the browser, at
`/admin/settings`, not in this file.

## 1. Prerequisites on the VM

- Docker Engine + Docker Compose v2
- A public DNS name pointed at the VM (`VM_PUBLIC_DOMAIN` below) — see
  `docs/2-Configuring-Credentials-Dinstar-and-Going-Live.pdf` for the
  GoDaddy → Cloudflare cutover. The A record must be **DNS only (grey
  cloud)**; Cloudflare's orange-cloud proxy cannot carry SIP/RTP/WSS.
- Ports open in your cloud security group / host firewall:

| Port | Protocol | Purpose | Public? |
| --- | --- | --- | --- |
| 80 | tcp | ACME/certbot challenges + redirect to HTTPS | yes |
| 443 | tcp | Web app + browser UI (Caddy → `web:3000`) | yes |
| 8089 | tcp | Asterisk WSS signaling for agents | yes |
| 3478 | tcp+udp | Coturn STUN/TURN listener | yes |
| 5349 | tcp | Coturn TURN over TLS | yes |
| 10000–20000 | udp | Asterisk RTP media | yes |
| 20001–30000 | udp | Coturn relay range | yes |
| 5060 | udp | SIP — Dinstar trunk ONLY, via Tailscale | **no** |
| 5038 | tcp | AMI — Docker bridge ACL only | **never** |
| 5432 | tcp | Postgres — loopback publish only | **never** |

`scripts/setup-firewall.sh` applies this matrix with ufw. Run it once after
first boot (adjust the SSH port inside first if you don't use 22).

- A Dinstar UC2000 reachable over the Tailscale route already documented
  in `ALGO_PBX_MASTER_DOC.md`

### 1.1 Running on VirtualBox

If the "VM" above is an Oracle VirtualBox guest on a Windows/Linux host rather
than a cloud instance, use a **Bridged Adapter** for the VM's network
interface, not NAT. NAT port-forwarding requires one explicit rule per port,
and the RTP (`10000-20000/udp`) plus Coturn relay (`20001-30000/udp`) ranges
alone are 20,000 ports wide — a NAT-forwarded deploy will serve the web UI but
every call will connect with no audio. Bridged Adapter puts the VM directly on
the LAN with its own IP, exactly like a physical box on the router, and avoids
any collision with host ports another VM on the same hypervisor already
forwards (see `docs/1-Deploying-Algo-PBX-on-a-Linux-VM.pdf` Chapter 3 for the
full walkthrough, written for a non-technical operator).

### 1.2 Port conflicts

Before opening anything in the router or firewall, confirm each port in the
matrix above is actually free:

```bash
# Inside the Linux VM:
sudo ss -tulpn | grep -E ':(80|443|8089|3478|5349|5060|5038|5432)\b'
docker ps --format '{{.Names}} {{.Ports}}'
```

```powershell
# On a Windows hypervisor host, checking what it (or another VM's NAT
# forwarding) already claims:
Get-NetTCPConnection -LocalPort 443 | Select-Object LocalAddress,State,OwningProcess
VBoxManage showvminfo "<other-vm-name>" --machinereadable | findstr Forwarding
```

Only the Caddy web-facing ports (80/443/8089) are safe to move, and only by
changing `docker-compose.yml`'s `caddy.ports`, `Caddyfile`'s site address,
`.env`'s `AUTH_URL`/`NEXT_PUBLIC_SIP_WS_SERVER`/`NEXT_PUBLIC_TURN_SERVER`, and
`scripts/setup-firewall.sh` together. The RTP range, Coturn relay range, 5060,
5038, and 5432 are not movable — see the matrix's own constraints above.
`docs/1-Deploying-Algo-PBX-on-a-Linux-VM.pdf` Chapter 2 has the full
port-conflict guide (what breaks, how to check both host and guest, and a
symptom → cause → fix table) for an operator working through this without
prior networking background.

## 2. Clone and generate secrets

```bash
git clone <your-fork-url> algo-pbx
cd algo-pbx
cp .env.example .env
```

Generate the values `.env.example` marks as bootstrap-required:

```bash
openssl rand -hex 32      # -> SETTINGS_ENCRYPTION_KEY
openssl rand -base64 33   # -> AUTH_SECRET
openssl rand -hex 32      # -> COTURN_AUTH_SECRET
openssl rand -hex 32      # -> AMI_SECRET, CDR_AMI_SECRET, CDR_INGEST_SECRET (one each)
```

Fill in `.env`'s **bootstrap** section (top of the file, above the
`RUNTIME SETTINGS` marker): Postgres credentials, `SETTINGS_ENCRYPTION_KEY`,
`AUTH_SECRET`/`AUTH_URL`, AMI credentials, `VM_PUBLIC_DOMAIN`/`VM_PUBLIC_IP`/
`VM_PRIVATE_IP`, `COTURN_AUTH_SECRET`, `DINSTAR_LAN_IP`.

**Do not** fill in the RUNTIME SETTINGS section (Resend, OpenWA, Meta,
Dinstar SMS credentials, Firebase, CRM webhook secret) unless you want a
fully non-interactive deploy — every one of those is configurable from
`/admin/settings` after first login, and takes effect immediately with no
restart when set there.

### TLS certificates (required before any call or HTTPS works)

One certificate pair serves everything: Caddy (443), Asterisk WSS (8089),
and Coturn TLS (5349) — via `pbx_configs/keys/fullchain.pem` + `privkey.pem`
(see `pbx_configs/keys/README.md`).

**Default path (Loop C4) — Caddy issues and renews this itself**, no
certbot, no manual copy/restart cron:

1. Point your domain at this VM in Cloudflare (an A record — GoDaddy →
   Cloudflare nameservers, then the A record lives in Cloudflare).
2. Before the first `docker compose up`, seed the generated config from
   `.env`'s `VM_PUBLIC_DOMAIN` (this is what lets a fresh deploy boot
   without any admin-panel action first):
   ```bash
   bash scripts/render-caddy-env.sh
   ```
3. `docker compose up -d --build` (the `caddy` service now builds from
   `Dockerfile.caddy`, adding the Cloudflare DNS-01 plugin — first build
   only, cached after).
4. Sign in to `/admin` (reachable directly on `http://<vm-ip>:3000` even
   before Caddy has a real cert — `web`'s port is published independently)
   and open **Settings → Domain & TLS**. Enter the domain again if it
   isn't already shown, and a Cloudflare API token scoped to
   `Zone:DNS:Edit` + `Zone:Zone:Read` on that domain's zone (create one at
   Cloudflare dashboard → My Profile → API Tokens). **Save**, then
   **Test connection** to confirm the token can see the right zone, then
   **Connect domain**.
5. `cert-sync` (a new service — see docker-compose.yml's comment on it for
   why it's the one container in this stack with Docker-socket access)
   picks up the change within ~30s, recreates `caddy` with the new
   env, and once Caddy obtains the certificate, copies it into
   `pbx_configs/keys/` and restarts `asterisk`/`coturn` so their WSS/TURN
   TLS use the same real, publicly-trusted cert automatically — not a
   self-signed one, and not the old certbot-issued one either.

Watch it happen: `docker logs -f algo-caddy` (look for "certificate
obtained successfully") and `docker logs -f algo-cert-sync`.

**Fallback — manual certbot**, if the automated path fails or you'd rather
not grant a container Docker-socket access at all: revert
`docker-compose.yml`'s `caddy` service to `image: caddy:2-alpine` (drop the
`build:`/`env_file:` lines) and `Caddyfile` to its pre-Loop-C4 form (`git
log Caddyfile` has it — `auto_https off` +
`tls /certs/fullchain.pem /certs/privkey.pem`), remove the `cert-sync`
service, then:

```bash
sudo apt install -y certbot python3-certbot-dns-cloudflare
sudo tee /etc/letsencrypt/cloudflare.ini >/dev/null <<'EOF'
dns_cloudflare_api_token = YOUR_TOKEN_WITH_ZONE_DNS_EDIT
EOF
sudo chmod 600 /etc/letsencrypt/cloudflare.ini
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d your-domain.example.com
sudo cp /etc/letsencrypt/live/your-domain.example.com/fullchain.pem pbx_configs/keys/
sudo cp /etc/letsencrypt/live/your-domain.example.com/privkey.pem  pbx_configs/keys/
```

Renewal cron for the manual path (certs expire every 90 days) — the
deploy hook must restart the three services that hold the cert files in
memory, or they keep serving the expired one:

```bash
0 3 * * 1 certbot renew --quiet --deploy-hook \
  "cp -f /etc/letsencrypt/live/YOUR_DOMAIN/{fullchain.pem,privkey.pem} /opt/algo-pbx/pbx_configs/keys/ && docker compose -f /opt/algo-pbx/docker-compose.yml restart asterisk coturn caddy"
```

## 3. Build and start

The OpenWA (WhatsApp) sidecar builds from a pinned upstream commit that
must be fetched separately before the first build — it is not vendored
into this repo's git history (see `vendor/openwa/README.md`):

```bash
bash vendor/openwa/prepare.sh
```

Then:

```bash
docker compose build
docker compose up -d
docker compose logs -f web   # watch for a clean startup
```

If Postgres's data volume already existed before this deploy (i.e. this
isn't a fresh volume), OpenWA's dedicated database won't have been created
by the init script — run it by hand once:

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d postgres \
  -f /docker-entrypoint-initdb.d/01-create-openwa-db.sql
```

The `web` container runs `prisma migrate deploy` automatically on start
(see the Dockerfile), so the schema is created on first boot — no manual
migration step.

## 4. First run

Visit `https://<your-domain>/setup`. This page is reachable only until
the first `ADMIN` account exists; visiting it afterward redirects to
`/login`. It will refuse to proceed if `SETTINGS_ENCRYPTION_KEY` wasn't
set in step 2, with a message naming the exact command to fix it.

Create the admin account, then you're taken straight to
`/admin/settings`. Configure and **Test connection** for each service you
plan to use:

- **Email (Resend)** — required before any agent invite can be sent.
- **WhatsApp — OpenWA** — required before OTP verification works at all
  (it's the default `OTP_CHANNEL`) and before the WhatsApp chat panel is
  usable. Pair your SIM ports afterward at `/admin/whatsapp` — the board
  shows all four slots (one per Dinstar GSM port) with live pairing codes
  or QRs simultaneously.
- **SMS — Dinstar** — required for the SIM SMS inbox.
- **WhatsApp — Meta Cloud / Firebase** — optional; only needed if you
  switch `OTP_CHANNEL` away from `OPENWA` under the OTP section.

`/admin/system` gives you a live readiness page (10 checks) — green every
line before trusting the deployment.

### Before you run the Dinstar setup wizard's network scan

`/admin/dinstar`'s "Scan network" step sends real HTTP probes from this
VM to every host in the CIDR you give it (default `192.168.1.0/24`, the
UAE office's LAN). If it finds nothing, **check these in order before
assuming the gateway isn't there** — the wizard's own result will now
tell you which of these is most likely (see the reason breakdown it
shows), but confirm on the host directly too:

1. `tailscale status` on this VM — the office subnet route must show as
   **approved**, not just advertised. An unapproved route looks identical
   to "no device" from the scanner's point of view.
2. `ip route` on this VM — confirm the office subnet actually appears in
   the routing table (approval in the Tailscale admin console and the
   route landing in the kernel routing table are two different things).
3. Only once both of those are confirmed does an empty scan mean "check
   the CIDR" or "the gateway's admin HTTP interface is disabled" rather
   than a networking problem.

`/admin/system`'s "Dinstar Network Route" check gives you a lower-level,
credential-free version of this same probe on demand, without running the
full wizard.

## 5. Ongoing

Application updates: `git pull`, `docker compose build`, `docker compose up -d`
— migrations run automatically. Credential rotation: change it in
`/admin/settings`, no redeploy needed. Most telephony config (AMI,
Coturn's realm/secret) is still **not** in the settings UI — those live in
`.env`/`pbx_configs/` and require a restart, by design (see
`prisma/schema.prisma`'s `AppSetting` model comment for why they were kept
out of the runtime-configurable set). **`VM_PUBLIC_DOMAIN` is the one
exception (Loop C4)** — it, plus `CLOUDFLARE_API_TOKEN`, live in
`/admin/settings`' "Domain & TLS" section; see this doc's TLS section
above for the full "Save" vs. "Connect domain" distinction (Save alone
does not touch any running container).

Backups: run `scripts/backup.sh` on a cron (it dumps both databases and
tars recordings/voicemail/photos/the OpenWA session volume). Restore steps
are documented in the script header. Test a restore before go-live — an
untested backup is a hope, not a backup.

Image pinning: `coturn` is pinned to a versioned tag; consider pinning
every image by digest (`docker image inspect --format '{{index .RepoDigests 0}}'`)
once a build is verified, so `docker compose pull` can never silently move
you to a broken upstream release.

## Before your first `git push`

Run `git status` and confirm nothing under `.env`, `pbx_configs/keys/`,
`recordings/`, `voicemail/`, or `agent-photos/` is staged — `.gitignore`
already excludes all of these, this is a sanity check, not a fix step.
