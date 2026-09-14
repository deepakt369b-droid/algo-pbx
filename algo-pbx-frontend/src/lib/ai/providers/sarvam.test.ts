import { afterEach, describe, expect, it, vi } from "vitest";
import { sarvamAdapter } from "./sarvam";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sarvamAdapter", () => {
  it("declares no live model list support", () => {
    expect(sarvamAdapter.supportsLiveModelList).toBe(false);
  });

  it("returns the static catalog regardless of network state, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const models = await sarvamAdapter.listModels({ apiKey: "anything" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(models.map((m) => m.id)).toEqual([
      "saarika:v2.5",
      "saaras:v3",
      "saaras:v3-realtime",
      "bulbul:v2",
      "bulbul:v3",
      "sarvam-m",
    ]);
    expect(models.find((m) => m.id === "saaras:v3-realtime")?.capabilities).toEqual(["realtime"]);
    expect(models.find((m) => m.id === "sarvam-m")?.capabilities).toEqual(["llm"]);
  });
});
