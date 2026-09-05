import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { X509Certificate } from "node:crypto";

// CA/PKI inventory for platform settings — READ-ONLY, and structurally
// incapable of signing anything.
//
// The CA private key is passphrase-protected and lives only in the OpenVPN
// container's volume. This module reads issued certificates and the CRL to
// report expiry dates; it never reads a key, never accepts a passphrase, and
// exposes no signing action. That is not caution, it is the design: signing
// stays in the CA-signing-flow-v2 work, and a console that could sign would
// have to hold the passphrase somewhere.

const PKI_DIR = process.env.OPENVPN_PKI_DIR || "/app/openvpn-pki";

export interface CertInfo {
  commonName: string;
  validFrom: string | null;
  validTo: string | null;
  daysUntilExpiry: number | null;
  expired: boolean;
  expiringSoon: boolean;
}

export interface PkiStatus {
  available: boolean;
  /** Why the inventory could not be read, when it could not. */
  unavailableReason?: string;
  certs: CertInfo[];
  crl: { present: boolean; lastRegeneratedAt: string | null; sizeBytes: number | null };
}

const EXPIRY_WARNING_DAYS = 30;

function describe(cert: X509Certificate, commonName: string): CertInfo {
  const to = new Date(cert.validTo);
  const valid = !Number.isNaN(to.getTime());
  const days = valid ? Math.floor((to.getTime() - Date.now()) / 86_400_000) : null;

  return {
    commonName,
    validFrom: Number.isNaN(new Date(cert.validFrom).getTime()) ? null : new Date(cert.validFrom).toISOString(),
    validTo: valid ? to.toISOString() : null,
    daysUntilExpiry: days,
    expired: days !== null && days < 0,
    expiringSoon: days !== null && days >= 0 && days <= EXPIRY_WARNING_DAYS,
  };
}

export async function readPkiStatus(): Promise<PkiStatus> {
  const issuedDir = path.join(PKI_DIR, "issued");
  const certs: CertInfo[] = [];

  let available = true;
  let unavailableReason: string | undefined;

  try {
    const files = await readdir(issuedDir);
    for (const file of files.filter((f) => f.endsWith(".crt"))) {
      try {
        const pem = await readFile(path.join(issuedDir, file), "utf8");
        certs.push(describe(new X509Certificate(pem), file.replace(/\.crt$/, "")));
      } catch {
        // One unparseable certificate must not hide the rest of the
        // inventory — report it as a row with no dates rather than dropping
        // it, since a cert we cannot read is itself worth seeing.
        certs.push({
          commonName: file.replace(/\.crt$/, ""),
          validFrom: null,
          validTo: null,
          daysUntilExpiry: null,
          expired: false,
          expiringSoon: false,
        });
      }
    }
  } catch (err) {
    available = false;
    unavailableReason =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `No PKI directory at ${PKI_DIR}. The web container does not mount the OpenVPN PKI volume in this deployment.`
        : err instanceof Error
          ? err.message
          : "Could not read the PKI directory.";
  }

  let crl: PkiStatus["crl"] = { present: false, lastRegeneratedAt: null, sizeBytes: null };
  try {
    const s = await stat(path.join(PKI_DIR, "crl.pem"));
    crl = { present: true, lastRegeneratedAt: s.mtime.toISOString(), sizeBytes: s.size };
  } catch {
    // Absent CRL is meaningful, not an error: it means revocation has never
    // been exercised on this deployment.
  }

  certs.sort((a, b) => (a.daysUntilExpiry ?? 1e9) - (b.daysUntilExpiry ?? 1e9));
  return { available, unavailableReason, certs, crl };
}
