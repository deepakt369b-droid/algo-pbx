import { afterEach, describe, expect, it, vi } from "vitest";
import { cartesiaAdapter } from "./cartesia";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cartesiaAdapter.listModels", () => {
  it("returns a static model catalog plus live voices, distinctly tagged (fixed 2026-09-15)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: "voice-1", name: "Aria" }]));
    vi.stubGlobal("fetch", fetchMock);

    const models = await cartesiaAdapter.listModels({ apiKey: "ck-test" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cartesia.ai/voices",
      expect.objectContaining({ headers: { "X-API-Key": "ck-test", "Cartesia-Version": "2024-06-10" } })
    );
    const modelIds = models.filter((m) => m.capabilities.includes("tts")).map((m) => m.id);
    const voiceIds = models.filter((m) => m.capabilities.includes("voice")).map((m) => m.id);
    expect(modelIds).toEqual(["sonic-2", "sonic-english", "sonic-multilingual"]);
    expect(voiceIds).toEqual(["voice-1"]);
  });

  it("handles a {data: [...]} envelope shape too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "voice-2", name: "Rex" }] })));
    const models = await cartesiaAdapter.listModels({ apiKey: "ck-test" });
    expect(models.some((m) => m.id === "voice-2" && m.capabilities.includes("voice"))).toBe(true);
  });

  it("throws a clear error when the apiKey is missing", async () => {
    await expect(cartesiaAdapter.listModels({ apiKey: "" })).rejects.toThrow(/apiKey is required/);
  });
});
