import { describe, expect, it, vi, beforeEach } from "vitest";
import { authHeaders, authQueryParams, DinstarSmsProvider } from "./dinstar-sms-provider";

// Settings-backed config (DINSTAR_LAN_IP / DINSTAR_SMS_USERNAME / PASSWORD /
// DINSTAR_AUTH_STYLE) is read through @/lib/settings/service's getSetting(),
// which itself hits the DB — mocked here so these stay pure unit tests.
const settingsStore = new Map<string, string | undefined>();
vi.mock("@/lib/settings/service", () => ({
  getSetting: vi.fn(async (key: string) => settingsStore.get(key)),
}));

function setSettings(values: Record<string, string | undefined>) {
  settingsStore.clear();
  for (const [k, v] of Object.entries(values)) settingsStore.set(k, v);
}

// ----------------------------------------------------------------------------
// FIXTURE PROVENANCE: live hardware (a real UC2000 at 192.168.11.1) was
// reachable and probed on 2026-08-28, but only unauthenticated — no valid
// DINSTAR_SMS_USERNAME/PASSWORD were available (only the `change-me`
// placeholder in .env.example), and credential-guessing was intentionally
// not attempted. That confirmed transport-level facts (plain HTTP always
// 302-redirects to HTTPS on a self-signed cert; see dinstar-sms-provider.ts's
// file header for detail) but never produced an authenticated JSON response
// body to capture. The goip_get_sms.html / goip_get_status.html payload
// shapes below are therefore BEST-EFFORT fixtures constructed from Dinstar's
// publicly documented GoIP-compatible HTTP API conventions (the
// `incoming_sms_id` / `number` / `timestamp` / `text` field names, and the
// `root.sms[]` array wrapper), NOT a real captured device response. They are
// deliberately varied per-test to also exercise parseInbound()'s documented
// tolerance for alternate key names (`sender`/`content`/`time`) some
// GoIP-family firmware revisions use instead.
// ----------------------------------------------------------------------------

describe("parseInbound", () => {
  const provider = new DinstarSmsProvider();

  it("parses a normal inbound SMS list (root.sms[], primary key names)", () => {
    const payload = {
      sms: [
        {
          incoming_sms_id: 42,
          port: 0,
          number: "971501234567",
          timestamp: "2026-08-28 10:15:00",
          text: "Hello from the gateway",
        },
        {
          incoming_sms_id: 43,
          port: 2,
          number: "+971559876543",
          timestamp: "2026-08-28 10:16:30",
          text: "Second message",
        },
      ],
    };

    const events = provider.parseInbound(payload);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      channel: "SMS",
      fromE164: "+971501234567",
      body: "Hello from the gateway",
      providerMessageId: "42",
      // 1-indexed hardware port numbering: api port 0 -> simPort "1".
      instanceRef: "1",
    });
    expect(events[0].timestamp).toBeInstanceOf(Date);
    expect(events[0].timestamp?.toISOString()).toBe(new Date("2026-08-28T10:15:00").toISOString());

    expect(events[1]).toMatchObject({
      fromE164: "+971559876543",
      body: "Second message",
      providerMessageId: "43",
      // api port 2 -> simPort "3".
      instanceRef: "3",
    });
  });

  it("parses the alternate firmware key names (sender/content/time) via root.result[]", () => {
    const payload = {
      result: [
        {
          port: 1,
          sender: "971501234567",
          content: "Alternate-shape message",
          time: "2026-08-28 11:00:00",
        },
      ],
    };

    const events = provider.parseInbound(payload);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromE164: "+971501234567",
      body: "Alternate-shape message",
      instanceRef: "2",
      // No incoming_sms_id present in this shape -> providerMessageId null.
      providerMessageId: null,
    });
  });

  it("parses a bare top-level array response", () => {
    const payload = [
      { incoming_sms_id: 1, port: 0, number: "971501234567", text: "bare array", timestamp: "2026-08-28 09:00:00" },
    ];

    const events = provider.parseInbound(payload);

    expect(events).toHaveLength(1);
    expect(events[0].body).toBe("bare array");
  });

  it("returns [] for an empty/no-messages response", () => {
    expect(provider.parseInbound({ sms: [] })).toEqual([]);
    expect(provider.parseInbound({ result: [] })).toEqual([]);
    expect(provider.parseInbound({})).toEqual([]);
  });

  it("returns [] (never throws) for malformed/garbage responses", () => {
    expect(provider.parseInbound(null)).toEqual([]);
    expect(provider.parseInbound(undefined)).toEqual([]);
    expect(provider.parseInbound("not json shaped")).toEqual([]);
    expect(provider.parseInbound(12345)).toEqual([]);
    expect(provider.parseInbound({ sms: "not-an-array" })).toEqual([]);
    // rows present but each row is garbage / missing every recognized field
    expect(provider.parseInbound({ sms: [null, 1, "x", {}, { number: "not-a-number" }] })).toEqual([]);
    // circular-ish/weird nested junk should still be swallowed, not thrown
    expect(provider.parseInbound({ sms: [{ number: {}, text: [] }] })).toEqual([]);
  });

  it("drops rows whose number cannot be normalized to E.164 but keeps the rest", () => {
    const payload = {
      sms: [
        { number: "not-a-real-number", text: "should be dropped" },
        { incoming_sms_id: 7, port: 0, number: "+971501234567", text: "should survive", timestamp: "2026-08-28 12:00:00" },
      ],
    };

    const events = provider.parseInbound(payload);

    expect(events).toHaveLength(1);
    expect(events[0].body).toBe("should survive");
  });
});

describe("authHeaders / authQueryParams", () => {
  beforeEach(() => {
    settingsStore.clear();
  });

  it("basic style: authHeaders returns a Basic Authorization header, authQueryParams is empty", async () => {
    setSettings({
      DINSTAR_AUTH_STYLE: "basic",
      DINSTAR_SMS_USERNAME: "admin",
      DINSTAR_SMS_PASSWORD: "s3cret",
    });

    const headers = await authHeaders();
    const query = await authQueryParams();

    expect(query).toEqual({});
    expect(headers).toHaveProperty("Authorization");
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("admin:s3cret").toString("base64")}`);
  });

  it("query style: authQueryParams returns username/password, authHeaders is empty", async () => {
    setSettings({
      DINSTAR_AUTH_STYLE: "query",
      DINSTAR_SMS_USERNAME: "admin",
      DINSTAR_SMS_PASSWORD: "s3cret",
    });

    const headers = await authHeaders();
    const query = await authQueryParams();

    expect(headers).toEqual({});
    expect(query).toEqual({ username: "admin", password: "s3cret" });
  });

  it("defaults to basic style when DINSTAR_AUTH_STYLE is unset (wizard never run)", async () => {
    setSettings({
      DINSTAR_SMS_USERNAME: "admin",
      DINSTAR_SMS_PASSWORD: "s3cret",
    });

    const headers = await authHeaders();
    const query = await authQueryParams();

    expect(query).toEqual({});
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("admin:s3cret").toString("base64")}`);
  });

  it("falls back to empty-string credentials when username/password are unset, rather than throwing", async () => {
    setSettings({ DINSTAR_AUTH_STYLE: "basic" });

    const headers = await authHeaders();

    expect(headers.Authorization).toBe(`Basic ${Buffer.from(":").toString("base64")}`);
  });
});
