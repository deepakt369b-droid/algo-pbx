// Single source of truth for "may this session read/write this
// conversation" and "may this session see this sensitive message's body".
//
// Same shape and same reasoning as src/lib/recording-access.ts: pure
// functions, no Prisma, used *identically* by the listing route, the
// single-thread route, the send route and the access-request route, so the
// four cannot drift apart. A conversation an agent may not read must be
// unreachable by direct id, not merely absent from their list.
//
// ASSIGNMENT POLICY (documented decision, was open in the brief):
// an AGENT may read and send on a conversation that is
//   (a) assigned to them, or
//   (b) unassigned — which they implicitly CLAIM by sending the first
//       message (the send route stamps assignedAgentId).
// Rationale: there are only 4 shared WaInstances (one per SIM), not one per
// agent, so `assignedAgentId` is the only thing preventing two agents from
// replying to the same customer. Leaving unassigned threads readable is
// what makes a shared inbox usable at all; the claim-on-send makes the race
// resolve to exactly one owner. A conversation assigned to *someone else*
// is invisible to an agent, full stop.

export type Role = "AGENT" | "SUPERVISOR" | "ADMIN";

export interface ConversationAccessInput {
  role: Role;
  userId: string;
  assignedAgentId: string | null;
}

/** Read access to the thread and its (non-sensitive) messages. */
export function canAccessConversation(input: ConversationAccessInput): boolean {
  if (input.role === "ADMIN" || input.role === "SUPERVISOR") return true;
  // AGENT: theirs, or up for grabs.
  return input.assignedAgentId === null || input.assignedAgentId === input.userId;
}

/** Send access. Same rule as read today — kept as a separate function so a
 * future "supervisors observe but don't reply" policy has one place to
 * live rather than being retrofitted into every call site. */
export function canSendOnConversation(input: ConversationAccessInput): boolean {
  return canAccessConversation(input);
}

export type AccessRequestStatus = "PENDING" | "APPROVED" | "DECLINED" | "REVOKED";

/** The client-visible state of an agent's unlock request for one sensitive
 * message. "none" = never requested. "expired" = was approved, window
 * lapsed — rendered as re-requestable, not as revealed. */
export type MessageAccessState = "none" | "pending" | "approved" | "declined" | "revoked" | "expired";

export interface SmsAccessRequestLike {
  status: AccessRequestStatus;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Collapse an agent's request history for ONE message into a single state.
 * The newest request wins; an APPROVED one whose expiresAt has passed
 * degrades to "expired" (and therefore does NOT reveal the body).
 */
export function resolveMessageAccessState(
  requests: SmsAccessRequestLike[],
  now: Date = new Date()
): MessageAccessState {
  if (requests.length === 0) return "none";

  const newest = [...requests].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  switch (newest.status) {
    case "APPROVED":
      if (newest.expiresAt !== null && newest.expiresAt.getTime() <= now.getTime()) return "expired";
      return "approved";
    case "PENDING":
      return "pending";
    case "DECLINED":
      return "declined";
    case "REVOKED":
      return "revoked";
    default:
      return "none";
  }
}

export interface RevealInput {
  role: Role;
  sensitive: boolean;
  accessState: MessageAccessState;
}

/**
 * THE gate. Returns true only when the real message body may be serialized
 * into this response. Called by every route that returns ChatMessage rows —
 * a `false` here means the route must omit the body entirely (send `null`),
 * never send-then-hide-in-CSS.
 */
export function canRevealMessageBody(input: RevealInput): boolean {
  if (!input.sensitive) return true;
  // ADMIN and SUPERVISOR run the SIM SMS inbox; withholding from them would
  // make the approval flow unapprovable.
  if (input.role === "ADMIN" || input.role === "SUPERVISOR") return true;
  return input.accessState === "approved";
}

export interface RawMessage {
  id: string;
  conversationId: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaKind: string | null;
  deliveryStatus: string;
  sensitive: boolean;
  createdAt: Date;
}

export interface RedactedMessage {
  id: string;
  conversationId: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaKind: string | null;
  deliveryStatus: string;
  sensitive: boolean;
  /** Only meaningful when sensitive === true. */
  accessRequestStatus: MessageAccessState;
  createdAt: Date;
}

/**
 * Map DB rows to the exact shape that leaves the route handler. This is the
 * function that must be impossible to forget: routes call THIS, not
 * `NextResponse.json({ messages })`.
 *
 * @param requestsByMessageId the calling agent's OWN access requests only —
 *        never another agent's, or one agent's approval would unlock a
 *        message for all of them.
 */
export function redactMessagesForSession(
  messages: RawMessage[],
  role: Role,
  requestsByMessageId: Map<string, SmsAccessRequestLike[]>,
  now: Date = new Date()
): RedactedMessage[] {
  return messages.map((m) => {
    const accessState = m.sensitive
      ? resolveMessageAccessState(requestsByMessageId.get(m.id) ?? [], now)
      : "none";
    const reveal = canRevealMessageBody({ role, sensitive: m.sensitive, accessState });
    return {
      id: m.id,
      conversationId: m.conversationId,
      direction: m.direction,
      // The withheld branch emits null — the plaintext never enters the
      // serialized object at all.
      body: reveal ? m.body : null,
      mediaUrl: reveal ? m.mediaUrl : null,
      mediaMimeType: reveal ? m.mediaMimeType : null,
      // mediaKind is not sensitive on its own (it's "voice"/"image"/…), but
      // hide it in the withheld branch too so the UI shows the lock, not a
      // broken player.
      mediaKind: reveal ? m.mediaKind : null,
      deliveryStatus: m.deliveryStatus,
      sensitive: m.sensitive,
      accessRequestStatus: accessState,
      createdAt: m.createdAt,
    };
  });
}
