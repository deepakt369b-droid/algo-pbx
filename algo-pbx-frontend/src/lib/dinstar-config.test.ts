import { describe, expect, it } from "vitest";
import { renderDinstarConf } from "./dinstar-config";

describe("renderDinstarConf", () => {
  it("renders the aor and identify stanzas with the given IP", () => {
    const output = renderDinstarConf("192.168.1.77");
    expect(output).toContain("[dinstar-aor]");
    expect(output).toContain("contact=sip:192.168.1.77:5060");
    expect(output).toContain("[dinstar-identify]");
    expect(output).toContain("endpoint=dinstar-trunk");
    expect(output).toContain("match=192.168.1.77");
  });

  it("rejects an IP containing a bracket or CRLF (config injection)", () => {
    expect(() => renderDinstarConf("192.168.1.1]\r\n[malicious]")).toThrow(/unsafe character/);
  });
});
