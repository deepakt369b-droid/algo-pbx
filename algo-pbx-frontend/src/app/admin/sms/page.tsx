"use client";

import { useEffect, useState } from "react";
import { ChatThread } from "@/components/chat/chat-thread";

interface AccessRequest {
  id: string;
  status: "PENDING" | "APPROVED" | "DECLINED" | "REVOKED";
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  message: { id: string; conversationId: string; createdAt: string };
  requestedBy: { id: string; name: string; email: string };
  decidedBy: { id: string; name: string; email: string } | null;
}

interface ConversationRow {
  id: string;
  channel: "WHATSAPP" | "SMS";
  contact: { numberE164: string; displayName: string | null };
  unreadCount: number;
  lastMessageAt: string | null;
}

// Admin-only SIM SMS inbox + the approval queue for sensitive (OTP-shaped)
// messages an agent has asked to see. Nothing here filters sensitive
// content — this IS the surface that can see it, by design (an admin has
// to be able to see a message to decide whether to unlock it). Agents
// never reach this route or this page; requireAdminSession backs every
// call.
export default function SmsAdminPage() {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [smsConversations, setSmsConversations] = useState<ConversationRow[]>([]);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  const load = () => {
    fetch("/api/admin/messaging/sms-access-requests?status=PENDING")
      .then((r) => r.json())
      .then((data) => setRequests(data.requests ?? []));
    // Staff sessions get every conversation here — filter to the SMS
    // channel client-side so this page actually shows the SIM inbox it
    // has always claimed to be (previously it only had the approval queue).
    fetch("/api/messaging/conversations", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) =>
        setSmsConversations(
          ((data.conversations ?? []) as ConversationRow[]).filter((c) => c.channel === "SMS")
        )
      );
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  const decide = async (id: string, action: "approve" | "decline" | "revoke") => {
    await fetch(`/api/admin/messaging/sms-access-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    load();
  };

  const pollNow = async () => {
    setPollMessage("Checking...");
    const res = await fetch("/api/admin/messaging/sms/poll", { method: "POST" });
    const data = await res.json();
    setPollMessage(res.ok ? `Ingested ${data.ingested} new SMS.` : `Failed: ${JSON.stringify(data.error ?? data)}`);
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">SIM SMS</h1>
      <p className="max-w-2xl text-center text-xs text-tertiary">
        Inbound SMS on the Dinstar SIMs. OTP/verification-code-shaped messages are withheld from every
        agent-facing view by default — an agent must request access here before seeing one, and the
        request expires 15 minutes after approval.
      </p>

      <div className="glass-card flex w-full max-w-md flex-col items-center gap-3 p-6">
        <button onClick={pollNow} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg">
          Check for new SMS now
        </button>
        {pollMessage && <p className="text-xs text-tertiary">{pollMessage}</p>}
        <p className="text-xs text-tertiary">
          The Dinstar gateway has no push webhook — new SMS only arrives here on a poll. Wire this
          route to a schedule for unattended ingestion once a human is available to authenticate it —
          see the route&apos;s own header comment.
        </p>
      </div>

      <div className="glass-card w-full max-w-2xl p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">
          SIM SMS inbox ({smsConversations.length})
        </h2>
        {smsConversations.length === 0 ? (
          <p className="text-tertiary">
            No SMS conversations yet — they appear here once the gateway ingests an inbound message.
          </p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-primary">
            {smsConversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setOpenThreadId(c.id)}
                  className="flex w-full items-center justify-between border-t border-border pt-2 text-left first:border-0 first:pt-0"
                >
                  <span>
                    {c.contact.displayName ?? c.contact.numberE164}
                    {c.unreadCount > 0 && (
                      <span className="ml-2 rounded-full bg-cyan px-1.5 py-0.5 text-[10px] font-semibold text-accent-fg">
                        {c.unreadCount} unread
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-tertiary">
                    {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="glass-card w-full max-w-2xl p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-secondary">
          Pending access requests ({requests.length})
        </h2>
        {requests.length === 0 ? (
          <p className="text-tertiary">Nothing pending.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm text-primary">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between border-t border-border pt-3 first:border-0 first:pt-0">
                <div>
                  <p>
                    {r.requestedBy.name} <span className="text-xs text-tertiary">({r.requestedBy.email})</span>
                  </p>
                  <p className="text-xs text-tertiary">
                    requested {new Date(r.createdAt).toLocaleString()} — message from{" "}
                    {new Date(r.message.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => decide(r.id, "approve")} className="text-xs text-success hover:text-success">
                    Approve
                  </button>
                  <button onClick={() => decide(r.id, "decline")} className="text-xs text-danger hover:text-danger">
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {openThreadId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setOpenThreadId(null)}>
          <div
            className="flex h-full w-full max-w-xl flex-col gap-2 border-l border-border bg-background p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary">SMS thread</h3>
              <button onClick={() => setOpenThreadId(null)} className="text-xs text-tertiary hover:text-primary">
                Close
              </button>
            </div>
            <ChatThread
              conversationId={openThreadId}
              contactLabel={
                smsConversations.find((c) => c.id === openThreadId)?.contact.displayName ??
                smsConversations.find((c) => c.id === openThreadId)?.contact.numberE164
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
