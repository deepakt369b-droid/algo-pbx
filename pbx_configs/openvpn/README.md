# pbx_configs/openvpn/

The OpenVPN server (`openvpn-server` service) and its cert-generation bridge
(`openvpn-bridge` service) — see `docker-compose.yml`'s comments on both for
the full reasoning. Same convention as `pbx_configs/keys/` and
`pbx_configs/generated/`: scripts here are committed, generated PKI/request
state is not.

## Committed (this directory, in git)

- `init-pki.sh` — one-time PKI bootstrap (CA + server cert). Run ONCE during
  initial deploy (see "Setup" below), never automatically on container
  start — re-running it against an already-initialized PKI directory is
  refused by its own guard clause, not just "don't run it twice by hand."
- `bridge-watch.sh` — the `openvpn-bridge` container's entrypoint. Polls
  `requests/` for `<site>.generate` / `<site>.revoke` files, runs the
  corresponding `easyrsa`/`ovpn_getclient` command against the shared PKI
  volume, writes the result to `clients/`. See its own header comment for
  the full request/response contract — the web app's caller-side code
  (a later task, not part of this node's work) must match it exactly.

## Gitignored (this directory, generated at runtime — see `.gitignore`)

- `pki/` is NOT here — it lives in the `openvpn_data` **named Docker
  volume** (`/etc/openvpn` inside both `openvpn-server` and
  `openvpn-bridge`, which share it), never bind-mounted to the host at
  all. This is deliberate: PKI private key material (the CA key, the
  server key, every per-site client key) never touches this git-tracked
  checkout's filesystem, only Docker's own volume storage.
- `requests/` — file-drop request queue, bind-mounted read-write into both
  `openvpn-bridge` (consumes) and (once its caller-side code is built)
  `web` (writes). Contains only empty marker files (`<site>.generate`,
  `<site>.revoke`) — no secrets, but still gitignored since it's
  runtime/operational state, not source.
- `clients/` — bind-mounted read-write into `openvpn-bridge` (writes),
  read-only into `web` once wired up. **Contains real `.ovpn` files with
  embedded private keys** (`ovpn_getclient`'s unified-file output) —
  MUST stay gitignored, this is the one directory in this folder that
  would be a real credential leak if ever committed.
- `ccd/` — client-config-dir, one file per site, for deterministic
  per-client tunnel IPs. Bind-mounted into `openvpn-server` only. No secret
  material, but still operational state generated per-deployment, not
  source. **The filename must exactly match the client cert's CN, which
  must exactly match `GatewaySite.name`** — the server matches this
  directory's filenames against the CN presented at connect time, not
  against any other identifier. Server itself is `10.8.0.1`
  (`ovpn_genconfig`'s own default first server-side address for its
  default `10.8.0.0/24` subnet). Example, for a site named `uae-office`
  getting the tunnel IP this task's plan uses throughout
  (`ccd/uae-office`):
  ```
  ifconfig-push 10.8.0.10 255.255.255.0
  ```

## Setup (one time, during G1 deploy — see the plan's "G1 — HUMAN GATE"
step; NOT run automatically)

```bash
# 1. Generate openvpn.conf with LEGACY-COMPATIBLE settings (see init-pki.sh's
#    own header for exactly why — the Dinstar's embedded OpenVPN client is
#    old firmware and a modern server's defaults will silently fail to
#    handshake against it), then initialize the CA + server cert.
#    Runs INSIDE the container (ovpn_genconfig/ovpn_initpki/easyrsa only
#    exist there), overriding the service's normal `ovpn_run` command for
#    this one-off invocation — VM_PUBLIC_IP must already be set in .env.
#    ovpn_initpki prompts interactively for a CA passphrase; do this at a
#    real terminal, don't pipe a blank one into production.
docker compose run --rm -it openvpn-server /scripts/init-pki.sh

# 2. Bring both services up for real (the daemon + the cert-request bridge).
docker compose up -d openvpn-server openvpn-bridge

# 3. Verify the tun0 interface exists on the HOST (network_mode: host is
#    what makes this possible — see docker-compose.yml's comment on the
#    openvpn-server block for why that's not optional here).
ip addr show tun0
```

Client cert generation/revocation after this point goes through the
`requests`/`clients` file-drop contract documented in `bridge-watch.sh`'s
header — not through this script again.
