import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptSetting, encryptSetting, SettingsEncryptionError } from "./crypto";

beforeEach(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

describe("encryptSetting / decryptSetting", () => {
  it("round-trips a plaintext value", () => {
    const stored = encryptSetting("re_live_abc123");
    expect(decryptSetting(stored)).toBe("re_live_abc123");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSetting("same-value");
    const b = encryptSetting("same-value");
    expect(a).not.toBe(b);
    expect(decryptSetting(a)).toBe("same-value");
    expect(decryptSetting(b)).toBe("same-value");
  });

  it("rejects tampered ciphertext rather than returning garbage plaintext", () => {
    const stored = encryptSetting("secret-value");
    const [iv, tag, ciphertext] = stored.split(":");
    const tamperedCiphertext = Buffer.from(ciphertext, "base64");
    tamperedCiphertext[0] ^= 0xff;
    const tampered = [iv, tag, tamperedCiphertext.toString("base64")].join(":");
    expect(() => decryptSetting(tampered)).toThrow(SettingsEncryptionError);
  });

  it("rejects decryption under a different key", () => {
    const stored = encryptSetting("secret-value");
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    expect(() => decryptSetting(stored)).toThrow(SettingsEncryptionError);
  });

  it("throws a clear error when no key is configured", () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(() => encryptSetting("x")).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });

  it("throws when the key is the wrong length", () => {
    process.env.SETTINGS_ENCRYPTION_KEY = "tooshort";
    expect(() => encryptSetting("x")).toThrow(/32 bytes/);
  });

  it("rejects a malformed stored value", () => {
    expect(() => decryptSetting("not-the-right-format")).toThrow(SettingsEncryptionError);
  });
});
