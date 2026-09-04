import { describe, expect, it } from "vitest";
import { RESERVED_TENANT_SLUGS, isValidTenantSlug, validateTenantSlug } from "./slug";

describe("validateTenantSlug", () => {
  it("accepts a plain valid slug", () => {
    expect(validateTenantSlug("sahara")).toEqual({ ok: true, slug: "sahara" });
  });

  it("accepts digits and internal hyphens", () => {
    expect(validateTenantSlug("acme-corp-2")).toEqual({ ok: true, slug: "acme-corp-2" });
  });

  it("accepts a single character slug", () => {
    expect(validateTenantSlug("a")).toEqual({ ok: true, slug: "a" });
  });

  it("rejects an empty string", () => {
    const result = validateTenantSlug("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/required/i);
  });

  for (const reserved of RESERVED_TENANT_SLUGS) {
    it(`rejects the reserved word "${reserved}"`, () => {
      const result = validateTenantSlug(reserved);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/reserved/i);
    });
  }

  it("rejects uppercase letters with a distinct error", () => {
    const result = validateTenantSlug("Sahara");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/lowercase/i);
  });

  it("rejects a mixed-case reserved word too (case-sensitive reserved check, but caught by the lowercase rule first)", () => {
    const result = validateTenantSlug("Platform");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/lowercase/i);
  });

  it("rejects underscores (DNS-unsafe, even though SAFE_NAME_RE alone would allow them)", () => {
    const result = validateTenantSlug("acme_corp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/lowercase letters, digits, and hyphens/i);
  });

  it("rejects spaces and other non-DNS-safe characters", () => {
    expect(validateTenantSlug("acme corp").ok).toBe(false);
    expect(validateTenantSlug("acme.corp").ok).toBe(false);
    expect(validateTenantSlug("acme/corp").ok).toBe(false);
    expect(validateTenantSlug("acme_corp!").ok).toBe(false);
  });

  it("rejects a slug outside bridge-watch.sh's SAFE_NAME_RE charset even where DNS might tolerate it", () => {
    // SAFE_NAME_RE is ^[A-Za-z0-9_-]{1,64}$ — anything with e.g. a unicode
    // character fails both DNS-safety and SAFE_NAME_RE, so this should be
    // rejected regardless of which check "would" have caught it first.
    expect(validateTenantSlug("acmé").ok).toBe(false);
  });

  it("rejects a leading hyphen", () => {
    const result = validateTenantSlug("-acme");
    expect(result.ok).toBe(false);
  });

  it("rejects a trailing hyphen", () => {
    const result = validateTenantSlug("acme-");
    expect(result.ok).toBe(false);
  });

  it("rejects a slug longer than 63 characters", () => {
    const tooLong = "a".repeat(64);
    const result = validateTenantSlug(tooLong);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/63 characters/i);
  });

  it("accepts a slug exactly 63 characters long", () => {
    const maxLen = "a" + "b".repeat(61) + "c"; // 63 chars, no leading/trailing hyphen
    expect(maxLen.length).toBe(63);
    expect(validateTenantSlug(maxLen).ok).toBe(true);
  });
});

describe("isValidTenantSlug", () => {
  it("returns a plain boolean", () => {
    expect(isValidTenantSlug("sahara")).toBe(true);
    expect(isValidTenantSlug("platform")).toBe(false);
    expect(isValidTenantSlug("")).toBe(false);
  });
});
