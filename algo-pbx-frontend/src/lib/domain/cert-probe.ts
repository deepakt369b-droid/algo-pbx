// Probes an actual TLS handshake and reads the peer certificate — `fetch`
// cannot expose this (no API for the negotiated cert), so this uses
// node:tls directly. Two distinct callers use this:
//   - an INTERNAL probe (host: "caddy", the service name on the `algo-net`
//     bridge network Caddy already sits on) answers "did Caddy actually
//     obtain and is it serving a real cert for this domain" — independent
//     of public DNS/reachability, so it still works while the A record
//     points at a private LAN address.
//   - an EXTERNAL probe (host: the real domain) answers "is the public
//     internet path actually open" — best-effort; self-probes and NAT
//     hairpin behavior are inconsistent, so the wizard must not treat a
//     failure here as conclusive.
import tls from "node:tls";

export interface CertProbeResult {
  ok: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: string;
  validTo?: string;
  error?: string;
}

export function probeTls(host: string, servername: string, port = 443, timeoutMs = 6000): Promise<CertProbeResult> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host, port, servername, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.subject) {
          resolve({ ok: false, error: "Connected, but no certificate was presented." });
          return;
        }
        const asString = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
        resolve({
          ok: true,
          issuer: asString(cert.issuer?.O) ?? asString(cert.issuer?.CN),
          subject: asString(cert.subject?.CN),
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
        });
      }
    );
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: `Timed out after ${timeoutMs}ms connecting to ${host}:${port}.` });
    });
    socket.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : "Connection failed." });
    });
  });
}
