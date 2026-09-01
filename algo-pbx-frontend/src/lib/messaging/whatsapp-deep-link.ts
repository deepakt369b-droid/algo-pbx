// Pure resolution logic for the CRM's "WhatsApp" deep-link entry point
// (P3/P1, LLM.md §28/29) — extracted out of components/chat/chat-panel.tsx
// so it's unit-testable without a DOM (this repo's vitest config is
// `environment: "node"`, no jsdom/testing-library — see LLM.md's plan
// notes on why logic lives here rather than adding that infra for one
// component). The component owns only rendering; every branch of "what
// happens when a contact's WhatsApp button is clicked" lives here.

export interface PickableInstance {
  id: string;
  label: string;
  simPort: number;
  provider: "OPENWA" | "META_CLOUD" | "NONE";
}

export type WhatsAppDeepLinkResult =
  | { kind: "found"; conversationId: string }
  | { kind: "no-instance-agent" }
  | { kind: "no-instance-admin"; instances: PickableInstance[] }
  | { kind: "error"; message: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Resolve a contact's number to a WHATSAPP conversation, in order:
 * 1. An existing conversation in the caller's own list — opened, never
 *    recreated.
 * 2. Otherwise attempt to create one (the route resolves the caller's own
 *    assigned WaInstance) — succeeds for an agent with a line.
 * 3. No instance (the route's "No WhatsApp instance is assigned to you"
 *    409): branch on whether GET /api/admin/whatsapp/instances answers at
 *    all. 200 -> caller is an admin, return the pickable (non-calls-only)
 *    instances so the UI can offer a SIM picker. 401/403 -> an ordinary
 *    agent with no line assigned.
 */
export async function resolveWhatsAppConversation(numberE164: string, fetchImpl: FetchLike = fetch): Promise<WhatsAppDeepLinkResult> {
  const listRes = await fetchImpl("/api/messaging/conversations", { cache: "no-store" });
  if (listRes.ok) {
    const listData = await listRes.json().catch(() => null);
    const match = (listData?.conversations ?? []).find(
      (c: { channel: string; contact: { numberE164: string } }) => c.channel === "WHATSAPP" && c.contact.numberE164 === numberE164
    );
    if (match) return { kind: "found", conversationId: match.id };
  }

  const createRes = await fetchImpl("/api/messaging/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numberE164, channel: "WHATSAPP" }),
  });
  if (createRes.ok) {
    const data = await createRes.json();
    return { kind: "found", conversationId: data.conversationId };
  }

  const createError = (await createRes.json().catch(() => null))?.error;
  if (createRes.status !== 409 || !createError?.includes("No WhatsApp instance is assigned")) {
    return { kind: "error", message: createError ?? `Failed (${createRes.status})` };
  }

  const adminRes = await fetchImpl("/api/admin/whatsapp/instances", { cache: "no-store" });
  if (!adminRes.ok) return { kind: "no-instance-agent" };

  const adminData = await adminRes.json();
  const instances: PickableInstance[] = (adminData.instances ?? [])
    .filter((i: PickableInstance) => i.provider !== "NONE")
    .map((i: PickableInstance) => ({ id: i.id, label: i.label, simPort: i.simPort, provider: i.provider }));
  return { kind: "no-instance-admin", instances };
}

/** The admin SIM-picker's follow-up: create the conversation with an
 * explicit waInstanceId once the operator has chosen one. */
export async function createWhatsAppConversationWithInstance(
  numberE164: string,
  waInstanceId: string,
  fetchImpl: FetchLike = fetch
): Promise<WhatsAppDeepLinkResult> {
  const res = await fetchImpl("/api/messaging/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numberE164, channel: "WHATSAPP", waInstanceId }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return { kind: "error", message: data?.error ?? `Failed (${res.status})` };
  return { kind: "found", conversationId: data.conversationId };
}
