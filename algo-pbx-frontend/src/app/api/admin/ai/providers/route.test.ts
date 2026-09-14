import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { requireAdminSessionMock, encryptSettingMock, aiProviderCredentialMock, tenantMock } = vi.hoisted(() => ({
  requireAdminSessionMock: vi.fn(),
  encryptSettingMock: vi.fn(),
  aiProviderCredentialMock: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
  tenantMock: { findUnique: vi.fn() },
}));

vi.mock("@/lib/auth-guard", () => ({
  requireAdminSession: requireAdminSessionMock,
}));

// Post-verification fix (2026-09-14): POST now re-checks planHasFeature via
// unsafeGlobalDb.tenant, same pattern as .../agents/route.ts's tenantPlan().
// Defaults every test's tenant to the premium plan so existing assertions
// keep testing what they were written to test; the "wrong plan" case gets
// its own test below.
vi.mock("@/lib/db", () => ({
  unsafeGlobalDb: { tenant: tenantMock },
}));

vi.mock("@/lib/settings/crypto", () => ({
  encryptSetting: encryptSettingMock,
  decryptSetting: vi.fn(),
}));

// Mocks the registry, not an individual provider file — this exercises the
// route's "validate before save" logic in isolation from any real network
// call, per the task's "mock prisma + crypto" instruction (the adapter
// itself is unit-tested separately in providers/openai.test.ts etc).
const listModelsMock = vi.fn();
vi.mock("@/lib/ai/providers", () => ({
  getProviderAdapter: () => ({ provider: "openai", supportsLiveModelList: true, listModels: listModelsMock }),
}));

import { POST, GET } from "./route";

function fakeDb() {
  return { aiProviderCredential: aiProviderCredentialMock };
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/ai/providers", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  tenantMock.findUnique.mockResolvedValue({ plan: "premium" });
});

describe("POST /api/admin/ai/providers", () => {
  it("validates the key via listModels() before saving, then encrypts and stores it", async () => {
    requireAdminSessionMock.mockResolvedValue({ session: { user: { id: "u1", tenantId: "tenant1" } }, db: fakeDb() });
    listModelsMock.mockResolvedValue([{ id: "gpt-4o", capabilities: ["llm"] }]);
    encryptSettingMock.mockReturnValue("iv:tag:ciphertext");
    aiProviderCredentialMock.create.mockResolvedValue({
      id: "cred1",
      provider: "openai",
      label: "Prod key",
      region: null,
      baseUrl: null,
      cachedModels: [{ id: "gpt-4o", capabilities: ["llm"] }],
      fetchedAt: new Date("2026-09-14T00:00:00Z"),
    });

    const response = await POST(request({ provider: "openai", label: "Prod key", apiKey: "sk-real" }));
    const json = await response.json();

    expect(listModelsMock).toHaveBeenCalledWith({ apiKey: "sk-real", region: null, baseUrl: null });
    expect(encryptSettingMock).toHaveBeenCalledWith("sk-real");
    expect(aiProviderCredentialMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ apiKeyCipher: "iv:tag:ciphertext", provider: "openai" }),
      })
    );
    expect(response.status).toBe(201);
    expect(json.credential.id).toBe("cred1");
    expect(json.credential.apiKeyCipher).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("sk-real");
  });

  it("returns 422 and does NOT save when listModels() fails", async () => {
    requireAdminSessionMock.mockResolvedValue({ session: { user: { id: "u1", tenantId: "tenant1" } }, db: fakeDb() });
    listModelsMock.mockRejectedValue(new Error("openai: request failed with status 401"));

    const response = await POST(request({ provider: "openai", label: "Bad key", apiKey: "sk-bad" }));
    const json = await response.json();

    expect(response.status).toBe(422);
    expect(json.error).toMatch(/401/);
    expect(aiProviderCredentialMock.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before touching the provider or db", async () => {
    const unauthorized = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    requireAdminSessionMock.mockResolvedValue({ response: unauthorized });

    const response = await POST(request({ provider: "openai", label: "x", apiKey: "y" }));

    expect(response.status).toBe(401);
    expect(listModelsMock).not.toHaveBeenCalled();
    expect(aiProviderCredentialMock.create).not.toHaveBeenCalled();
  });

  it("rejects a tenant whose plan lacks the aiAgents feature, before touching the provider or db (post-verification fix)", async () => {
    requireAdminSessionMock.mockResolvedValue({ session: { user: { id: "u1", tenantId: "tenant1" } }, db: fakeDb() });
    tenantMock.findUnique.mockResolvedValue({ plan: "standard" });

    const response = await POST(request({ provider: "openai", label: "x", apiKey: "y" }));

    expect(response.status).toBe(403);
    expect(listModelsMock).not.toHaveBeenCalled();
    expect(aiProviderCredentialMock.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/ai/providers", () => {
  it("never returns apiKeyCipher", async () => {
    requireAdminSessionMock.mockResolvedValue({ session: { user: { id: "u1", tenantId: "tenant1" } }, db: fakeDb() });
    aiProviderCredentialMock.findMany.mockResolvedValue([
      { id: "cred1", provider: "openai", label: "Prod key", region: null, baseUrl: null, cachedModels: [], fetchedAt: null },
    ]);

    const response = await GET();
    const json = await response.json();

    expect(json.credentials).toHaveLength(1);
    expect(json.credentials[0].apiKeyCipher).toBeUndefined();
    const selectArg = aiProviderCredentialMock.findMany.mock.calls[0][0].select;
    expect(selectArg.apiKeyCipher).toBeUndefined();
  });
});
