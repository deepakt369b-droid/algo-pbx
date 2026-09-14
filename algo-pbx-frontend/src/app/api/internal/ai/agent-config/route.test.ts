import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { tenantDbMock, extensionMock, aiProviderCredentialMock, decryptSettingMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  extensionMock: { findUnique: vi.fn() },
  aiProviderCredentialMock: { findUnique: vi.fn() },
  decryptSettingMock: vi.fn(),
}));

vi.mock("@/lib/db-tenant", () => ({
  tenantDb: tenantDbMock,
}));

vi.mock("@/lib/settings/crypto", () => ({
  decryptSetting: decryptSettingMock,
}));

import { GET } from "./route";

function fakeDb() {
  return { extension: extensionMock, aiProviderCredential: aiProviderCredentialMock };
}

function request(qs: string) {
  return new NextRequest(`http://localhost/api/internal/ai/agent-config${qs}`);
}

beforeEach(() => {
  tenantDbMock.mockReturnValue(fakeDb());
  process.env.AI_SIDECAR_SHARED_SECRET = "shared-secret-value";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_SIDECAR_SHARED_SECRET;
});

describe("GET /api/internal/ai/agent-config — auth", () => {
  it("rejects a request with no x-internal-secret header", async () => {
    const response = await GET(request("?ext=2001&tenant=t1"));
    expect(response.status).toBe(401);
    expect(extensionMock.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong x-internal-secret header", async () => {
    const req = new NextRequest("http://localhost/api/internal/ai/agent-config?ext=2001&tenant=t1", {
      headers: { "x-internal-secret": "wrong" },
    });
    const response = await GET(req);
    expect(response.status).toBe(401);
    expect(extensionMock.findUnique).not.toHaveBeenCalled();
  });

  it("rejects when the shared secret env var is not configured at all", async () => {
    delete process.env.AI_SIDECAR_SHARED_SECRET;
    const req = new NextRequest("http://localhost/api/internal/ai/agent-config?ext=2001&tenant=t1", {
      headers: { "x-internal-secret": "shared-secret-value" },
    });
    const response = await GET(req);
    expect(response.status).toBe(401);
  });
});

function authedRequest(qs: string) {
  return new NextRequest(`http://localhost/api/internal/ai/agent-config${qs}`, {
    headers: { "x-internal-secret": "shared-secret-value" },
  });
}

describe("GET /api/internal/ai/agent-config — 404s", () => {
  it("returns 404 when no extension matches", async () => {
    extensionMock.findUnique.mockResolvedValue(null);
    const response = await GET(authedRequest("?ext=9999&tenant=t1"));
    expect(response.status).toBe(404);
  });

  it("returns 404 when the extension is HUMAN, not AI", async () => {
    extensionMock.findUnique.mockResolvedValue({
      id: "ext1",
      number: "1001",
      agentType: "HUMAN",
      aiAgent: null,
    });
    const response = await GET(authedRequest("?ext=1001&tenant=t1"));
    expect(response.status).toBe(404);
  });

  it("returns 404 when AiAgent.enabled is false", async () => {
    extensionMock.findUnique.mockResolvedValue({
      id: "ext1",
      number: "2001",
      agentType: "AI",
      aiAgent: {
        id: "agent1",
        enabled: false,
        language: "en",
        greeting: "hi",
        systemPrompt: "prompt",
        pipelineMode: "CASCADE",
        realtimeProviderId: null,
        realtimeModel: null,
        sttProviderId: null,
        sttModel: null,
        llmProviderId: null,
        llmModel: null,
        ttsProviderId: null,
        ttsModel: null,
        ttsVoice: null,
        tools: null,
        outboundEnabled: false,
      },
    });
    const response = await GET(authedRequest("?ext=2001&tenant=t1"));
    expect(response.status).toBe(404);
  });

  it("returns 400 when ext or tenant query params are missing", async () => {
    const response = await GET(authedRequest("?ext=2001"));
    expect(response.status).toBe(400);
  });
});

describe("GET /api/internal/ai/agent-config — shapes provider legs", () => {
  it("decrypts each configured leg's credential and omits unconfigured legs", async () => {
    extensionMock.findUnique.mockResolvedValue({
      id: "ext1",
      number: "2001",
      agentType: "AI",
      aiAgent: {
        id: "agent1",
        enabled: true,
        language: "hi-en",
        greeting: "Hello, this is an automated assistant.",
        systemPrompt: "You are a helpful agent.",
        pipelineMode: "CASCADE",
        realtimeProviderId: null,
        realtimeModel: null,
        sttProviderId: "cred-stt",
        sttModel: "nova-2",
        llmProviderId: "cred-llm",
        llmModel: "gpt-4o-mini",
        ttsProviderId: "cred-tts",
        ttsModel: "eleven_turbo_v2",
        ttsVoice: "rachel",
        tools: { webhooks: [] },
        outboundEnabled: false,
      },
    });

    aiProviderCredentialMock.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      const rows: Record<string, unknown> = {
        "cred-stt": { id: "cred-stt", provider: "deepgram", apiKeyCipher: "iv:tag:stt", region: "us", baseUrl: null },
        "cred-llm": { id: "cred-llm", provider: "openai", apiKeyCipher: "iv:tag:llm", region: null, baseUrl: null },
        "cred-tts": { id: "cred-tts", provider: "elevenlabs", apiKeyCipher: "iv:tag:tts", region: null, baseUrl: null },
      };
      return Promise.resolve(rows[where.id] ?? null);
    });
    decryptSettingMock.mockImplementation((cipher: string) => `decrypted:${cipher}`);

    const response = await GET(authedRequest("?ext=2001&tenant=t1"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.agentId).toBe("agent1");
    expect(json.extensionNumber).toBe("2001");
    expect(json.pipelineMode).toBe("CASCADE");
    expect(json.realtime).toBeUndefined();
    expect(json.stt).toEqual({ provider: "deepgram", model: "nova-2", apiKey: "decrypted:iv:tag:stt", region: "us" });
    expect(json.llm).toEqual({ provider: "openai", model: "gpt-4o-mini", apiKey: "decrypted:iv:tag:llm", baseUrl: null });
    expect(json.tts).toEqual({
      provider: "elevenlabs",
      model: "eleven_turbo_v2",
      voice: "rachel",
      apiKey: "decrypted:iv:tag:tts",
      region: null,
    });
    expect(json.outboundEnabled).toBe(false);
    // The response carries the decrypted key (the sidecar needs it to call
    // the provider), never the raw ciphertext stored on AiProviderCredential.
    expect(JSON.stringify(json)).not.toContain("cred-stt");
    expect(JSON.stringify(json)).toContain("decrypted:iv:tag:stt");
  });
});

describe("GET /api/internal/ai/agent-config — handoffExtensionHint", () => {
  function baseAgent(overrides: Record<string, unknown>) {
    return {
      id: "agent1",
      enabled: true,
      language: "en",
      greeting: "hi",
      systemPrompt: "prompt",
      pipelineMode: "CASCADE",
      realtimeProviderId: null,
      realtimeModel: null,
      sttProviderId: null,
      sttModel: null,
      llmProviderId: null,
      llmModel: null,
      ttsProviderId: null,
      ttsModel: null,
      ttsVoice: null,
      tools: null,
      outboundEnabled: false,
      escalationEnabled: false,
      handoffTargetKind: null,
      handoffNumberE164: null,
      handoffExtension: null,
      ...overrides,
    };
  }

  it("is null when escalationEnabled is false, even if a target is configured", async () => {
    extensionMock.findUnique.mockResolvedValue({
      id: "ext1",
      number: "2001",
      agentType: "AI",
      aiAgent: baseAgent({
        escalationEnabled: false,
        handoffTargetKind: "NUMBER",
        handoffNumberE164: "+971500000000",
      }),
    });
    const json = await (await GET(authedRequest("?ext=2001&tenant=t1"))).json();
    expect(json.handoffExtensionHint).toBeNull();
  });

  it("is null when escalationEnabled is true but no target kind is chosen yet", async () => {
    extensionMock.findUnique.mockResolvedValue({
      id: "ext1",
      number: "2001",
      agentType: "AI",
      aiAgent: baseAgent({ escalationEnabled: true }),
    });
    const json = await (await GET(authedRequest("?ext=2001&tenant=t1"))).json();
    expect(json.handoffExtensionHint).toBeNull();
  });

  it("resolves to the E.164 number for a NUMBER target", async () => {
    extensionMock.findUnique.mockResolvedValue({
      id: "ext1",
      number: "2001",
      agentType: "AI",
      aiAgent: baseAgent({
        escalationEnabled: true,
        handoffTargetKind: "NUMBER",
        handoffNumberE164: "+971500000000",
      }),
    });
    const json = await (await GET(authedRequest("?ext=2001&tenant=t1"))).json();
    expect(json.handoffExtensionHint).toBe("+971500000000");
  });

  it("resolves to the linked extension's number for an EXTENSION target", async () => {
    extensionMock.findUnique.mockResolvedValue({
      id: "ext1",
      number: "2001",
      agentType: "AI",
      aiAgent: baseAgent({
        escalationEnabled: true,
        handoffTargetKind: "EXTENSION",
        handoffExtension: { number: "1002" },
      }),
    });
    const json = await (await GET(authedRequest("?ext=2001&tenant=t1"))).json();
    expect(json.handoffExtensionHint).toBe("1002");
  });
});
