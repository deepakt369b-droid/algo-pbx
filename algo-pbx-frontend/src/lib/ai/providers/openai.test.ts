import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiAdapter } from "./openai";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openaiAdapter.listModels", () => {
  it("tags realtime models and llm models correctly, using Bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ id: "gpt-4o" }, { id: "gpt-4o-realtime-preview" }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await openaiAdapter.listModels({ apiKey: "sk-test" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer sk-test" } })
    );
    expect(models.filter((m) => m.capabilities.includes("llm") || m.capabilities.includes("realtime"))).toEqual([
      { id: "gpt-4o", capabilities: ["llm"] },
      { id: "gpt-4o-realtime-preview", capabilities: ["realtime"] },
    ]);
    // Fixed 2026-09-15 (workflow-builder plan, blocker #7): the static
    // voice catalog is always appended, distinctly capability-tagged.
    expect(models.filter((m) => m.capabilities.includes("voice")).map((m) => m.id)).toEqual([
      "alloy",
      "echo",
      "fable",
      "onyx",
      "nova",
      "shimmer",
    ]);
  });

  it("classifies tts-*/whisper models distinctly and drops embedding models entirely", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ id: "tts-1" }, { id: "whisper-1" }, { id: "text-embedding-3-small" }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await openaiAdapter.listModels({ apiKey: "sk-test" });
    expect(models.find((m) => m.id === "tts-1")?.capabilities).toEqual(["tts"]);
    expect(models.find((m) => m.id === "whisper-1")?.capabilities).toEqual(["stt"]);
    expect(models.find((m) => m.id === "text-embedding-3-small")).toBeUndefined();
  });

  it("throws a clear error when the apiKey is missing", async () => {
    await expect(openaiAdapter.listModels({ apiKey: "" })).rejects.toThrow(/apiKey is required/);
  });

  it("throws a clear error on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "bad key" }, false, 401)));
    await expect(openaiAdapter.listModels({ apiKey: "sk-bad" })).rejects.toThrow(/status 401/);
  });

  it("throws a clear error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(openaiAdapter.listModels({ apiKey: "sk-test" })).rejects.toThrow(/network error/);
  });
});
