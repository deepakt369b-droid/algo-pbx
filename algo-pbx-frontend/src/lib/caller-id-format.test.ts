import { describe, expect, it } from "vitest";
import { formatUnknownCaller } from "./caller-id-format";

describe("formatUnknownCaller", () => {
  it("returns bare 'Unknown' for no caller id at all", () => {
    expect(formatUnknownCaller(null)).toBe("Unknown");
    expect(formatUnknownCaller(undefined)).toBe("Unknown");
    expect(formatUnknownCaller("")).toBe("Unknown");
  });

  it("formats a valid UAE mobile with country and type", () => {
    expect(formatUnknownCaller("+971501234567")).toBe("Unknown — +971501234567 (United Arab Emirates · Mobile)");
  });

  it("falls back to the raw string when it can't be parsed as a phone number", () => {
    expect(formatUnknownCaller("sip:abc@10.0.0.1")).toBe("Unknown — sip:abc@10.0.0.1");
  });

  it("still labels a bare national-format number using the AE default", () => {
    expect(formatUnknownCaller("0501234567")).toBe("Unknown — +971501234567 (United Arab Emirates · Mobile)");
  });
});
