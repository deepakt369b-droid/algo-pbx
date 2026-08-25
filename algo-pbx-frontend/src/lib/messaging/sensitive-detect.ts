// Heuristic OTP / verification-code detector for inbound SIM SMS
// (Workstream E). A message classified sensitive has its body withheld from
// every agent-facing API response server-side, behind the admin-approved
// SmsAccessRequest unlock flow.
//
// TUNING BIAS — deliberate and important: false POSITIVES are cheap (an
// agent has to click "Request access" for a message that turned out to be
// harmless) while false NEGATIVES are the actual security failure (an OTP
// leaks straight into an agent's browser with no approval). Every threshold
// below is therefore set generously. Do not "tighten" this to reduce noise
// without re-reading this paragraph.
//
// This is a heuristic, not a guarantee. It is the first of two defences —
// the second being that agents only ever see conversations assigned to
// them at all.

/** Words that, in any language-mixed SMS, signal an authentication code. */
const KEYWORDS = [
  "otp",
  "o.t.p",
  "one time password",
  "one-time password",
  "one time passcode",
  "one-time passcode",
  "verification code",
  "verification pin",
  "verify code",
  "security code",
  "secure code",
  "auth code",
  "authentication code",
  "access code",
  "login code",
  "log-in code",
  "sign in code",
  "sign-in code",
  "confirmation code",
  "activation code",
  "passcode",
  "password reset",
  "reset your password",
  "reset password",
  "two factor",
  "two-factor",
  "2fa",
  "verification",
  "verify",
  "authenticate",
  "do not share",
  "don't share",
  "never share",
  "confidential code",
  "tac ",
  "mtan",
  "transaction code",
  // Common UAE / regional bank + wallet OTP template phrases.
  "your code is",
  "code is",
  "use code",
  "valid for",
  "expires in",
];

/** Phrases that on their own are enough — no numeric code needed nearby.
 * These are near-universal in OTP templates and essentially never appear in
 * ordinary customer conversation. */
const STANDALONE_PHRASES = [
  "do not share this",
  "do not share it with anyone",
  "never share this code",
  "do not disclose",
  "one time password",
  "one-time password",
  "verification code",
  "otp",
];

/** A 4-8 digit run that isn't part of a longer number. Also matches the
 * grouped forms providers use ("123 456", "123-456"). */
const CODE_PATTERN = /(?<![0-9])(?:[0-9]{4,8}|[0-9]{3}[ -][0-9]{3})(?![0-9])/;

/** Alphanumeric codes ("A4F92C", "G-7H2K9") used by some services. */
const ALNUM_CODE_PATTERN = /(?<![A-Za-z0-9])(?:[A-Z]-)?(?=[A-Z0-9]{5,8}(?![A-Za-z0-9]))(?=[^ ]*[0-9])(?=[^ ]*[A-Z])[A-Z0-9]{5,8}(?![A-Za-z0-9])/;

function normalize(body: string): string {
  return body
    .toLowerCase()
    // Collapse the separators OTP templates use to break up keywords, so
    // "O.T.P" / "O T P" / "c-o-d-e" don't slip past a literal match.
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True if this SMS body looks like it carries an authentication secret.
 *
 * Rules (any one is sufficient):
 *  1. Contains a standalone OTP-template phrase.
 *  2. Contains an OTP keyword AND a 4-8 digit code anywhere in the message.
 *  3. Contains an OTP keyword AND an alphanumeric code token.
 *  4. Is a short message (<= 120 chars) that is *mostly* a bare code —
 *     e.g. "483920" or "Your Google code: 483920" — even without keywords.
 */
export function isSensitiveSms(body: string): boolean {
  if (!body) return false;
  const text = normalize(body);
  if (!text) return false;

  // De-spaced/de-punctuated copy, so "o.t.p" and "c o d e" still hit.
  const squashed = text.replace(/[^a-z0-9]/g, "");

  for (const phrase of STANDALONE_PHRASES) {
    if (text.includes(phrase) || squashed.includes(phrase.replace(/[^a-z0-9]/g, ""))) {
      return true;
    }
  }

  const hasKeyword = KEYWORDS.some(
    (k) => text.includes(k) || squashed.includes(k.replace(/[^a-z0-9]/g, ""))
  );
  const hasNumericCode = CODE_PATTERN.test(body);
  const hasAlnumCode = ALNUM_CODE_PATTERN.test(body);

  if (hasKeyword && (hasNumericCode || hasAlnumCode)) return true;

  // Rule 4 — a short message dominated by a digit run. "483920" and
  // "483920 is your code" both qualify; a 6-digit order number buried in a
  // 400-character marketing blast does not.
  if (body.length <= 120 && hasNumericCode) {
    const digits = (body.match(/[0-9]/g) ?? []).length;
    const letters = (body.match(/[A-Za-z]/g) ?? []).length;
    // Either almost nothing but the code, or the code is a big share of a
    // short message.
    if (letters <= 24 || digits / Math.max(body.length, 1) >= 0.2) return true;
  }

  return false;
}

/** The placeholder body an agent sees in place of a withheld message. The
 * real body is NEVER serialized into an agent-facing response; this exists
 * so the client has something to render behind the lock affordance. */
export const SENSITIVE_PLACEHOLDER = null;
