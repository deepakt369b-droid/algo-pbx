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
    expect(models).toEqual([
      { id: "gpt-4o", capabilities: ["llm"] },
      { id: "gpt-4o-realtime-preview", capabilities: ["realtime"] },
    ]);
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
