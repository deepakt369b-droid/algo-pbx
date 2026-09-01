import { describe, expect, it } from "vitest";
import {
  canAccessConversation,
  canRevealMessageBody,
  redactMessagesForSession,
  resolveMessageAccessState,
  type RawMessage,
  type SmsAccessRequestLike,
} from "./conversation-access";

const NOW = new Date("2026-08-23T12:00:00Z");
const EARLIER = new Date("2026-08-23T11:00:00Z");
const PAST = new Date("2026-08-23T11:59:00Z");
const FUTURE = new Date("2026-08-23T12:15:00Z");

describe("canAccessConversation", () => {
  it("allows ADMIN and SUPERVISOR on anyone's conversation", () => {
    for (const role of ["ADMIN", "SUPERVISOR"] as const) {
      expect(canAccessConversation({ role, userId: "u1", assignedAgentId: "u2" })).toBe(true);
    }
  });

  it("allows an AGENT on their own conversation", () => {
    expect(canAccessConversation({ role: "AGENT", userId: "u1", assignedAgentId: "u1" })).toBe(true);
  });

  it("allows an AGENT on an unassigned conversation (claimable shared inbox)", () => {
    expect(canAccessConversation({ role: "AGENT", userId: "u1", assignedAgentId: null })).toBe(true);
  });

  it("denies an AGENT on another agent's conversation", () => {
    expect(canAccessConversation({ role: "AGENT", userId: "u1", assignedAgentId: "u2" })).toBe(false);
  });
});

describe("resolveMessageAccessState", () => {
  const req = (o: Partial<SmsAccessRequestLike>): SmsAccessRequestLike => ({
    status: "PENDING",
    expiresAt: null,
    createdAt: EARLIER,
    ...o,
  });

  it("is 'none' with no requests", () => {
    expect(resolveMessageAccessState([], NOW)).toBe("none");
  });

  it("reports pending / declined / revoked verbatim", () => {
    expect(resolveMessageAccessState([req({ status: "PENDING" })], NOW)).toBe("pending");
    expect(resolveMessageAccessState([req({ status: "DECLINED" })], NOW)).toBe("declined");
    expect(resolveMessageAccessState([req({ status: "REVOKED" })], NOW)).toBe("revoked");
  });

  it("is 'approved' while the window is open", () => {
    expect(resolveMessageAccessState([req({ status: "APPROVED", expiresAt: FUTURE })], NOW)).toBe(
      "approved"
    );
  });

  it("degrades an APPROVED request to 'expired' once expiresAt has passed", () => {
    expect(resolveMessageAccessState([req({ status: "APPROVED", expiresAt: PAST })], NOW)).toBe(
      "expired"
    );
  });

  it("treats expiresAt exactly == now as expired (no off-by-one grace)", () => {
    expect(resolveMessageAccessState([req({ status: "APPROVED", expiresAt: NOW })], NOW)).toBe(
      "expired"
    );
  });

  it("lets the newest request win, not the first-listed", () => {
    const state = resolveMessageAccessState(
      [
        req({ status: "APPROVED", expiresAt: FUTURE, createdAt: EARLIER }),
        req({ status: "REVOKED", createdAt: NOW }),
      ],
      NOW
    );
    expect(state).toBe("revoked");
  });
});

describe("canRevealMessageBody", () => {
  it("always reveals a non-sensitive message", () => {
    expect(canRevealMessageBody({ role: "AGENT", sensitive: false, accessState: "none" })).toBe(true);
  });

  it("reveals sensitive bodies to ADMIN and SUPERVISOR", () => {
    expect(canRevealMessageBody({ role: "ADMIN", sensitive: true, accessState: "none" })).toBe(true);
    expect(canRevealMessageBody({ role: "SUPERVISOR", sensitive: true, accessState: "none" })).toBe(
      true
    );
  });

  it("withholds a sensitive body from an AGENT in every non-approved state", () => {
    for (const s of ["none", "pending", "declined", "revoked", "expired"] as const) {
      expect(canRevealMessageBody({ role: "AGENT", sensitive: true, accessState: s })).toBe(false);
    }
  });

  it("reveals to an AGENT only with a live approval", () => {
    expect(canRevealMessageBody({ role: "AGENT", sensitive: true, accessState: "approved" })).toBe(
      true
    );
  });
});

describe("redactMessagesForSession", () => {
  const msg = (o: Partial<RawMessage>): RawMessage => ({
    id: "m1",
    conversationId: "c1",
    direction: "INBOUND",
    body: "Your OTP is 483920",
    mediaUrl: null,
    mediaMimeType: null,
    mediaKind: null,
    deliveryStatus: "delivered",
    sensitive: true,
    createdAt: EARLIER,
    ...o,
  });

  it("emits body: null for a withheld sensitive message (plaintext never serialized)", () => {
    const [out] = redactMessagesForSession([msg({})], "AGENT", new Map(), NOW);
    expect(out.body).toBeNull();
    expect(out.sensitive).toBe(true);
    expect(out.accessRequestStatus).toBe("none");
    // Belt and braces: the OTP must not appear anywhere in the payload.
    expect(JSON.stringify(out)).not.toContain("483920");
  });

  it("reveals the body once the agent's own request is approved and live", () => {
    const requests = new Map([
      ["m1", [{ status: "APPROVED" as const, expiresAt: FUTURE, createdAt: EARLIER }]],
    ]);
    const [out] = redactMessagesForSession([msg({})], "AGENT", requests, NOW);
    expect(out.body).toBe("Your OTP is 483920");
    expect(out.accessRequestStatus).toBe("approved");
  });

  it("re-withholds once the approval expires", () => {
    const requests = new Map([
      ["m1", [{ status: "APPROVED" as const, expiresAt: PAST, createdAt: EARLIER }]],
    ]);
    const [out] = redactMessagesForSession([msg({})], "AGENT", requests, NOW);
    expect(out.body).toBeNull();
    expect(out.accessRequestStatus).toBe("expired");
  });

  it("also withholds media on a sensitive message", () => {
    const [out] = redactMessagesForSession(
      [msg({ mediaUrl: "https://x/secret.png", mediaMimeType: "image/png" })],
      "AGENT",
      new Map(),
      NOW
    );
    expect(out.mediaUrl).toBeNull();
    expect(out.mediaMimeType).toBeNull();
  });

  it("passes non-sensitive messages through untouched", () => {
    const [out] = redactMessagesForSession(
      [msg({ id: "m2", sensitive: false, body: "hello" })],
      "AGENT",
      new Map(),
      NOW
    );
    expect(out.body).toBe("hello");
    expect(out.accessRequestStatus).toBe("none");
  });

  it("does not leak one agent's approval into another message's state", () => {
    const requests = new Map([
      ["m1", [{ status: "APPROVED" as const, expiresAt: FUTURE, createdAt: EARLIER }]],
    ]);
    const out = redactMessagesForSession([msg({}), msg({ id: "m9" })], "AGENT", requests, NOW);
    expect(out[0].body).not.toBeNull();
    expect(out[1].body).toBeNull();
  });
});
