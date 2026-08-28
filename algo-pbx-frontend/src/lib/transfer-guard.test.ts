import { describe, expect, it } from "vitest";
import { evaluateTransferPermission, isInternalExtension } from "./transfer-guard";

describe("isInternalExtension", () => {
  it("matches a 4-digit extension starting with 1", () => {
    expect(isInternalExtension("1001")).toBe(true);
  });

  it("matches a 4-digit extension starting with 2", () => {
    expect(isInternalExtension("2001")).toBe(true);
  });

  it("rejects an external-looking UAE mobile number", () => {
    expect(isInternalExtension("0501234567")).toBe(false);
  });

  it("rejects an E.164 number", () => {
    expect(isInternalExtension("+971501234567")).toBe(false);
  });

  it("rejects a 3-digit number (too short to be _1XXX/_2XXX)", () => {
    expect(isInternalExtension("100")).toBe(false);
  });

  it("rejects a 5-digit number starting with 1", () => {
    expect(isInternalExtension("10001")).toBe(false);
  });

  it("rejects a 4-digit number starting with 3", () => {
    expect(isInternalExtension("3001")).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isInternalExtension(" 1001 ")).toBe(true);
  });
});

describe("evaluateTransferPermission", () => {
  it("blocks a trunk call transferred to an external number", () => {
    const result = evaluateTransferPermission({ currentCallOrigin: "trunk", target: "0501234567" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/only has one connection/i);
  });

  it("allows a trunk call transferred to a known internal extension", () => {
    const result = evaluateTransferPermission({ currentCallOrigin: "trunk", target: "2001" });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("allows an internal call transferred to an external number — unaffected by this guard", () => {
    const result = evaluateTransferPermission({ currentCallOrigin: "internal", target: "0501234567" });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("allows an internal call transferred to another internal extension", () => {
    const result = evaluateTransferPermission({ currentCallOrigin: "internal", target: "1002" });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("fails open when the current call's origin is unknown", () => {
    const result = evaluateTransferPermission({ currentCallOrigin: null, target: "0501234567" });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });
});
