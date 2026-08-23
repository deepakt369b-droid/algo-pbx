# Deploying Algo PBX

Target: a plain Linux VM running Docker + Docker Compose. This doc covers
`git clone` through a working first login — service credentials (Resend,
WhatsApp, SMS, Firebase) are configured afterward, in the browser, at
`/admin/settings`, not in this file.

## 1. Prerequisites on the VM

- Docker Engine + Docker Compose v2
- A public DNS name pointed at the VM (`VM_PUBLIC_DOMAIN` below)
- Ports open: 443/80 (behind your own reverse proxy — this repo does not
  ship one), 8089 (WSS signaling), 5060/udp (SIP to the Dinstar trunk),
  10000-20000/udp (Asterisk RTP), 20001-30000/udp (Coturn relay)
- A Dinstar UC2000 reachable over the Tailscale route already documented
  in `ALGO_PBX_MASTER_DOC.md`

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

Generate the DTLS/WSS certs per `pbx_configs/keys/README.md` before
starting — the stack will build without them but no call will connect
until they exist.

## 3. Build and start

```bash
docker compose build
docker compose up -d
docker compose logs -f web   # watch for a clean startup
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
  usable. Pair an instance afterward at `/admin/whatsapp`.
- **SMS — Dinstar** — required for the SIM SMS inbox.
- **WhatsApp — Meta Cloud / Firebase** — optional; only needed if you
  switch `OTP_CHANNEL` away from `OPENWA` under the OTP section.

## 5. Ongoing

Application updates: `git pull`, `docker compose build`, `docker compose up -d`
— migrations run automatically. Credential rotation: change it in
`/admin/settings`, no redeploy needed. Telephony config (AMI, Coturn,
`VM_PUBLIC_DOMAIN`) is **not** in the settings UI — those live in `.env`
and `pbx_configs/` and require a restart, by design (see
`prisma/schema.prisma`'s `AppSetting` model comment for why they were
kept out of the runtime-configurable set).

## Before your first `git push`

Run `git status` and confirm nothing under `.env`, `pbx_configs/keys/`,
`recordings/`, `voicemail/`, or `agent-photos/` is staged — `.gitignore`
already excludes all of these, this is a sanity check, not a fix step.
