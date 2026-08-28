import { describe, expect, it } from "vitest";
import { DinstarApplySchema } from "./dinstar-apply-schema";

const basePayload = { host: "192.168.11.1", username: "admin", password: "secret" };

describe("DinstarApplySchema", () => {
  it("defaults sipPort to 5060 when omitted", () => {
    const parsed = DinstarApplySchema.parse(basePayload);
    expect(parsed.sipPort).toBe("5060");
  });

  it("accepts a non-default sipPort (e.g. the UC2000's own local port moved to avoid clashing with Asterisk's 5060)", () => {
    const parsed = DinstarApplySchema.parse({ ...basePayload, sipPort: "5061" });
    expect(parsed.sipPort).toBe("5061");
  });

  it("rejects a non-numeric sipPort", () => {
    const result = DinstarApplySchema.safeParse({ ...basePayload, sipPort: "abcd" });
    expect(result.success).toBe(false);
  });

  it("rejects a sipPort outside the 2-5 digit range", () => {
    expect(DinstarApplySchema.safeParse({ ...basePayload, sipPort: "1" }).success).toBe(false);
    expect(DinstarApplySchema.safeParse({ ...basePayload, sipPort: "123456" }).success).toBe(false);
  });

  it("defaults writeAsteriskConfig to false when omitted", () => {
    const parsed = DinstarApplySchema.parse(basePayload);
    expect(parsed.writeAsteriskConfig).toBe(false);
  });

  it("still requires host, username, password", () => {
    expect(DinstarApplySchema.safeParse({ username: "admin", password: "x" }).success).toBe(false);
    expect(DinstarApplySchema.safeParse({ host: "1.2.3.4", password: "x" }).success).toBe(false);
    expect(DinstarApplySchema.safeParse({ host: "1.2.3.4", username: "admin" }).success).toBe(false);
  });
});
