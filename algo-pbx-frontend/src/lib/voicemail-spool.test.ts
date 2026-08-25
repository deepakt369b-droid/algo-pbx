import { describe, expect, it } from "vitest";
import { canAccessMailbox, parseVoicemailId, parseVoicemailMessageMetadata } from "./voicemail-spool";

const SAMPLE = `[message]
; Message Information
;
origmailbox=1001
context=default
macrocontext=
exten=1001
rdnis=unknown
priority=2
callerchan=PJSIP/1002-00000001
callerid="John Doe" <1002>
origdate=Mon Aug 24 10:00:00 2026
origtime=1753344000
category=
duration=15
`;

describe("parseVoicemailMessageMetadata", () => {
  it("extracts callerid, origtime, duration, and context from a well-formed sidecar", () => {
    const result = parseVoicemailMessageMetadata(SAMPLE);
    expect(result).toEqual({
      callerId: '"John Doe" <1002>',
      origtime: 1753344000,
      durationSec: 15,
      context: "default",
    });
  });

  it("returns nulls for missing fields rather than throwing", () => {
    const result = parseVoicemailMessageMetadata("[message]\nexten=1001\n");
    expect(result).toEqual({ callerId: null, origtime: null, durationSec: null, context: null });
  });

  it("tolerates an empty file", () => {
    expect(parseVoicemailMessageMetadata("")).toEqual({
      callerId: null,
      origtime: null,
      durationSec: null,
      context: null,
    });
  });

  it("ignores comment lines and the section header", () => {
    const result = parseVoicemailMessageMetadata("[message]\n; a comment\norigtime=100\n");
    expect(result.origtime).toBe(100);
  });

  it("treats a non-numeric origtime/duration as absent rather than NaN", () => {
    const result = parseVoicemailMessageMetadata("origtime=not-a-number\nduration=also-not\n");
    expect(result.origtime).toBeNull();
    expect(result.durationSec).toBeNull();
  });
});

describe("canAccessMailbox", () => {
  it("allows ADMIN and SUPERVISOR regardless of ownership", () => {
    expect(canAccessMailbox({ role: "ADMIN", callerExtension: "9999", mailbox: "1001" })).toBe(true);
    expect(canAccessMailbox({ role: "SUPERVISOR", callerExtension: "9999", mailbox: "1001" })).toBe(true);
  });

  it("allows an AGENT to access their own mailbox", () => {
    expect(canAccessMailbox({ role: "AGENT", callerExtension: "1001", mailbox: "1001" })).toBe(true);
  });

  it("denies an AGENT accessing someone else's mailbox", () => {
    expect(canAccessMailbox({ role: "AGENT", callerExtension: "1002", mailbox: "1001" })).toBe(false);
  });

  it("denies an AGENT with no linked extension, even against a mailbox with a matching-looking null", () => {
    expect(canAccessMailbox({ role: "AGENT", callerExtension: null, mailbox: "1001" })).toBe(false);
  });
});

describe("parseVoicemailId", () => {
  it("splits a well-formed id into mailbox and message base", () => {
    expect(parseVoicemailId("1001-msg0000")).toEqual({ mailbox: "1001", msgBase: "msg0000" });
  });

  it("rejects an id with a path-traversal attempt", () => {
    expect(parseVoicemailId("../../etc/passwd-msg0000")).toBeNull();
  });

  it("rejects an id whose message part isn't msgNNN", () => {
    expect(parseVoicemailId("1001-notamessage")).toBeNull();
  });

  it("rejects an id with no separator", () => {
    expect(parseVoicemailId("1001msg0000")).toBeNull();
  });
});
