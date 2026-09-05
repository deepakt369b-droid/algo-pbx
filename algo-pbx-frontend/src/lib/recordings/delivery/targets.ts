import { z } from "zod";
import { decryptSetting, encryptSetting } from "@/lib/settings/crypto";

// Target configuration: parsing, validation, and the encryption boundary.
//
// Credentials never sit in the database in plaintext. They are encrypted with
// the same AES-256-GCM helper the settings store uses (one key, one rotation
// story, one audited implementation — a second bespoke crypto path here would
// be a liability, not defence in depth).
//
// They are also never returned to a client. `redact()` is what the console
// renders, and it exists so that no route has to remember to strip fields.

export const S3ConfigSchema = z.object({
  kind: z.literal("CUSTOMER_S3"),
  bucket: z.string().min(1),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  /** For S3-compatible storage (Cloudflare R2, MinIO, Wasabi). */
  endpoint: z.string().url().optional(),
  prefix: z.string().default(""),
});

export const SftpConfigSchema = z.object({
  kind: z.literal("CUSTOMER_SFTP"),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535).default(22),
  username: z.string().min(1),
  // Exactly one of these. A password AND a key is ambiguous about which
  // actually authenticated, which matters when diagnosing a failure.
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  remotePath: z.string().default("/"),
});

export const TargetConfigSchema = z.discriminatedUnion("kind", [S3ConfigSchema, SftpConfigSchema]);

export type S3Config = z.infer<typeof S3ConfigSchema>;
export type SftpConfig = z.infer<typeof SftpConfigSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

export function encodeTargetConfig(config: TargetConfig): string {
  return encryptSetting(JSON.stringify(config));
}

export function decodeTargetConfig(ciphertext: string): TargetConfig {
  return TargetConfigSchema.parse(JSON.parse(decryptSetting(ciphertext)));
}

/** What the console is allowed to see. Never the credential itself — a
 * "reveal" affordance on a stored secret is an exfiltration path with a
 * helpful label. */
export function redact(config: TargetConfig): Record<string, string | number | boolean> {
  if (config.kind === "CUSTOMER_S3") {
    return {
      kind: config.kind,
      bucket: config.bucket,
      region: config.region,
      endpoint: config.endpoint ?? "aws",
      prefix: config.prefix,
      accessKeyId: `••••${config.accessKeyId.slice(-4)}`,
      secretConfigured: true,
    };
  }
  return {
    kind: config.kind,
    host: config.host,
    port: config.port,
    username: config.username,
    remotePath: config.remotePath,
    auth: config.privateKey ? "private key" : "password",
  };
}

/** Validation beyond the schema's shape — the combinations that parse but
 * cannot work. */
export function validateTargetConfig(config: TargetConfig): { ok: true } | { ok: false; error: string } {
  if (config.kind === "CUSTOMER_SFTP") {
    if (!config.password && !config.privateKey) {
      return { ok: false, error: "SFTP needs either a password or a private key." };
    }
    if (config.password && config.privateKey) {
      return {
        ok: false,
        error:
          "Provide either a password or a private key, not both — otherwise a failure cannot be attributed to the right credential.",
      };
    }
  }
  return { ok: true };
}
