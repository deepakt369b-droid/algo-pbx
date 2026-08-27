// Renders mailbox lines for pbx_configs/voicemail_dynamic.conf — Phase E's
// voicemail equivalent of src/lib/pjsip-config.ts's renderPjsipConf(),
// generated from the Extension table alongside pjsip_dynamic.conf and
// reloaded together (see src/lib/pjsip-provision.ts's regeneration flow).
//
// Asterisk voicemail.conf mailbox line format:
//   <mailbox> => <pin>,<Name>[,<email>[,<pager_email>[,<options>]]]
// (confidence: high — this is the long-standing, stable voicemail.conf
// format, unlike some of the AMI event field names elsewhere in this repo
// that needed live-verification caveats).

export interface VoicemailEntry {
  number: string;
  pin: string;
  name: string | null;
  email?: string;
}

const BANNER = `; GENERATED FILE — DO NOT HAND-EDIT.
; Rendered by src/lib/voicemail-config.ts from the Extension table in
; Postgres, alongside pjsip_dynamic.conf. Hand edits will be silently
; overwritten the next time an extension is created, updated, or removed.
; Static voicemail.conf settings ([general]) live in voicemail.conf itself,
; which #includes this file inside its [default] context.
`;

// This output is written directly into a file Asterisk parses. A comma
// would silently shift which field is which (pin/name/email); a bracket or
// newline could inject a new voicemail.conf section.
//
// `number`, `pin` and `email` are system-generated / format-validated
// elsewhere, so an unsafe char there is a real bug worth throwing on.
// `name`, though, is agent-supplied free text (POST /api/register) that a
// legitimate value — "Smith, John" — can contain. Loop B4: throwing for
// the WHOLE batch there let any one agent permanently break voicemail
// regeneration org-wide, reported only as a vague "reloading Asterisk
// failed". Sanitize `name` per-entry instead of aborting.
const UNSAFE_CHARS = /[[\],\r\n]/;

function assertSafe(value: string, field: string): void {
  if (UNSAFE_CHARS.test(value)) {
    throw new Error(`renderVoicemailConf: unsafe character in ${field} (commas/brackets/newlines not allowed): ${value}`);
  }
}

const UNSAFE_CHARS_G = /[[\],\r\n]/g;
function sanitizeName(value: string): string {
  // Strip every char that would break the line; collapse whitespace.
  return value.replace(UNSAFE_CHARS_G, " ").replace(/\s+/g, " ").trim();
}

export function renderVoicemailConf(entries: VoicemailEntry[]): string {
  const lines = entries.map((entry) => {
    assertSafe(entry.number, "number");
    assertSafe(entry.pin, "pin");
    const name = sanitizeName(entry.name ?? entry.number) || entry.number;
    const fields = [entry.pin, name];
    if (entry.email) {
      assertSafe(entry.email, "email");
      fields.push(entry.email);
    }
    return `${entry.number} => ${fields.join(",")}`;
  });

  return [BANNER, ...lines].join("\n");
}
