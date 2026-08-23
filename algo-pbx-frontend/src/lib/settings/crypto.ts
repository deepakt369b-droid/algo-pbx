import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM encryption for AppSetting.valueEncrypted. Every runtime
// setting is encrypted uniformly (not just the "obviously secret" ones —
// see AppSetting's schema comment for why that per-key judgement call is
// worth avoiding).
//
// Stored format: "<12-byte iv>:<16-byte auth tag>:<ciphertext>", each
// segment base64. GCM's auth tag is what makes this fail CLOSED on
// tampering — decrypt() throws rather than returning attacker-chosen
// plaintext if the ciphertext, iv, or tag don't match what was encrypted
// under this exact key.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export class SettingsEncryptionError extends Error {}

function getKey(): Buffer {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!hex) {
    throw new SettingsEncryptionError(
      "SETTINGS_ENCRYPTION_KEY is not configured. Generate one with `openssl rand -hex 32` and set it before using runtime settings."
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new SettingsEncryptionError("SETTINGS_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters).");
  }
  return key;
}

export function encryptSetting(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSetting(stored: string): string {
  const key = getKey();
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new SettingsEncryptionError("Stored setting value is not in the expected iv:tag:ciphertext format.");
  }
  const [ivB64, tagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // setAuthTag verification failure lands here — tampered ciphertext,
    // wrong key, or corrupted row. Never surface the underlying crypto
    // error detail; the fact of failure is all a caller needs.
    throw new SettingsEncryptionError("Failed to decrypt setting value — wrong key or corrupted data.");
  }
}
