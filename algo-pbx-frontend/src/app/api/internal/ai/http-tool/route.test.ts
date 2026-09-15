import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { unsafeGlobalAiAgentMock, aiWorkflowSecretMock, decryptSettingMock, tenantDbMock, fetchMock } = vi.hoisted(() => ({
  unsafeGlobalAiAgentMock: { findUnique: vi.fn() },
  aiWorkflowSecretMock: { findMany: vi.fn() },
  decryptSettingMock: vi.fn(),
  tenantDbMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ unsafeGlobalDb: { aiAgent: unsafeGlobalAiAgentMock } }));
vi.mock("@/lib/db-tenant", () => ({ tenantDb: tenantDbMock }));
vi.mock("@/lib/settings/crypto", () => ({ decryptSetting: decryptSettingMock }));

import { POST } from "./route";

function fakeDb() {
  return { aiWorkflowSecret: aiWorkflowSecretMock };
}

function request(body: unknown, headers: Record<string, string> = { "x-internal-secret": "shared-secret-value" }) {
  return new NextRequest("http://localhost/api/internal/ai/http-tool", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}

const HTTP_TOOL_NODE = {
  kind: "HTTP_TOOL",
  id: "lookup",
  label: "Order lookup",
  position: { x: 0, y: 0 },
  prompt: "",
  allowInterruption: true,
  variables: [],
  modelOverride: {},
  method: "GET",
  urlTemplate: "https://api.example.com/orders/{{gathered_context.orderId}}?key={{secrets.API_KEY}}",
  headers: [{ name: "Authorization", valueTemplate: "Bearer {{secrets.API_KEY}}" }],
  bodyTemplate: null,
  timeoutMs: 5000,
  responseMapping: [{ jsonPath: "status", intoVariable: "status" }],
};

const START_NODE = {
  kind: "START_CALL",
  id: "start",
  label: "Start",
  position: { x: 0, y: 0 },
  prompt: "",
  allowInterruption: true,
  variables: [],
  modelOverride: {},
};

function graphWith(...nodes: unknown[]) {
  return { schemaVersion: 1, nodes, edges: [] };
}

beforeEach(() => {
  process.env.AI_SIDECAR_SHARED_SECRET = "shared-secret-value";
  tenantDbMock.mockReturnValue(fakeDb());
  aiWorkflowSecretMock.findMany.mockResolvedValue([{ key: "API_KEY", valueCipher: "iv:tag:cipher" }]);
  decryptSettingMock.mockImplementation((cipher: string) => `decrypted:${cipher}`);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.AI_SIDECAR_SHARED_SECRET;
});

describe("POST /api/internal/ai/http-tool — auth", () => {
  it("rejects a request with no shared secret header", async () => {
    const response = await POST(request({ agentId: "a1", nodeId: "lookup" }, {}));
    expect(response.status).toBe(401);
    expect(unsafeGlobalAiAgentMock.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/ai/http-tool — resolution", () => {
  it("404s when the agent has no published workflow", async () => {
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({ tenantId: "t1", workflow: null });
    const response = await POST(request({ agentId: "a1", nodeId: "lookup" }));
    expect(response.status).toBe(404);
  });

  it("404s when the node id doesn't exist in the published graph", async () => {
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({
      tenantId: "t1",
      workflow: { publishedVersion: { graph: graphWith(START_NODE) } },
    });
    const response = await POST(request({ agentId: "a1", nodeId: "ghost" }));
    expect(response.status).toBe(404);
  });

  it("404s when the node id exists but is not an HTTP_TOOL node", async () => {
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({
      tenantId: "t1",
      workflow: { publishedVersion: { graph: graphWith(START_NODE) } },
    });
    const response = await POST(request({ agentId: "a1", nodeId: "start" }));
    expect(response.status).toBe(404);
  });
});

describe("POST /api/internal/ai/http-tool — SSRF guard", () => {
  it("blocks a rendered URL pointing at a private/internal address", async () => {
    const node = { ...HTTP_TOOL_NODE, urlTemplate: "http://169.254.169.254/latest/meta-data" };
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({
      tenantId: "t1",
      workflow: { publishedVersion: { graph: graphWith(START_NODE, node) } },
    });
    const response = await POST(request({ agentId: "a1", nodeId: "lookup" }));
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.error).toBe("blocked_url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never trusts a URL sent by the sidecar itself - only the published node's own urlTemplate is used", async () => {
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({
      tenantId: "t1",
      workflow: { publishedVersion: { graph: graphWith(START_NODE, HTTP_TOOL_NODE) } },
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: "shipped" }) });

    await POST(
      request({
        agentId: "a1",
        nodeId: "lookup",
        gatheredContext: { orderId: "123" },
        // A malicious/compromised sidecar sending its own url/method has no effect - the request schema doesn't even accept these fields.
        url: "http://169.254.169.254/",
        method: "DELETE",
      }),
    );

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.example.com/orders/123?key=decrypted:iv:tag:cipher");
    expect(calledInit.method).toBe("GET");
  });
});

describe("POST /api/internal/ai/http-tool — templating and extraction", () => {
  it("renders gathered_context and secrets into URL/headers, and never leaks the secret into the error/response", async () => {
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({
      tenantId: "t1",
      workflow: { publishedVersion: { graph: graphWith(START_NODE, HTTP_TOOL_NODE) } },
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: "shipped" }) });

    const response = await POST(request({ agentId: "a1", nodeId: "lookup", gatheredContext: { orderId: "123" } }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, extracted: { status: "shipped" } });
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.example.com/orders/123?key=decrypted:iv:tag:cipher");
    expect(calledInit.headers.Authorization).toBe("Bearer decrypted:iv:tag:cipher");
    // The response body itself never echoes the secret.
    expect(JSON.stringify(json)).not.toContain("decrypted:iv:tag:cipher");
  });

  it("maps a nested jsonPath into the declared variable", async () => {
    const node = {
      ...HTTP_TOOL_NODE,
      responseMapping: [{ jsonPath: "data.order.status", intoVariable: "status" }],
    };
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({
      tenantId: "t1",
      workflow: { publishedVersion: { graph: graphWith(START_NODE, node) } },
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { order: { status: "delivered" } } }) });

    const json = await (await POST(request({ agentId: "a1", nodeId: "lookup" }))).json();
    expect(json.extracted).toEqual({ status: "delivered" });
  });

  it("returns ok:false without throwing on a non-2xx upstream response", async () => {
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({
      tenantId: "t1",
      workflow: { publishedVersion: { graph: graphWith(START_NODE, HTTP_TOOL_NODE) } },
    });
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const response = await POST(request({ agentId: "a1", nodeId: "lookup" }));
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("http_503");
  });

  it("returns ok:false without throwing on a network error", async () => {
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({
      tenantId: "t1",
      workflow: { publishedVersion: { graph: graphWith(START_NODE, HTTP_TOOL_NODE) } },
    });
    fetchMock.mockRejectedValue(new Error("network down"));

    const response = await POST(request({ agentId: "a1", nodeId: "lookup" }));
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("request_failed");
  });

  it("omits a request body for GET even when bodyTemplate is set", async () => {
    const node = { ...HTTP_TOOL_NODE, bodyTemplate: '{"x":1}' };
    unsafeGlobalAiAgentMock.findUnique.mockResolvedValue({
      tenantId: "t1",
      workflow: { publishedVersion: { graph: graphWith(START_NODE, node) } },
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: "shipped" }) });

    await POST(request({ agentId: "a1", nodeId: "lookup" }));
    const [, calledInit] = fetchMock.mock.calls[0];
    expect(calledInit.body).toBeUndefined();
  });
});
