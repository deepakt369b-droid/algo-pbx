import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCloudflareToken, findZoneForDomain, findARecord, upsertARecord, CloudflareError } from "./cloudflare";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyCloudflareToken", () => {
  it("resolves when Cloudflare reports success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true })));
    await expect(verifyCloudflareToken("tok")).resolves.toBeUndefined();
  });

  it("throws CloudflareError when the token is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: false })));
    await expect(verifyCloudflareToken("bad")).rejects.toThrow(CloudflareError);
  });
});

describe("findZoneForDomain", () => {
  it("finds an exact-match zone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [{ id: "z1", name: "example.com" }] }))
    );
    const zone = await findZoneForDomain("tok", "example.com");
    expect(zone.id).toBe("z1");
  });

  it("finds a zone covering a subdomain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [{ id: "z1", name: "example.com" }] }))
    );
    const zone = await findZoneForDomain("tok", "pbx.example.com");
    expect(zone.id).toBe("z1");
  });

  it("throws when listing zones fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: false })));
    await expect(findZoneForDomain("tok", "example.com")).rejects.toThrow(/listing zones failed/);
  });

  it("throws a distinct message when no zone matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [{ id: "z1", name: "other.com" }] }))
    );
    await expect(findZoneForDomain("tok", "example.com")).rejects.toThrow(/no zone covering/);
  });
});

describe("findARecord", () => {
  it("returns null when no record exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [] })));
    await expect(findARecord("tok", "z1", "example.com")).resolves.toBeNull();
  });

  it("returns the first matching record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ success: true, result: [{ id: "r1", type: "A", name: "example.com", content: "1.2.3.4", proxied: false }] })
      )
    );
    const record = await findARecord("tok", "z1", "example.com");
    expect(record?.id).toBe("r1");
  });
});

describe("upsertARecord", () => {
  it("creates a record with proxied:false when none exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] })) // findARecord lookup
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "r1" } })); // create
    vi.stubGlobal("fetch", fetchMock);

    await upsertARecord("tok", "z1", "example.com", "5.6.7.8");

    const createCall = fetchMock.mock.calls[1];
    expect(createCall[1].method).toBe("POST");
    const body = JSON.parse(createCall[1].body);
    expect(body).toMatchObject({ type: "A", name: "example.com", content: "5.6.7.8", proxied: false });
  });

  it("updates the existing record via PUT when one is found", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: "r1", type: "A", name: "example.com", content: "1.1.1.1", proxied: false }] })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "r1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await upsertARecord("tok", "z1", "example.com", "5.6.7.8");

    const updateCall = fetchMock.mock.calls[1];
    expect(updateCall[0]).toContain("/dns_records/r1");
    expect(updateCall[1].method).toBe("PUT");
  });

  it("throws CloudflareError with Cloudflare's own error message on failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: false, errors: [{ message: "invalid content" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(upsertARecord("tok", "z1", "example.com", "not-an-ip")).rejects.toThrow(/invalid content/);
  });
});
