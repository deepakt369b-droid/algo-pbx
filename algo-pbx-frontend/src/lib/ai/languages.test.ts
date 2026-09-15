import { describe, expect, it } from "vitest";
import { AI_LANGUAGES, languageLabel, sttLanguageTag, ttsLanguageTag } from "./languages";

describe("languages catalog", () => {
  it("has no duplicate tags", () => {
    const tags = AI_LANGUAGES.map((l) => l.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("resolves a known label", () => {
    expect(languageLabel("hi")).toBe("Hindi");
  });

  it("falls back to the tag itself for an unknown language", () => {
    expect(languageLabel("xx-unknown")).toBe("xx-unknown");
  });

  it("resolves a provider-specific sttTag when one differs from the base tag", () => {
    expect(sttLanguageTag("hi-en")).toBe("hi");
  });

  it("falls back to the base tag when no sttTag override exists", () => {
    expect(sttLanguageTag("en")).toBe("en");
  });

  it("resolves a provider-specific ttsTag", () => {
    expect(ttsLanguageTag("hi")).toBe("hi-IN");
  });

  it("never throws for an unrecognized tag", () => {
    expect(() => sttLanguageTag("made-up")).not.toThrow();
    expect(sttLanguageTag("made-up")).toBe("made-up");
  });
});
