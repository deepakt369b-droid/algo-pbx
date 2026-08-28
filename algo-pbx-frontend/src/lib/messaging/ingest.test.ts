import { beforeEach, describe, expect, it, vi } from "vitest";

// findOrCreateConversation() (and, transitively, ingestInboundEvent()) is
// the one place the compound-unique-with-nullable-column footgun documented
// in this file's own comment must be tested: Postgres treats
// waInstanceId: null as always-distinct, so a naive `upsert` on
// (contactId, channel, waInstanceId) would silently duplicate rows instead
// of erroring. Mock only the two Conversation methods this module calls.
const findFirst = vi.fn();
const create = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    conversation: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      create: (...args: unknown[]) => create(...args),
    },
  },
}));

const { findOrCreateConversation } = await import("./ingest");

beforeEach(() => {
  findFirst.mockReset();
  create.mockReset();
});

describe("findOrCreateConversation", () => {
  it("creates a new conversation when none exists for (contactId, channel, waInstanceId)", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: "conv-1", contactId: "c1", channel: "SMS", waInstanceId: null });

    const result = await findOrCreateConversation("c1", "SMS", null);

    expect(findFirst).toHaveBeenCalledWith({ where: { contactId: "c1", channel: "SMS", waInstanceId: null } });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toEqual({ data: { contactId: "c1", channel: "SMS", waInstanceId: null } });
    expect(result).toEqual({ conversation: expect.objectContaining({ id: "conv-1" }), created: true });
  });

  it("reuses an existing conversation instead of creating a duplicate", async () => {
    findFirst.mockResolvedValue({ id: "conv-existing", contactId: "c1", channel: "WHATSAPP", waInstanceId: "wa-1" });

    const result = await findOrCreateConversation("c1", "WHATSAPP", "wa-1");

    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({
      conversation: expect.objectContaining({ id: "conv-existing" }),
      created: false,
    });
  });

  it("passes extra createData through only on creation, not on reuse", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: "conv-2", contactId: "c1", channel: "SMS", waInstanceId: null });

    await findOrCreateConversation("c1", "SMS", null, { assignedAgentId: "agent-1" });

    expect(create.mock.calls[0][0]).toEqual({
      data: { contactId: "c1", channel: "SMS", waInstanceId: null, assignedAgentId: "agent-1" },
    });
  });

  it("does not treat two waInstanceId: null conversations for the same contact+channel as colliding — it looks them up explicitly rather than relying on the DB's compound-unique constraint", async () => {
    // Simulates two independent contacts' SMS conversations, both with
    // waInstanceId: null — the compound unique index in schema.prisma
    // cannot distinguish these at the DB level (Postgres NULL != NULL),
    // so correctness here rests entirely on the explicit findFirst below,
    // not on a constraint the DB would enforce for us.
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    create
      .mockResolvedValueOnce({ id: "conv-a", contactId: "contact-a", channel: "SMS", waInstanceId: null })
      .mockResolvedValueOnce({ id: "conv-b", contactId: "contact-b", channel: "SMS", waInstanceId: null });

    const a = await findOrCreateConversation("contact-a", "SMS", null);
    const b = await findOrCreateConversation("contact-b", "SMS", null);

    expect(a.conversation.id).toBe("conv-a");
    expect(b.conversation.id).toBe("conv-b");
    expect(findFirst).toHaveBeenNthCalledWith(1, { where: { contactId: "contact-a", channel: "SMS", waInstanceId: null } });
    expect(findFirst).toHaveBeenNthCalledWith(2, { where: { contactId: "contact-b", channel: "SMS", waInstanceId: null } });
  });

  it("reuses the existing row rather than creating a duplicate when called twice for the same key (the new-conversation POST route's reuse case)", async () => {
    const existing = { id: "conv-reused", contactId: "c1", channel: "WHATSAPP", waInstanceId: "wa-1" };
    findFirst.mockResolvedValue(existing);

    const first = await findOrCreateConversation("c1", "WHATSAPP", "wa-1", { assignedAgentId: "agent-1" });
    const second = await findOrCreateConversation("c1", "WHATSAPP", "wa-1", { assignedAgentId: "agent-2" });

    expect(create).not.toHaveBeenCalled();
    expect(first.conversation.id).toBe("conv-reused");
    expect(second.conversation.id).toBe("conv-reused");
    expect(first.created).toBe(false);
    expect(second.created).toBe(false);
  });
});
