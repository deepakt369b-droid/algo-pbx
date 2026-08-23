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

// Same defense-in-depth rationale as pjsip-config.ts's assertSafe: this
// output is written directly into a file Asterisk parses. A comma would
// silently shift which field is which (pin/name/email); a bracket or
// newline could inject a new voicemail.conf section.
const UNSAFE_CHARS = /[[\],\r\n]/;

function assertSafe(value: string, field: string): void {
  if (UNSAFE_CHARS.test(value)) {
    throw new Error(`renderVoicemailConf: unsafe character in ${field} (commas/brackets/newlines not allowed): ${value}`);
  }
}

export function renderVoicemailConf(entries: VoicemailEntry[]): string {
  const lines = entries.map((entry) => {
    assertSafe(entry.number, "number");
    assertSafe(entry.pin, "pin");
    const name = entry.name ?? entry.number;
    assertSafe(name, "name");
    const fields = [entry.pin, name];
    if (entry.email) {
      assertSafe(entry.email, "email");
      fields.push(entry.email);
    }
    return `${entry.number} => ${fields.join(",")}`;
  });

  return [BANNER, ...lines].join("\n");
}
