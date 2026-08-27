import { describe, expect, it } from "vitest";
import { renderVoicemailConf } from "./voicemail-config";

describe("renderVoicemailConf", () => {
  it("renders a mailbox line with pin and name", () => {
    const output = renderVoicemailConf([{ number: "1001", pin: "4821", name: "Agent One" }]);
    expect(output).toContain("1001 => 4821,Agent One");
  });

  it("falls back to the extension number as the display name when no name is given", () => {
    const output = renderVoicemailConf([{ number: "2001", pin: "9012", name: null }]);
    expect(output).toContain("2001 => 9012,2001");
  });

  it("includes an email address when given", () => {
    const output = renderVoicemailConf([{ number: "1001", pin: "4821", name: "Agent One", email: "agent1@example.com" }]);
    expect(output).toContain("1001 => 4821,Agent One,agent1@example.com");
  });

  it("renders multiple mailboxes as independent lines in order", () => {
    const output = renderVoicemailConf([
      { number: "1001", pin: "1111", name: "A" },
      { number: "1002", pin: "2222", name: "B" },
    ]);
    const lines = output.split("\n").filter((l) => l.startsWith("1001") || l.startsWith("1002"));
    expect(lines).toEqual(["1001 => 1111,A", "1002 => 2222,B"]);
  });

  it("renders an empty array as just the banner, no mailbox lines", () => {
    const output = renderVoicemailConf([]);
    expect(output).not.toMatch(/=>/);
  });

  it("wraps the output with a DO NOT HAND-EDIT banner", () => {
    const output = renderVoicemailConf([{ number: "1001", pin: "1111", name: "A" }]);
    expect(output).toMatch(/generated file/i);
    expect(output).toMatch(/do not hand-edit/i);
  });

  it("throws if number, pin or email contains a character that could break the mailbox line", () => {
    expect(() => renderVoicemailConf([{ number: "1001", pin: "11,11", name: "A" }])).toThrow();
    expect(() => renderVoicemailConf([{ number: "1001", pin: "1111", name: "A", email: "x,y@example.com" }])).toThrow();
  });

  it("sanitizes an agent-supplied name rather than aborting the whole batch (Loop B4)", () => {
    const output = renderVoicemailConf([
      { number: "1001", pin: "1111", name: "Smith, John" },
      { number: "1002", pin: "2222", name: "B\n[evil]" },
    ]);
    const lines = output.split("\n").filter((l) => l.startsWith("1001") || l.startsWith("1002"));
    expect(lines).toEqual(["1001 => 1111,Smith John", "1002 => 2222,B evil"]);
    expect(output).not.toMatch(/\[evil\]/);
  });
});
