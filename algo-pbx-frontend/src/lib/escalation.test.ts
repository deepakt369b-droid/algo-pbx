import { describe, expect, it } from "vitest";
import { classifyDialEnd } from "./escalation";

describe("classifyDialEnd", () => {
  it("maps ANSWER to ANSWERED", () => {
    expect(classifyDialEnd("ANSWER")).toBe("ANSWERED");
  });
  it("maps BUSY to BUSY", () => {
    expect(classifyDialEnd("BUSY")).toBe("BUSY");
  });
  it("maps NOANSWER and CANCEL to NO_ANSWER", () => {
    expect(classifyDialEnd("NOANSWER")).toBe("NO_ANSWER");
    expect(classifyDialEnd("CANCEL")).toBe("NO_ANSWER");
  });
  it("maps CONGESTION and CHANUNAVAIL to FAILED", () => {
    expect(classifyDialEnd("CONGESTION")).toBe("FAILED");
    expect(classifyDialEnd("CHANUNAVAIL")).toBe("FAILED");
  });
  it("maps an unrecognized or missing status to UNKNOWN", () => {
    expect(classifyDialEnd("SOMETHING_NEW")).toBe("UNKNOWN");
    expect(classifyDialEnd(undefined)).toBe("UNKNOWN");
  });
});
