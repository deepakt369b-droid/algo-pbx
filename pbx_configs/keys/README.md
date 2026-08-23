# DTLS-SRTP media certificates

This directory is bind-mounted read-only to `/etc/asterisk/keys` (see
`docker-compose.yml`'s `asterisk` service) and must contain:

- `asterisk.crt` / `asterisk.key` — the DTLS-SRTP media certificate/key
  referenced by every generated PJSIP endpoint's `dtls_cert_file` /
  `dtls_private_key_file` (see `src/lib/pjsip-config.ts`). **Self-signed is
  fine here** — `dtls_verify=fingerprint` on each endpoint validates the SDP
  fingerprint exchanged in signaling, not the certificate's chain of trust.
  Generate with:

  ```bash
  ast_tls_cert -C ${VM_PUBLIC_DOMAIN} -O "Algo IT" -d ./pbx_configs/keys
  ```

  or with plain openssl if `ast_tls_cert` isn't available on the host:

  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout pbx_configs/keys/asterisk.key \
    -out pbx_configs/keys/asterisk.crt \
    -subj "/CN=${VM_PUBLIC_DOMAIN}"
  ```

- `fullchain.pem` / `privkey.pem` — the **real, CA-issued** TLS cert for
  `VM_PUBLIC_DOMAIN`, used by `http.conf`'s `tlscertfile`/`tlsprivatekey` for
  the WSS signaling transport on 8089. Unlike the DTLS pair above, this one
  is NOT allowed to be self-signed — browsers refuse to open a `wss://`
  WebSocket to an untrusted cert with no user-facing "accept the risk"
  affordance the way they do for a plain HTTPS page. Use the same
  certificate Nginx/Let's Encrypt already issues for the domain (copy or
  symlink `fullchain.pem`/`privkey.pem` from `/etc/letsencrypt/live/<domain>/`
  here, and re-copy on renewal, or point these two filenames at that path
  directly via bind mount instead of copying).

None of these five files are committed to git — this directory is listed in
`.gitignore`. Generate them on the deployment host, not in source control.
