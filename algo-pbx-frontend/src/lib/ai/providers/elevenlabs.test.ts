import { afterEach, describe, expect, it, vi } from "vitest";
import { elevenlabsAdapter } from "./elevenlabs";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("elevenlabsAdapter.listModels", () => {
  it("merges /v1/models and /v2/voices into one tts list, using xi-api-key auth", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "https://api.elevenlabs.io/v1/models") {
        return Promise.resolve(jsonResponse([{ model_id: "eleven_multilingual_v2", name: "Multilingual v2" }]));
      }
      if (url === "https://api.elevenlabs.io/v2/voices") {
        return Promise.resolve(jsonResponse({ voices: [{ voice_id: "voice-1", name: "Rachel" }] }));
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await elevenlabsAdapter.listModels({ apiKey: "el-test" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/models",
      expect.objectContaining({ headers: { "xi-api-key": "el-test" } })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v2/voices",
      expect.objectContaining({ headers: { "xi-api-key": "el-test" } })
    );
    expect(models).toEqual([
      { id: "eleven_multilingual_v2", label: "Multilingual v2", capabilities: ["tts"] },
      { id: "voice-1", label: "Rachel", capabilities: ["tts"] },
    ]);
  });

  it("throws a clear error when the models call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false, 403)));
    await expect(elevenlabsAdapter.listModels({ apiKey: "bad" })).rejects.toThrow(/status 403/);
  });
});
