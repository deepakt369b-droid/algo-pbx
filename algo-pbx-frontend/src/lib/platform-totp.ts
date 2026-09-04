// TOTP (RFC 6238) for the platform plane — see plan §"Platform auth
// requirements": "TOTP 2FA mandatory for every PlatformUser from day one".
//
// Library choice: `otpauth`. package.json had none of otplib/speakeasy/
// otpauth already (grepped before adding). otpauth was picked over the
// alternatives because it's pure JS with zero native deps, works unchanged
// in both the Node runtime (platform-auth.ts) and, if ever needed, the Edge
// runtime (platform-auth.config.ts) — matching this repo's existing
// edge/node split convention for the tenant auth stack. No QR-image
// rendering library is added: totpUri() returns the raw `otpauth://` URI as
// text (per the task brief, that's sufficient — an authenticator app's
// manual-entry field accepts it directly, and the owner-console setup
// script prints it for the operator to type in, no image needed).
import * as OTPAuth from "otpauth";

const ISSUER = "Algo PBX Platform";
const DIGITS = 6;
const PERIOD = 30;

/** Fresh random base32 secret for a new PlatformUser's first-time setup. */
export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

/** `otpauth://totp/...` URI, scannable by any RFC-6238 authenticator app
 * (Google Authenticator, 1Password, Authy, ...) or typeable via its
 * `secret=` query param for manual entry. */
export function totpUri(email: string, base32Secret: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  });
  return totp.toString();
}

/** True if `code` is a valid current (or one-step-adjacent, for clock
 * drift) TOTP code for this secret. `window: 1` accepts the previous and
 * next 30s step in addition to the current one — standard TOTP tolerance,
 * matches every mainstream authenticator app's own leniency. */
export function verifyTotpCode(base32Secret: string, code: string): boolean {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  });
  return totp.validate({ token: trimmed, window: 1 }) !== null;
}
