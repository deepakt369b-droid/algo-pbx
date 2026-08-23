import { describe, expect, it } from "vitest";
import { e164ToWaId, isGroupOrBroadcastJid, waIdToE164 } from "./wa-id";

describe("waIdToE164", () => {
  it("prefixes '+' onto a bare wa_id before parsing", () => {
    expect(waIdToE164("971501234567")).toBe("+971501234567");
  });

  it("does NOT reinterpret a non-UAE wa_id as a UAE number", () => {
    // The whole reason this helper exists: "14155552671" parsed with the
    // default country AE is not the US number the wa_id actually means.
    expect(waIdToE164("14155552671")).toBe("+14155552671");
  });

  it("strips an @c.us JID suffix", () => {
    expect(waIdToE164("971501234567@c.us")).toBe("+971501234567");
  });

  it("strips an @s.whatsapp.net JID suffix", () => {
    expect(waIdToE164("971501234567@s.whatsapp.net")).toBe("+971501234567");
  });

  it("strips a multi-device :device agent suffix", () => {
    expect(waIdToE164("971501234567:12@s.whatsapp.net")).toBe("+971501234567");
  });

  it("rejects group JIDs", () => {
    expect(waIdToE164("971501234567-1600000000@g.us")).toBeNull();
  });

  it("rejects status/broadcast JIDs", () => {
    expect(waIdToE164("status@broadcast")).toBeNull();
  });

  it("rejects empty, non-numeric and junk input", () => {
    expect(waIdToE164("")).toBeNull();
    expect(waIdToE164("   ")).toBeNull();
    expect(waIdToE164("not-a-number@c.us")).toBeNull();
    expect(waIdToE164("+971501234567abc")).toBeNull();
  });

  it("returns null for a numerically-shaped but invalid number", () => {
    expect(waIdToE164("000000")).toBeNull();
  });
});

describe("isGroupOrBroadcastJid", () => {
  it("flags groups and broadcasts, not individuals", () => {
    expect(isGroupOrBroadcastJid("123-456@g.us")).toBe(true);
    expect(isGroupOrBroadcastJid("status@broadcast")).toBe(true);
    expect(isGroupOrBroadcastJid("971501234567@c.us")).toBe(false);
  });
});

describe("e164ToWaId", () => {
  it("strips the leading '+'", () => {
    expect(e164ToWaId("+971501234567")).toBe("971501234567");
  });

  it("rejects anything not already E.164-with-plus", () => {
    expect(e164ToWaId("971501234567")).toBeNull();
    expect(e164ToWaId("050 123 4567")).toBeNull();
    expect(e164ToWaId("")).toBeNull();
  });
});
